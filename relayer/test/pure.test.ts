/**
 * Local tests for the relayer's chain-independent logic.
 *
 * Run with (no build, no `npm install`, no network):
 *
 *     node --import ./relayer/test/register.mjs --test relayer/test/pure.test.ts
 *
 * Why this file exists at all: this project is developed on a machine that
 * cannot run `npm install` or `forge build` (MEMORY.md), so the Solidity and
 * the GenLayer SDK surface are only ever verified in CI. But a large part of the
 * relayer never touches either chain — the commitment hashes, the verdict
 * parser, the coherence check that has to agree with Solidity, the nonce
 * derivation, and the state store — and that part can run here. See
 * `test/stubs/viem.ts` for how, and for what stops the stub from making these
 * tests circular.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OUTCOME } from '../src/abi.ts';
import {
  assertCoherent,
  buildDecision,
  deriveNonce,
  parseVerdict,
  VerdictError,
  type Verdict,
} from '../src/decision.ts';
import { criteriaBitmap, bitmapToIndices, decisionDigestHex, evidenceRootHex, rubricHashHex, sha256Hex } from '../src/hashes.ts';
import { resolveChain } from '../src/genlayer.ts';
import { buildPackage, serializePackage, validateEvidenceUrl, PackageError } from '../src/package.ts';
import { Store } from '../src/store.ts';
import { keccak256 } from './stubs/viem.ts';
import * as chains from './stubs/genlayer-chains.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VECTORS = JSON.parse(
  readFileSync(join(ROOT, 'docs', 'vectors', 'hash-vectors.json'), 'utf8'),
) as {
  note: string;
  string_sha256: { name: string; text: string; sha256: string }[];
  rubric_sha256: { name: string; rubric: string[]; joined: string; sha256: string }[];
};

// ---------------------------------------------------------------------------
// The stub's own correctness, so the tests below mean something.
// ---------------------------------------------------------------------------

test('stub keccak256 matches the published digest of the empty string', () => {
  // If this fails, every evidenceRoot assertion below is meaningless.
  assert.equal(
    keccak256(new Uint8Array(0)),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
});

// ---------------------------------------------------------------------------
// The cross-language contract: Solidity, Python and this must all agree.
// ---------------------------------------------------------------------------

test('every shared string vector hashes to the committed digest', () => {
  assert.ok(VECTORS.string_sha256.length >= 9);
  for (const v of VECTORS.string_sha256) {
    assert.equal(sha256Hex(v.text), `0x${v.sha256}`, `vector "${v.name}"`);
  }
});

test('every shared rubric vector hashes to the committed digest', () => {
  assert.ok(VECTORS.rubric_sha256.length >= 4);
  for (const v of VECTORS.rubric_sha256) {
    assert.equal(rubricHashHex(v.rubric), `0x${v.sha256}`, `vector "${v.name}"`);
    // The joined form is asserted too: it is what recourse_judgment.py hashes,
    // and a change to the separator would keep the hash self-consistent while
    // silently disagreeing with Solidity.
    assert.equal(v.rubric.join('\n'), v.joined, `vector "${v.name}" join`);
  }
});

test('hashing is over verbatim bytes: whitespace changes the digest', () => {
  const base = 'Deliver three illustrations.';
  const withNewline = `${base}\n`;
  const withSpace = `${base} `;
  const withLeading = ` ${base}`;

  const h = sha256Hex(base);
  for (const [label, variant] of [
    ['trailing newline', withNewline],
    ['trailing space', withSpace],
    ['leading space', withLeading],
  ] as const) {
    assert.notEqual(sha256Hex(variant), h, `${label} must change the digest`);
  }

  // The regression this guards, stated as the failure it would cause: the
  // Python contract used to `.strip()` before hashing, so a promise ending in a
  // newline hashed to the same value as one without — and then disagreed with
  // the escrow, which hashed it verbatim. Every such dispute was unjudgeable.
  assert.equal(sha256Hex(withNewline), sha256Hex(base.trim() + '\n'));
  assert.notEqual(sha256Hex(withNewline), sha256Hex(withNewline.trim()));
});

test('rubric order is load-bearing', () => {
  assert.notEqual(
    rubricHashHex(['a', 'b', 'c']),
    rubricHashHex(['c', 'b', 'a']),
  );
  // The separator is a single newline, not a comma or a space — so a rubric
  // written with one style hashes differently from the other, and the escrow
  // (which joins the same way) is the authority on which.
  assert.notEqual(rubricHashHex(['a', 'b']), rubricHashHex(['a, b']));
  assert.notEqual(rubricHashHex(['a', 'b']), rubricHashHex(['a b']));

  // KNOWN LIMITATION, asserted here so it cannot be discovered by surprise
  // later: because the preimage is the joined text, a newline inside a rubric
  // item is indistinguishable from an item boundary. `['a', 'b']` and
  // `['a\nb']` are the same preimage and therefore the same commitment.
  //
  // This is a property of the shared scheme, not of this transcription: the
  // escrow hashes the joined string identically and the Python contract does
  // too, so all three agree — they just agree on something ambiguous. Closing
  // it would mean hashing a length-prefixed encoding on all three sides, which
  // would invalidate the locked vectors in docs/vectors/hash-vectors.json.
  //
  // It is not exploitable here. The rubric array itself is stored on-chain in
  // the Purchase struct and the seller sets it at creation, so a collision
  // would have to come from the relayer — which is already trusted in this
  // prototype (relayer/README.md). Recorded rather than fixed.
  assert.equal(rubricHashHex(['a', 'b']), rubricHashHex(['a\nb']));
});

// ---------------------------------------------------------------------------
// evidenceRoot
// ---------------------------------------------------------------------------

test('evidenceRoot is keccak256 over the three 32-byte hashes in order', () => {
  const delivery = sha256Hex('delivery notes');
  const dispute = sha256Hex('dispute notes');
  const artifact = sha256Hex('artifact bytes');
  const root = evidenceRootHex(delivery, dispute, artifact);

  assert.match(root, /^0x[0-9a-f]{64}$/);
  // Every position is load-bearing: moving any field to a different slot must
  // change the root, or a relayer could present one commitment as another.
  assert.notEqual(root, evidenceRootHex(dispute, delivery, artifact));
  assert.notEqual(root, evidenceRootHex(delivery, artifact, dispute));
  assert.notEqual(root, evidenceRootHex(artifact, dispute, delivery));
  // Three static bytes32 values encode as their plain 96-byte concatenation,
  // which is what `abi.encode` produces and what Solidity's `evidenceRoot()`
  // hashes. If this ever stops holding, the relayer and the escrow have parted
  // ways and every settle() would revert with "evidence mismatch".
  assert.equal(root, keccak256(`0x${delivery.slice(2)}${dispute.slice(2)}${artifact.slice(2)}`));
});

test('evidenceRoot is not the old two-field root', () => {
  // The regression guard for the change that made this function three-field.
  // `concatHex([deliveryHash, disputeHash])` was valid while the root covered
  // two commitments; it is a *silently different value* now, not a type error,
  // so nothing but an explicit assertion catches it coming back.
  const delivery = sha256Hex('delivery notes');
  const dispute = sha256Hex('dispute notes');
  const artifact = sha256Hex('artifact bytes');

  assert.notEqual(
    evidenceRootHex(delivery, dispute, artifact),
    keccak256(`0x${delivery.slice(2)}${dispute.slice(2)}`),
  );
  // And the artifact is bound, not ignored: same two text hashes, different
  // artifact, different root. Without this the whole delivery-fetch is
  // decorative — a verdict would travel with any artifact at all.
  assert.notEqual(
    evidenceRootHex(delivery, dispute, artifact),
    evidenceRootHex(delivery, dispute, sha256Hex('different bytes')),
  );
});

test('decisionDigest is over the exact verdict bytes', () => {
  const canonical = '{"criteria_met":[true,false],"outcome":"PARTIAL_REFUND","reason":"x","refund_bps":5000}';
  const digest = decisionDigestHex(canonical);
  assert.match(digest, /^0x[0-9a-f]{64}$/);
  // A third party recomputing this from `get_decision(key)` must get the same
  // answer, which only holds if the preimage is byte-identical.
  assert.notEqual(digest, decisionDigestHex(`${canonical} `));
  assert.notEqual(digest, decisionDigestHex(canonical.replace('false', 'true')));
});

// ---------------------------------------------------------------------------
// Bitmaps
// ---------------------------------------------------------------------------

test('criteriaBitmap sets bit i for criterion i and round-trips', () => {
  for (const count of [2, 3, 4]) {
    for (let mask = 0; mask < 1 << count; mask++) {
      const met = Array.from({ length: count }, (_, i) => (mask & (1 << i)) !== 0);
      assert.equal(criteriaBitmap(met, count), mask, `count=${count} mask=${mask}`);
      assert.deepEqual(bitmapToIndices(mask, count), met.flatMap((m, i) => (m ? [i] : [])));
    }
  }
});

test('criteriaBitmap refuses a verdict that does not match the rubric length', () => {
  // Silently truncating or padding here would shift every bit and produce a
  // bitmap the escrow reads as a different verdict entirely.
  assert.throws(() => criteriaBitmap([true, false], 3), /3 criteria/);
  assert.throws(() => criteriaBitmap([true, false, true, false], 3), /3 criteria/);
});

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

const GOOD = JSON.stringify({
  criteria_met: [true, false, true],
  outcome: 'PARTIAL_REFUND',
  reason: 'Criterion 2 was not delivered.',
  refund_bps: 3333,
});

test('parseVerdict accepts what the judgment contract produces', () => {
  const { verdict, canonicalJson } = parseVerdict(GOOD, 3);
  assert.equal(verdict.outcome, OUTCOME.PARTIAL_REFUND);
  assert.equal(verdict.refundBps, 3333);
  assert.deepEqual(verdict.criteriaMet, [true, false, true]);
  assert.equal(verdict.reason, 'Criterion 2 was not delivered.');
  // The canonical string is preserved byte-for-byte — decisionDigest depends on it.
  assert.equal(canonicalJson, GOOD);
});

test('parseVerdict accepts a Uint8Array, which is what a raw call can return', () => {
  const { verdict } = parseVerdict(new TextEncoder().encode(GOOD), 3);
  assert.equal(verdict.outcome, OUTCOME.PARTIAL_REFUND);
});

test('parseVerdict refuses every way a verdict can be wrong', () => {
  const cases: [string, unknown, RegExp][] = [
    ['empty string', '', /never been evaluated/],
    ['whitespace only', '   ', /never been evaluated/],
    ['not JSON', 'not json at all', /not valid JSON/],
    ['JSON array', '[1,2,3]', /must be an object/],
    ['JSON null', 'null', /must be an object/],
    ['unknown outcome', JSON.stringify({ outcome: 'MAYBE', refund_bps: 0, criteria_met: [true, true] }), /outcome must be one of/],
    ['missing outcome', JSON.stringify({ refund_bps: 0, criteria_met: [true, true] }), /outcome must be one of/],
    ['fractional bps', JSON.stringify({ outcome: 'RELEASE', refund_bps: 1.5, criteria_met: [true, true] }), /must be an integer/],
    ['string bps', JSON.stringify({ outcome: 'RELEASE', refund_bps: '0', criteria_met: [true, true] }), /must be an integer/],
    ['bps above 10000', JSON.stringify({ outcome: 'RELEASE', refund_bps: 10001, criteria_met: [true, true] }), /0\.\.10000/],
    ['bps below 0', JSON.stringify({ outcome: 'RELEASE', refund_bps: -1, criteria_met: [true, true] }), /0\.\.10000/],
    ['criteria_met not an array', JSON.stringify({ outcome: 'RELEASE', refund_bps: 0, criteria_met: 'yes' }), /must be an array/],
    ['wrong criteria count', JSON.stringify({ outcome: 'RELEASE', refund_bps: 0, criteria_met: [true] }), /1 entries but the purchase has 2/],
  ];
  for (const [label, input, expected] of cases) {
    assert.throws(() => parseVerdict(input, 2), expected, label);
  }
  // A non-string, non-bytes value (the SDK handing back a decoded Map, say).
  assert.throws(() => parseVerdict({ outcome: 'RELEASE' }, 2), /must be a string of JSON/);
});

// ---------------------------------------------------------------------------
// The coherence check — the relayer's copy of Solidity's rule.
//
// The loop below asserts a restatement of the rule rather than replaying the
// implementation, so a swapped branch, an off-by-one in the `full` mask, or a
// boundary error in the bps range fails here rather than as a reverted
// settlement. It is exhaustive over the whole input space the relayer can
// produce: 2..4 criteria x every bitmap x all four outcomes x a spread of bps.
// ---------------------------------------------------------------------------

test('assertCoherent accepts exactly the verdicts the escrow accepts', () => {
  const bpsCases = [-1, 0, 1, 5000, 9999, 10000, 10001];
  let checked = 0;

  for (const count of [2, 3, 4]) {
    const full = (1 << count) - 1;
    for (let bitmap = 0; bitmap <= full; bitmap++) {
      const allMet = bitmap === full;
      for (const outcome of [OUTCOME.RELEASE, OUTCOME.PARTIAL_REFUND, OUTCOME.FULL_REFUND, OUTCOME.UNDETERMINED]) {
        for (const refundBps of bpsCases) {
          checked++;
          const v: Verdict = {
            outcome,
            refundBps,
            criteriaMet: Array.from({ length: count }, (_, i) => (bitmap & (1 << i)) !== 0),
            reason: '',
          };

          const shouldAccept =
            outcome === OUTCOME.RELEASE
              ? refundBps === 0 && allMet
              : outcome === OUTCOME.FULL_REFUND
                ? refundBps === 10_000 && !allMet
                : outcome === OUTCOME.PARTIAL_REFUND
                  ? refundBps > 0 && refundBps < 10_000 && !allMet
                  : refundBps === 0;

          const label = `count=${count} bitmap=${bitmap} outcome=${outcome} bps=${refundBps}`;
          if (shouldAccept) {
            assert.doesNotThrow(() => assertCoherent(v, bitmap, count), label);
          } else {
            assert.throws(() => assertCoherent(v, bitmap, count), VerdictError, label);
          }
        }
      }
    }
  }
  // 2..4 criteria x every bitmap (4+8+16) x 4 outcomes x 7 bps values = 784.
  // Asserted so that adding a criteria count or an outcome and forgetting to
  // extend the sweep shows up as a number that no longer matches.
  assert.equal(checked, (4 + 8 + 16) * 4 * bpsCases.length);
});

test('assertCoherent rejects bitmap bits outside the rubric', () => {
  // A verdict whose criteria_met array is the right length but whose packed
  // bitmap has stray bits is a decoder bug, not a judgment — the escrow
  // catches it with the same check.
  assert.throws(() => assertCoherent({ outcome: OUTCOME.UNDETERMINED, refundBps: 0, criteriaMet: [true, true], reason: '' }, 0b111, 2), /outside the .*criterion range/);
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

test('deriveNonce is a pure function of the transaction and the purchase', () => {
  const txA = `0x${'11'.repeat(32)}` as const;
  const txB = `0x${'22'.repeat(32)}` as const;

  assert.equal(deriveNonce(txA, 1n), deriveNonce(txA, 1n));
  assert.notEqual(deriveNonce(txA, 1n), deriveNonce(txB, 1n));
  assert.notEqual(deriveNonce(txA, 1n), deriveNonce(txA, 2n));
  // Not a counter: a keccak output is essentially always larger than 64 bits,
  // so a nonce small enough to be a sequence number would mean this is not
  // deriving anything.
  assert.ok(deriveNonce(txA, 1n) > 1n << 64n);
});

test('buildDecision assembles a release end to end', () => {
  const parsed = parseVerdict(
    JSON.stringify({ criteria_met: [true, true, true], outcome: 'RELEASE', reason: 'All delivered.', refund_bps: 0 }),
    3,
  );
  const decision = buildDecision({
    purchaseId: 7,
    genlayerTxHash: `0x${'ab'.repeat(32)}`,
    sourceChainId: 61997n,
    sourceContract: `0x${'cd'.repeat(20)}`,
    promiseHash: sha256Hex('promise'),
    rubricHash: rubricHashHex(['a', 'b', 'c']),
    evidenceRoot: evidenceRootHex(sha256Hex('d'), sha256Hex('x'), sha256Hex('a')),
    decisionDigest: decisionDigestHex(parsed.canonicalJson),
    verdict: parsed.verdict,
    criteriaCount: 3,
    finalized: true,
  });

  assert.equal(decision.outcome, OUTCOME.RELEASE);
  assert.equal(decision.refundBps, 0);
  assert.equal(decision.criteriaMetBitmap, 0b111);
  assert.equal(decision.finalized, true);
  assert.equal(decision.nonce, deriveNonce(`0x${'ab'.repeat(32)}`, 7n));
  assert.equal(decision.purchaseId, 7n);
});

test('buildDecision refuses a verdict the escrow would reject', () => {
  // The judgment contract's `_clamp` is expected to prevent this, so reaching
  // it means something upstream is wrong — and signing it would burn a
  // settlement attempt for nothing.
  assert.throws(
    () =>
      buildDecision({
        purchaseId: 1,
        genlayerTxHash: `0x${'ab'.repeat(32)}`,
        sourceChainId: 1n,
        sourceContract: `0x${'cd'.repeat(20)}`,
        promiseHash: sha256Hex('p'),
        rubricHash: rubricHashHex(['a', 'b']),
        evidenceRoot: evidenceRootHex(sha256Hex('d'), sha256Hex('x'), sha256Hex('a')),
        decisionDigest: decisionDigestHex('{}'),
        verdict: { outcome: OUTCOME.RELEASE, refundBps: 500, criteriaMet: [true, true], reason: '' },
        criteriaCount: 2,
        finalized: true,
      }),
    /RELEASE must carry refundBps 0/,
  );
});

// ---------------------------------------------------------------------------
// The evidence package
// ---------------------------------------------------------------------------

/**
 * A commit-pinned raw URL — the only shape the escrow, the judgment contract,
 * and `validateEvidenceUrl` all accept. The commit is a real 40-character
 * lowercase SHA and the path is non-empty, because every one of those three
 * properties is separately enforced and separately tested below.
 */
