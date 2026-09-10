'use client';

/**
 * The document primitives: the shapes a form is made of.
 *
 * These exist so the same structure recurs across all eight screens without
 * being re-invented per page — a section header with a rule under it, a
 * label/value field, an exhibit, the stamp. The class names they apply live in
 * globals.css; these only carry the markup and the small amount of behaviour
 * (a countdown, a copy-to-clipboard) that markup alone cannot.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { EXPLORER_URL } from '@/lib/chain';
import { outcomeInfo } from '@/lib/status';

// --- Structure -------------------------------------------------------------

export function DocCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`doc-card ${className}`}>{children}</section>;
}

export function DocHead({
  title,
  aside,
}: {
  title: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="doc-head">
      <h2 className="doc-head-title">{title}</h2>
      {aside !== undefined && <div className="text-[13px] text-ink-muted">{aside}</div>}
    </div>
  );
}

export function DocBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`doc-body ${className}`}>{children}</div>;
}

/** A label/value row, as on a printed form. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{children}</span>
    </div>
  );
}

/** Verbatim text exactly as it was stored and hashed. Never reformatted. */
export function Verbatim({ text }: { text: string }) {
  return <div className="verbatim text-[14px]">{text}</div>;
}

// --- Identifiers -----------------------------------------------------------

/**
 * A transaction or contract link. Monospace is for genuine identifiers only —
 * this is the case the rule exists for.
 */
export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a
      href={`${EXPLORER_URL}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="ident no-underline hover:underline"
      title={hash}
    >
      {label ?? truncateHash(hash)}
    </a>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <a
      href={`${EXPLORER_URL}/address/${address}`}
      target="_blank"
      rel="noreferrer"
      className="ident no-underline hover:underline"
      title={address}
    >
      {label ?? truncateHash(address)}
    </a>
  );
}

function truncateHash(h: string): string {
  return h.length <= 18 ? h : `${h.slice(0, 10)}…${h.slice(-6)}`;
}

// --- The verdict mark ------------------------------------------------------

/**
 * The stamped disposition. One per screen, on the settlement screen, and it is
 * the only loud element in the app — see the note on `.stamp` in globals.css.
 */
export function Stamp({ outcome, size = 'md' }: { outcome: number; size?: 'md' | 'lg' }) {
  const info = outcomeInfo(outcome);
  return (
    <span
      className={`stamp stamp-${info.tone}`}
      style={size === 'lg' ? { fontSize: '1.35rem', paddingLeft: '1.75rem', paddingRight: '1.75rem' } : undefined}
      role="img"
      aria-label={info.label}
    >
      {info.stamp}
    </span>
  );
}

// --- Countdown -------------------------------------------------------------

/**
 * A procedural deadline, shown as a countdown.
 *
 * Design spec §5.4 asks for the Amazon/Etsy pattern — an explicit deadline, not
 * a vague "under review". So this renders the actual date alongside the
 * remaining time, and refreshes once a minute rather than every second: seconds
 * add urgency without adding information, and a deadline measured in hours does
 * not need them.
 *
 * Renders nothing until mounted, because the server has no idea what time it is
 * on the reader's clock and a mismatched first paint would flip visible text.
 */
export function Countdown({
  to,
  prefix,
  onExpired,
}: {
  to: bigint;
  prefix?: string;
  onExpired?: 'closed' | 'expired';
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (to === 0n) return null;
  const target = Number(to) * 1000;
  const date = new Date(target).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  if (now === null) {
    return <span className="text-ink-muted">{prefix ? `${prefix} ` : ''}{date}</span>;
  }

  const remaining = target - now;
  if (remaining <= 0) {
    return (
      <span className="text-ink-muted">
        {onExpired === 'expired' ? 'Expired' : 'Closed'} — {date}
      </span>
    );
  }

  return (
    <span>
      {prefix !== undefined && <span className="text-ink-muted">{prefix} </span>}
      <span className="font-medium">{humanDuration(remaining)}</span>
      <span className="text-ink-muted"> · {date}</span>
    </span>
  );
}

export function humanDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}, ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)} min`;
}

// --- Feedback --------------------------------------------------------------

export function Notice({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'error' | 'ok';
  children: ReactNode;
}) {
  const cls =
    tone === 'error'
      ? 'border-refund/40 bg-refund/[0.05] text-refund'
      : tone === 'ok'
        ? 'border-release/40 bg-release/[0.05] text-release'
        : 'border-rule bg-paper text-ink-muted';
  return (
    <p className={`rounded-card border px-3 py-2 text-[13px] ${cls}`} role="status">
      {children}
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="py-6 text-[13px] text-ink-muted">Loading {what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="doc-card px-5 py-10 text-center">
      <p className="text-[14px] text-ink-muted">{children}</p>
    </div>
  );
}

// --- Wallet gating ---------------------------------------------------------

/**
 * Shown in place of an action that needs a wallet.
 *
 * Separate from `Notice` because the fix is a specific button, not a message —
 * a disabled control with an explanation beside it is clearer than an enabled
 * one that fails on click.
 */
export function ConnectPrompt({ action, onConnect, connecting }: {
  action: string;
  onConnect: () => void;
  connecting: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-rule bg-paper px-3 py-3">
      <p className="flex-1 text-[13px] text-ink-muted">Connect a wallet to {action}.</p>
      <button type="button" className="btn btn-primary" onClick={onConnect} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
    </div>
  );
}
