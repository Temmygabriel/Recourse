'use client';

/**
 * 5.8 — Settlement receipt.
 *
 * The job is to close the loop and make the movement of money visible and
 * final, so this is the most literal screen in the app: the exact split, the
 * transaction it happened in, and the block it was mined at. No summary
 * language, no "approximately", no rounded figures.
 *
 * It is also the screen a buyer is most likely to screenshot, so the four
 * lines that matter — what was paid, what came back, what the seller got, what
 * happened to the bond — are stated as amounts rather than described in
 * prose.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';

import {
  AddressLink,
  DocBody,
  DocCard,
  DocHead,
  Field,
  Loading,
  Notice,
  Stamp,
  TxLink,
} from '@/components/Document';
import { STAGE } from '@/lib/abi';
import { ESCROW, formatUsdc } from '@/lib/chain';
import { fetchPurchase, fetchSettlement } from '@/lib/escrow';
import { outcomeInfo, refundDescription } from '@/lib/status';
import { useAsync } from '@/lib/useAsync';

export default function ReceiptPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  const read = useCallback(async () => {
    const purchase = await fetchPurchase(id);
    if (purchase === null) return { purchase: null, settlement: null };
    return { purchase, settlement: await fetchSettlement(id) };
  }, [id]);

  const { data, error, loading } = useAsync(read, [id]);

  if (loading && data === null) {
    return (
      <div className="sheet">
        <Loading what={`receipt for #${id}`} />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="sheet">
        <Notice tone="error">Could not read the receipt for #{id}: {error}</Notice>
      </div>
    );
  }

  const purchase = data?.purchase ?? null;
  const settlement = data?.settlement ?? null;

  if (purchase === null || settlement === null) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Receipt #{id}</h1>
        </div>
        <Notice>
          {purchase !== null && purchase.stage === STAGE.DISPUTED
            ? 'The case is still being decided. The receipt appears once the settlement lands on Base.'
            : `There is no settled purchase with the number ${id}.`}
        </Notice>
        <p className="mt-4">
          <Link href="/">Back to offers</Link>
        </p>
      </div>
    );
  }

  const info = outcomeInfo(settlement.outcome);
  const total = settlement.sellerAmount + settlement.buyerAmount;

  return (
    <div className="sheet">
      <div className="page-head">
        <h1>Settlement receipt</h1>
        <p className="lede">
          Promise #{id}, settled on Base Sepolia. Every figure below is an amount the escrow
          contract transferred.
        </p>
      </div>

      <DocCard>
        <DocHead
          title={`Promise #${id}`}
          aside={<span className={`status status-${info.tone}`}>{info.label}</span>}
        />
        <DocBody>
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="compare-label">Paid into escrow</p>
              <p className="amount">{formatUsdc(purchase.price)}</p>
              <p className="mt-1 text-[13px] text-ink-muted">
                {refundDescription(settlement.refundBps)}
              </p>
            </div>
            <div className="shrink-0">
              <Stamp outcome={settlement.outcome} />
            </div>
          </div>

          <div className="mt-6 border-t border-rule pt-4">
            <div className="money-row">
              <span className="text-[15px]">Seller received</span>
              <span className="amount">{formatUsdc(settlement.sellerAmount)}</span>
            </div>
            <div className="money-row border-b border-rule pb-3">
              <span className="text-[15px]">Buyer received back</span>
              <span className="amount">{formatUsdc(settlement.buyerAmount)}</span>
            </div>
            <div className="money-row pt-3">
              <span className="text-[13px] text-ink-muted">Total moved</span>
              <span className="text-[13px] text-ink-muted">{formatUsdc(total)}</span>
            </div>
          </div>

          {(settlement.bondToBuyer > 0n || settlement.bondToSeller > 0n) && (
            <div className="mt-4 border-t border-rule pt-4">
              <p className="compare-label">Dispute bond</p>
              <div className="money-row">
                <span className="text-[14px] text-ink-muted">
                  <AddressLink address={purchase.buyer} label="Buyer" /> bonded{' '}
                  {formatUsdc(settlement.bondToBuyer + settlement.bondToSeller)}
                </span>
                <span className="text-[14px]">
                  {settlement.bondToBuyer > 0n && (
                    <>{formatUsdc(settlement.bondToBuyer)} returned</>
                  )}
                  {settlement.bondToBuyer > 0n && settlement.bondToSeller > 0n && ' · '}
                  {settlement.bondToSeller > 0n && (
                    <>{formatUsdc(settlement.bondToSeller)} to the seller</>
                  )}
                </span>
              </div>
            </div>
          )}
        </DocBody>
      </DocCard>

      <div className="mt-5">
        <DocCard>
          <DocHead title="On chain" />
          <DocBody>
            <Field label="Settlement transaction">
              <TxLink hash={settlement.txHash} />
            </Field>
            <Field label="Block">{settlement.blockNumber.toString()}</Field>
            <Field label="Seller">
              <AddressLink address={purchase.seller} />
            </Field>
            <Field label="Buyer">
              <AddressLink address={purchase.buyer} />
            </Field>
            {!/^0x0{64}$/.test(settlement.genlayerTxHash) && (
              <Field label="GenLayer transaction">
                <span className="ident" title={settlement.genlayerTxHash}>
                  {settlement.genlayerTxHash}
                </span>
              </Field>
            )}
            {settlement.nonce > 0n && (
              <Field label="Decision nonce">{settlement.nonce.toString()}</Field>
            )}
            <Field label="Escrow contract">
              <AddressLink address={ESCROW.address} />
            </Field>
          </DocBody>
        </DocCard>
      </div>

      <p className="mt-5 flex flex-wrap gap-3">
        <Link href={`/verdict/${id}`} className="btn btn-secondary no-underline">
          See the finding
        </Link>
        <Link href={`/offers/${id}`} className="btn btn-secondary no-underline">
          Back to the purchase
        </Link>
      </p>
    </div>
  );
}