const GOOD_URL =
  'https://raw.githubusercontent.com/Temmygabriel/recourse-evidence/' +
  '8f3c1d90a4b27e56cf0d1a3b8e47f2069cd51a3e/illustrations/delivery.md';

function fakePurchase(overrides: Record<string, unknown> = {}) {
  return {
    seller: `0x${'11'.repeat(20)}`,
    buyer: `0x${'22'.repeat(20)}`,
    price: 100_000_000n,
    deliveryDeadline: 2_000_000_000n,
    reviewWindow: 259_200n,
    deliveredAt: 1_999_000_000n,
    criteriaCount: 3,
    stage: 4,
    disputeBond: 5_000_000n,
    disputedBitmap: 0b010,
    promiseText: 'Deliver three illustrations.',
    rubric: ['Three illustrations at 3000px', 'Mobile versions', 'Layered source files'],
    deliveryNotes: 'Delivered three illustrations at 1500px.',
    deliveryUrl: GOOD_URL,
    artifactHash: sha256Hex('the bytes the server serves'),
    disputeNotes: 'Resolution is half of what was promised.',
    ...overrides,
  } as Parameters<typeof buildPackage>[0];
}

test('buildPackage carries verbatim text and matches the escrow commitments', () => {
  const p = fakePurchase();
  const commitments = {
    promiseHash: sha256Hex(p.promiseText),
    rubricHash: rubricHashHex(p.rubric),
    deliveryHash: sha256Hex(p.deliveryNotes),
    disputeHash: sha256Hex(p.disputeNotes),
    evidenceRoot: '0x' as const,
  };
  const pkg = buildPackage(p, commitments);

  // Byte-identical, including the trailing newline a textarea would produce.
  assert.equal(pkg.promise_text, p.promiseText);
  assert.equal(pkg.delivery_notes, p.deliveryNotes);
  assert.deepEqual(pkg.rubric, p.rubric);
  // Hashes go over the wire without the 0x prefix, matching `_sha256_hex`.
  assert.equal(pkg.promise_hash, commitments.promiseHash.slice(2));
  assert.equal(pkg.rubric_hash, commitments.rubricHash.slice(2));
  // 0b010 -> criterion index 1.
  assert.deepEqual(pkg.disputed_indices, [1]);
});

