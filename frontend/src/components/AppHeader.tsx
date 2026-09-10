'use client';

/**
 * The masthead and wallet control.
 *
 * The header is deliberately thin. Design spec §4 puts the purchase first on
 * every screen, so the chrome that competes with it — a big product nav, a hero
 * banner, a chain selector — is not here. What is left is the product name, the
 * two things a visitor can do, and which account is connected.
 */

import Link from 'next/link';

import { useWallet } from '@/lib/wallet';
import { CHAIN, EXPLORER_URL } from '@/lib/chain';
import { shortAddress } from '@/lib/escrow';

export function AppHeader() {
  const { account, connect, connecting, error, hasWallet, chainOk, clearError } = useWallet();

  return (
    <header className="border-b border-rule bg-surface">
      <div className="sheet flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-3">
        <div className="flex items-baseline gap-6">
          <Link href="/" className="font-display text-lg font-semibold no-underline text-ink">
            Recourse
          </Link>
          <nav className="flex items-baseline gap-4 text-[13px]">
            <Link href="/" className="text-ink-muted no-underline hover:text-ink hover:underline">
              Offers
            </Link>
            <Link
              href="/offers/new"
              className="text-ink-muted no-underline hover:text-ink hover:underline"
            >
              Post a promise
            </Link>
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/*
            The chain is shown as a plain fact, not a dropdown. There is one
            chain and the contract is immutable; a selector would imply a choice
            the user does not have.
          */}
          <span className="status status-neutral" title={`Chain id ${CHAIN.id}`}>
            {CHAIN.name}
          </span>

          {!chainOk && account !== null && (
            <span className="status status-partial">Wrong network — reconnect</span>
          )}

          {account === null ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void connect()}
              disabled={connecting}
            >
              {connecting ? 'Connecting…' : hasWallet ? 'Connect wallet' : 'Install a wallet'}
            </button>
          ) : (
            <a
              href={`${EXPLORER_URL}/address/${account}`}
              target="_blank"
              rel="noreferrer"
              className="ident no-underline hover:underline"
              title={account}
            >
              {shortAddress(account)}
            </a>
          )}
        </div>
      </div>

      {error !== null && (
        <div className="sheet pb-3">
          <p className="flex items-start gap-2 text-[13px] text-refund">
            <span className="flex-1">{error}</span>
            <button type="button" onClick={clearError} className="underline">
              Dismiss
            </button>
          </p>
        </div>
      )}
    </header>
  );
}
