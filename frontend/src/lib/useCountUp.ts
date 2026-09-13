'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Counts a USDC amount up to its target, for the handful of figures that are
 * the actual point of a screen — the settlement split on the verdict, the
 * receipt's two amounts, the proof card on the home page.
 *
 * Returns **base units as a bigint**, not a formatted string, so the caller
 * passes it straight to `formatUsdc` like any other amount. An earlier draft
 * returned a digit string, which forced a `BigInt()` parse at every call site
 * just to hand the value back to the formatter that was always going to run.
 *
 * Deliberately not applied to reference figures — the offer's price panel, the
 * dispute bond, anything in a list row. Those are numbers a reader is checking,
 * not a moment being revealed, and animating them is motion for its own sake.
 *
 * Re-triggers only when `target` changes. The verdict page polls every 20s and
 * returns the same settlement each time, so a count keyed to anything looser
 * would restart every tick and the figure would never settle.
 */
export function useCountUpUsdc(target: bigint, durationMs = 650): bigint {
  const [display, setDisplay] = useState(0n);
  const seen = useRef<bigint | null>(null);

  useEffect(() => {
    if (seen.current === target) return;
    seen.current = target;

    const start = performance.now();
    let raf: number;

    // Integer arithmetic end to end. The frame progress is turned into a
    // thousandth (0–1000) and applied as bigint, so no float ever touches a
    // token amount — the value is exact at p = 1 and monotonic in between.
    function step(now: number) {
      const p = Math.min((now - start) / durationMs, 1);
      setDisplay((target * BigInt(Math.round(p * 1000))) / 1000n);
      if (p < 1) raf = requestAnimationFrame(step);
    }

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return display;
}