test('buildPackage preserves a trailing newline rather than trimming it', () => {
  const p = fakePurchase({ promiseText: 'Deliver three illustrations.\n' });
  const pkg = buildPackage(p, {
    promiseHash: sha256Hex(p.promiseText),
    rubricHash: rubricHashHex(p.rubric),
    deliveryHash: sha256Hex(p.deliveryNotes),
    disputeHash: sha256Hex(p.disputeNotes),
    evidenceRoot: '0x' as const,
  });
  assert.ok(pkg.promise_text.endsWith('\n'));
  assert.equal(sha256Hex(pkg.promise_text), sha256Hex('Deliver three illustrations.\n'));
  assert.notEqual(sha256Hex(pkg.promise_text), sha256Hex('Deliver three illustrations.'));
});

test('buildPackage round-trips through JSON, which is how it reaches the GenVM', () => {
  const p = fakePurchase({ disputeNotes: 'Ligne un\n\tindented, and  double  spaced.' });
  const pkg = buildPackage(p, {
    promiseHash: sha256Hex(p.promiseText),
    rubricHash: rubricHashHex(p.rubric),
    deliveryHash: sha256Hex(p.deliveryNotes),
    disputeHash: sha256Hex(p.disputeNotes),
    evidenceRoot: '0x' as const,
  });
  const roundTripped = JSON.parse(serializePackage(pkg)) as { dispute_notes: string };
  assert.equal(roundTripped.dispute_notes, p.disputeNotes);
  assert.equal(sha256Hex(roundTripped.dispute_notes), sha256Hex(p.disputeNotes));
});

