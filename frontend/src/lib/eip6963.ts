/**
 * EIP-6963: asking the browser which wallets are actually installed.
 *
 * THE PROBLEM
 *
 * Every wallet used to inject itself at `window.ethereum`, and only one of them
 * could win. When two are installed — MetaMask and Brave Wallet is the pairing
 * that bit this project — both write to the same property, the last script to
 * run takes it, and the app silently talks to whichever that was. The user sees
 * the address they have open in MetaMask, the app asks Brave Wallet for an
 * account, and the two disagree about who is connected, what the balance is,
 * and which network is selected. Depending on the pair it can also throw
 * straight out of `eth_requestAccounts` with "Already processing
 * eth_requestAccounts" — one wallet still holding the request the other is
 * trying to make.
 *
 * This is not a bug in any one wallet. It is what a single shared property
 * does, and it is why EIP-6963 exists.
 *
 * THE STANDARD
 *
 * Each wallet announces itself as a `{ info, provider }` pair on an
 * `eip6963:announceProvider` event. Nothing is overwritten: two wallets produce
 * two events and two distinct provider objects, both of which can be held at
 * once. The app dispatches `eip6963:requestProvider` to make every wallet
 * announce, and picks from the list.
 *
 * WHY IT ASKS RATHER THAN ONLY LISTENS
 *
 * Wallets announce once when they load. A Next.js page hydrates well after
 * that, so a listener attached on mount would hear nothing at all. Dispatching
 * the request is what makes the announcements arrive — the events are not
 * replayed for late listeners, they are re-emitted on demand.
 *
 * WHY THERE IS A TIMEOUT
 *
 * Announcements are separate events from separate scripts and there is no
 * "everyone has answered" signal. A short window is the only way to collect
 * them, and it has to end even if a wallet is slow: discovery runs behind the
 * wallet button, so a wallet that never answers must not hold the UI.
 *
 * WHAT THIS IS NOT
 *
 * Discovery finds what is installed. It does not decide what to use. A browser
 * with one wallet has no choice to make and should never be asked; a browser
 * with three has a real one, and only the person at the keyboard can make it.
 * That decision lives in ./wallet, not here.
 */

import type { Eip1193Provider } from './chain';

/** The three fields the EIP defines, plus the reverse-DNS id we key on. */
export interface Eip6963ProviderInfo {
  /** Unique per wallet *instance*, and regenerated on every page load. */
  uuid: string;
  /** Display name, e.g. "MetaMask" or "Brave Wallet". */
  name: string;
  /** A `data:` URI the wallet supplies for its own logo. */
  icon: string;
  /** Stable wallet identifier, e.g. `io.metamask`. This is what we remember. */
  rdns: string;
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

const ANNOUNCE_EVENT = 'eip6963:announceProvider';
const REQUEST_EVENT = 'eip6963:requestProvider';

/**
 * How long to collect announcements before answering.
 *
 * 250ms is deliberately short. Wallets that implement EIP-6963 answer
 * synchronously in response to the request — they are already loaded, since
 * they are extensions and content scripts — so the wait is on event dispatch,
 * not on I/O. A longer window would only make the connect button feel slow for
 * a wallet that is never going to answer.
 */
export const DISCOVERY_WINDOW_MS = 250;

/**
 * Every EIP-6963 wallet in this browser, or `[]` when there is nothing to find.
 *
 * Never throws and never rejects. A browser without EIP-6963 support, a
 * sandboxed iframe, or a server render all produce `[]`, and the caller falls
 * back to `window.ethereum` — the pre-6963 path, which is still correct for a
 * browser with exactly one old wallet in it.
 *
 * Duplicates are dropped by `uuid`. A wallet may announce more than once (once
 * on load, once in answer to the request) and the same provider must not appear
 * twice in the list the user is choosing from.
 */
export function discoverWallets(
  windowMs: number = DISCOVERY_WINDOW_MS,
): Promise<Eip6963ProviderDetail[]> {
  if (typeof window === 'undefined') return Promise.resolve([]);

  return new Promise((resolve) => {
    const found = new Map<string, Eip6963ProviderDetail>();

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      // Everything below is written by the wallet, not by us. A malformed or
      // hostile announcement must be skipped, not allowed to throw inside an
      // event handler where the error would be swallowed and the timeout would
      // then resolve with a corrupt entry in the list.
      if (detail === null || typeof detail !== 'object') return;
      const { info, provider } = detail;
      if (info === null || typeof info !== 'object') return;
      if (typeof info.uuid !== 'string' || typeof info.rdns !== 'string') return;
      if (typeof info.name !== 'string') return;
      if (provider === null || typeof provider !== 'object') return;
      if (typeof provider.request !== 'function') return;
      if (found.has(info.uuid)) return;
      found.set(info.uuid, detail);
    };

    window.addEventListener(ANNOUNCE_EVENT, onAnnounce);
    window.dispatchEvent(new Event(REQUEST_EVENT));

    setTimeout(() => {
      window.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
      resolve([...found.values()]);
    }, windowMs);
  });
}

/**
 * The pre-EIP-6963 fallback: whatever claimed `window.ethereum`.
 *
 * Only used when discovery found nothing. In a browser with two modern wallets
 * this is the ambiguous value that caused the bug in the first place, so it is
 * never consulted when the list is non-empty.
 */
export function legacyInjected(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}
