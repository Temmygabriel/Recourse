/**
 * A whole logging library in forty lines, on purpose.
 *
 * The relayer runs as a long-lived process with no collector, so the log *is*
 * the observability story for the demo. What it therefore optimises for is one
 * line per event, always including the purchase it concerns, so a run can be
 * read back afterwards and every decision reconstructed. It never logs a secret,
 * which is why there is no generic "log this object" helper to misuse.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLevel(level: Level): void {
  threshold = ORDER[level];
}

export function isLevel(value: string): value is Level {
  return value in ORDER;
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), msg];
  if (ctx && Object.keys(ctx).length > 0) parts.push(JSON.stringify(ctx));
  const line = parts.join(' ');
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
};

/** Reduce a thrown value to something safe to put in a log line. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * A short, non-identifying reason extracted from a viem revert.
 *
 * viem wraps contract reverts in a fairly deep error chain and the useful part
 * — `"nonce used"`, `"promise mismatch"` — is the revert reason from the
 * contract's own `require`. Without this, every on-chain rejection logs as
 * "Execution reverted" and the rejection list in `settle()` becomes invisible
 * at exactly the moment it matters.
 */
export function revertReason(e: unknown): string {
  const seen = new Set<unknown>();
  let node: unknown = e;
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const rec = node as Record<string, unknown>;
    for (const key of ['shortMessage', 'reason', 'details', 'message']) {
      const v = rec[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    node = rec['cause'];
  }
  return errText(e);
}
