'use client';

/**
 * Wallet state, as a React context.
 *
 * Small on purpose (MEMORY.md D8 — no wagmi, no connector framework). It holds
 * one address and the connect action, and re-reads the account when the wallet
 * reports a change. Nothing here signs anything; screens call `walletClient()`
 * from ./chain when they need to send a transaction.
 *
 * Connections are not persisted by this app. `eth_accounts` already returns the
 * account the wallet is willing to share without prompting, so on load the
 * context asks for that — which means a returning user is connected without a
 * modal, and a first-time visitor is not prompted until they click.
 *
 * WHAT IS PERSISTED, AND WHY IT HAS TO BE
 *
 * The *wallet*, not the connection. With two wallets installed there is no
 * correct default: `window.ethereum` is whichever extension loaded last, which
 * has nothing to do with which one the user is looking at. Picking for them is
 * the bug. So the app discovers what is there (./eip6963), and when it finds
 * more than one it asks — once — and remembers the answer by the wallet's
 * `rdns`, which unlike its `uuid` is stable across reloads.
 *
 * Remembering it matters for more than convenience. This app does not persist
 * connections either, so on a reload with no remembered wallet the picker would
 * come back every time — and a picker that reappears no matter what you chose
 * is worse than no picker, because the second visit the user is choosing a
 * wallet they already chose.
 *
 * THE ONE HONEST VALUE
 *
 * `chainOk` starts `true` and is corrected by an `eth_chainId` probe as soon as
 * a provider is bound. Leaving it at its initial value without probing would be
 * asserting something the app never asked about — the same mistake as rendering
 * a purchase stage the chain has not confirmed, which is the bug this codebase
 * spent a session fixing (see ./settle).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Address } from 'viem';

import {
  CHAIN_ID,
  connect as connectWallet,
  currentAccount,
  ensureChain,
  rememberProvider,
  WalletError,
} from './chain';
import { discoverWallets, legacyInjected, type Eip6963ProviderDetail } from './eip6963';

/** Keyed by `rdns` — stable across reloads, unlike the per-load `uuid`. */
const CHOSEN_KEY = 'recourse.wallet.rdns';

function readChosen(): string | null {
  try {
    return window.localStorage.getItem(CHOSEN_KEY);
  } catch {
    return null;
  }
}

function writeChosen(rdns: string): void {
  try {
    window.localStorage.setItem(CHOSEN_KEY, rdns);
  } catch {
    // Private mode, or storage blocked. The choice does not survive a reload
    // and the picker appears again; that is a small annoyance and not worth an
    // error the user cannot act on.
  }
}

interface WalletState {
  account: Address | null;
  /** True once discovery and the initial account probe have finished. */
  ready: boolean;
  connecting: boolean;
  error: string | null;
  /** False when there is no wallet at all in this browser. */
  hasWallet: boolean;
  /** Whether the connected wallet is on Base Sepolia. Probed, not assumed. */
  chainOk: boolean;
  /** Every EIP-6963 wallet found. Empty on a browser with none, or an old one. */
  wallets: Eip6963ProviderDetail[];
  /** True when the user must choose a wallet before anything can connect. */
  choosing: boolean;
  /** The wallet in use, by `rdns`. Null until one is discovered or chosen. */
  chosenRdns: string | null;
  /**
   * The name of the wallet in use, or null when it was never identified.
   *
   * Surfaced because with two wallets installed the first question about any
   * odd balance or address is "which wallet is this app even talking to", and
   * that should be answerable without opening the picker again.
   */
  walletName: string | null;
  connect: () => Promise<Address | null>;
  choose: (rdns: string) => void;
  cancelChoose: () => void;
  /** Move the wallet to Base Sepolia, prompting if it has never seen it. */
  switchNetwork: () => Promise<boolean>;
  clearError: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Eip6963ProviderDetail[]>([]);
  const [chosenRdns, setChosenRdns] = useState<string | null>(null);
  const [detected, setDetected] = useState(false);

