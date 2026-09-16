'use client';

/**
 * A disputed purchase that has no finding on Base yet.
 *
 * WHY THIS EXISTS. Every other screen in this app resolves in seconds, because
 * every other fact is already on Base. A dispute is the one state where the
 * answer genuinely does not exist yet — GenLayer's validators have to read the
 * frozen promise, the rubric and the delivered file, agree, and have that
 * agreement carried back to Base — and that takes minutes.
 *
 * The screen before this one said only "the case is still being decided", which
 * is true and useless. It could not be told apart from a broken page, it gave
 * no scale for the wait, and it never said the finding would arrive on its own.
 * So this renders the wait as a state the reader can read: who is deciding,
 * that the page is polling, and a live counter that proves the page is awake.
 *
 * THE COUNTER MEASURES THE PAGE, NOT THE DISPUTE, and the wording says so
 * ("on this page"). How long the case has actually been open is not in the
 * `Purchase` struct and is not readable from Base without scanning the
 * `DisputeOpened` log, so claiming it would be inventing a fact — the exact
 * thing this codebase refuses to do elsewhere. What it can honestly report is
 * that it has been watching for N seconds and has not seen a finding yet.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { DocBody, DocCard } from '@/components/Document';
import {
  AWAITING_VERDICT_HEADLINE,
  AWAITING_VERDICT_NOTE,
  AWAITING_VERDICT_POLLS,
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
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1_000);
    return () => clearInterval(t);
  }, []);

  const disputed = bitmapIndices(disputedBitmap, criteriaCount);

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
          */}
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-contested" />
          <h2 className="font-display text-lg">{AWAITING_VERDICT_HEADLINE}</h2>
        </div>

        <p className="mt-3 text-[14px]">{AWAITING_VERDICT_NOTE}</p>

        {disputed.length > 0 && (
          <p className="mt-3 text-[13px] text-ink-muted">
            In dispute:{' '}
            {disputed.map((i) => requirementLabel(i)).join(', ')} of {criteriaCount}.
          </p>
        )}

        <p className="mt-3 text-[13px] text-ink-muted">{AWAITING_VERDICT_POLLS}</p>

        <div className="mt-4 border-t border-rule pt-3">
          <p className="text-[12px] text-ink-muted">
            Watching for the finding on this page for {formatElapsed(seconds)}.
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

/** "4m 12s", "38s" — reads as a duration, not a clock time. */
function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}
