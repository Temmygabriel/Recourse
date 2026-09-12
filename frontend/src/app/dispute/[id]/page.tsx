'use client';

/**
 * 5.5 — Open a dispute (buyer).
 *
 * Design spec §5.5: classify before explaining. The buyer ticks the specific
 * requirements that were not met, out of the seller's own frozen list — they
 * cannot describe a new problem here, because a dispute is only ever about
 * what was agreed. Only after a criterion is ticked does the evidence box make
 * sense, so it is disabled until then and the prompt says what it wants.
 *
 * The bond is shown before the button, not after: what it costs, where it goes
 * if the buyer is right, and where it goes if they are not. Design spec §5.5
 * asks for that explicitly, and a bond the buyer only discovers at the wallet
 * prompt is a bond they were not told about.
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import {
  Countdown,
  DocBody,
  DocCard,
  DocHead,
  Loading,
  Notice,
  Verbatim,
} from '@/components/Document';
import { RequirementList, selectionToBitmap } from '@/components/RequirementList';
import { STAGE } from '@/lib/abi';
import { formatUsdc } from '@/lib/chain';
import {
  confirm,
  disputeBondFor,
  ensureAllowance,
  fetchPurchase,
  isSameAddress,
  writeEscrow,
} from '@/lib/escrow';
import { BOND_RETURNED_NOTE, DISPUTE_PROMPT, reviewDeadlineOf } from '@/lib/status';
import { pollUntil, stageIs } from '@/lib/settle';
import { describeError, useAsync } from '@/lib/useAsync';
import { useWallet } from '@/lib/wallet';

const MAX_NOTES = 2000;

export default function DisputePage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const router = useRouter();
  const { account, connect, connecting } = useWallet();

  const read = useCallback(() => fetchPurchase(id), [id]);
  const { data: purchase, error, loading } = useAsync(read, [id]);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const bond = useAsync(
    useCallback(
      () => (purchase === null ? Promise.resolve(0n) : disputeBondFor(purchase.price)),
      [purchase],
    ),
    [purchase?.price],
  );

  if (loading && purchase === null) {
    return (
      <div className="sheet">
        <Loading what={`offer #${id}`} />
      </div>
    );
  }

  if (error !== null || purchase === null) {
    return (
      <div className="sheet">
        <Notice tone="error">{error ?? `There is no purchase with the number ${id}.`}</Notice>
        <p className="mt-4">
          <Link href="/">Back to offers</Link>
        </p>
      </div>
    );
  }

  const p = purchase;
  const isBuyer = isSameAddress(account ?? undefined, p.buyer);
  const windowClosed =
    p.deliveredAt > 0n && BigInt(Math.floor(Date.now() / 1000)) > reviewDeadlineOf(p);

  if (p.stage !== STAGE.DELIVERED) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Open a dispute — promise #{id}</h1>
        </div>
        <Notice>
          {p.stage === STAGE.DISPUTED
            ? 'This purchase is already in dispute.'
            : p.stage === STAGE.SETTLED
              ? 'This purchase has already been settled.'
              : 'You can only dispute a purchase once the seller has marked it delivered.'}
        </Notice>
        <p className="mt-4">
          <Link href={p.stage === STAGE.DISPUTED ? `/case/${id}` : `/offers/${id}`}>
            {p.stage === STAGE.DISPUTED ? 'See the case file' : 'Back to the purchase'}
          </Link>
        </p>
      </div>
    );
  }

  if (windowClosed) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Open a dispute — promise #{id}</h1>
        </div>
        <Notice tone="error">
          The review window closed on {shortDate(reviewDeadlineOf(p))}. A dispute can no longer
          be opened — the payment releases to the seller.
        </Notice>
        <p className="mt-4">
          <Link href={`/offers/${id}`}>Back to the purchase</Link>
        </p>
      </div>
    );
  }

  if (account !== null && !isBuyer) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Open a dispute — promise #{id}</h1>
        </div>
        <Notice>Only the buyer on this purchase can open a dispute.</Notice>
        <p className="mt-4">
          <Link href={`/offers/${id}`}>Back to the purchase</Link>
        </p>
      </div>
    );
  }

  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelected(next);
  };

  const submit = async () => {
    setProblem(null);
    if (selected.size === 0) {
      setProblem('Tick at least one requirement — a dispute has to name something specific.');
      return;
    }
    if (notes.trim() === '') {
      setProblem('Add the evidence for the requirements you ticked.');
      return;
    }

    let owner = account;
    if (owner === null) owner = await connect();
    if (owner === null) return;

    setBusy(true);
    try {
      const required = bond.data ?? 0n;
      if (required > 0n) {
        const approval = await ensureAllowance(owner, required);
        if (approval !== null) await confirm(approval);
      }
      await confirm(
        await writeEscrow(owner, 'openDispute', [
          BigInt(id),
          selectionToBitmap(selected),
          notes,
        ]),
      );

      // The case page we are about to open reads once on mount, and the bond
      // has just moved. Without this wait, a buyer who disputes can land on a
      // case page still showing the review-window state — the exact stale read
      // this project hit on its first live run, where an inspection straight
      // after openDispute reported DELIVERED against a chain that already said
      // DISPUTED. The dispute HAS succeeded by this point, so the result is not
      // acted on; the case page's own poll is the backstop.
      await pollUntil(() => fetchPurchase(id), stageIs<{ stage: number }>(STAGE.DISPUTED));
      router.push(`/case/${id}`);
    } catch (e) {
      setProblem(describeError(e));
      setBusy(false);
    }
  };

  const bondAmount = bond.data ?? 0n;

  return (
    <div className="sheet">
      <div className="page-head">
        <h1>{DISPUTE_PROMPT}</h1>
        <p className="lede">
          Tick each requirement the delivery did not meet, then say what you have that shows it.
          The seller sees both, and so does whoever decides.
        </p>
        <p className="mt-2 text-[13px] text-ink-muted">
          Review window closes in{' '}
          <Countdown to={reviewDeadlineOf(p)} onExpired="closed" />
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <aside className="min-w-0">
          <DocCard>
            <DocHead title="What was promised" />
            <DocBody>
              <Verbatim text={p.promiseText} />
              <p className="mt-3 text-[13px] text-ink-muted">
                The seller&rsquo;s delivery notes are on{' '}
                <Link href={`/offers/${id}`}>the purchase page</Link>.
              </p>
            </DocBody>
          </DocCard>
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <DocCard>
            <DocHead
              title="Which requirements weren't met"
              aside={<span>{selected.size} ticked</span>}
            />
            <DocBody>
              <RequirementList rubric={p.rubric} selected={selected} onToggle={toggle} disabled={busy} />
            </DocBody>
          </DocCard>

          <DocCard>
            <DocHead
              title="What do you have that shows it?"
              aside={
                <span>
                  {notes.length} / {MAX_NOTES}
                </span>
              }
            />
            <DocBody>
              <p className="hint mb-2">
                Only about the requirements you ticked. Plain text — a link can change after the
                fact, so this box is the record.
              </p>
              <textarea
                className="textarea"
                rows={9}
                maxLength={MAX_NOTES}
                disabled={selected.size === 0}
                placeholder={
                  selected.size === 0
                    ? 'Tick a requirement above first.'
                    : 'Requirement 2: the video has no logo in the opening frame — here is a screenshot of the first second, and the timestamp is 00:00.'
                }
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </DocBody>
          </DocCard>

          <DocCard>
            <DocHead title="What this costs" />
            <DocBody className="flex flex-col gap-3">
              {problem !== null && <Notice tone="error">{problem}</Notice>}

              <div className="money-row border-b border-rule pb-3">
                <span className="text-[14px] text-ink-muted">Dispute bond</span>
                <span className="amount">{formatUsdc(bondAmount)}</span>
              </div>
              <p className="text-[13px] text-ink-muted">{BOND_RETURNED_NOTE}</p>
              <p className="text-[13px] text-ink-muted">
                The bond is charged on top of the {formatUsdc(p.price)} already in escrow. It does
                not change the price.
              </p>

              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || connecting || selected.size === 0 || notes.trim() === ''}
                onClick={() => void submit()}
              >
                {busy
                  ? 'Opening…'
                  : account === null
                    ? 'Connect and open the dispute'
                    : `Open the dispute — ${formatUsdc(bondAmount)} bond`}
              </button>

              <p className="hint">
                <Link href={`/offers/${id}`}>Cancel — back to the purchase</Link>
              </p>
            </DocBody>
          </DocCard>
        </div>
      </div>
    </div>
  );
}

function shortDate(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
