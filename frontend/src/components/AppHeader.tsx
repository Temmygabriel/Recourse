'use client';

/**
 * The masthead and wallet control.
 *
 * The header is deliberately thin. Design spec §4 puts the purchase first on
 * every screen, so the chrome that competes with it — a big product nav, a hero
 * banner, a chain selector — is not here. What is left is the product name, the
 * two things a visitor can do, and which account is connected.
 *
 * THE ONE THING THAT IS NOT THIN: THE WRONG-NETWORK BANNER.
 *
 * The chain chip used to say "Wrong network — reconnect" and nothing else. That
 * was wrong twice. Reconnecting does not change the network — the wallet is on
 * whatever chain the user left it on, and `connect()` no longer switches (see
 * ./lib/chain for why) — so the hint sent people to do the one thing that could
 * not help. And it was a status with no action, on a state the user has to
 * leave before anything in the app will work.
 *
 * So it is a banner with a button. It appears only once a wallet is connected
 * and known to be elsewhere, which is a fact probed with `eth_chainId` rather
 * than assumed, and it names the network it wants.
 */

import Link from 'next/link';
import { useState } from 'react';

import { ShieldCheckIcon } from '@/components/Icon';
import { useWallet } from '@/lib/wallet';
import { CHAIN, EXPLORER_URL } from '@/lib/chain';
import { shortAddress } from '@/lib/escrow';

export function AppHeader() {
  const {
    account,
    connect,
    connecting,
    error,
    hasWallet,
    ready,
    chainOk,
    switchNetwork,
    walletName,
    clearError,
  } = useWallet();

  const [switching, setSwitching] = useState(false);

  const onSwitch = async () => {
    setSwitching(true);
    try {
      await switchNetwork();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <header className="border-b border-rule bg-surface">
      {/* One of the two security bands on the page — the frame, top and
          bottom. Not repeated inside cards. */}
      <div className="security-band" />
      <div className="sheet flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-3">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 font-display text-lg font-semibold no-underline text-ink"
          >
            {/* The recurring brand mark: a 24px shield in a 30px outlined ink
                circle. Icon.tsx fixes its own 20px width/height attributes
                (design direction §7), so the size is applied here via CSS
                rather than forked into a second variant of the icon. */}
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-ink [&>svg]:h-6 [&>svg]:w-6">
              <ShieldCheckIcon />
            </span>
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
          <span
            className={`status ${chainOk ? 'status-neutral' : 'status-contested'}`}
            title={`Chain id ${CHAIN.id}`}
          >
            {CHAIN.name}
          </span>

          {account === null ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void connect()}
              // Not before discovery has run. Until it has, the app does not
              // know how many wallets are installed, so it cannot know whether
              // to connect straight away or ask which one — and guessing is the
              // bug. The window is ~250ms.
              disabled={connecting || !ready}
            >
              {connecting
                ? 'Connecting…'
                : // Until discovery has run, `hasWallet` is not yet known to be
                  // false — it is merely not yet known. Saying "Install a
                  // wallet" during that window would be a claim the app has not
                  // checked, and would flash at users who have one.
                  ready && !hasWallet
                  ? 'Install a wallet'
                  : 'Connect wallet'}
            </button>
          ) : (
            // The wallet's name is in the tooltip rather than the row. With two
            // wallets installed, "which one is this app talking to" is the
            // first question about any surprising address or balance, and it
            // should be answerable without opening the picker again.
            <a
              href={`${EXPLORER_URL}/address/${account}`}
              target="_blank"
              rel="noreferrer"
              className="ident no-underline hover:underline"
              title={walletName === null ? account : `${walletName} — ${account}`}
            >
              {shortAddress(account)}
            </a>
          )}
        </div>
      </div>

      {!chainOk && account !== null && (
        <div className="sheet pb-3">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-contested">
            <span className="min-w-0 flex-1">
              Your wallet is on another network. Everything here settles on {CHAIN.name}, on
              chain id {CHAIN.id} — no transaction can be signed until the wallet is switched.
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={switching}
              onClick={() => void onSwitch()}
            >
              {switching ? 'Switching…' : `Switch to ${CHAIN.name}`}
            </button>
          </p>
        </div>
      )}

      {error !== null && (
        <div className="sheet pb-3">
          <p className="flex items-start gap-2 text-[13px] text-contested">
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