test('buildPackage refuses a purchase with nothing to adjudicate', () => {
  assert.throws(() => buildPackage(fakePurchase({ disputedBitmap: 0 }), {
    promiseHash: '0x', rubricHash: '0x', deliveryHash: '0x', disputeHash: '0x', evidenceRoot: '0x',
  }), PackageError);
  assert.throws(() => buildPackage(fakePurchase({ deliveryNotes: '   ' }), {
    promiseHash: '0x', rubricHash: '0x', deliveryHash: '0x', disputeHash: '0x', evidenceRoot: '0x',
  }), /no delivery notes/);
  assert.throws(() => buildPackage(fakePurchase({ criteriaCount: 5 }), {
    promiseHash: '0x', rubricHash: '0x', deliveryHash: '0x', disputeHash: '0x', evidenceRoot: '0x',
  }), /2-4/);
});

test('buildPackage carries the URL and the artifact hash to the judgment layer', () => {
  const p = fakePurchase();
  const pkg = buildPackage(p, {
    promiseHash: sha256Hex(p.promiseText),
    rubricHash: rubricHashHex(p.rubric),
    deliveryHash: sha256Hex(p.deliveryNotes),
    disputeHash: sha256Hex(p.disputeNotes),
    evidenceRoot: '0x' as const,
  });

  // Verbatim: the judgment contract re-validates this string and fetches it, so
  // any rewriting here would move the fetch to a different resource.
  assert.equal(pkg.delivery_url, p.deliveryUrl);
  // Bare lowercase hex, matching `_norm_hash` on the Python side. The 0x
  // prefix is stripped for the same reason the text hashes are: the contract
  // normalises it away, so sending it is noise.
  assert.equal(pkg.artifact_hash, p.artifactHash.slice(2));
  assert.match(pkg.artifact_hash, /^[0-9a-f]{64}$/);
});

