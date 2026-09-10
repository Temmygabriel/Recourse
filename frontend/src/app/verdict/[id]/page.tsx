'use client';

/**
 * 5.7 — Verdict reveal.
 *
 * Design spec §5.7 asks for a decision that feels legitimate rather than
 * arbitrary, and names the three layers it has to disclose at once: the
 * decision, the evidence basis, and the record behind it. All three are on the
 * screen without a click. The record is inside a `<details>` because it is long
 * and only the technically curious want it — but it is *closed*, never hidden,
 * and the line above it says what is in there.
 *
 * §5.7 also asks for the stamp to resolve directly into the money. So the
 * stamped mark, the sentence, and the split are one continuous block: you read
 * the finding and the consequence in the same glance, which is the whole point
 * of the hero moment in §3.
 *
 * Every number on this page comes from the escrow's `Settled` event — the
 * outcome, the bitmap, and the two amounts the contract actually transferred.
 * Nothing here is recomputed from the dispute, and nothing is read from
 * GenLayer. Base is the authority for what was settled.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';

import {
  DocBody,
  DocCard,
  DocHead,
  Field,
  Loading,
  Notice,
  Stamp,
  TxLink,
} from '@/components/Document';
import { PromiseVsEvidence } from '@/components/PromiseVsEvidence';
import { RequirementList, type RequirementMark } from '@/components/RequirementList';
import { STAGE } from '@/lib/abi';
import { formatUsdc } from '@/lib/chain';
import { fetchPurchase, fetchSettlement } from '@/lib/escrow';
import { WHO_DECIDED_NOTE, refundDescription, verdictLine } from '@/lib/status';
import { useAsync } from '@/lib/useAsync';

export default function VerdictPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  const read = useCallback(async () => {
    const purchase = await fetchPurchase(id);
    if (purchase === null) return { purchase: null, settlement: null };
    return { purchase, settlement: await fetchSettlement(id) };
  }, [id]);

  const { data, error, loading } = useAsync(read, [id], { pollMs: 20_000 });

  if (loading && data === null) {
    return (
      <div className="sheet">
        <Loading what={`verdict for #${id}`} />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="sheet">
        <Notice tone="error">Could not read the verdict for #{id}: {error}</Notice>
      </div>
    );
  }

  const purchase = data?.purchase ?? null;
  const settlement = data?.settlement ?? null;

  if (purchase === null) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Verdict #{id}</h1>
        </div>
        <Notice>There is no purchase with that number.</Notice>
        <p className="mt-4">
          <Link href="/">Back to offers</Link>
        </p>
      </div>
    );
  }

  if (settlement === null) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Verdict #{id}</h1>
        </div>
        <Notice>
          {purchase.stage === STAGE.DISPUTED
            ? 'The case is still being decided. This page will show the finding as soon as the settlement lands on Base.'
            : 'This purchase has not been through a dispute, so there is no verdict to show.'}
        </Notice>
        <p className="mt-4">
          <Link href={`/offers/${id}`}>Back to the purchase</Link>
        </p>
      </div>
    );
  }

  const met: RequirementMark[] = Array.from({ length: purchase.criteriaCount }, (_, i) =>
    (settlement.criteriaMetBitmap & (1 << i)) !== 0 ? 'met' : 'unmet',
  );
  const metCount = met.filter((m) => m === 'met').length;
  const total = met.length;

  return (
    <div className="sheet">
      <div className="page-head">
        <h1>Finding on promise #{id}</h1>
      </div>

      {/* --- Layer 1: the decision ---------------------------------------- */}
      <div className="doc-card px-4 py-6 sm:px-6">
        <Stamp outcome={settlement.outcome} size="lg" />
        <p className="mt-5 font-display text-xl leading-snug">
          {verdictLine({ outcome: settlement.outcome, criteriaMet: met.map((m) => m === 'met') })}
        </p>
        <p className="mt-2 text-[14px] text-ink-muted">
          {refundDescription(settlement.refundBps)}
        </p>

        {/*
          Immediately the money — design spec §3. The two figures are the
          contract's own transfer amounts, so they always add up to the price
          plus whatever bond was returned, and they can be checked against the
          transaction below.
        */}
        <div className="mt-6 border-t border-rule pt-4">
          <div className="money-row">
            <span className="text-[14px] text-ink-muted">Seller receives</span>
            <span className="amount">{formatUsdc(settlement.sellerAmount)}</span>
          </div>
          <div className="money-row">
            <span className="text-[14px] text-ink-muted">Buyer receives</span>
            <span className="amount">{formatUsdc(settlement.buyerAmount)}</span>
          </div>
          {(settlement.bondToBuyer > 0n || settlement.bondToSeller > 0n) && (
            <div className="money-row border-t border-rule pt-3">
              <span className="text-[13px] text-ink-muted">
                Dispute bond — {formatUsdc(settlement.bondToBuyer)} back to the buyer,{' '}
                {formatUsdc(settlement.bondToSeller)} to the seller
              </span>
            </div>
          )}
        </div>

        <p className="mt-4">
          <Link href={`/receipt/${id}`} className="btn btn-secondary no-underline">
            Settlement receipt &rarr;
          </Link>
        </p>
      </div>

      {/* --- Layer 2: the evidence basis ---------------------------------- */}
      <div className="mt-5">
        <DocCard>
          <DocHead
            title="How each requirement was found"
            aside={
              <span>
                {metCount} of {total} met
              </span>
            }
          />
          <DocBody>
            <RequirementList rubric={purchase.rubric} marks={met} />
            <p className="mt-4 text-[13px] text-ink-muted">{WHO_DECIDED_NOTE}</p>
          </DocBody>
        </DocCard>
      </div>

      {/* --- Layer 3: the record ------------------------------------------ */}
      <div className="mt-5">
        <DocCard>
          <DocHead title="The record" />
          <DocBody>
            <Field label="Settled in transaction">
              <TxLink hash={settlement.txHash} />
            </Field>
            <Field label="Block">{settlement.blockNumber.toString()}</Field>
            <Field label="Decision nonce">{settlement.nonce.toString()}</Field>
            <Field label="Decision digest">
              <span className="ident" title={settlement.decisionDigest}>
                {settlement.decisionDigest}
              </span>
            </Field>
            <Field label="GenLayer transaction">
              {/^0x0{64}$/.test(settlement.genlayerTxHash) ? (
                // The three non-judgment settlements — accepted delivery, review
                // timeout, delivery-deadline refund — carry a zero hash because
                // no judgment was involved. Saying so is better than a row of
                // zeroes that looks like a missing value.
                <span className="text-ink-muted">
                  None — this settlement came from the deadline rules, not from a judgment.
                </span>
              ) : (
                <span className="ident" title={settlement.genlayerTxHash}>
                  {settlement.genlayerTxHash}
                </span>
              )}
            </Field>

            <details className="mt-4 border-t border-rule pt-4">
              <summary className="cursor-pointer text-[14px] font-medium">
                See the promise, the evidence, and the dispute this was decided on
              </summary>
              <div className="mt-4">
                <PromiseVsEvidence id={id} purchase={purchase} settlement={settlement} />
              </div>
            </details>
          </DocBody>
        </DocCard>
      </div>

      <p className="mt-5 text-[13px] text-ink-muted">
        <Link href={`/offers/${id}`}>Back to the purchase</Link>
      </p>
    </div>
  );
}
