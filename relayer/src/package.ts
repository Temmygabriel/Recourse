/**
 * Assembling the evidence package the judgment contract is asked to rule on.
 *
 * The package carries both the text and its commitment for every field. The
 * judgment contract hashes the text and checks it against the commitment, which
 * is a *consistency* check — it proves the package does not contradict itself,
 * not that the package is the one the escrow froze. That second, authoritative
 * check happens in `RecourseEscrow.settle()`, which re-derives every hash from
 * its own storage. See the note at the bottom of recourse_judgment.py.
 *
 * The text is copied out of the purchase struct exactly as viem decoded it. No
 * `.trim()`, no `.normalize()`, no line-ending conversion — every one of those
 * would change the hash and the package would be rejected by both layers. This
 * is MEMORY.md D12 and it is the single easiest way to break this system.
 *
 * The URL is the one field where the package carries a *pointer* rather than
 * the evidence itself. The judgment contract fetches it, hashes the bytes it
 * gets back, and compares to `artifact_hash` before any model is consulted, so
 * the package never asserts what the artifact says — only where it is and what
 * it must hash to. That is what keeps a convincing description of undelivered
 * work from being scored as delivered work.
 */

import type { Purchase } from './escrow.ts';
import { bitmapToIndices } from './hashes.ts';
import type { LocalCommitments } from './escrow.ts';

export interface EvidencePackage {
  readonly promise_text: string;
  readonly promise_hash: string;
  readonly rubric: readonly string[];
  readonly rubric_hash: string;
  readonly delivery_notes: string;
  readonly delivery_hash: string;
  /** Commit-pinned raw GitHub URL. The judgment contract fetches this. */
  readonly delivery_url: string;
  /** sha256 of the bytes at `delivery_url`, bare lowercase hex. */
  readonly artifact_hash: string;
  readonly dispute_notes: string;
  readonly dispute_hash: string;
  /** 0-based indices of the disputed criteria. Never empty. */
  readonly disputed_indices: readonly number[];
}

/** Hex without the 0x prefix — the shape `_sha256_hex` produces in Python. */
function bareHex(h: string): string {
  return h.replace(/^0x/i, '').toLowerCase();
}

export class PackageError extends Error {}

/**
 * The one host an evidence URL may point at, and the shape the rest of the path
 * must take.
 *
 * This is the third copy of this rule — `RecourseEscrow._validateEvidenceUrl`
 * and `recourse_judgment._validate_evidence_url` are the other two — and the
 * duplicated rule is the reason it is written as an explicit left-to-right scan
 * rather than a regex. A regex would be shorter and would drift, because the
 * three languages disagree at the edges: JS `\s` matches U+00A0 and friends
 * that Solidity's four-code-point check does not, so `/\s/` here would make the
 * relayer refuse URLs the escrow had already accepted. The character class
 * below is spelled out to match the contract exactly.
 *
 * The rule exists because the digest is only meaningful if the URL names
 * immutable bytes. A branch URL (`.../main/...`) can be repointed by whoever
 * owns the repo after the buyer's money is committed, which would let a seller
 * deliver, wait, and then rewrite the evidence. A 40-character commit SHA is
 * content-addressed by construction, so pinning to one is what makes "the
 * artifact the buyer paid for" a durable claim rather than a promise.
 *
 * The relayer is not the authority here — the escrow already enforced this at
 * `submitDelivery`, so anything read back off the chain has passed. This is a
 * pre-flight mirror: if it disagrees with the chain, the ABI or the deployment
 * is wrong, and that is worth knowing before a GenLayer fee is spent.
 */
const EVIDENCE_HOST_PREFIX = 'https://raw.githubusercontent.com/';
const COMMIT_HEX_LEN = 40;

