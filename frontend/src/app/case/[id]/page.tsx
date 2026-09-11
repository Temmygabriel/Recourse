'use client';

/**
 * 5.6 — Promise vs. evidence (both parties, after a dispute).
 *
 * The shell around the comparison: the header, the state, and the one thing
 * neither party can see anywhere else — what the other side actually submitted
 * and when. The comparison itself lives in `PromiseVsEvidence`, shared with the
 * verdict screen so the two can never drift into telling different stories
 * about the same case.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';

import { DocBody, DocCard, Field, Loading, Notice } from '@/components/Document';
import { PromiseVsEvidence } from '@/components/PromiseVsEvidence';
import { STAGE } from '@/lib/abi';
import { formatUsdc } from '@/lib/chain';
import { fetchPurchase, fetchSettlement, isSameAddress } from '@/lib/escrow';
import { bitmapIndices, stageInfo } from '@/lib/status';
import { useAsync } from '@/lib/useAsync';
import { useWallet } from '@/lib/wallet';

export default function CasePage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { account } = useWallet();

  const read = useCallback(
    async () => {
      const purchase = await fetchPurchase(id);
      if (purchase === null) return { purchase: null, settlement: null };
      return { purchase, settlement: await fetchSettlement(id) };
    },
    [id],
  );

  const { data, error, loading } = useAsync(read, [id], { pollMs: 20_000 });

  if (loading && data === null) {
    return (
      <div className="sheet">
        <Loading what={`case #${id}`} />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="sheet">
        <Notice tone="error">Could not read case #{id}: {error}</Notice>
      </div>
    );
  }

  const purchase = data?.purchase ?? null;
  const settlement = data?.settlement ?? null;

  if (purchase === null) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Case #{id}</h1>
        </div>
        <Notice>There is no purchase with that number.</Notice>
        <p className="mt-4">
          <Link href="/">Back to offers</Link>
        </p>
      </div>
    );
  }

  // The case file is meaningful from the moment a dispute is opened. Before
  // that there is only one side's evidence, which belongs on the purchase page.
  if (purchase.stage === STAGE.OPEN || purchase.stage === STAGE.FUNDED) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Case #{id}</h1>
        </div>
        <Notice>
          There is no dispute on this purchase yet, so there is no case to compare.
        </Notice>
        <p className="mt-4">
          <Link href={`/offers/${id}`}>Back to the purchase</Link>
        </p>
      </div>
    );
  }

  const info = stageInfo(purchase.stage);
  const isSeller = isSameAddress(account ?? undefined, purchase.seller);
  const isBuyer = isSameAddress(account ?? undefined, purchase.buyer);
  const settled = purchase.stage === STAGE.SETTLED;

  return (
    <div className="sheet">
      <div className="page-head">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1>Case #{id}</h1>
          <span className={`status status-${info.tone}`}>{info.label}</span>
        </div>
        <p className="lede">
          {isBuyer
            ? 'This is your dispute, and the promise it is measured against.'
            : isSeller
              ? 'This is the promise you made, and what the buyer says is missing.'
              : info.blurb}
        </p>
      </div>

      <div className="mb-5">
        <DocCard>
          <DocBody>
            <Field label="Amount in dispute">{formatUsdc(purchase.price)}</Field>
            <Field label="Disputed on">
              {purchase.disputedBitmap === 0
                ? '—'
                : `${bitmapIndices(purchase.disputedBitmap, purchase.criteriaCount).length} of ${purchase.criteriaCount} requirements`}
            </Field>
            <Field label="Delivery notes">
              {purchase.deliveryNotes.trim() === ''
                ? 'None submitted'
                : `${purchase.deliveryNotes.length} characters, locked`}
            </Field>

            {/*
              The bond gets its own strip rather than a fourth Field, because it
              is not a fact about the dispute — it is a second sum of money the
              buyer put up to open one, and it moves on the same verdict.

              Held cases read the amount from the struct, so it is what the
              escrow actually took. Settled cases read `bondToBuyer` from the
              settlement instead, because that is the only record of where the
              bond actually ended up — the struct still holds the original
              amount, which by then is a fact about the past.
            */}
            {purchase.disputeBond > 0n && (
              <div className="bond-strip">
                <span className="text-[12px] text-ink-muted">
                  {settlement === null
                    ? 'Dispute bond — posted by the buyer'
                    : settlement.bondToBuyer > 0n
                      ? 'Dispute bond — returned to the buyer'
                      : 'Dispute bond — forfeited to the seller'}
                </span>
                <span className="font-display text-[15px]">
                  {formatUsdc(settlement === null ? purchase.disputeBond : settlement.bondToBuyer)}
                </span>
                <span className="w-full text-[11px] text-ink-muted">
                  {settlement === null
                    ? 'Posted to open the case. It comes back in full if the dispute is upheld, and goes to the seller if it is not.'
                    : settlement.bondToBuyer > 0n
                      ? 'Awarded back because the buyer’s dispute was upheld.'
                      : 'Awarded to the seller because the buyer’s dispute was not upheld.'}
                </span>
              </div>
            )}
          </DocBody>
        </DocCard>
      </div>

      <PromiseVsEvidence id={id} purchase={purchase} settlement={settlement} />

      {settled && (
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href={`/verdict/${id}`} className="btn btn-primary no-underline">
            See the finding
          </Link>
          <Link href={`/receipt/${id}`} className="btn btn-secondary no-underline">
            See the settlement receipt
          </Link>
        </div>
      )}
    </div>
  );
}
