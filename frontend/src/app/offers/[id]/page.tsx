'use client';

/**
 * 5.2 Purchase / pay (buyer) — and 5.4, the review window, once the purchase
 * has moved on.
 *
 * One screen for both because they are the same document at two moments, and
 * design spec §4 puts the same five questions in the same order either way:
 * what was bought, what was promised, what happened, what is happening now,
 * and what happens to the money. Splitting them would mean writing the locked
 * promise — the thing the buyer is agreeing to — twice.
 *
 * THE PROMISE IS THE PRIMARY OBJECT HERE, NOT THE TRANSACTION. The price and
 * the pay button sit in a column beside the terms rather than above them, and
 * the criteria are rendered exactly as the seller wrote them, before any
 * button is pressed. That is the receipt the buyer is agreeing to.
 *
 * The actions offered depend on the stage and on who is looking. Every action
 * is gated by the same conditions the contract checks, so nobody is offered a
 * button that will revert: the seller alone sees "mark delivered", the buyer
 * alone sees "accept" and "something's wrong", and the time-based escape
 * hatches only appear once their deadline has actually passed.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { Address } from 'viem';

import {
  AddressLink,
  Countdown,
  DocBody,
  DocCard,
  DocHead,
  Field,
  Loading,
  Notice,
  Verbatim,
} from '@/components/Document';
import { RequirementList } from '@/components/RequirementList';
import { STAGE, type Purchase } from '@/lib/abi';
import {
  ESCROW_EXPLAINER,
  SETTLING_NOTE,
  SETTLE_TIMEOUT_NOTE,
  bitmapIndices,
  stageInfo,
  reviewDeadlineOf,
  requirementLabel,
} from '@/lib/status';
import {
  confirm,
  disputeBondFor,
  ensureAllowance,
  fetchPurchase,
  isSameAddress,
  usdcBalance,
  writeEscrow,
} from '@/lib/escrow';
import { formatUsdc } from '@/lib/chain';
import { stageIs } from '@/lib/settle';
import { describeError, useAsync } from '@/lib/useAsync';
import { useWallet } from '@/lib/wallet';

export default function OfferPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { account, connect, connecting } = useWallet();

  const read = useCallback(() => fetchPurchase(id), [id]);
  const { data: purchase, error, loading, settling, reloadUntil } = useAsync(read, [id], {
    pollMs: 15_000,
  });

  const bond = useAsync(
    useCallback(
      () => (purchase === null ? Promise.resolve(0n) : disputeBondFor(purchase.price)),
      [purchase],
    ),
    [purchase?.price],
  );

  const balance = useAsync(
    useCallback(
      () => (account === null ? Promise.resolve(null) : usdcBalance(account)),
      [account],
    ),
    [account],
  );

  if (loading && purchase === null) {
    return (
      <div className="sheet">
        <Loading what={`offer #${id}`} />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="sheet">
        <Notice tone="error">Could not read offer #{id}: {error}</Notice>
      </div>
    );
  }

  if (purchase === null) {
    return (
      <div className="sheet">
        <div className="page-head">
          <h1>Offer #{id}</h1>
        </div>
        <Notice>There is no purchase with that number.</Notice>
        <p className="mt-4">
          <Link href="/">Back to offers</Link>
        </p>
      </div>
    );
  }

  const isSeller = isSameAddress(account ?? undefined, purchase.seller);
  const isBuyer = isSameAddress(account ?? undefined, purchase.buyer);
  const info = stageInfo(purchase.stage);

  return (
    <div className="sheet">
      <div className="page-head">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1>Offer #{id}</h1>
          <span className={`status status-${info.tone}`}>{info.label}</span>
        </div>
        <p className="lede">{info.blurb}</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* --- The document ------------------------------------------------ */}
        <div className="flex min-w-0 flex-col gap-5">
          {/*
            The promise gets more room than anything else on the page (design
            direction §6.3). It is the object the buyer is agreeing to and the
            text a dispute is read against, so it is the one card here that is
            allowed to take up space — see the padding on the body below.
          */}
          <DocCard>
            <DocHead
              title="What was promised"
              aside={<span>{purchase.criteriaCount} requirements</span>}
            />
            <DocBody className="py-6 sm:px-7">
              <Verbatim text={purchase.promiseText} />

              <div className="mt-5">
                <RequirementList
                  rubric={purchase.rubric}
                  caption="A dispute can only be about these"
                />
              </div>
            </DocBody>
          </DocCard>

          {(purchase.deliveryNotes !== '' || purchase.disputeNotes !== '') && (
            <DocCard>
              <DocHead title="What happened" />
              <DocBody className="flex flex-col gap-4">
                {purchase.deliveryNotes !== '' && (
                  <div className="exhibit">
                    <div className="exhibit-head">
                      <span className="font-medium text-[13px]">
                        {isSeller ? 'Your delivery notes' : "The seller's delivery notes"}
                      </span>
                      {purchase.deliveredAt > 0n && (
                        <span className="text-[12px] text-ink-muted">
                          {new Date(Number(purchase.deliveredAt) * 1000).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <div className="exhibit-body">{purchase.deliveryNotes}</div>
                  </div>
                )}

                {purchase.disputeNotes !== '' && (
                  <div className="exhibit">
                    <div className="exhibit-head">
                      <span className="font-medium text-[13px]">
                        {isBuyer ? 'Your dispute' : "The buyer's dispute"}
                      </span>
                      <span className="text-[12px] text-ink-muted">
                        {disputedLine(purchase)}
                      </span>
                    </div>
                    <div className="exhibit-body">{purchase.disputeNotes}</div>
                  </div>
                )}
              </DocBody>
            </DocCard>
          )}

          {purchase.stage === STAGE.DISPUTED && (
            <div className="doc-card px-4 py-4 sm:px-5">
              <p className="text-[14px]">
                {purchase.disputeNotes === ''
                  ? 'A dispute is open on this purchase.'
                  : 'This purchase is in dispute.'}{' '}
                <Link href={`/case/${id}`}>See the promise beside the evidence &rarr;</Link>
              </p>
            </div>
          )}

          {purchase.stage === STAGE.SETTLED && (
            <div className="doc-card px-4 py-4 sm:px-5">
              <p className="text-[14px]">
                This purchase has been settled.{' '}
                <Link href={`/verdict/${id}`}>See the finding &rarr;</Link>
              </p>
            </div>
          )}
        </div>

        {/* --- The action column ------------------------------------------- */}
        <aside className="flex min-w-0 flex-col gap-4">
          <DocCard>
            <DocBody>
              <p className="stub-label">
                {purchase.stage === STAGE.OPEN
                  ? 'Asking price'
                  : purchase.stage === STAGE.SETTLED
                    ? 'Price paid'
                    : 'Held in escrow'}
              </p>
              <p className="amount mt-1">{formatUsdc(purchase.price)}</p>
              <div className="stub-rule" />
              <div className="mt-2">
                <Field label="Seller">
                  <AddressLink address={purchase.seller} />
                </Field>
                <Field label="Buyer">
                  {purchase.buyer === '0x0000000000000000000000000000000000000000' ? (
                    <span className="text-ink-muted">Not purchased yet</span>
                  ) : (
                    <AddressLink address={purchase.buyer} />
                  )}
                </Field>
                <Field label="Deliver by">
                  <Countdown to={purchase.deliveryDeadline} onExpired="expired" />
                </Field>
                {purchase.deliveredAt > 0n && (
                  <Field label="Review window">
                    <Countdown to={reviewDeadlineOf(purchase)} onExpired="closed" />
                  </Field>
                )}
              </div>
            </DocBody>
          </DocCard>

          <Actions
            id={id}
            purchase={purchase}
            isSeller={isSeller}
            isBuyer={isBuyer}
            account={account}
            balance={balance.data ?? null}
            bond={bond.data ?? 0n}
            connecting={connecting}
            onConnect={connect}
            reloadUntil={reloadUntil}
            settling={settling}
          />
        </aside>
      </div>
    </div>
  );
}

// --- Actions ---------------------------------------------------------------

/**
 * The shape of `Actions.run`, named so the two claim components below cannot
 * drift from it. When `run` grew its third argument, both of them had a
 * hand-written copy of the old signature and both would have kept compiling
 * while silently skipping the post-write stage check.
 */
type RunAction = (
  label: string,
  fn: (owner: Address) => Promise<void>,
  reached: (value: Purchase | null) => boolean,
) => Promise<void>;

function Actions({
  id,
  purchase,
  isSeller,
  isBuyer,
  account,
  balance,
  bond,
  connecting,
  onConnect,
  reloadUntil,
  settling,
}: {
  id: number;
  purchase: Purchase;
  isSeller: boolean;
  isBuyer: boolean;
  account: Address | null;
  balance: bigint | null;
  bond: bigint;
  connecting: boolean;
  onConnect: () => Promise<Address | null>;
  reloadUntil: (isSettled: (value: Purchase | null) => boolean) => Promise<boolean>;
  settling: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  /**
   * Run one action, then wait for the chain to agree that it happened.
   *
   * `reached` is the post-condition the action promises — the stage this
   * purchase should be in once it lands. It is required rather than optional:
   * every write on this page has one, and making it optional would let a new
   * action silently skip the check that stops the user being shown a stale
   * screen right after spending money.
   */
  const run = async (
    label: string,
    fn: (owner: Address) => Promise<void>,
    reached: (value: Purchase | null) => boolean,
  ) => {
    setError(null);
    setWarning(null);
    let owner = account;
    if (owner === null) owner = await onConnect();
    if (owner === null) return;

    setBusy(label);
    try {
      await fn(owner);
      // The receipt proves the transaction was mined; it does not prove the
      // node answering our next read has seen it. Wait for the state itself.
      const caughtUp = await reloadUntil(reached);
      if (!caughtUp) setWarning(SETTLE_TIMEOUT_NOTE);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const pay = () =>
    run(
      'pay',
      async (owner) => {
        // The escrow pulls the money with `transferFrom`, so the approval has to
        // be in place first. `ensureAllowance` is a no-op when it already is.
        const approval = await ensureAllowance(owner, purchase.price);
        if (approval !== null) await confirm(approval);
        await confirm(await writeEscrow(owner, 'purchase', [BigInt(id)]));
      },
      stageIs<Purchase>(STAGE.FUNDED),
    );

  const shortfall = balance !== null && balance < purchase.price;

  // The two timeout actions are gated on `block.timestamp`, which this cannot
  // read. The browser clock is a close enough stand-in to decide whether to
  // *offer* the button: if it is wrong by a few seconds the contract rejects
  // the call and the error is shown, and if it is wrong by more than that the
  // page is being read from a machine whose clock is broken, which is not a
  // failure mode worth designing around here.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deadlinePassed = nowSec > purchase.deliveryDeadline;
  const reviewClosed = purchase.deliveredAt > 0n && nowSec > reviewDeadlineOf(purchase);

  return (
    <DocCard>
      <DocHead title="What happens to the money" />
      <DocBody className="flex flex-col gap-3">
        {error !== null && <Notice tone="error">{error}</Notice>}

        {/* The write confirmed but the RPC had not caught up. Said plainly
            rather than left as a silent stale screen — see SETTLING_NOTE in
            status.ts for why this case exists at all. `neutral`, not `error`:
            the transaction succeeded, so colouring this red would tell the user
            their payment failed when it did not. Notice carries role="status",
            so a screen reader announces it without stealing focus. */}
        {settling && busy === null && <Notice tone="neutral">{SETTLING_NOTE}</Notice>}
        {warning !== null && <Notice tone="neutral">{warning}</Notice>}

        <p className="text-[13px] text-ink-muted">{ESCROW_EXPLAINER}</p>

        {purchase.stage === STAGE.OPEN && !isSeller && (
          <>
            {shortfall && (
              <Notice tone="error">
                This wallet holds {formatUsdc(balance ?? 0n)}. You need{' '}
                {formatUsdc(purchase.price)}.
              </Notice>
            )}
            {/*
              One button for both cases: `run` resolves the account itself, so
              "not connected" is a label change rather than a second code path
              that could drift from this one.
            */}
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null || connecting || shortfall}
              onClick={() => void pay()}
            >
              {busy === 'pay'
                ? 'Paying…'
                : account === null
                  ? 'Connect and pay'
                  : `Pay ${formatUsdc(purchase.price)}`}
            </button>
            <p className="hint">
              You will be asked to approve the token first, then to pay. Two confirmations.
            </p>
          </>
        )}

        {purchase.stage === STAGE.OPEN && isSeller && (
          <>
            <p className="text-[13px]">
              This is your offer. It is waiting for a buyer.
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  'cancel',
                  async (owner) => {
                    await confirm(await writeEscrow(owner, 'cancelOffer', [BigInt(id)]));
                  },
                  // cancelOffer sets the stage back to NONE (RecourseEscrow.sol
                  // :363), so the page must wait for the offer to disappear
                  // rather than re-offering the button.
                  stageIs<Purchase>(STAGE.NONE),
                )
              }
            >
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel this offer'}
            </button>
          </>
        )}

        {purchase.stage === STAGE.FUNDED && (
          <>
            <p className="text-[13px]">
              {formatUsdc(purchase.price)} is held by the escrow until the seller marks the
              work delivered and you accept it.
            </p>
            {isSeller && (
              <Link href={`/offers/${id}/deliver`} className="btn btn-primary no-underline">
                Mark as delivered
              </Link>
            )}
            {isBuyer && !deadlinePassed && (
              <p className="text-[13px] text-ink-muted">Waiting on the seller.</p>
            )}
            {isBuyer && (
              <ClaimDeadlineRefund id={id} run={run} busy={busy} ready={deadlinePassed} />
            )}
          </>
        )}

        {purchase.stage === STAGE.DELIVERED && (
          <>
            <p className="text-[13px]">
              The seller says the work is delivered. You have until the review window closes to
              accept it or dispute a specific requirement.
            </p>
            {isBuyer && (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      'accept',
                      async (owner) => {
                        await confirm(await writeEscrow(owner, 'acceptDelivery', [BigInt(id)]));
                      },
                      stageIs<Purchase>(STAGE.SETTLED),
                    )
                  }
                >
                  {busy === 'accept' ? 'Releasing…' : 'Accept — release the payment'}
                </button>
                <Link href={`/dispute/${id}`} className="btn btn-danger no-underline">
                  Something&rsquo;s wrong
                </Link>
              </>
            )}
            {isSeller && !reviewClosed && (
              <p className="text-[13px] text-ink-muted">
                Waiting on the buyer. If they do nothing, the payment releases to you when the
                review window closes.
              </p>
            )}
            {/*
              Permissionless in the contract, and offered to everyone here for
              the same reason: the money goes to the seller either way, so
              letting a passer-by unstick a purchase takes nothing from anyone
              and stops a vanished buyer from freezing the seller's money.
            */}
            <ClaimReviewTimeout id={id} run={run} busy={busy} ready={reviewClosed} />
          </>
        )}

        {purchase.stage === STAGE.DISPUTED && (
          <>
            <p className="text-[13px]">
              The dispute bond of {formatUsdc(bond)} was paid by the buyer and is held with the
              purchase.
            </p>
            <Link href={`/case/${id}`} className="btn btn-secondary no-underline">
              See the case file
            </Link>
          </>
        )}

        {purchase.stage === STAGE.SETTLED && (
          <Link href={`/receipt/${id}`} className="btn btn-secondary no-underline">
            See the settlement receipt
          </Link>
        )}

        {account === null && purchase.stage !== STAGE.OPEN && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={connecting}
            onClick={() => void onConnect()}
          >
            {connecting ? 'Connecting…' : 'Connect a wallet'}
          </button>
        )}
      </DocBody>
    </DocCard>
  );
}