test('buildPackage refuses a zero or malformed artifact hash', () => {
  const commitments = {
    promiseHash: '0x' as const, rubricHash: '0x' as const, deliveryHash: '0x' as const,
    disputeHash: '0x' as const, evidenceRoot: '0x' as const,
  };
  // `submitDelivery` requires a non-zero bytes32, so a zero here means the ABI
  // is decoding the wrong slot — worth failing on rather than shipping to
  // GenLayer, where it would be a full refund for the seller's honest work.
  assert.throws(
    () => buildPackage(fakePurchase({ artifactHash: `0x${'00'.repeat(32)}` }), commitments),
    /zero artifactHash/,
  );
  assert.throws(
    () => buildPackage(fakePurchase({ artifactHash: '0xdeadbeef' }), commitments),
    /not a sha256/,
  );
});

// ---------------------------------------------------------------------------
// The evidence URL policy
//
// Three implementations of this rule exist — Solidity, Python, and this one —
// and all three are exercised here against the same cases. `buildPackage`
// refuses anything the escrow would have refused at submitDelivery, so a
// mismatch between the copies surfaces as a failing test rather than as a
// purchase nobody can settle.
// ---------------------------------------------------------------------------

test('the URL policy accepts a commit-pinned raw GitHub URL', () => {
  assert.doesNotThrow(() => validateEvidenceUrl(GOOD_URL));
  // A deeper path is fine; only the first four segments are constrained.
  assert.doesNotThrow(() =>
    validateEvidenceUrl(GOOD_URL.replace('/illustrations/delivery.md', '/a/b/c/d.txt')),
  );
});

