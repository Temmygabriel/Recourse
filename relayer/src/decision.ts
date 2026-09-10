/**
 * Turning a GenLayer verdict into a signed `SettlementDecision`.
 *
 * The two things worth understanding here:
 *
 * NONCE DERIVATION. The nonce must be globally unique for the life of the
 * escrow and must never be reused, because `nonceUsed` is the only replay guard.
 * A persisted counter would satisfy that until the first crash — a counter read,
 * written, and then lost to a power cut either reuses a nonce (settlement
 * reverts, recoverable) or, if it is advanced too eagerly, skips one (harmless).
 * Deriving the nonce from `keccak256(genlayerTxHash, purchaseId)` removes the
 * failure mode entirely: it is a pure function of inputs that are already
 * unique, so a *retry* of the same verdict reproduces the same nonce and the
 * second attempt reverts harmlessly on `"nonce used"`, while a genuinely new
 * verdict (a re-evaluation after an appeal) produces a new transaction hash and
 * therefore a new nonce. That is exactly the idempotency a restartable process
 * needs, obtained by construction rather than by careful bookkeeping.
 *
 * COHERENCE IS CHECKED TWICE. `_clamp` in the judgment contract already repairs
 * an incoherent model answer into a coherent one, and the escrow re-checks it.
 * The relayer checks it a third time, before signing, because the failure this
 * prevents is asymmetric: a verdict that reaches `settle()` and is rejected
 * costs a broadcast and leaves the dispute unresolved, whereas catching it here
 * costs nothing and names the field that was wrong. `assertCoherent` is a
 * deliberate transcription of `_checkVerdictCoherence`, in the same order, so
 * the two agree on *which* problem to report first.
 */

import { encodePacked, keccak256, type Address, type Hex } from 'viem';

import { OUTCOME, type OutcomeValue } from './abi.ts';
import { criteriaBitmap } from './hashes.ts';

export interface Verdict {
  readonly outcome: OutcomeValue;
  readonly refundBps: number;
  readonly criteriaMet: readonly boolean[];
  readonly reason: string;
}

export interface ParsedVerdict {
  readonly verdict: Verdict;
  /**
   * The exact string the judgment contract returned and stored. `decisionDigest`
   * is hashed over this verbatim, which is what lets a third party fetch
   * `get_decision(key)` from GenLayer and reproduce the digest.
   */
  readonly canonicalJson: string;
}

const OUTCOME_BY_NAME: Record<string, OutcomeValue> = {
  RELEASE: OUTCOME.RELEASE,
  PARTIAL_REFUND: OUTCOME.PARTIAL_REFUND,
  FULL_REFUND: OUTCOME.FULL_REFUND,
  UNDETERMINED: OUTCOME.UNDETERMINED,
};

export class VerdictError extends Error {}

/**
 * Parse and validate the verdict returned by the GenLayer contract.
 *
 * Everything is validated rather than coerced. The judgment contract's `_clamp`
 * is expected to have made this well-formed already, so a surprise here means
 * something is genuinely wrong — a different contract at that address, a
 * version skew, or a returned error string — and coercing it into a plausible
 * verdict is the one response guaranteed to be wrong.
 */
