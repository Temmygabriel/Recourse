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

  return {
    promise_text: p.promiseText,
    promise_hash: bareHex(commitments.promiseHash),
    rubric: p.rubric,
    rubric_hash: bareHex(commitments.rubricHash),
    delivery_notes: p.deliveryNotes,
    delivery_hash: bareHex(commitments.deliveryHash),
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