test('the URL policy refuses mutable refs, because a branch can be repointed', () => {
  const withRef = (ref: string) => GOOD_URL.replace('8f3c1d90a4b27e56cf0d1a3b8e47f2069cd51a3e', ref);
  // The whole point of pinning: `main` names whatever the repo owner says it
  // names today, so a seller could deliver, wait for the buyer to read it, and
  // then rewrite the artifact the verdict will be made about.
  for (const ref of ['main', 'HEAD', 'master', 'v1.0.0', 'latest']) {
    assert.throws(() => validateEvidenceUrl(withRef(ref)), /40 lowercase hex/, `ref=${ref}`);
  }
});

test('the URL policy refuses an abbreviated or wrongly-cased commit', () => {
  // An 8-character prefix names the same commit to a human and to `git`, but it
  // is not the immutable identity the digest needs — GitHub could, in
  // principle, resolve it to a different object later.
  assert.throws(
    () => validateEvidenceUrl(GOOD_URL.replace('8f3c1d90a4b27e56cf0d1a3b8e47f2069cd51a3e', '8f3c1d90')),
    /40 lowercase hex/,
  );
  assert.throws(
    () => validateEvidenceUrl(GOOD_URL.replace('8f3c1d90', '8F3C1D90')),
    /40 lowercase hex/,
  );
  assert.throws(
    () => validateEvidenceUrl(GOOD_URL.replace('8f3c1d90a4b27e5', '8f3c1d90a4b27e5zz')),
    /40 lowercase hex/,
  );
});

