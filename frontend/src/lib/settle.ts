/**
 * Waiting for the chain to agree that something happened.
 *
 * WHY THIS EXISTS
 *
 * `confirm()` waits for a transaction receipt, which proves the transaction was
 * *mined*. It does not prove that the node answering the next read has seen it.
 * Base Sepolia's public RPC load-balances across replicas that do not agree on
 * recent state (MEMORY.md, *Base Sepolia's public RPC has lagging replicas*),
 * so a read issued moments after a write can be served by a node that is still
 * behind and return the state from before the user's own transaction.
 *
 * This was observed for real on this project's first end-to-end run: an
 * inspection read immediately after `openDispute` returned `DELIVERED`, and
 * only a re-read showed `DISPUTED`. On chain the transaction had succeeded the
 * whole time.
 *
 * WHY IT MATTERS MORE IN THE UI THAN ANYWHERE ELSE
 *
 * In the relayer a stale read costs a wasted tick. In a browser it costs the
 * user's trust: a buyer pays, the payment succeeds, and the page still offers
 * them the "Pay" button. The reasonable conclusion is that the app is broken,
 * and the reasonable next action is to pay again.
 *
 * HOW THE FIX WORKS
 *
 * After a write, the caller says what it just made true — "this purchase is now
 * FUNDED" — and `pollUntil` re-reads on a short loop until the chain agrees. The
 * predicate is always passed in, never inferred, because only the call site
 * knows what it asked the chain to do, and a wrong guess here would be worse
 * than no check at all: it would silently accept the stale state it exists to
 * catch.
 *
 * If the wait times out, the caller is told `false` and says so honestly. The
 * transaction did confirm — that was checked before this point — so claiming
 * failure would be wrong, and claiming success would be a guess.
 */

export interface SettleOptions {
  /** How long to keep trying. Default 60s — RPC lag is seconds, not minutes. */
  timeoutMs?: number;
  /** How often to re-read while waiting. Default 2s. */
  intervalMs?: number;
}

export const SETTLE_DEFAULT_TIMEOUT_MS = 60_000;
export const SETTLE_DEFAULT_INTERVAL_MS = 2_000;

/**
 * Re-read until `isSettled(value)` holds, or the timeout runs out.
 *
 * Returns `true` if the chain caught up, `false` if it did not. `onValue` is
 * called with every attempt so a caller can publish progress as it goes rather
 * than only at the end, and `shouldStop` lets a caller abandon the loop when
 * its component has gone away.
 *
 * A read that *throws* ends the loop and returns `false`: a transient RPC error
 * is not evidence that the state changed, and retrying into it is the caller's
 * decision, not this function's.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  isSettled: (value: T) => boolean,
  opts: SettleOptions & {
    onValue?: (value: T) => void;
    shouldStop?: () => boolean;
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? SETTLE_DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? SETTLE_DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let value: T;
    try {
      value = await read();
    } catch {
      return false;
    }

    if (opts.shouldStop?.() === true) return false;
    opts.onValue?.(value);
    if (isSettled(value)) return true;

    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
    if (opts.shouldStop?.() === true) return false;
  }
}

/**
 * The predicate for "this purchase has reached `stage`".
 *
 * Named once because every write in this app ends in exactly this shape, and a
 * stage number written at eight call sites is eight chances to typo one — which
 * would reintroduce the stale-read bug in the one place it is hardest to see,
 * because a wrong predicate still typechecks and still resolves.
 *
 * NULL-TOLERANT ON PURPOSE. `fetchPurchase` returns `Purchase | null` — a
 * purchase id that does not exist yet reads as null, not as an error — so a
 * predicate that only accepted `Purchase` could not be handed to `pollUntil`
 * without a cast. `null` is simply "not there yet", so it fails the predicate
 * and the poll keeps trying, which is exactly right for the one case where it
 * arises: polling for an offer the user just created.
 */
export function stageIs<T extends { stage: number }>(stage: number) {
  return (value: T | null): boolean => value !== null && value.stage === stage;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
