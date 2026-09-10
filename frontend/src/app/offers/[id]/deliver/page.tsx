'use client';

/**
 * 5.3 — Delivery submission (seller).
 *
 * Design spec §5.3 asks for evidence attached to specific criteria rather than
 * a generic upload. The escrow stores one `deliveryNotes` string and hashes
 * those exact bytes, so there is no per-criterion field to write to — but the
 * judgment contract is handed the buyer's disputed criterion indices and reads
 * this text against them, so notes that answer the requirements one by one are
 * read far more reliably than a paragraph that mentions them in passing.
 *
 * That is what this screen is for: the requirements are pinned beside the box,
 * and one button seeds the numbering so the seller writes *to* the list. The
 * seller can then edit the whole thing freely — the seeded numbers are a
 * starting point, not a format the contract expects.
 *
 * No URL field and no file picker, deliberately. Build spec §4.3 restricts
 * evidence to hash-pinned content because a live URL can serve different bytes
 * to different validators, and that attack class is closed here by the form
 * simply not having anywhere to put one.
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
import { RequirementList } from '@/components/RequirementList';
import { STAGE, type Purchase } from '@/lib/abi';
import { formatUsdc } from '@/lib/chain';
import { confirm, fetchPurchase, isSameAddress, writeEscrow } from '@/lib/escrow';
import { EVIDENCE_ASK } from '@/lib/status';
import { describeError, useAsync } from '@/lib/useAsync';
import { useWallet } from '@/lib/wallet';

const MAX_NOTES = 2000;

export default function DeliverPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const router = useRouter();
  const { account, connect, connecting } = useWallet();

  const read = useCallback(() => fetchPurchase(id), [id]);
  const { data: purchase, error, loading } = useAsync(read, [id]);

  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
  const isSeller = isSameAddress(account ?? undefined, p.seller);
  const late = BigInt(Math.floor(Date.now() / 1000)) > p.deliveryDeadline;

  // --- States where the form is not the right thing to show ----------------

  if (p.stage !== STAGE.FUNDED) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Deliver — offer #{id}</h1>
        </div>
        <Notice>
          {p.stage === STAGE.OPEN
            ? 'Nobody has bought this offer yet, so there is nothing to deliver.'
            : `This purchase is already ${stageWord(p)}.`}
        </Notice>
        <div className="mt-5">
          <DocCard>
            <DocHead title="What you promised" />
            <DocBody>
              <Verbatim text={p.promiseText} />
            </DocBody>
          </DocCard>
        </div>
        <p className="mt-4">
          <Link href={`/offers/${id}`}>Back to the purchase</Link>
        </p>
      </div>
    );
  }

  // Connected as somebody other than the seller. Checked only once a wallet is
  // connected, so a visitor who has not connected yet still sees the form and
  // is asked for a wallet at the submit button instead.
  if (account !== null && !isSeller) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Deliver — offer #{id}</h1>
        </div>
        <Notice>Only the seller on this purchase can mark it delivered.</Notice>
        <p className="mt-4">
          <Link href={`/offers/${id}`}>Back to the purchase</Link>
        </p>
      </div>
    );
  }

  const submit = async () => {
    setProblem(null);
    if (notes.trim() === '') {
      setProblem('Write what you delivered. A blank submission is not evidence.');
      return;
    }

    let owner = account;
    if (owner === null) owner = await connect();
    if (owner === null) return;

    setBusy(true);
    try {
      // The text is sent exactly as typed — no trim, no reformat. The escrow
      // hashes these bytes and the judgment is made against them, so quietly
      // cleaning them up here would mean judging something the seller never
      // wrote. Whitespace is only *checked*, never stripped.
      await confirm(await writeEscrow(owner, 'submitDelivery', [BigInt(id), notes]));
      router.push(`/offers/${id}`);
    } catch (e) {
      setProblem(describeError(e));
      setBusy(false);
    }
  };

  return (
    <div className="sheet">
      <div className="page-head">
        <h1>What did you deliver?</h1>
        <p className="lede">{EVIDENCE_ASK}</p>
      </div>

      <div className="mb-5">
        {late ? (
          <Notice tone="error">
            The delivery deadline passed on {shortDate(p.deliveryDeadline)}. The contract no
            longer accepts a delivery on this purchase — the buyer can take their money back,
            and nothing written here can be submitted.
          </Notice>
        ) : (
          <Notice>
            Deadline: <Countdown to={p.deliveryDeadline} onExpired="expired" />
          </Notice>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-4">
          <DocCard>
            <DocHead title="What you promised" />
            <DocBody>
              <Verbatim text={p.promiseText} />
              <div className="mt-4">
                <RequirementList rubric={p.rubric} caption="Answer these one by one" />
              </div>
            </DocBody>
          </DocCard>

          <DocCard>
            <DocBody>
              <p className="hint">
                Payment held:{' '}
                <strong className="text-ink">{formatUsdc(p.price)}</strong>. It releases when
                the buyer accepts, or when the review window closes with no dispute.
              </p>
            </DocBody>
          </DocCard>
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <DocCard>
            <DocHead
              title="Your evidence"
              aside={
                <span>
                  {notes.length} / {MAX_NOTES}
                </span>
              }
            />
            <DocBody>
              <p className="hint mb-2">
                Describe what you actually delivered, against each numbered requirement. Say
                where the buyer can see each thing. Plain text only — a link can change after
                the fact, so this box is the record.
              </p>

              {p.rubric.length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary mb-3"
                  disabled={notes.trim() !== ''}
                  title={
                    notes.trim() === ''
                      ? undefined
                      : 'Clear the box first — this would replace what you have written'
                  }
                  onClick={() => setNotes(numberedSkeleton(p.rubric.length))}
                >
                  Number my notes to match the requirements
                </button>
              )}

              <textarea
                className="textarea"
                rows={14}
                maxLength={MAX_NOTES}
                placeholder={
                  '1. The video runs 92 seconds.\n\n' +
                  '2. Your logo appears in the opening frame…'
                }
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </DocBody>
          </DocCard>

          <DocCard>
            <DocBody className="flex flex-col gap-3">
              {problem !== null && <Notice tone="error">{problem}</Notice>}

              <p className="hint">
                Once submitted, these notes are hashed and locked. They cannot be edited, and
                the buyer sees them exactly as written above.
              </p>

              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || connecting || late || notes.trim() === ''}
                onClick={() => void submit()}
              >
                {busy
                  ? 'Submitting…'
                  : account === null
                    ? 'Connect and submit delivery'
                    : 'Submit delivery'}
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

/** `1.\n\n2.\n\n3.\n` — blank numbered slots, nothing pre-filled. */
function numberedSkeleton(count: number): string {
  return Array.from({ length: count }, (_, i) => `${i + 1}. `).join('\n\n');
}

function shortDate(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function stageWord(p: Purchase): string {
  switch (p.stage) {
    case STAGE.DELIVERED:
      return 'marked delivered';
    case STAGE.DISPUTED:
      return 'in dispute';
    case STAGE.SETTLED:
      return 'settled';
    default:
      return 'past the point where a delivery can be submitted';
  }
}
