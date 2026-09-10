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
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Address } from 'viem';

import { CHAIN_ID, connect as connectWallet, currentAccount, injected, WalletError } from './chain';

interface WalletState {
  account: Address | null;
  /** True once the initial `eth_accounts` probe has finished. */
  ready: boolean;
  connecting: boolean;
  error: string | null;
  /** False when there is no injected wallet at all. */
  hasWallet: boolean;
  chainOk: boolean;
  connect: () => Promise<Address | null>;
  clearError: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chainOk, setChainOk] = useState(true);
  const [hasWallet, setHasWallet] = useState(false);

  // Probe for an already-authorised account, and subscribe to wallet changes.
  useEffect(() => {
    const provider = injected();
    setHasWallet(provider !== null);
    if (provider === null) {
      setReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      const found = await currentAccount();
      if (cancelled) return;
      setAccount(found);
      setReady(true);
    })();

    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[] | undefined;
      setAccount(((accounts?.[0] as Address | undefined) ?? null) as Address | null);
    };
    const onChain = (...args: never[]) => {
      const id = args[0] as unknown as string | undefined;
      setChainOk(id === undefined || parseInt(id, 16) === CHAIN_ID);
    };

    provider.on?.('accountsChanged', onAccounts);
    provider.on?.('chainChanged', onChain);

    return () => {
      cancelled = true;
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, []);

  const connect = useCallback(async (): Promise<Address | null> => {
    setConnecting(true);
    setError(null);
    try {
      const found = await connectWallet();
      setAccount(found);
      setChainOk(true);
      return found;
    } catch (e) {
      setError(e instanceof WalletError ? e.message : 'Could not connect to the wallet.');
      return null;
    } finally {
      setConnecting(false);
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
      connect,
      clearError: () => setError(null),
    }),
    [account, ready, connecting, error, hasWallet, chainOk, connect],
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
