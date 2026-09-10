'use client';

/**
 * 5.1 — Offer creation (seller).
 *
 * The job of this screen is to get a promise specific enough that a dispute
 * later has something concrete to check. So the criteria are not a free-text
 * afterthought at the bottom of a form: they are numbered, individually sized,
 * and the copy says plainly that they are the only things a dispute can be
 * argued against.
 *
 * Every rule the contract enforces is enforced here first, with the same
 * numbers (2–4 criteria, 500 / 200 character limits, a review window between
 * one hour and thirty days). The contract is still the authority — this is so
 * the seller gets a sentence instead of a reverted transaction and a gas fee.
 *
 * WHERE EVIDENCE COMES FROM: the escrow stores evidence as text and hashes it
 * on chain (build spec §4.3), so there is no upload widget and no URL field
 * anywhere in this app. The seller's delivery notes and the buyer's dispute
 * notes are the evidence, and they are shown verbatim, because those exact
 * bytes are what the judgment is made against.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { DocBody, DocCard, DocHead, Notice } from '@/components/Document';
import { parseUsdc } from '@/lib/chain';
import { createOfferAndGetId } from '@/lib/escrow';
import { describeError } from '@/lib/useAsync';
import { useWallet } from '@/lib/wallet';

const MAX_PROMISE = 500;
const MAX_ITEM = 200;
const MIN_CRITERIA = 2;
const MAX_CRITERIA = 4;

/** The contract's own bounds, restated so the form can explain them. */
const MIN_REVIEW_SECONDS = 60 * 60;
const MAX_REVIEW_SECONDS = 30 * 24 * 60 * 60;

