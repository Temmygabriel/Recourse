/**
 * The relayer's transcription of the escrow's commitment scheme.
 *
 * This is the third implementation of these hashes in the project — Solidity on
 * Base, Python in the GenVM, and this — and the only reason it is safe to have
 * three is that each one *checks itself against the other* rather than being
 * trusted. Concretely:
 *
 *   - The escrow derives every hash from text it stores, so it cannot desync
 *     from itself (design rule 1 in RecourseEscrow.sol).
 *   - The relayer re-derives each hash from the text it just read off the chain
 *     and compares it to the escrow's own view function before doing anything
 *     with it (`verifyCommitments` in `escrow.ts`). If this file disagrees with
 *     Solidity by even one byte — a different encoding, an accidental trim —
 *     the relayer stops instead of submitting a package GenLayer will reject
 *     forever.
 *   - GenLayer re-derives them again from the package text.
 *
 * Encoding is the whole game here. Solidity's `bytes(s)` is the UTF-8 encoding
 * of `s` with no BOM and no normalisation, so `sha256(bytes(s))` equals
 * `sha256(utf8Encode(s))`, which is exactly what Node's `createHash` does when
 * given a JS string. What would break it is anything that *rewrites* the
 * string: `String.prototype.trim`, `normalize('NFC')`, or a line-ending
 * conversion. None of those appear below, and none may be added.
 * See MEMORY.md D12 and docs/vectors/hash-vectors.json.
 */

import { createHash } from 'node:crypto';
import { concatHex, keccak256, stringToHex, type Hex } from 'viem';

/**
 * sha256 of a string's UTF-8 bytes, as a 0x-prefixed bytes32.
 *
 * The string is passed to `Buffer.from(s, 'utf8')` unmodified — deliberately
 * not trimmed, not normalized, not line-ending-converted. A trailing newline
 * here is a different hash from no trailing newline, and that is correct: it is
 * what the escrow committed to.
 */
export function sha256Hex(text: string): Hex {
  const digest = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  return `0x${digest}` as Hex;
}

/**
 * sha256 over the rubric items joined by a single "\n", in list order.
 *
 * Order is load-bearing: criterion i here is bit i of `criteriaMetBitmap` and
 * bit i of the escrow's `disputedBitmap`. Reordering this list silently
 * reinterprets every criterion.
 */
export function rubricHashHex(rubric: readonly string[]): Hex {
  return sha256Hex(rubric.join('\n'));
}

/**
 * keccak256(abi.encode(deliveryHash, disputeHash)).
 *
 * Two bytes32 values are already 32-byte aligned, so `abi.encode` of them is
 * their plain concatenation — no length prefix, no padding. viem's `concatHex`
 * does exactly that. If this ever needed a third field, this shortcut would
 * stop being valid and the function would have to use `encodeAbiParameters`.
 */
export function evidenceRootHex(deliveryHash: Hex, disputeHash: Hex): Hex {
  return keccak256(concatHex([deliveryHash, disputeHash]));
}

/**
 * `decisionDigest` — the audit anchor for the verdict payload.
 *
 * The escrow does not verify this field (an EVM contract cannot read GenLayer
 * state); it only records it in the `Settled` event, signed. Its purpose is
 * that anyone can later pull the stored verdict from the GenLayer contract,
 * serialize it the same way, and confirm the relayer relayed a real verdict
 * rather than inventing one.
 *
 * To make that possible the preimage must be reproducible by a third party, so
 * it is not a hash of the relayer's own object: it is a hash of the exact bytes
 * the judgment contract returned and stored, which is canonical JSON — sorted
 * keys, no incidental whitespace — as `recourse_judgment.py` documents. This
 * function takes that string and hashes it verbatim, and the caller passes the
 * string exactly as `get_decision` returned it.
 */
export function decisionDigestHex(canonicalVerdictJson: string): Hex {
  return keccak256(stringToHex(canonicalVerdictJson));
}

/**
 * Pack a boolean list into the escrow's criteria bitmap, bit i for criterion i.
 *
 * Bounds-checked rather than silently truncated: a verdict with more entries
 * than the rubric has would otherwise shift every bit and produce a bitmap the
 * escrow's coherence check reads as a completely different verdict.
 */
export function criteriaBitmap(criteriaMet: readonly boolean[], criteriaCount: number): number {
  if (criteriaMet.length !== criteriaCount) {
    throw new Error(
      `verdict has ${criteriaMet.length} criteria_met entries but the purchase has ` +
        `${criteriaCount} criteria`,
    );
  }
  let bitmap = 0;
  for (let i = 0; i < criteriaMet.length; i++) {
    if (criteriaMet[i]) bitmap |= 1 << i;
  }
  return bitmap;
}

/** The indices (0-based) set in a disputed bitmap. */
export function bitmapToIndices(bitmap: number, criteriaCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < criteriaCount; i++) {
    if ((bitmap & (1 << i)) !== 0) out.push(i);
  }
  return out;
}