export function parseVerdict(raw: unknown, criteriaCount: number): ParsedVerdict {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw instanceof Uint8Array) {
    text = new TextDecoder().decode(raw);
  } else {
    throw new VerdictError(`verdict must be a string of JSON, got ${typeof raw}`);
  }

  if (text.trim() === '') {
    throw new VerdictError(
      'the judgment contract returned an empty verdict. `get_decision` returns "" for a ' +
        'purchase that has never been evaluated — check that the evaluate() call actually ' +
        'finalized before reading the decision back.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new VerdictError(`verdict is not valid JSON (${msg}): ${text.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new VerdictError('verdict JSON must be an object');
  }
  const obj = parsed as Record<string, unknown>;

  const outcomeName = typeof obj['outcome'] === 'string' ? obj['outcome'] : '';
  const outcome = OUTCOME_BY_NAME[outcomeName];
  if (outcome === undefined) {
    throw new VerdictError(
      `verdict outcome must be one of ${Object.keys(OUTCOME_BY_NAME).join(', ')}, ` +
        `got ${JSON.stringify(obj['outcome'])}`,
    );
  }

  const refundBpsRaw = obj['refund_bps'];
  if (typeof refundBpsRaw !== 'number' || !Number.isInteger(refundBpsRaw)) {
    throw new VerdictError(`verdict refund_bps must be an integer, got ${JSON.stringify(refundBpsRaw)}`);
  }
  if (refundBpsRaw < 0 || refundBpsRaw > 10_000) {
    throw new VerdictError(`verdict refund_bps must be 0..10000, got ${refundBpsRaw}`);
  }

  const metRaw = obj['criteria_met'];
  if (!Array.isArray(metRaw)) {
    throw new VerdictError('verdict criteria_met must be an array');
  }
  if (metRaw.length !== criteriaCount) {
    throw new VerdictError(
      `verdict criteria_met has ${metRaw.length} entries but the purchase has ` +
        `${criteriaCount} criteria. Refusing to guess which criteria were meant.`,
    );
  }
  const criteriaMet = metRaw.map((v) => v === true);

  const reason = typeof obj['reason'] === 'string' ? obj['reason'] : '';

  return {
    verdict: { outcome, refundBps: refundBpsRaw, criteriaMet, reason },
    canonicalJson: text,
  };
}

/**
 * A transcription of `RecourseEscrow._checkVerdictCoherence`.
 *
 * Same checks, same order, so the reason string the relayer logs names the same
 * problem the contract would have reverted on. `criteriaMetBitmap` is passed in
 * rather than derived so that this function checks what would actually be sent.
 */
export function assertCoherent(v: Verdict, criteriaMetBitmap: number, criteriaCount: number): void {
  const full = (1 << criteriaCount) - 1;
  if ((criteriaMetBitmap & ~full) !== 0) {
    throw new VerdictError(
      `criteriaMetBitmap ${criteriaMetBitmap.toString(2)} sets bits outside the ` +
        `${criteriaCount}-criterion range (full mask ${full.toString(2)})`,
    );
  }

  const allMet = criteriaMetBitmap === full;

  switch (v.outcome) {
    case OUTCOME.RELEASE:
      if (v.refundBps !== 0) throw new VerdictError(`RELEASE must carry refundBps 0, got ${v.refundBps}`);
      if (!allMet) throw new VerdictError('RELEASE with an unmet criterion');
      return;
    case OUTCOME.FULL_REFUND:
      if (v.refundBps !== 10_000) {
        throw new VerdictError(`FULL_REFUND must carry refundBps 10000, got ${v.refundBps}`);
      }
      if (allMet) throw new VerdictError('FULL_REFUND with every criterion met');
      return;
    case OUTCOME.PARTIAL_REFUND:
      if (v.refundBps <= 0 || v.refundBps >= 10_000) {
        throw new VerdictError(`PARTIAL_REFUND must carry refundBps in 1..9999, got ${v.refundBps}`);
      }
      if (allMet) throw new VerdictError('PARTIAL_REFUND with every criterion met');
      return;
    case OUTCOME.UNDETERMINED:
      if (v.refundBps !== 0) {
        throw new VerdictError(`UNDETERMINED must carry refundBps 0, got ${v.refundBps}`);
      }
      return;
  }
}

export interface SettlementDecision {
  readonly purchaseId: bigint;
  readonly nonce: bigint;
  readonly sourceChainId: bigint;
  readonly sourceContract: Address;
  readonly genlayerTxHash: Hex;
  readonly promiseHash: Hex;
  readonly rubricHash: Hex;
  readonly evidenceRoot: Hex;
  readonly decisionDigest: Hex;
  readonly outcome: number;
  readonly refundBps: number;
  readonly criteriaMetBitmap: number;
  readonly finalized: boolean;
}

