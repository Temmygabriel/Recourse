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
 * That is what the notes box is for: the requirements are pinned beside it, and
 * one button seeds the numbering so the seller writes *to* the list. The seller
 * can then edit the whole thing freely — the seeded numbers are a starting
 * point, not a format the contract expects.
 *
 * THE LINK FIELD IS THE LOAD-BEARING ONE.
 *
 * An earlier version of this screen had no URL field, on the reasoning that
 * build spec §4.3 restricts evidence to hash-pinned content and a live URL can
 * serve different bytes to different validators — so the attack was closed by
 * giving the form nowhere to put a link. That reasoning was half right and the
 * conclusion was wrong. The attack is closed by *pinning the bytes*, not by
 * refusing to name them: the seller commits to a commit-pinned raw URL and the
 * sha256 of what it serves, so the evidence is immutable even though it lives
 * at a URL.
 *
 * What the old design could not do was survive contact with a seller who
 * describes work they did not do. Judging prose about a delivery is judging the
 * seller's ability to write prose. With a pinned artifact the court reads the
 * work itself, and a description that outruns its artifact is exactly what
 * `recourse_judgment.py` rule 8 exists to catch.
 *
 * The fingerprint is computed by fetching the URL — never by hashing a file the
 * seller picked. See the note at the top of `lib/evidence.ts` for why that
 * distinction costs an honest seller their fee when it is got wrong.
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

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
import {
  ArtifactGone,
  ArtifactUnreachable,
  fetchArtifact,
  sizeAdvice,
  urlProblem,
  type FetchedArtifact,
} from '@/lib/evidence';
import { confirm, fetchPurchase, isSameAddress, writeEscrow } from '@/lib/escrow';
import { EVIDENCE_ASK } from '@/lib/status';
import { pollUntil, stageIs } from '@/lib/settle';
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

  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProblem, setCheckProblem] = useState<{ tone: 'error' | 'neutral'; text: string } | null>(
    null,
  );

  // The checked artifact is stored WITH the URL it was fetched from, and the
  // fingerprint is used only while those two still agree. Editing the link
  // after checking therefore drops the fingerprint by construction rather than
  // by an effect that clears it — there is no arrangement of state in which a
  // seller can edit the URL and submit the previous link's digest, which would
  // be a delivery that fails its own digest check.
  const [checked, setChecked] = useState<{ url: string; artifact: FetchedArtifact } | null>(null);
  const artifact = checked !== null && checked.url === url.trim() ? checked.artifact : null;

  const linkProblem = useMemo(() => (url.trim() === '' ? null : urlProblem(url)), [url]);
  const advice = artifact === null ? null : sizeAdvice(artifact);

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

  const check = async () => {
    setCheckProblem(null);
    const bad = urlProblem(url);
    if (bad !== null) {
      setCheckProblem({ tone: 'error', text: bad });
      return;
    }
    setChecking(true);
    try {
      const fetched = await fetchArtifact(url.trim());
      setChecked({ url: url.trim(), artifact: fetched });
    } catch (e) {
      // The two failure kinds get different tones because they call for
      // different actions: a missing file is the seller's to fix, an
      // unreachable host is not, and telling them apart is the difference
      // between "check your link" and "try again in a minute".
      if (e instanceof ArtifactGone) {
        setCheckProblem({ tone: 'error', text: e.message });
      } else if (e instanceof ArtifactUnreachable) {
        setCheckProblem({ tone: 'neutral', text: e.message });
      } else {
        setCheckProblem({ tone: 'error', text: describeError(e) });
      }
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    setProblem(null);
    if (notes.trim() === '') {
      setProblem('Write what you delivered. A blank submission is not evidence.');
      return;
    }
    // Not merely a UI nicety: `artifact` is null unless the link on screen is
    // the one that was fetched, so this is the same check as "the digest below
    // is the digest of the link above".
    if (artifact === null) {
      setProblem('Check your link first — the delivery is committed to that fingerprint.');
      return;
    }
    if (advice?.tone === 'error') {
      setProblem(advice.text);
      return;
    }

    let owner = account;
    if (owner === null) owner = await connect();
    if (owner === null) return;

    setBusy(true);
    try {
      // The URL and the notes are sent exactly as typed — no trim, no reformat.
      // The escrow hashes the notes' bytes and validates the URL against its own
      // rule, and the judgment contract re-reads both, so quietly cleaning them
      // up here would mean committing to something the seller never wrote.
      // Whitespace in the notes is only *checked*, never stripped.
      //
      // The URL sent is `url.trim()`, which is the same string `artifact` was
      // derived from — the check above proved the two agree, so this is not a
      // second guess at which link was verified.
      await confirm(
        await writeEscrow(owner, 'submitDelivery', [
          BigInt(id),
          url.trim(),
          artifact.sha256,
          notes,
        ]),
      );

      // Wait for the chain to actually read back as DELIVERED before leaving.
      // The receipt proves the transaction was mined, not that the replica
      // answering the next read has caught up — and the page we are about to
      // land on reads once on mount. Navigating early means arriving at a page
      // that says this offer is still awaiting delivery, moments after the
      // seller delivered it.
      //
      // The result is deliberately not acted on. The delivery HAS succeeded —
      // the receipt proved that — so staying here and reporting a failure would
      // be wrong, and this page has nothing left to offer once it is done. The
      // destination polls every 15s, which is the backstop for the rare case
      // where even 60s of re-reading is not enough.
      await pollUntil(() => fetchPurchase(id), stageIs<{ stage: number }>(STAGE.DELIVERED));
      router.push(`/offers/${id}`);
    } catch (e) {
      setProblem(describeError(e));
      setBusy(false);
    }
  };

  const canSubmit = !busy && !connecting && !late && notes.trim() !== '' && artifact !== null;

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
          {/* --- The link ------------------------------------------------- */}
          <DocCard>
            <DocHead title="Where is it?" />
            <DocBody className="flex flex-col gap-3">
              <p className="hint">
                A link to the file itself on GitHub, pinned to one exact commit. The court
                opens this link and reads the file, so it has to be the file — not a page
                describing it.
              </p>

              <input
                type="url"
                className="input"
                spellCheck={false}
                autoComplete="off"
                placeholder="https://raw.githubusercontent.com/you/repo/8f3c1d9…/report.md"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />

              {linkProblem !== null && <Notice tone="error">{linkProblem}</Notice>}
              {checkProblem !== null && <Notice tone={checkProblem.tone}>{checkProblem.text}</Notice>}
              {advice !== null && <Notice tone={advice.tone}>{advice.text}</Notice>}

              <p className="hint">
                Open the file on GitHub, click the commit it belongs to, then Raw, and copy
                the address. A link to a branch like <code>main</code> will be refused — it
                can be repointed after you deliver, and then the file the buyer paid for is
                not the file they would get.
              </p>

              <button
                type="button"
                className="btn btn-secondary"
                disabled={checking || url.trim() === '' || linkProblem !== null}
                onClick={() => void check()}
              >
                {checking ? 'Fetching and hashing…' : 'Check this link'}
              </button>

              {artifact !== null && (
                <div className="rounded border border-line bg-surface-2 p-3">
                  <p className="hint mb-1">
                    Checked. The file at that link hashes to:
                  </p>
                  <code className="block break-all font-mono text-xs text-ink">
                    {artifact.sha256}
                  </code>
                  <p className="hint mt-2">
                    {artifact.bytes.toLocaleString()} bytes. This fingerprint is written into
                    the contract when you submit, and the court re-checks it before reading
                    anything. If the file at that link ever changes, the delivery fails
                    immediately and the buyer is refunded in full — so do not edit or delete
                    it after submitting.
                  </p>
                </div>
              )}
            </DocBody>
          </DocCard>

          {/* --- The notes ------------------------------------------------ */}
          <DocCard>
            <DocHead
              title="Your description"
              aside={
                <span>
                  {notes.length} / {MAX_NOTES}
                </span>
              }
            />
            <DocBody>
              <p className="hint mb-2">
                Describe what you delivered, against each numbered requirement. The court
                reads this alongside the file — but the file is the evidence, and this is
                your account of it. Anything you claim here that the file does not show will
                not count.
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
                rows={10}
                maxLength={MAX_NOTES}
                placeholder={
                  '1. The report is attached as report.md and runs to twelve findings.\n\n' +
                  '2. Each finding names the element it applies to and the WCAG criterion…'
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
                Once submitted, the link, its fingerprint and these notes are locked. They
                cannot be edited, and the buyer sees them exactly as written above.
              </p>

              <button
                type="button"
                className="btn btn-primary"
                disabled={!canSubmit}
                onClick={() => void submit()}
              >
                {busy
                  ? 'Submitting…'
                  : account === null
                    ? 'Connect and submit delivery'
                    : 'Submit delivery'}
              </button>

              {artifact === null && notes.trim() !== '' && (
                <p className="hint">Check your link above before submitting.</p>
              )}

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
