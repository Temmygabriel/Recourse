'use client';

/**
 * Choosing which wallet to use, when the browser has more than one.
 *
 * This exists because there is no correct default. Every wallet used to inject
 * at `window.ethereum`; with two installed, that property holds whichever
 * extension loaded last, which has nothing to do with which one the user is
 * looking at. An app that just uses it will connect to Brave Wallet for
 * somebody who has MetaMask open — and the two will then disagree about the
 * account, the balance and the network for the rest of the session.
 *
 * So the app asks. Once: the answer is stored by `rdns` and the picker does not
 * come back (./wallet explains why that persistence is load-bearing rather than
 * a convenience).
 *
 * The list is deliberately plain — name, logo, one row each. Everything here is
 * written by the wallet, not by us, and a choice between two wallets is made on
 * the wallet's own identity, not on anything this app adds.
 */

import { useEffect } from 'react';

import { useWallet } from '@/lib/wallet';

/**
 * Whether an announcement's `icon` is something safe to hand to an `<img>`.
 *
 * The field is a free string from the wallet. Constraining it to `data:image/`
 * means a malformed or hostile announcement cannot turn this into a request to
 * a third-party host — which would leak the fact that this page is open, and
 * to whom. A wallet with no usable icon still gets a row; the name identifies
 * it, and the icon is decoration.
 */
function isImageDataUri(icon: unknown): icon is string {
  return typeof icon === 'string' && icon.startsWith('data:image/');
}

export function WalletPicker() {
  const { choosing, wallets, choose, cancelChoose } = useWallet();

  // Escape closes it. The picker can appear without the user having asked for a
  // modal specifically — they clicked Connect — so there has to be a way out
  // that is not "choose a wallet anyway".
  useEffect(() => {
    if (!choosing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelChoose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choosing, cancelChoose]);

  if (!choosing) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-picker-title"
      onClick={cancelChoose}
    >
      <div
        className="w-full max-w-sm rounded-card border border-rule bg-surface p-5"
        // The overlay closes on click; the card must not, or a stray click
        // while reading dismisses the thing the user just opened.
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="wallet-picker-title" className="font-display text-lg font-semibold text-ink">
          Which wallet?
        </h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          More than one wallet is installed in this browser, and there is no safe way to guess
          which you meant. Recourse will use the one you pick, and remember it.
        </p>

        <ul className="mt-4 flex list-none flex-col gap-2 p-0">
          {wallets.map((wallet) => (
            <li key={wallet.info.uuid}>
              <button
                type="button"
                className="btn btn-secondary w-full justify-start"
                onClick={() => choose(wallet.info.rdns)}
              >
                {isImageDataUri(wallet.info.icon) && (
                  // A data: URI, so next/image has nothing to optimise and
                  // would only add a loader. `alt=""` because the name is the
                  // very next thing in the row and the logo repeats it.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={wallet.info.icon}
                    alt=""
                    width={20}
                    height={20}
                    className="h-5 w-5 shrink-0 rounded-[4px]"
                  />
                )}
                <span className="truncate">{wallet.info.name}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-[13px]">
          <button type="button" className="text-ink-muted underline" onClick={cancelChoose}>
            Cancel
          </button>
        </p>
      </div>
    </div>
  );
}
