'use client';

/**
 * The hero moment (design spec §3 and §5.6): the promise and the evidence,
 * side by side, criterion by criterion.
 *
 * This is the one screen a judge should remember without narration, so it is
 * also the one that is easiest to get wrong by embellishing. Three rules hold
 * it together:
 *
 *   1. NOTHING IS PARAPHRASED. The promise, the requirements, the delivery
 *      notes and the dispute notes are rendered as the exact bytes the escrow
 *      hashed. The requirement list is the seller's list, in the seller's
 *      order, with the seller's numbering — because those numbers are what the
 *      buyer cited and what the verdict reports back.
 *
 *   2. NO SCORE. There is no confidence percentage, no meter, no "82% match".
 *      The mapping is shown as words against the numbered list: this
 *      requirement was named in the dispute, this one was found met. That is
 *      the same information without inventing a number the system never
 *      computes.
 *
 *   3. THE EVIDENCE IS SHOWN WHOLE. The escrow stores one delivery text and one
 *      dispute text, so splitting them per criterion would mean inventing a
 *      split that does not exist. They are shown once each, verbatim, with the
 *      disputed criteria marked on the list above them.
 */

import Link from 'next/link';

import { DocBody, DocCard, DocHead, Verbatim } from './Document';
import { RequirementList, type RequirementMark } from './RequirementList';
import type { Purchase } from '@/lib/abi';
import { STAGE } from '@/lib/abi';
import type { Settlement } from '@/lib/escrow';
import { bitmapIndices } from '@/lib/status';

export function PromiseVsEvidence({
  id,
  purchase,
  settlement,
}: {
  id: number;
  purchase: Purchase;
  settlement: Settlement | null;
}) {
  const disputed = new Set(bitmapIndices(purchase.disputedBitmap, purchase.criteriaCount));

  // The verdict's per-criterion finding, when there is one. `criteriaMetBitmap`
  // is the escrow's own record of what the judgment returned — the same bitmap
  // the money was split on, not a second opinion computed here.
  const marks: RequirementMark[] | undefined =
    settlement === null
      ? undefined
      : Array.from({ length: purchase.criteriaCount }, (_, i) =>
          (settlement.criteriaMetBitmap & (1 << i)) !== 0 ? 'met' : 'unmet',
        );

  return (
    <div className="flex flex-col gap-5">
      <DocCard>
        <DocHead
          title="The promise, and what arrived"
          aside={
            settlement === null ? (
              <span>Not yet decided</span>
            ) : (
              <span>
                {marks?.filter((m) => m === 'met').length ?? 0} of {purchase.criteriaCount} met
              </span>
            )
          }
        />
        <DocBody>
          <div className="compare">
            <div className="compare-side">
              <p className="compare-label">Promised</p>
              <Verbatim text={purchase.promiseText} />
              <div className="mt-4">
                <RequirementList
                  rubric={purchase.rubric}
                  marks={marks}
                  disputed={marks === undefined ? disputed : undefined}
                  caption={
                    marks === undefined
                      ? 'The requirements the buyer agreed to'
                      : 'How each requirement was found'
                  }
                />
              </div>
            </div>

            <div className="compare-side lg:pt-0">
              <p className="compare-label">Delivered</p>
              {purchase.deliveryNotes.trim() === '' ? (
                <p className="text-[14px] text-ink-muted">
                  The seller did not mark this as delivered.
                </p>
              ) : (
                /*
                 * Dashed, not solid (design direction §6.6). Everything else on
                 * this screen is a document the app produced; this box is the
                 * seller's own words, attached. The change of border is what
                 * says "exhibit" without needing a label to say it.
                 */
                <div className="exhibit exhibit-dashed">
                  <div className="exhibit-head">
                    <span className="text-[12px] text-ink-muted">
                      The seller&rsquo;s delivery notes, as submitted
                    </span>
                  </div>
                  <div className="exhibit-body">{purchase.deliveryNotes}</div>
                </div>
              )}
            </div>
          </div>
        </DocBody>
      </DocCard>

      {purchase.disputeNotes.trim() !== '' && (
        <DocCard>
          <DocHead
            title="The dispute"
            aside={
              <span>
                {disputed.size} of {purchase.criteriaCount} requirements named
              </span>
            }
          />
          <DocBody>
            <div className="exhibit exhibit-dashed">
              <div className="exhibit-head">
                <span className="text-[12px] text-ink-muted">
                  The buyer&rsquo;s notes, as submitted
                </span>
              </div>
              <div className="exhibit-body">{purchase.disputeNotes}</div>
            </div>

            <p className="mt-3 text-[13px] text-ink-muted">
              The buyer named{' '}
              {[...disputed]
                .sort((a, b) => a - b)
                .map((i) => `Requirement ${i + 1}`)
                .join(', ')}
              .
            </p>
          </DocBody>
        </DocCard>
      )}

      {settlement === null && purchase.stage === STAGE.DISPUTED && (
        <p className="text-[13px] text-ink-muted">
          This is what the finding will be made against. When it arrives it is written to{' '}
          <Link href={`/offers/${id}`}>the purchase</Link> and to{' '}
          <Link href={`/verdict/${id}`}>the verdict</Link>.
        </p>
      )}
    </div>
  );
}