export function validateEvidenceUrl(url: string): void {
  if (/[?#]/.test(url)) {
    throw new PackageError(
      'delivery_url must not carry a query or fragment: a URL with either can serve ' +
        'different bytes on different fetches, which defeats the digest.',
    );
  }
  if (/[\t\n\r ]/.test(url)) {
    throw new PackageError('delivery_url must not contain whitespace');
  }
  if (!url.startsWith(EVIDENCE_HOST_PREFIX)) {
    throw new PackageError(
      `delivery_url must start with ${EVIDENCE_HOST_PREFIX} — it is the one host the ` +
        `judgment contract fetches from.`,
    );
  }

  let i = EVIDENCE_HOST_PREFIX.length;
  i = skipUrlSegment(url, i, 'owner');
  i = skipUrlSegment(url, i, 'repo');

  const commit = url.slice(i, i + COMMIT_HEX_LEN);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new PackageError(
      `delivery_url commit must be 40 lowercase hex characters, got "${commit}". A branch ` +
        `or tag name is mutable and is refused for that reason; so is an abbreviated SHA.`,
    );
  }
  if (url[i + COMMIT_HEX_LEN] !== '/') {
    throw new PackageError('delivery_url must have a path after the commit');
  }

  i += COMMIT_HEX_LEN + 1;
  if (i >= url.length) {
    throw new PackageError('delivery_url must name a path');
  }
}

function skipUrlSegment(url: string, start: number, field: string): number {
  const slash = url.indexOf('/', start);
  // Mirrors the contract's two separate checks: a segment that begins at or
  // past the end of the string is *empty*, while one that runs off the end
  // without a delimiter is *unterminated*. The distinction is only in the
  // message, but the messages are part of the test contract.
  if (start >= url.length || slash === start) {
    throw new PackageError(`delivery_url ${field} is empty`);
  }
  if (slash === -1) throw new PackageError(`delivery_url ${field} is unterminated`);
  return slash + 1;
}

export function buildPackage(p: Purchase, commitments: LocalCommitments): EvidencePackage {
  if (p.criteriaCount < 2 || p.criteriaCount > 4) {
    throw new PackageError(
      `purchase has ${p.criteriaCount} criteria; the judgment contract accepts 2-4. ` +
        `The escrow should have rejected this at offer creation.`,
    );
  }
  if (p.rubric.length !== p.criteriaCount) {
    throw new PackageError(
      `purchase stores ${p.rubric.length} rubric items but declares criteriaCount ` +
        `${p.criteriaCount}`,
    );
  }

  const disputed = bitmapToIndices(p.disputedBitmap, p.criteriaCount);
  if (disputed.length === 0) {
    throw new PackageError(
      'the dispute bitmap names no criteria, so there is nothing to adjudicate. The ' +
        'escrow requires at least one disputed criterion at openDispute().',
    );
  }

  if (p.deliveryNotes.trim() === '') {
    throw new PackageError('the purchase has no delivery notes to judge against');
  }
  if (p.disputeNotes.trim() === '') {
    throw new PackageError('the purchase has no dispute notes to judge against');
  }

  validateEvidenceUrl(p.deliveryUrl);

  const artifactHash = bareHex(p.artifactHash);
  if (!/^[0-9a-f]{64}$/.test(artifactHash)) {
    throw new PackageError(
      `purchase stores artifactHash ${p.artifactHash}, which is not a sha256. The escrow ` +
        `requires a non-zero bytes32 at submitDelivery(), so this means the ABI in ` +
        `relayer/src/abi.ts does not match the deployed contract.`,
    );
  }
  if (/^0+$/.test(artifactHash)) {
    throw new PackageError('the purchase stores a zero artifactHash');
  }

  return {
    promise_text: p.promiseText,
    promise_hash: bareHex(commitments.promiseHash),
    rubric: p.rubric,
    rubric_hash: bareHex(commitments.rubricHash),
    delivery_notes: p.deliveryNotes,
    delivery_hash: bareHex(commitments.deliveryHash),
    delivery_url: p.deliveryUrl,
    artifact_hash: artifactHash,
    dispute_notes: p.disputeNotes,
    dispute_hash: bareHex(commitments.disputeHash),
    disputed_indices: disputed,
  };
}

/**
 * Serialize for the GenVM. `JSON.stringify` of a plain object in V8 escapes
 * exactly what `json.loads` expects back, and the contract re-hashes the parsed
 * values rather than the JSON text, so formatting here is not load-bearing —
 * only the decoded strings are.
 */
export function serializePackage(pkg: EvidencePackage): string {
  return JSON.stringify(pkg);
}
