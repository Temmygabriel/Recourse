'use client';

/**
 * The delivered artifact, as a document reference.
 *
 * Everywhere the app shows what a seller delivered, this is what it shows: the
 * link the escrow froze, the fingerprint the escrow froze with it, and a button
 * that re-fetches the link here in the reader's own browser and checks the two
 * still agree.
 *
 * WHY THE FINGERPRINT IS SHOWN AT ALL, rather than just a tidy "view file" link.
 * The digest is the actual claim being made. The URL is only where the bytes
 * were found; the digest is what they were. Displaying the link alone would
 * present a location as if it were a commitment, and anyone who repointed that
 * location later would look, to a reader of this page, like they had done
 * nothing at all. Shown together, the pair says the thing that is true: this
 * file, at this address, and if either changes, the other is a lie.
 *
 * WHY THERE IS A VERIFY BUTTON. Everything else in this app asks the reader to
 * take a hash on faith — the settlement receipt prints digests nobody can
 * recompute from the page. This one they can, and it is the single check the
 * whole evidence design rests on, so it would be perverse to hide it behind a
 * command line. The button is honest about what it proves: it confirms the file
 * at that link still hashes to what the seller committed to, which is exactly
 * the check the judgment contract runs. It does not tell the reader whether the
 * work is any good — that is the court's job, and the wording below says so.
 *
 * Clicking it is deliberately manual. Fetching third-party URLs on page load
 * would leak every reader's IP to raw.githubusercontent.com just for opening a
 * case file, and would spend a network round trip on a question most readers
 * are not asking.
 */

import { useState } from 'react';

import { EVIDENCE_HOST_PREFIX, fetchArtifact } from '@/lib/evidence';

type Verify =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'matches' }
  | { kind: 'differs'; found: string }
  | { kind: 'unreachable'; why: string };

export function ArtifactRef({
  url,
  hash,
  className = '',
}: {
  url: string;
  hash: string;
  className?: string;
}) {
  const [verify, setVerify] = useState<Verify>({ kind: 'idle' });

  if (url === '') {
    return (
      <p className={`text-[13px] text-ink-muted ${className}`}>
        No file was pinned to this delivery.
      </p>
    );
  }

  const check = async () => {
    setVerify({ kind: 'checking' });
    try {
      const found = await fetchArtifact(url);
      setVerify(
        found.sha256.toLowerCase() === hash.toLowerCase()
          ? { kind: 'matches' }
          : { kind: 'differs', found: found.sha256 },
      );
    } catch (e) {
      // Both failure classes land here, and neither is reported as a mismatch.
      // A host that is down, or a file that has been deleted, does not mean the
      // seller delivered something other than what they promised — it means
      // this check could not be run. Calling that "the file changed" would
      // accuse the seller of something the reader has no evidence for.
      setVerify({ kind: 'unreachable', why: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[12px] text-ink-muted">Delivered file</span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="ident no-underline hover:underline"
          title={url}
        >
          {artifactLabel(url)}
        </a>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[12px] text-ink-muted">Fingerprint</span>
        <code className="ident break-all" title={hash}>
          {hash}
        </code>
      </div>

      <p className="text-[12px] text-ink-muted">
        sha256 of the file at that address, committed when the seller delivered. The court
        re-checks it before reading anything, and refuses the delivery if it no longer
        matches.
      </p>

      {verify.kind === 'idle' && (
        <button type="button" className="btn btn-secondary self-start" onClick={() => void check()}>
          Check this file against the fingerprint
        </button>
      )}

      {verify.kind === 'checking' && (
        <p className="text-[13px] text-ink-muted" role="status">
          Fetching the file and hashing it…
        </p>
      )}

      {/*
        The three outcomes are worded as descriptions of this check, never as
        verdicts about the seller. "The file no longer matches" is a fact about
        a URL; it is not the same statement as "the seller lied", and this page
        is not the place that decides the second one.
      */}
      {verify.kind === 'matches' && (
        <p className="text-[13px] text-release" role="status">
          The file at that link still hashes to the committed fingerprint. This is the exact
          check the court runs.
        </p>
      )}

      {verify.kind === 'differs' && (
        <div className="flex flex-col gap-1" role="status">
          <p className="text-[13px] text-contested">
            The file at that link has changed since delivery. It now hashes to:
          </p>
          <code className="ident break-all">{verify.found}</code>
          <p className="text-[12px] text-ink-muted">
            That does not match what the seller committed to, so the court would treat this
            delivery as a fault and refund the buyer in full.
          </p>
        </div>
      )}

      {verify.kind === 'unreachable' && (
        <div className="flex flex-col gap-1" role="status">
          <p className="text-[13px] text-ink-muted">
            Could not run the check, so nothing is proved either way. The file may be fine —
            the host may just be unreachable from here.
          </p>
          <p className="text-[12px] text-ink-muted">{verify.why}</p>
          <button
            type="button"
            className="btn btn-secondary self-start"
            onClick={() => void check()}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * `owner/repo · path/to/file.md` — enough to recognise the file, without the
 * host and the commit id, which are shown elsewhere (the commit is inside the
 * fingerprint's story, and the host is always the same one).
 */
export function artifactLabel(url: string): string {
  const rest = url.startsWith(EVIDENCE_HOST_PREFIX)
    ? url.slice(EVIDENCE_HOST_PREFIX.length)
    : url;
  const parts = rest.split('/');
  if (parts.length < 4) return url;
  const path = parts.slice(3).join('/');
  return `${parts[0]}/${parts[1]} · ${path}`;
}
