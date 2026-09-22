'use client';

/**
 * A disputed purchase that has no finding on Base yet.
 *
 * WHY THIS EXISTS. Every other screen in this app resolves in seconds, because
 * every other fact is already on Base. A dispute is the one state where the
 * answer genuinely does not exist yet — GenLayer's validators have to read the
 * frozen promise, the rubric and the delivered file, agree, and have that
 * agreement carried back to Base.
 *
 * The screen before this one said only "the case is still being decided", which
 * is true and useless. It could not be told apart from a broken page, it gave
 * no scale for the wait, and it never said the finding would arrive on its own.
 *
 * TWO STATES, ONE THRESHOLD. The wait has a normal shape and an abnormal one,
 * and until now the screen rendered both identically — which is how a reviewer
 * came to report a verdict "stuck far longer than the project's own docs
 * describe" and could not tell whether the pipeline was working. A case sitting
 * for four days behind a relayer that had been dead since the previous evening
 * looked exactly like a case that had been waiting ninety seconds. So past
 * `DISPUTE_LONG_WAIT_SECONDS` the copy changes to say the wait is unusual and
 * that nothing has been decided against either party in the meantime.
 *
 * THE COUNTER IS THE DISPUTE'S, NOT THE PAGE'S, where Base can prove it. The
 * age comes from the `DisputeOpened` log, which is the only place it exists —
 * the `Purchase` struct has no `disputedAt`, and `deliveredAt` is an upper
 * bound at best, since a delivery can sit for days before anyone disputes it.
 * The read is issued after mount and never blocks the first paint, so a slow or
 * failed lookup costs the page a line of copy and nothing else; when it fails
 * the screen falls back to counting its own watch, which is what it did before
 * and is still true, just weaker.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { DocBody, DocCard } from '@/components/Document';
import { fetchDisputeOpened, type DisputeAge } from '@/lib/escrow';
import {
  AWAITING_VERDICT_HEADLINE,
  AWAITING_VERDICT_LONG_HEADLINE,
  AWAITING_VERDICT_LONG_NEXT,
  AWAITING_VERDICT_LONG_NOTE,
  AWAITING_VERDICT_NOTE,
  AWAITING_VERDICT_POLLS,
  DISPUTE_LONG_WAIT_SECONDS,
  WHO_DECIDED_NOTE,
  bitmapIndices,
  requirementLabel,
} from '@/lib/status';

export function AwaitingVerdict({
  id,
  disputedBitmap,
  criteriaCount,
}: {
  id: number;
  /** Bit i set means requirement i is the one the buyer is disputing. */
  disputedBitmap: number;
  criteriaCount: number;
}) {
  // Drives the live counters. The page itself is a client component that stays
  // mounted while `useAsync` polls, so this interval is never restarted.
  const [seconds, setSeconds] = useState(0);

  // `null` covers both "not asked yet" and "could not be read" — the screen
  // behaves the same either way, and a third state would only add a branch that
  // renders identically.
  const [opened, setOpened] = useState<DisputeAge | null>(null);

  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let live = true;
    // Deliberately not awaited into the render path: this is a log read, and a
    // disputed case is the last screen that should wait on one. Two directions
    // of staleness are both fine — landing late upgrades the copy, and never
    // landing leaves the honest fallback below.
    fetchDisputeOpened(id).then((age) => {
      if (live) setOpened(age);
    });
    return () => {
      live = false;
    };
  }, [id]);

  const disputed = bitmapIndices(disputedBitmap, criteriaCount);

  // Re-derived each render, and the interval above forces one per second, so the
  // age ticks without a second timer. When `exact` is false `since` is a "no
  // later than", which can only *understate* the age — so a floor that has
  // already crossed the threshold is conclusive, and the wording below says
  // which of the two it is.
  const disputeSeconds = opened === null ? null : Math.max(0, Date.now() / 1000 - opened.since);
  const waitingLong = disputeSeconds !== null && disputeSeconds >= DISPUTE_LONG_WAIT_SECONDS;

  return (
    <DocCard>
      <DocBody>
        <div className="flex items-center gap-2">
          {/*
            `animate-pulse` is a Tailwind core utility, so it survives the
            build — unlike the interpolated `stamp-*` / `status-*` classes that
            had to be safelisted (see tailwind.config.ts). A dot that is
            visibly breathing is the whole point here: it is the one signal on
            this screen that separates "working" from "frozen".

            Amber once the wait is unusual, which is the one colour this palette
            reserves for a procedural waiting state. Both classes are written
            literally here so Tailwind's scanner finds them.
          */}
          <span
            className={`inline-block h-2 w-2 shrink-0 animate-pulse rounded-full ${
              waitingLong ? 'bg-pending' : 'bg-contested'
            }`}
          />
          <h2 className="font-display text-lg">
            {waitingLong ? AWAITING_VERDICT_LONG_HEADLINE : AWAITING_VERDICT_HEADLINE}
          </h2>
        </div>

        <p className="mt-3 text-[14px]">
          {waitingLong ? AWAITING_VERDICT_LONG_NOTE : AWAITING_VERDICT_NOTE}
        </p>

        {disputed.length > 0 && (
          <p className="mt-3 text-[13px] text-ink-muted">
            In dispute:{' '}
            {disputed.map((i) => requirementLabel(i)).join(', ')} of {criteriaCount}.
          </p>
        )}

        <p className="mt-3 text-[13px] text-ink-muted">
          {waitingLong ? AWAITING_VERDICT_LONG_NEXT : AWAITING_VERDICT_POLLS}
        </p>

        <div className="mt-4 border-t border-rule pt-3">
          <p className="text-[12px] text-ink-muted">
            {disputeSeconds === null
              ? `Watching for the finding on this page for ${formatElapsed(seconds)}.`
              : `This dispute has been open for ${
                  opened?.exact === false ? 'at least ' : ''
                }${formatElapsed(disputeSeconds)}.`}
          </p>
          <p className="mt-2 text-[12px] text-ink-muted">{WHO_DECIDED_NOTE}</p>
        </div>

        <p className="mt-4 flex flex-wrap gap-3">
          <Link href={`/case/${id}`} className="btn btn-secondary no-underline">
            See the promise beside the evidence &rarr;
          </Link>
        </p>
      </DocBody>
    </DocCard>
  );
}

/**
 * "38s", "4m 12s", "3h 07m", "4d 2h" — reads as a duration, not a clock time.
 *
 * Seconds drop out past the hour and minutes past the day because they stop
 * being information: nobody reading a four-day-old dispute is helped by knowing
 * it is four days and eleven seconds. Under an hour they stay, because the
 * common case is a wait of minutes and a figure that visibly moves is what
 * tells the reader the page is alive.
 */
function formatElapsed(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;

  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;

  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;

  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
