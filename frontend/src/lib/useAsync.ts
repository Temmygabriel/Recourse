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
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-read on demand, e.g. after a transaction confirms. */
  reload: () => void;
}

export function useAsync<T>(
  read: () => Promise<T>,
  deps: readonly unknown[],
  options: { pollMs?: number } = {},
): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // The reader closes over props and wallet state, so it changes on nearly
  // every render. Holding it in a ref keeps it out of the effect's dependency
  // list, where it would restart the poll on every render and never settle.
  const readRef = useRef(read);
  readRef.current = read;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

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

  return { data, error, loading, reload };
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