/**
 * The replay guard, derived rather than counted. See the header.
 *
 * `encodePacked(['bytes32','uint256'], …)` is 64 bytes with no padding
 * ambiguity, so there is no possibility of two distinct pairs hashing alike by
 * concatenation.
 */
export function deriveNonce(genlayerTxHash: Hex, purchaseId: bigint): bigint {
  return BigInt(keccak256(encodePacked(['bytes32', 'uint256'], [genlayerTxHash, purchaseId])));
}

export function buildDecision(args: {
  purchaseId: number;
  genlayerTxHash: Hex;
  sourceChainId: bigint;
  sourceContract: Address;
  promiseHash: Hex;
  rubricHash: Hex;
  evidenceRoot: Hex;
  decisionDigest: Hex;
  verdict: Verdict;
  criteriaCount: number;
  finalized: boolean;
}): SettlementDecision {
  const bitmap = criteriaBitmap(args.verdict.criteriaMet, args.criteriaCount);
  assertCoherent(args.verdict, bitmap, args.criteriaCount);
  return {
    purchaseId: BigInt(args.purchaseId),
    nonce: deriveNonce(args.genlayerTxHash, BigInt(args.purchaseId)),
    sourceChainId: args.sourceChainId,
    sourceContract: args.sourceContract,
    genlayerTxHash: args.genlayerTxHash,
    promiseHash: args.promiseHash,
    rubricHash: args.rubricHash,
    evidenceRoot: args.evidenceRoot,
    decisionDigest: args.decisionDigest,
    outcome: args.verdict.outcome,
    refundBps: args.verdict.refundBps,
    criteriaMetBitmap: bitmap,
    finalized: args.finalized,
  };
}

/**
 * The EIP-712 typed data, mirroring `SettlementDecision` exactly.
 *
 * Field order here must match the typehash string in RecourseEscrow.sol
 * character for character: EIP-712 hashes the *encoding*, so a reordered field
 * produces a valid-looking signature over a different message. The relayer
 * guards against ever getting this wrong by reading `hashDecision()` back off
 * the chain before broadcasting (`assertSignatureMatchesChain` in index.ts) —
 * if this definition drifts, the check fails loudly instead of the relayer
 * silently signing decisions the escrow refuses.
 */
export const SETTLEMENT_TYPES = {
  SettlementDecision: [
    { name: 'purchaseId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'sourceContract', type: 'address' },
    { name: 'genlayerTxHash', type: 'bytes32' },
    { name: 'promiseHash', type: 'bytes32' },
    { name: 'rubricHash', type: 'bytes32' },
    { name: 'evidenceRoot', type: 'bytes32' },
    { name: 'decisionDigest', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'refundBps', type: 'uint16' },
    { name: 'criteriaMetBitmap', type: 'uint8' },
    { name: 'finalized', type: 'bool' },
  ],
} as const;

/**
 * Domain: ("Recourse", "1", chainId, verifyingContract) — see
 * `_buildDomainSeparator` in RecourseEscrow.sol. `chainId` is Base's, not
 * GenLayer's; the escrow is the verifying contract and it lives on Base.
 */
export function domain(chainId: number, verifyingContract: Address) {
  return { name: 'Recourse', version: '1', chainId, verifyingContract } as const;
}

/** The struct as plain EIP-712 data (numbers as bigint/number, not hex). */
export function typedDataMessage(d: SettlementDecision) {
  return {
    purchaseId: d.purchaseId,
    nonce: d.nonce,
    sourceChainId: d.sourceChainId,
    sourceContract: d.sourceContract,
    genlayerTxHash: d.genlayerTxHash,
    promiseHash: d.promiseHash,
    rubricHash: d.rubricHash,
    evidenceRoot: d.evidenceRoot,
    decisionDigest: d.decisionDigest,
    outcome: d.outcome,
    refundBps: d.refundBps,
    criteriaMetBitmap: d.criteriaMetBitmap,
    finalized: d.finalized,
  };
}
