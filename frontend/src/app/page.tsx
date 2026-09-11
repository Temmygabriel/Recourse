'use client';

/**
 * The front door: what the product is, what is on offer, and what is already in
 * progress.
 *
 * Design spec §8 says the offer list comes first because it is the screen that
 * explains the product in one glance — a promise, a price, and a deadline. The
 * split into two sections is the only organising idea: things you can still
 * buy, and things that are already moving. There is no search, no filter, no
 * sort control, because at demo scale the list is short enough to read.
 *
 * Above all of that sits the hero (design direction §6.1). It is the one pitch
 * in the app, and it earns its place only because a visitor at the front door
 * has no document to lead with yet. Its proof card is the part worth being
 * careful about: it renders a real settlement or it does not render at all.
 * There is no placeholder verdict and no sample number, because a fake one here
 * would be the most dishonest pixel in the product — the entire claim being
 * made is that this thing shows you what actually happened.
 *
 * Reads go through the public RPC, so a visitor with no wallet sees the whole
 * list. Creating an offer is the only thing behind a wallet.
 */

import Link from 'next/link';

import { PurchaseRow } from '@/components/PurchaseRow';
import { Empty, Loading, Notice, Stamp } from '@/components/Document';
import { CardIcon, PackageIcon, ShieldCheckIcon } from '@/components/Icon';
import { fetchAllPurchases, fetchSettlement, fetchSettledOutcomes } from '@/lib/escrow';
import { formatUsdc } from '@/lib/chain';
import { STAGE } from '@/lib/abi';
import { useAsync } from '@/lib/useAsync';

export default function HomePage() {
  const { data, error, loading } = useAsync(fetchAllPurchases, [], { pollMs: 20_000 });

  // One query for every settlement, so the list's stage bars can be coloured
  // without a round trip per row.
  const outcomes = useAsync(fetchSettledOutcomes, []);

  const rows = data ?? [];
  const open = rows.filter(({ purchase }) => purchase.stage === STAGE.OPEN);
  const rest = rows.filter(({ purchase }) => purchase.stage !== STAGE.OPEN);

  // The newest settled purchase, which is the one the proof card shows. The
  // list is already newest-first, so the first match is the most recent.
  const proofId =
    rows.find(({ purchase }) => purchase.stage === STAGE.SETTLED)?.id ?? null;

  // Hooks cannot be conditional, so the read is issued unconditionally and
  // resolves to null when there is nothing to prove yet.
  const proof = useAsync(
    () => (proofId === null ? Promise.resolve(null) : fetchSettlement(proofId)),
    [proofId],
  );

  const settlement = proof.data;

  return (
    <div className="sheet">
      <section className="hero">
        <h1>Buy from creators. Get refunded automatically if they don&rsquo;t deliver.</h1>
        <p className="hero-sub">
          Your payment waits in escrow on Base, not in the seller&rsquo;s wallet. If the work
          arrives and doesn&rsquo;t match what was promised, an independent check reads both and
          decides where the money goes.
        </p>

        <div className="steps">
          <div className="step">
            <span className="step-mark" aria-hidden="true">
              <CardIcon />
            </span>
            <div className="min-w-0">
              <p className="step-label">Pay into escrow</p>
              <p className="step-note">The seller can&rsquo;t touch it yet.</p>
            </div>
          </div>

          <div className="step">
            <span className="step-mark" aria-hidden="true">
              <PackageIcon />
            </span>
            <div className="min-w-0">
              <p className="step-label">They deliver</p>
              <p className="step-note">Marked delivered, with notes kept as evidence.</p>
            </div>
          </div>

          <div className="step">
            {/* The one coloured mark in the hero: the step where the money
                actually moves on its own. */}
            <span className="step-mark step-mark-done" aria-hidden="true">
              <ShieldCheckIcon />
            </span>
            <div className="min-w-0">
              <p className="step-label">Checked, then settled</p>
              <p className="step-note">Promise and delivery read together; escrow releases.</p>
            </div>
          </div>
        </div>

        {/*
          The proof card, and only when there is something real to show. A
          settled purchase is not automatically a happy one — a refund settles
          just as finally — so the stamp carries the actual verdict and the two
          figures are what each side actually received, not what they were owed.
        */}
        {proofId !== null && settlement !== null && (
          <div className="proof">
            <Stamp outcome={settlement.outcome} />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-ink-muted">
                Purchase <span className="font-mono">#{proofId}</span> settled on Base — buyer
                received{' '}
                <span className="proof-figure">{formatUsdc(settlement.buyerAmount)}</span>, seller
                received <span className="proof-figure">{formatUsdc(settlement.sellerAmount)}</span>
                .
              </p>
            </div>
            <Link href={`/offers/${proofId}`} className="text-[13px]">
              Read the case
            </Link>
          </div>
        )}
      </section>

      <div className="page-head">
        {/* An h2, not an h1: the hero above already carries the page's one
            top-level heading, and a second h1 here would make the outline claim
            there are two subjects on this screen. */}
        <h2>Promises, in writing</h2>
        <p className="lede">
          A seller writes down exactly what they will deliver and the requirements it has to
          meet. A buyer pays into escrow. If what arrives doesn&rsquo;t match what was promised,
          the buyer disputes the specific requirement, and the money moves on the finding.
        </p>
        <p className="mt-3">
          <Link href="/offers/new" className="btn btn-secondary no-underline">
            Post a promise
          </Link>
        </p>
      </div>

      {loading && data === null && <Loading what="offers" />}

      {error !== null && <Notice tone="error">Could not read from Base Sepolia: {error}</Notice>}

      {data !== null && rows.length === 0 && (
        <Empty>
          No promises have been posted yet. <Link href="/offers/new">Post the first one</Link>.
        </Empty>
      )}

      {open.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3">Open offers</h2>
          <div className="flex flex-col gap-3">
            {open.map(({ id, purchase }) => (
              <PurchaseRow
                key={id}
                id={id}
                purchase={purchase}
                outcome={outcomes.data?.get(id)}
              />
            ))}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h2 className="mb-3">In progress and closed</h2>
          <div className="flex flex-col gap-3">
            {rest.map(({ id, purchase }) => (
              <PurchaseRow
                key={id}
                id={id}
                purchase={purchase}
                outcome={outcomes.data?.get(id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