  const [account, setAccount] = useState<Address | null>(null);
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chainOk, setChainOk] = useState(true);
  const [hasWallet, setHasWallet] = useState(false);
  const [choosing, setChoosing] = useState(false);

  // The connect that is waiting on a wallet choice.
  //
  // Screens call `connect()` and then use the address it returns — "connect,
  // then send the transaction". If the answer is "you have to pick a wallet
  // first", returning null would make every one of those call sites treat it as
  // a refusal and abandon the action the user was in the middle of. So the
  // promise is parked here and settled once the choice is made, and the caller
  // resumes as if nothing had interrupted it.
  const pendingChoice = useRef<{
    promise: Promise<Address | null>;
    resolve: (value: Address | null) => void;
  } | null>(null);

  // --- Discovery ----------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await discoverWallets();
      if (cancelled) return;
      setWallets(found);

      if (found.length > 0) {
        const remembered = readChosen();
        // A remembered wallet wins. Failing that, a browser with exactly one
        // wallet has no choice to offer, so there is nothing to ask about.
        const pick =
          found.find((w) => w.info.rdns === remembered) ??
          (found.length === 1 ? found[0] : undefined);
        if (pick !== undefined) setChosenRdns(pick.info.rdns);
      }
      setDetected(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const chosen = useMemo(
    () => wallets.find((w) => w.info.rdns === chosenRdns) ?? null,
    [wallets, chosenRdns],
  );

  // --- Binding to the active provider -------------------------------------

  useEffect(() => {
    // Discovery runs after mount, so binding before it finishes would bind to
    // nothing and briefly report `hasWallet: false` to a browser that has one.
    if (!detected) return;

    // Wallets were found and the user has not chosen between them. There is
    // nothing safe to bind to: `window.ethereum` holds whichever extension
    // loaded last, so reading an account through it would put an address in the
    // header from a wallet the user never picked. Wait for the choice — this is
    // the case the picker exists for.
    const choosePending = wallets.length > 0 && chosen === null;

    // The pre-6963 path, for a browser where discovery found nothing at all.
    // That is a browser with one old wallet in it, so there is no ambiguity to
    // resolve and `window.ethereum` is the only answer available.
    const legacy = choosePending ? null : legacyInjected();
    const active = choosePending ? null : (chosen?.provider ?? legacy);

    rememberProvider(active);
    setHasWallet(wallets.length > 0 || legacy !== null);

    if (active === null) {
      // Not an error. A visitor with no wallet, or one who has not chosen yet,
      // still reads every page — reads go through the public RPC, not the
      // wallet.
      setReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      const found = await currentAccount();
      if (cancelled) return;
      setAccount(found);

      // `chainOk` starts true and this probe is what makes that a fact rather
      // than an assumption. It cannot reject the whole binding: a wallet that
      // will not answer is not evidence of a wrong network.
      try {
        const id = (await active.request({ method: 'eth_chainId' })) as string;
        if (!cancelled) setChainOk(parseInt(id, 16) === CHAIN_ID);
      } catch {
        // Leave the last known answer alone.
      }
      if (!cancelled) setReady(true);
    })();

    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[] | undefined;
      setAccount((accounts?.[0] as Address | undefined) ?? null);
    };
    const onChain = (...args: never[]) => {
      const id = args[0] as unknown as string | undefined;
      setChainOk(id === undefined || parseInt(id, 16) === CHAIN_ID);
    };

    active.on?.('accountsChanged', onAccounts);
    active.on?.('chainChanged', onChain);

    return () => {
      cancelled = true;
      active.removeListener?.('accountsChanged', onAccounts);
      active.removeListener?.('chainChanged', onChain);
    };
  }, [detected, chosen, wallets.length]);

  // --- Actions ------------------------------------------------------------

  const doConnect = useCallback(async (): Promise<Address | null> => {
    setConnecting(true);
    setError(null);
    try {
      const found = await connectWallet();
      setAccount(found);
      return found;
    } catch (e) {
      setError(e instanceof WalletError ? e.message : 'Could not connect to the wallet.');
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  /**
   * One promise per outstanding choice, shared by every caller waiting on it.
   *
   * Shared rather than one each because a screen can call `connect()` twice
   * while the picker is open — the submit button is not disabled yet at that
   * point, so an impatient second click is entirely reachable. A promise per
   * call would leave the first one pending forever.
   */
  const choicePromise = useCallback((): Promise<Address | null> => {
    if (pendingChoice.current === null) {
      let resolve: (value: Address | null) => void = () => {};
      const promise = new Promise<Address | null>((r) => {
        resolve = r;
      });
      pendingChoice.current = { promise, resolve };
    }
    return pendingChoice.current.promise;
  }, []);

  const settleChoice = useCallback((value: Address | null) => {
    const pending = pendingChoice.current;
    pendingChoice.current = null;
    pending?.resolve(value);
  }, []);

  const connect = useCallback(async (): Promise<Address | null> => {
    // More than one wallet and no choice made yet: only the person at the
    // keyboard can say which. Guessing is the bug EIP-6963 exists to fix.
    if (chosen === null && wallets.length > 1) {
      setChoosing(true);
      return choicePromise();
    }
    return doConnect();
  }, [chosen, wallets.length, doConnect, choicePromise]);

  // Finishes the connect the user started, once the binding effect above has
  // pointed the app at the wallet they picked. Declared after that effect
  // deliberately: effects run in order, so `rememberProvider` has already run
  // by the time this fires and `doConnect` reaches the right wallet.
  useEffect(() => {
    if (chosen === null || pendingChoice.current === null) return;
    void doConnect().then(settleChoice);
  }, [chosen, doConnect, settleChoice]);

  const choose = useCallback((rdns: string) => {
    writeChosen(rdns);
    setChosenRdns(rdns);
    setChoosing(false);
  }, []);

  const cancelChoose = useCallback(() => {
    setChoosing(false);
    // Everyone waiting on the choice is told no. Cancelling is a decision, and
    // leaving the callers hanging would freeze whatever they were doing.
    settleChoice(null);
  }, [settleChoice]);

  const switchNetwork = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      await ensureChain();
      setChainOk(true);
      return true;
    } catch (e) {
      setError(e instanceof WalletError ? e.message : 'Could not switch the network.');
      return false;
    }
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      account,
      ready,
      connecting,
      error,
      hasWallet,
      chainOk,
      wallets,
      choosing,
      chosenRdns,
      walletName: chosen?.info.name ?? null,
      connect,
      choose,
      cancelChoose,
      switchNetwork,
      clearError: () => setError(null),
    }),
    [
      account,
      ready,
      connecting,
      error,
      hasWallet,
      chainOk,
      wallets,
      choosing,
      chosenRdns,
      chosen,
      connect,
      choose,
      cancelChoose,
      switchNetwork,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (ctx === null) {
    throw new Error('useWallet must be used inside <WalletProvider>.');
  }
  return ctx;
}