/**
 * The two time-based escape hatches. Both are shown from the moment the stage
 * allows, disabled until their deadline has actually passed — a buyer who
 * cannot see the option at all will assume there isn't one.
 */

function ClaimDeadlineRefund({
  id,
  run,
  busy,
  ready,
}: {
  id: number;
  run: RunAction;
  busy: string | null;
  ready: boolean;
}) {
  return (
    <button
      type="button"
      className="btn btn-secondary"
      disabled={busy !== null || !ready}
      title={ready ? undefined : 'Available once the delivery deadline passes'}
      onClick={() =>
        void run(
          'refund',
          async (owner) => {
            await confirm(await writeEscrow(owner, 'claimDeadlineRefund', [BigInt(id)]));
          },
          stageIs<Purchase>(STAGE.SETTLED),
        )
      }
    >
      {busy === 'refund'
        ? 'Claiming…'
        : ready
          ? 'Take the money back — deadline passed'
          : 'Refund unlocks after the delivery deadline'}
    </button>
  );
}

function ClaimReviewTimeout({
  id,
  run,
  busy,
  ready,
}: {
  id: number;
  run: RunAction;
  busy: string | null;
  ready: boolean;
}) {
  return (
    <button
      type="button"
      className="btn btn-secondary"
      disabled={busy !== null || !ready}
      title={ready ? undefined : 'Available once the review window closes'}
      onClick={() =>
        void run(
          'timeout',
          async (owner) => {
            await confirm(await writeEscrow(owner, 'claimReviewTimeout', [BigInt(id)]));
          },
          stageIs<Purchase>(STAGE.SETTLED),
        )
      }
    >
      {busy === 'timeout'
        ? 'Releasing…'
        : ready
          ? 'Release the payment to the seller'
          : 'Release unlocks when the review window closes'}
    </button>
  );
}

// --- Small helpers ---------------------------------------------------------

function disputedLine(purchase: Purchase): string {
  const indices = bitmapIndices(purchase.disputedBitmap, purchase.criteriaCount);
  const labels = indices.map((i) => requirementLabel(i));
  if (labels.length === 0) return 'Disputed';
  if (labels.length === 1) return labels[0] ?? 'Disputed';
  return `${labels.length} requirements disputed`;
}
