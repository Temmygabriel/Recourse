'use client';

/**
 * A tiny async read hook.
 *
 * There is no data library here on purpose (MEMORY.md D8): three screens read
 * from a public RPC, none of them needs caching, deduplication, background
 * revalidation or optimistic updates, and a wrong guess about which of those
 * mattered would cost more than the whole hook.
 *
 * Two things it does do that a bare `useEffect` gets wrong:
 *
 *   - It ignores a result that arrives after the component moved on. Without
 *     that, clicking quickly between two offers can leave the slower fetch
 *     painting over the newer one.
 *   - It can re-poll. A purchase changes stage because *someone else* acted —
 *     the seller delivered, the relayer settled — so a static read goes stale
 *     while the page is open, and the wrong action buttons are then offered.
 *
 * AND ONE THING THE POLL DOES NOT FIX ON ITS OWN: `reloadUntil`.
 *
 * Base Sepolia's public RPC load-balances across replicas that do not agree on
 * recent state (MEMORY.md, *Base Sepolia's public RPC has lagging replicas*).
 * A read issued moments after a write lands can therefore be served by a node
 * that has not seen it yet and return the state from *before the user's own
 * transaction*. Waiting for the receipt does not help — the receipt proves the
 * transaction was mined, not that the node answering the next `eth_call` has
 * caught up with it.
 *
 * The symptom is specific and bad: a buyer pays, the transaction succeeds, and
 * the page still offers them the "Pay" button. They conclude the app is broken
 * and may pay twice. A 15-second poll eventually corrects it, but "eventually"
 * is not good enough for a screen the user is staring at right after spending
 * money.
 *
 * So after a write the page calls `reloadUntil` with a predicate describing
 * what it just made true — "this purchase is now FUNDED". That re-reads on a
 * fast loop until the chain agrees, and reports honestly if it never does.
 * The predicate is passed at the call site rather than inferred, because the
 * page is the only thing that knows what it asked the chain to do, and a wrong
 * guess here would be worse than no check at all.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { pollUntil, type SettleOptions } from './settle';

export interface AsyncResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /**
   * True while this page is waiting for the chain to reflect a write it just
   * made. Deliberately distinct from `loading`, which means "nothing to show
   * yet" — `settling` means "there is plenty to show, but it is about to
   * change and must not be acted on".
   */
  settling: boolean;
  /** Re-read once, on demand. */
  reload: () => void;
  /**
   * Re-read on a fast loop until `isSettled(data)` holds, or `timeoutMs` runs
   * out. Resolves `true` if the chain caught up, `false` if it did not.
   */
  reloadUntil: (isSettled: (value: T) => boolean, opts?: SettleOptions) => Promise<boolean>;
}

export type { SettleOptions };

export function useAsync<T>(
  read: () => Promise<T>,
  deps: readonly unknown[],
  options: { pollMs?: number } = {},
): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settling, setSettling] = useState(false);
  const [nonce, setNonce] = useState(0);

  // The reader closes over props and wallet state, so it changes on nearly
  // every render. Holding it in a ref keeps it out of the effect's dependency
  // list, where it would restart the poll on every render and never settle.
  const readRef = useRef(read);
  readRef.current = read;

  // `reloadUntil` can outlive the component — the user can navigate away while
  // a settlement is still being confirmed — and setting state after unmount
  // would warn. This is also what stops the loop.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const reloadUntil = useCallback(
    async (isSettled: (value: T) => boolean, opts: SettleOptions = {}): Promise<boolean> => {
      if (mountedRef.current) setSettling(true);
      try {
        return await pollUntil(readRef.current, isSettled, {
          ...opts,
          // Publish each attempt, so the page updates the instant the chain
          // catches up rather than only when this call returns.
          onValue: (value) => {
            if (!mountedRef.current) return;
            setData(value);
            setError(null);
          },
          shouldStop: () => !mountedRef.current,
        });
      } finally {
        if (mountedRef.current) setSettling(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const run = async () => {
      try {
        const value = await readRef.current();
        if (cancelled) return;
        setData(value);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    const pollMs = options.pollMs;
    if (pollMs !== undefined && pollMs > 0) {
      timer = setInterval(() => void run(), pollMs);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
    // `read` is deliberately absent — see the ref above. Its real inputs are
    // the caller's deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, options.pollMs, ...deps]);

  return { data, error, loading, settling, reload, reloadUntil };
}

/**
 * A readable message from whatever was thrown.
 *
 * viem throws objects with a `shortMessage` that is written for a user ("User
 * rejected the request") sitting next to a `details` field full of RPC noise.
 * Preferring `shortMessage` is the difference between a useful banner and a
 * wall of hex.
 */
export function describeError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e !== null && typeof e === 'object') {
    const o = e as { shortMessage?: unknown; message?: unknown };
    if (typeof o.shortMessage === 'string' && o.shortMessage.length > 0) return o.shortMessage;
    if (typeof o.message === 'string' && o.message.length > 0) return firstLine(o.message);
  }
  return 'Something went wrong reading from the chain.';
}

function firstLine(s: string): string {
  const line = s.split('\n')[0]?.trim() ?? s;
  return line.length > 240 ? `${line.slice(0, 237)}…` : line;
}