test('the URL policy refuses anything that is not the one allowed host', () => {
  // A lookalike host is the case a naive `includes()` check would let through.
  const path = 'Temmygabriel/recourse-evidence/8f3c1d90a4b27e56cf0d1a3b8e47f2069cd51a3e/f.md';
  assert.throws(() => validateEvidenceUrl(`https://evil.example.com/${path}`), /must start with/);
  assert.throws(
    () => validateEvidenceUrl(GOOD_URL.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.evil.example')),
    /must start with/,
  );
  assert.throws(
    () => validateEvidenceUrl(GOOD_URL.replace('https://', 'http://')),
    /must start with/,
  );
  assert.throws(
    () => validateEvidenceUrl(GOOD_URL.replace('https://', 'https://user@')),
    /must start with/,
  );
});

test('the URL policy refuses a query or fragment', () => {
  // Either would let the same path serve different bytes on different fetches,
  // which is precisely what the artifact digest exists to rule out.
  assert.throws(() => validateEvidenceUrl(`${GOOD_URL}?v=2`), /query or fragment/);
  assert.throws(() => validateEvidenceUrl(`${GOOD_URL}#section`), /query or fragment/);
});

test('the URL policy refuses whitespace anywhere', () => {
  // The character class is spelled out rather than using `\s`, because JS `\s`
  // also matches U+00A0 and the contract does not — a superset here would make
  // the relayer refuse URLs the escrow had already accepted.
  for (const ws of [' ', '\t', '\n', '\r']) {
    assert.throws(
      () => validateEvidenceUrl(GOOD_URL.replace('illustrations', `illustr${ws}ations`)),
      /whitespace/,
    );
  }
});

test('the URL policy refuses missing owner, repo, commit, or path', () => {
  const P = 'https://raw.githubusercontent.com/';
  assert.throws(() => validateEvidenceUrl(`${P}/repo/${'a'.repeat(40)}/f.md`), /owner is empty/);
  assert.throws(() => validateEvidenceUrl(`${P}owner//${'a'.repeat(40)}/f.md`), /repo is empty/);
  assert.throws(() => validateEvidenceUrl(`${P}owner/repo`), /repo is unterminated/);
  assert.throws(() => validateEvidenceUrl(`${P}owner/repo/${'a'.repeat(40)}`), /path after the commit/);
  assert.throws(() => validateEvidenceUrl(`${P}owner/repo/${'a'.repeat(40)}/`), /name a path/);
  // The bare host is the degenerate case of "no owner".
  assert.throws(() => validateEvidenceUrl(P), /owner is empty/);
});

// ---------------------------------------------------------------------------
// The state store
// ---------------------------------------------------------------------------

test('Store persists, resumes, and keeps a nonce lossless', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recourse-store-'));
  try {
    const path = join(dir, 'state.json');
    const nonce = deriveNonce(`0x${'ab'.repeat(32)}`, 1n);

    const a = new Store(path);
    await a.update(1, { status: 'evaluating', genlayerKey: 'recourse:1', genlayerTxHash: '0xdead' });
    await a.update(1, { nonce: nonce.toString(), status: 'evaluated' });
    await a.update(2, { status: 'settled', genlayerKey: 'recourse:2' });

    // A fresh Store over the same file is what a restart looks like.
    const b = new Store(path);
    assert.equal(b.get(1)?.status, 'evaluated');
    assert.equal(b.get(1)?.nonce, nonce.toString());
    // A keccak-derived nonce exceeds 2^53, so storing it as a JSON number would
    // have silently rounded it and produced a different — unusable — nonce.
    assert.equal(BigInt(b.get(1)!.nonce!), nonce);
    assert.ok(nonce > BigInt(Number.MAX_SAFE_INTEGER));

    // Settled purchases are not re-examined.
    assert.deepEqual(b.pending().map((p) => p.id), [1]);
    assert.deepEqual(b.summary(), { evaluated: 1, settled: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Store writes atomically and leaves no temporary file behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recourse-store-'));
  try {
    const path = join(dir, 'state.json');
    const store = new Store(path);
    await store.update(1, { status: 'discovered' });
    assert.ok(existsSync(path));
    assert.ok(!existsSync(`${path}.tmp`), 'the temporary file must be renamed away, not left');
    // The file must always parse — a truncated one would look like "no state".
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Store refuses to start on a corrupt state file instead of re-settling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recourse-store-'));
  try {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{"version": 1, "purchases":', 'utf8');
    // Starting fresh would re-evaluate and re-attempt settlements that may
    // already have happened, so this must be a hard stop.
    assert.throws(() => new Store(path), /not valid JSON/);

    writeFileSync(path, '{"version": 99, "purchases": {}}', 'utf8');
    assert.throws(() => new Store(path), /unrecognised shape/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordError keeps the previous status unless the failure is terminal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recourse-store-'));
  try {
    const store = new Store(join(dir, 'state.json'));
    await store.update(1, { status: 'evaluated' });
    await store.recordError(1, 'transient', false);
    assert.equal(store.get(1)?.status, 'evaluated');
    assert.equal(store.get(1)?.attempts, 1);
    await store.recordError(1, 'fatal', true);
    assert.equal(store.get(1)?.status, 'failed');
    assert.equal(store.get(1)?.attempts, 2);
    assert.deepEqual(store.pending(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Chain resolution
//
// Against the stub in test/stubs/genlayer-chains.ts, which transcribes the real
// definitions from genlayer-js 2.0.0-rc.1. Read that file's header for what
// these tests can and cannot prove.
// ---------------------------------------------------------------------------

test('the stub reproduces the id collision that motivated the resolver', () => {
  // If a future SDK release gives Bradbury its own id, this test is the signal
  // that the ambiguity guard in resolveChain can be relaxed — and if the
  // collision is real, the guard below is load-bearing.
  const byId = new Map<number, string[]>();
  for (const [name, chain] of Object.entries(chains)) {
    const id = (chain as { id: number }).id;
    byId.set(id, [...(byId.get(id) ?? []), name]);
  }
  assert.deepEqual(byId.get(4221)?.sort(), ['testnetAsimov', 'testnetBradbury']);
  assert.deepEqual(byId.get(61997), ['studioDevnet']);
  assert.deepEqual(byId.get(61999), ['studionet']);
});

test('resolveChain finds each chain by its real export name', async () => {
  const expected: [string, number][] = [
    ['localnet', 61127],
    ['studioDevnet', 61997],
    ['studionet', 61999],
    ['testnetAsimov', 4221],
    ['testnetBradbury', 4221],
  ];
  for (const [name, id] of expected) {
    const chain = (await resolveChain(name)) as { id: number };
    assert.equal(chain.id, id, name);
  }
});

test('resolveChain accepts the spellings people actually write', async () => {
  // The v0.6 migration doc calls chain 61997 "studio-dev"; the package exports
  // `studioDevnet`. A config copied out of the docs has to work.
  const spellings = [
    'studio-dev',
    'studio_dev',
    'studioDev',
    'studioDevnet',
    'studiodevnet',
    'STUDIODEV',
    '  studio-dev  ',
    'Studio-Dev',
  ];
  for (const s of spellings) {
    const chain = (await resolveChain(s)) as { id: number };
    assert.equal(chain.id, 61997, `"${s}" should resolve to Studio Devnet`);
  }
});

test('resolveChain refuses to pick between the two chains sharing id 4221', async () => {
  // This is the whole point. Returning the first match would be a silent coin
  // flip between rpc-asimov and rpc-bradbury, and the mistake would not surface
  // until a settlement reverted on a sourceChainId mismatch.
  await assert.rejects(
    () => resolveChain('not-a-real-chain', 4221),
    (e: Error) => {
      assert.match(e.message, /ambiguous/);
      assert.match(e.message, /testnetAsimov and testnetBradbury/);
      return true;
    },
  );
  // But an unambiguous id still resolves.
  const chain = (await resolveChain('nonsense-name', 61997)) as { id: number };
  assert.equal(chain.id, 61997);
});

test('resolveChain fails with a message that names the real exports', async () => {
  await assert.rejects(
    () => resolveChain('sepolia'),
    (e: Error) => {
      // The message has to be actionable on its own: the fix is to pick one of
      // these names, so they must be in it.
      for (const name of ['localnet', 'studioDevnet', 'studionet', 'testnetAsimov', 'testnetBradbury']) {
        assert.ok(e.message.includes(name), `error should name ${name}`);
      }
      return true;
    },
  );

  // An unknown name with no id gives a different, equally specific message.
  await assert.rejects(() => resolveChain(''), /no chain definition found/);
});
