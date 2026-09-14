/**
 * Committing to a delivered artifact, in the browser.
 *
 * The seller pastes a URL, this fetches it, hashes exactly what came back, and
 * shows the result before anything is signed. The escrow stores that digest
 * alongside the URL, and the judgment contract later re-fetches and re-hashes —
 * so what the seller sees on this screen is precisely the claim they are making
 * about their own delivery.
 *
 * WHY THE FETCH HAPPENS HERE RATHER THAN HASHING A LOCAL FILE.
 *
 * The obvious cheaper design is a file picker that hashes the file on the
 * seller's disk. It is wrong, and wrong in a way that costs an honest seller
 * their whole fee. The contract's check is against the bytes the *host serves*,
 * and a local file can differ from its published form without anyone intending
 * it — a CRLF checkout on Windows, an editor that normalises Unicode, a
 * `.gitattributes` filter. Hashing the local copy commits the seller to a
 * digest the URL does not serve, which the judgment contract reads as a
 * tampered artifact and answers with a full refund. Fetching removes the
 * question: there is only ever one set of bytes under discussion.
 *
 * WHY THIS CAN WORK AT ALL. `raw.githubusercontent.com` serves
 * `Access-Control-Allow-Origin: *` on both 200 and 404 responses (verified
 * against the live host), so a browser can read the body of a cross-origin
 * fetch from it. Without that header this whole screen would need a server-side
 * proxy. It is the reason the evidence host is this one and not something else,
 * and it is worth re-checking if a second host is ever added.
 *
 * The URL rule below is the fourth copy in this project — the escrow, the
 * judgment contract, and the relayer hold the others. It is duplicated on
 * purpose: the seller gets told a link is unusable before they sign, rather
 * than the escrow reverting a gas-paying transaction. The authoritative copies
 * are on-chain and in the GenVM; this one only has to agree with them.
 */

/** The one host an evidence URL may point at. */
export const EVIDENCE_HOST_PREFIX = 'https://raw.githubusercontent.com/';

const COMMIT_HEX_LEN = 40;

/**
 * The contract's own limits, mirrored so the seller is warned before signing
 * rather than after their delivery is refused.
 *
 * Both are real and they bind at different points: `bytes` is a hard rejection
 * (an abuse guard), while `chars` is where the judgment contract *truncates*
 * rather than rejects — a 20,000-character article is real work and refusing it
 * over a formatting limit would take the seller's fee for nothing. The warning
 * below says which is which, because "too long" meaning "refused" and "too
 * long" meaning "the court will read the first 16,000 characters" are very
 * different things to a seller deciding whether to submit.
 */
export const MAX_EVIDENCE_BYTES = 128 * 1024;
export const MAX_EVIDENCE_CHARS = 16_000;

/**
 * Why a URL is unusable, phrased for the person who typed it.
 *
 * Returns `null` when the URL is acceptable. Never throws: a bad link is an
 * ordinary state of this form, not an exception.
 */
export function urlProblem(url: string): string | null {
  const trimmed = url.trim();

  if (trimmed === '') return 'Paste the link to your delivered file.';

  if (/[?#]/.test(trimmed)) {
    return (
      'Remove the ? and # parts of the link. A URL carrying either can serve different ' +
      'bytes on different fetches, which would defeat the fingerprint — so the contract ' +
      'refuses it outright.'
    );
  }
  if (/[\t\n\r ]/.test(trimmed)) {
    return 'The link has a space or line break in it. It should be one unbroken URL.';
  }
  if (!trimmed.startsWith(EVIDENCE_HOST_PREFIX)) {
    return (
      `The link must start with ${EVIDENCE_HOST_PREFIX} — open the file on GitHub, click ` +
      `Raw, and copy the address bar. That is the only host the contract will fetch from.`
    );
  }

  let i = EVIDENCE_HOST_PREFIX.length;
  const ownerEnd = trimmed.indexOf('/', i);
  if (ownerEnd === -1 || ownerEnd === i) return 'The link is missing the repository owner.';
  i = ownerEnd + 1;

  const repoEnd = trimmed.indexOf('/', i);
  if (repoEnd === -1) return 'The link is missing the repository name.';
  if (repoEnd === i) return 'The link is missing the repository name.';
  i = repoEnd + 1;

  const ref = trimmed.slice(i, i + COMMIT_HEX_LEN);
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    return (
      'The link is not pinned to a commit. It must contain the full 40-character commit ' +
      'id — not a branch name like main, and not an abbreviated id. A branch can be ' +
      'repointed after you deliver, so the contract will not accept one. On GitHub, click ' +
      'the commit, then Browse files, then Raw, and copy that address.'
    );
  }
  if (trimmed[i + COMMIT_HEX_LEN] !== '/') {
    return 'The link needs a file path after the commit id.';
  }
  if (i + COMMIT_HEX_LEN + 1 >= trimmed.length) {
    return 'The link names a repository but no file. Copy the Raw link for the file itself.';
  }

  return null;
}