export default function NewOfferPage() {
  const router = useRouter();
  const { account, connect, connecting } = useWallet();

  const [price, setPrice] = useState('');
  const [deadline, setDeadline] = useState(defaultDeadline());
  const [reviewAmount, setReviewAmount] = useState('7');
  const [reviewUnit, setReviewUnit] = useState<'hours' | 'days'>('days');
  const [promise, setPromise] = useState('');
  const [rubric, setRubric] = useState<string[]>(['', '']);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reviewSeconds =
    (Number(reviewAmount) || 0) * (reviewUnit === 'days' ? 86_400 : 3_600);

  const filled = rubric.map((r) => r.trim()).filter((r) => r !== '');

  const problem = validate({
    price,
    deadline,
    reviewSeconds,
    promise,
    filled,
  });

  async function submit() {
    setError(null);

    // `connect()` resolves to the account it just authorised, but `account` in
    // this closure is the value from the render that produced the click — so
    // the returned address is used directly rather than re-read from state.
    let owner = account;
    if (owner === null) owner = await connect();
    if (owner === null) return;

    setBusy(true);
    try {
      const deadlineSeconds = BigInt(Math.floor(new Date(deadline).getTime() / 1000));
      const { id } = await createOfferAndGetId(owner, {
        price: parseUsdc(price),
        deliveryDeadline: deadlineSeconds,
        reviewWindow: BigInt(reviewSeconds),
        promiseText: promise.trim(),
        rubric: filled,
      });
      router.push(`/offers/${id}`);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <div className="sheet">
      <div className="page-head">
        <h1>Post a promise</h1>
        <p className="lede">
          Write down what you will deliver and the requirements it has to meet. Once a buyer
          pays, these are locked — a dispute can only ever be about the numbered requirements
          below, so they are worth getting right.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <DocCard>
          <DocHead title="The offer" />
          <DocBody>
            <div className="field">
              <label className="field-label" htmlFor="price">
                Price
              </label>
              <div className="field-value">
                <input
                  id="price"
                  className="input max-w-[12rem]"
                  inputMode="decimal"
                  placeholder="150.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
                <p className="hint mt-1">In USDC, on Base Sepolia.</p>
              </div>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="deadline">
                Deliver by
              </label>
              <div className="field-value">
                <input
                  id="deadline"
                  type="datetime-local"
                  className="input max-w-[18rem]"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
                <p className="hint mt-1">
                  After this passes, the buyer can take their money back without a dispute.
                </p>
              </div>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="review">
                Review window
              </label>
              <div className="field-value">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="review"
                    className="input max-w-[6rem]"
                    inputMode="numeric"
                    value={reviewAmount}
                    onChange={(e) => setReviewAmount(e.target.value)}
                  />
                  <select
                    className="select max-w-[8rem]"
                    value={reviewUnit}
                    onChange={(e) => setReviewUnit(e.target.value as 'hours' | 'days')}
                  >
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                </div>
                <p className="hint mt-1">
                  How long the buyer has to accept or dispute, starting when you mark the work
                  delivered. Between 1 hour and 30 days.
                </p>
              </div>
            </div>
          </DocBody>
        </DocCard>

        <DocCard>
          <DocHead
            title="The promise"
            aside={<span>{promise.length} / {MAX_PROMISE}</span>}
          />
          <DocBody>
            <p className="hint mb-2">
              One paragraph, in plain English, saying what the buyer gets. This is the text a
              dispute is read against — so describe the deliverable, not the process.
            </p>
            <textarea
              className="textarea"
              rows={5}
              maxLength={MAX_PROMISE}
              placeholder="I will write and record a 90-second explainer video about the buyer's product, delivered as an MP4 plus the source project file."
              value={promise}
              onChange={(e) => setPromise(e.target.value)}
            />
            {promise.trim() === '' && promise !== '' && (
              <p className="hint mt-1 text-refund">A promise of only spaces is not a promise.</p>
            )}
          </DocBody>
        </DocCard>

        <DocCard>
          <DocHead
            title="Requirements"
            aside={<span>{filled.length} of {MIN_CRITERIA}–{MAX_CRITERIA}</span>}
          />
          <DocBody>
            <p className="hint mb-3">
              These are the only things a dispute can be about. Each one should be something
              someone could look at the delivery and answer yes or no to.
            </p>

            <ol className="req-list">
              {rubric.map((item, i) => (
                <li key={i} className="req">
                  <span className="req-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <input
                      className="input"
                      maxLength={MAX_ITEM}
                      placeholder={
                        [
                          'Runs 85–95 seconds',
                          'Includes the buyer\'s logo in the opening frame',
                          'Delivered as MP4 plus the editable project file',
                          'No third-party music that needs a licence',
                        ][i] ?? 'A requirement the delivery must meet'
                      }
                      value={item}
                      onChange={(e) => {
                        const next = [...rubric];
                        next[i] = e.target.value;
                        setRubric(next);
                      }}
                    />
                    <p className="hint mt-1">
                      {item.length} / {MAX_ITEM}
                    </p>
                  </div>
                  {rubric.length > MIN_CRITERIA && (
                    <button
                      type="button"
                      className="btn btn-secondary self-start px-3 py-1 text-[13px]"
                      onClick={() => setRubric(rubric.filter((_, j) => j !== i))}
                      aria-label={`Remove requirement ${i + 1}`}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ol>

            {rubric.length < MAX_CRITERIA && (
              <button
                type="button"
                className="btn btn-secondary mt-3"
                onClick={() => setRubric([...rubric, ''])}
              >
                Add a requirement
              </button>
            )}
          </DocBody>
        </DocCard>

        <DocCard>
          <DocHead title="Check before posting" />
          <DocBody>
            <p className="mb-3 text-[13px] text-ink-muted">
              Posting costs nothing but gas. Nobody is charged until a buyer pays, and you can
              cancel the offer until then.
            </p>

            {error !== null && (
              <div className="mb-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}

            {problem !== null && <p className="hint mb-3">{problem}</p>}

            {account === null ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={connecting}
                onClick={() => void submit()}
              >
                {connecting ? 'Connecting…' : 'Connect a wallet to post'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || problem !== null}
                onClick={() => void submit()}
              >
                {busy ? 'Posting…' : 'Post this promise'}
              </button>
            )}

            <p className="hint mt-3">
              <Link href="/">Back to offers</Link>
            </p>
          </DocBody>
        </DocCard>
      </div>
    </div>
  );
}

// --- Validation ------------------------------------------------------------

function validate(args: {
  price: string;
  deadline: string;
  reviewSeconds: number;
  promise: string;
  filled: string[];
}): string | null {
  try {
    parseUsdc(args.price);
  } catch (e) {
    return describeError(e);
  }

  const when = new Date(args.deadline).getTime();
  if (Number.isNaN(when)) return 'Choose a delivery deadline.';
  if (when <= Date.now() + 60_000) {
    return 'The delivery deadline has to be in the future.';
  }

  if (args.reviewSeconds < MIN_REVIEW_SECONDS) {
    return 'The review window has to be at least 1 hour.';
  }
  if (args.reviewSeconds > MAX_REVIEW_SECONDS) {
    return 'The review window cannot be longer than 30 days.';
  }

  if (args.promise.trim() === '') return 'Write the promise.';
  if (args.promise.length > MAX_PROMISE) {
    return `The promise is ${args.promise.length} characters; the limit is ${MAX_PROMISE}.`;
  }

  if (args.filled.length < MIN_CRITERIA) {
    return `Write at least ${MIN_CRITERIA} requirements — a dispute needs something specific to check against.`;
  }
  if (args.filled.length > MAX_CRITERIA) {
    return `No more than ${MAX_CRITERIA} requirements.`;
  }
  for (const item of args.filled) {
    if (item.length > MAX_ITEM) {
      return `Each requirement is limited to ${MAX_ITEM} characters.`;
    }
  }

  return null;
}

/** A week out, formatted for a `datetime-local` input. */
function defaultDeadline(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
