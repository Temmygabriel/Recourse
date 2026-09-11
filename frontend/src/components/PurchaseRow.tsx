'use client';

/**
 * One purchase, as a row in a list.
 *
 * Deliberately a summary of the document rather than a card with a picture:
 * the price, what was promised, how many requirements, and where it stands.
 * The promise text is shown in the seller's words, unedited, because it is the
 * thing a buyer is being asked to accept — a marketing paraphrase here would
 * be the one place it matters most.
 *
 * The left bar is stage-coded (design direction §6.2) so the whole list can be
 * scanned by colour before any text is read.
 */

import Link from 'next/link';

import { OUTCOME, STAGE, type Purchase } from '@/lib/abi';
import { formatUsdc } from '@/lib/chain';
import { shortAddress } from '@/lib/escrow';
import { Countdown } from './Document';
import { stageInfo } from '@/lib/status';

/**
 * The colour of the row's left bar, which is the whole point of it.
 *
 * The one case worth reading twice is SETTLED. A settled purchase is not
 * automatically a good outcome — a refund settles just as finally and just as
 * permanently as a release does. Colouring every settled row green would let a
 * buyer scan the list and read "refunded" as "kept the money", which is the
 * exact opposite of what happened. So a settled row keeps the contested
 * burgundy unless the verdict was an outright RELEASE.
 *
 * `outcome` is undefined when the settlement log has not been read yet (the
 * outcome map loads alongside the list) or when the read failed. In that case
 * the bar stays neutral rather than guessing — a wrong colour here would be a
 * wrong claim about where someone's money went.
 */
function barClass(stage: number, outcome: number | undefined): string {
  switch (stage) {
    case STAGE.OPEN:
      return 'border-l-ink';
    case STAGE.FUNDED:
    case STAGE.DELIVERED:
      return 'border-l-pending';
    case STAGE.DISPUTED:
      return 'border-l-contested';
    case STAGE.SETTLED:
      if (outcome === undefined) return 'border-l-rule';
      return outcome === OUTCOME.RELEASE ? 'border-l-release' : 'border-l-contested';
    default:
      return 'border-l-rule';
  }
}

export function PurchaseRow({
  id,
  purchase,
  outcome,
}: {
  id: number;
  purchase: Purchase;
  /** The settlement outcome, when this purchase has settled and it is known. */
  outcome?: number | undefined;
}) {
  const info = stageInfo(purchase.stage);
  const isOpen = purchase.stage === STAGE.OPEN;

  return (
    <Link
      href={`/offers/${id}`}
      className={`doc-card block border-l-4 no-underline text-ink transition-colors hover:border-ink-muted/50 ${barClass(
        purchase.stage,
        outcome,
      )}`}
    >
      <div className="doc-head">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[12px] text-ink-muted">#{id}</span>
          <span className={`status status-${info.tone}`}>{info.label}</span>
        </div>
        <span className="font-display text-base">{formatUsdc(purchase.price)}</span>
      </div>

      <div className="doc-body">
        <p className="line-clamp-3 text-[14px]">{purchase.promiseText}</p>

        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px] text-ink-muted">
          <span>
            {purchase.criteriaCount}{' '}
            {purchase.criteriaCount === 1 ? 'requirement' : 'requirements'}
          </span>
          <span>Seller {shortAddress(purchase.seller)}</span>
          {isOpen && purchase.deliveryDeadline > 0n && (
            <Countdown to={purchase.deliveryDeadline} prefix="Deliver by" onExpired="expired" />
          )}
          {purchase.stage === STAGE.DELIVERED && purchase.deliveredAt > 0n && (
            <Countdown
              to={purchase.deliveredAt + purchase.reviewWindow}
              prefix="Review closes in"
              onExpired="closed"
            />
          )}
        </div>
      </div>
    </Link>
  );
}