export interface FetchedArtifact {
  /** sha256 of exactly the bytes the host served, as 0x-prefixed hex. */
  readonly sha256: `0x${string}`;
  readonly bytes: number;
  /** Characters once decoded as UTF-8 — the number the judgment contract caps. */
  readonly chars: number;
}

/** A problem with the artifact itself: it is gone, or unusable. The seller must act. */
export class ArtifactGone extends Error {}

/** The host could not be reached. Nothing is wrong with the link; try again. */
export class ArtifactUnreachable extends Error {}

/**
 * Fetch the URL and hash exactly what comes back.
 *
 * The three-way split mirrors the judgment contract's, because the seller needs
 * the same distinctions the court will make: a link that is *wrong* is theirs
 * to fix, a host that is *down* is nobody's fault, and the two need different
 * words on screen. A `fetch` that throws is almost always the second kind
 * (offline, DNS, a CORS change) and is reported as retryable rather than as a
 * bad link.
 */
export async function fetchArtifact(url: string): Promise<FetchedArtifact> {
  let res: Response;
  try {
    // `redirect: 'error'` on purpose. `fetch` follows redirects by default, and
    // a redirect would mean the bytes came from somewhere other than the URL
    // being committed to — the digest would be a claim about content the seller
    // never pinned. Raw GitHub serves files directly, so any redirect here means
    // something is wrong with the link rather than that it is a normal hop.
    res = await fetch(url, { redirect: 'error', cache: 'no-store' });
  } catch (e) {
    throw new ArtifactUnreachable(
      'Could not reach the host. This is a network problem, not a problem with your ' +
        `link — check your connection and try again. (${describe(e)})`,
    );
  }

  if (res.status === 404 || res.status === 410) {
    throw new ArtifactGone(
      `The host answered ${res.status} — there is no file at that address. Check the link ` +
        `is the Raw URL for a commit that exists, and that the repository is public.`,
    );
  }
  if (!res.ok) {
    throw new ArtifactUnreachable(
      `The host answered ${res.status}. That is usually temporary — wait a moment and ` +
        `try again.`,
    );
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) {
    throw new ArtifactGone('The file at that link is empty, so there is nothing to deliver.');
  }

  // `crypto.subtle` is only defined in a secure context, which the deployed site
  // is (https) and so is localhost. If it is ever missing the failure should say
  // so rather than surfacing as `undefined is not an object`.
  if (globalThis.crypto?.subtle === undefined) {
    throw new ArtifactUnreachable(
      'This browser will not hash over an insecure connection. Open the site over https.',
    );
  }

  const digest = await crypto.subtle.digest('SHA-256', buf);
  const sha256 = `0x${[...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}` as `0x${string}`;

  // Decoded only to report the character count. `TextDecoder` with
  // `fatal: false` replaces invalid sequences rather than throwing, which is
  // right here: the contract rejects non-UTF-8 bytes as a fault and the seller
  // should hear about it *before* signing, but this function's job is to hash,
  // not to adjudicate. `chars` is advisory.
  const chars = new TextDecoder('utf-8', { fatal: false }).decode(buf).length;

  return { sha256, bytes: buf.byteLength, chars };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The advisory the seller sees about size, or `null` when there is nothing to
 * say. Deliberately separate from `fetchArtifact`: a size problem is not a
 * failure, and conflating the two would either block a submission the contract
 * would accept or stay silent about one it will refuse.
 *
 * `neutral` rather than a `warn` tone, because there is no `warn` tone — the
 * house rule is that `neutral` means "true and worth reading, not a failure",
 * which is exactly what a truncation notice is. Adding a fourth tone would mean
 * new classes in globals.css and a second convention for the same idea.
 */
export function sizeAdvice(
  a: FetchedArtifact,
): { tone: 'error' | 'neutral'; text: string } | null {
  if (a.bytes > MAX_EVIDENCE_BYTES) {
    return {
      tone: 'error',
      text:
        `That file is ${Math.round(a.bytes / 1024)} KB. The judgment contract refuses ` +
        `anything over ${MAX_EVIDENCE_BYTES / 1024} KB, so this delivery could not be ` +
        `adjudicated — and a delivery that cannot be judged is a full refund for the ` +
        `buyer. Deliver something smaller.`,
    };
  }
  if (a.chars > MAX_EVIDENCE_CHARS) {
    return {
      tone: 'neutral',
      text:
        `That file is ${a.chars.toLocaleString()} characters. The court reads the first ` +
        `${MAX_EVIDENCE_CHARS.toLocaleString()} and is told the rest was cut — it will not ` +
        `treat anything past that point as met. This is allowed, but anything you need ` +
        `counted should appear early.`,
    };
  }
  return null;
}
