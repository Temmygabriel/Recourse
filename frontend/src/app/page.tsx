'use client';

/**
 * The front door: what is on offer, and what is already in progress.
 *
 * Design spec §8 says the offer list comes first because it is the screen that
 * explains the product in one glance — a promise, a price, and a deadline. The
 * split into two sections is the only organising idea: things you can still
 * buy, and things that are already moving. There is no search, no filter, no
 * sort control, because at demo scale the list is short enough to read.
 *
 * Reads go through the public RPC, so a visitor with no wallet sees the whole
 * list. Creating an offer is the only thing behind a wallet.
 */

import Link from 'next/link';

import { PurchaseRow } from '@/components/PurchaseRow';
import { Empty, Loading, Notice } from '@/components/Document';
import { fetchAllPurchases } from '@/lib/escrow';
import { STAGE } from '@/lib/abi';
import { useAsync } from '@/lib/useAsync';

export default function HomePage() {
  const { data, error, loading } = useAsync(fetchAllPurchases, [], { pollMs: 20_000 });

  const rows = data ?? [];
  const open = rows.filter(({ purchase }) => purchase.stage === STAGE.OPEN);
  const rest = rows.filter(({ purchase }) => purchase.stage !== STAGE.OPEN);

  return (
    <div className="sheet">
      <div className="page-head">
        <h1>Promises, in writing</h1>
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
              <PurchaseRow key={id} id={id} purchase={purchase} />
            ))}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h2 className="mb-3">In progress and closed</h2>
          <div className="flex flex-col gap-3">
            {rest.map(({ id, purchase }) => (
              <PurchaseRow key={id} id={id} purchase={purchase} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
