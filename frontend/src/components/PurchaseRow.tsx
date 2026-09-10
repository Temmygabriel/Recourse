'use client';

/**
 * One purchase, as a row in a list.
 *
 * Deliberately a summary of the document rather than a card with a picture:
 * the price, what was promised, how many requirements, and where it stands.
 * The promise text is shown in the seller's words, unedited, because it is the
 * thing a buyer is being asked to accept — a marketing paraphrase here would
 * be the one place it matters most.
 */

import Link from 'next/link';

import type { Purchase } from '@/lib/abi';
import { formatUsdc } from '@/lib/chain';
import { shortAddress } from '@/lib/escrow';
import { Countdown } from './Document';
import { stageInfo } from '@/lib/status';

export function PurchaseRow({ id, purchase }: { id: number; purchase: Purchase }) {
  const info = stageInfo(purchase.stage);
  const isOpen = purchase.stage === 1;

  return (
    <Link
      href={`/offers/${id}`}
      className="doc-card block no-underline text-ink transition-colors hover:border-ink-muted/50"
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
          {purchase.stage === 3 && purchase.deliveredAt > 0n && (
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
