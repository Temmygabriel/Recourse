/**
 * Reads and writes against RecourseEscrow.
 *
 * READS GO THROUGH THE PUBLIC CLIENT, NOT THE WALLET. A visitor with no wallet
 * installed can still open an offer, follow a case and read a verdict — which
 * matters for a judge clicking a link, and for the demo video, where the person
 * recording is often not the person whose wallet is connected.
 *
 * THE VERDICT IS READ FROM BASE, NOT FROM GENLAYER. The escrow's `Settled` event
 * carries the outcome, the per-criterion bitmap and the exact money split, so
 * every number on the verdict and receipt screens comes from the chain that
 * actually moved the money. That is the right authority for "what was settled",
 * and it means the browser never needs the GenLayer SDK.
 *
 * Listing offers reads `purchaseCount` then each purchase, rather than indexing
 * events. It is N+1 calls, which is the wrong trade at scale and the right one
 * here: there is no indexer to run, no cursor to persist, and no way for the
 * list to disagree with the contract about what exists.
 */

import { decodeEventLog, parseAbiItem, type Address } from 'viem';

import {
  ensureAuthorized,
  ensureChain,
  ESCROW,
  publicClient,
  usdcAddress,
  walletClient,
} from './chain';
import type { Purchase } from './abi';
import { erc20Abi, escrowAbi, STAGE } from './abi';

// --- Reads -----------------------------------------------------------------

export async function purchaseCount(): Promise<number> {
  const n = (await publicClient().readContract({
    ...ESCROW,
    functionName: 'purchaseCount',
  })) as bigint;
  return Number(n);
}

export async function fetchPurchase(id: number): Promise<Purchase | null> {
  try {
    const raw = (await publicClient().readContract({
      ...ESCROW,
      functionName: 'getPurchase',
      args: [BigInt(id)],
    })) as unknown as Purchase;
    // A purchase that was never created decodes as an all-zero struct rather
    // than reverting, so the stage is what distinguishes "absent" from "empty".
    if (raw.seller === '0x0000000000000000000000000000000000000000') return null;
    return raw;
  } catch {
    return null;
  }
}

/** Every purchase that exists, newest first, each paired with its id. */
export async function fetchAllPurchases(): Promise<{ id: number; purchase: Purchase }[]> {
  const count = await purchaseCount();
  if (count === 0) return [];
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const purchases = await Promise.all(ids.map(fetchPurchase));
  // The id travels with the purchase rather than being inferred from position.
  // Inferring it would be wrong the moment a purchase fails to decode and drops
  // out of the array — every row after it would be labelled with its neighbour's
  // id, and the link would open the wrong case.
  //
  // The guard is `!== null`, not `!== undefined`: `fetchPurchase` returns null
  // both for a purchase that does not exist and for a read that failed, and it
  // never returns undefined. Testing for undefined would let every null through
  // — and because the type predicate would still claim `Purchase`, the compiler
  // would not object while the home list threw on the first failed read. That
  // is reachable: the public RPC is rate-limited and this fetches one purchase
  // per count, concurrently.
  return ids
    .map((id, i) => ({ id, purchase: purchases[i] }))
    .filter((r): r is { id: number; purchase: Purchase } => r.purchase !== null)
    .reverse();
}

export interface Settlement {
  outcome: number;
  refundBps: number;
  criteriaMetBitmap: number;
  buyerAmount: bigint;
  sellerAmount: bigint;
  bondToBuyer: bigint;
  bondToSeller: bigint;
  genlayerTxHash: `0x${string}`;
  decisionDigest: `0x${string}`;
  nonce: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

const SETTLED_EVENT = parseAbiItem(
  'event Settled(uint256 indexed purchaseId, uint8 outcome, uint16 refundBps, uint8 criteriaMetBitmap, uint256 buyerAmount, uint256 sellerAmount, uint256 bondToBuyer, uint256 bondToSeller, uint256 nonce, bytes32 genlayerTxHash, bytes32 decisionDigest)',
);

const DISPUTE_OPENED_EVENT = parseAbiItem(
  'event DisputeOpened(uint256 indexed purchaseId, address indexed buyer, uint8 disputedBitmap, bytes32 disputeHash, uint96 bond)',
);

/**
 * The escrow's deploy block, which is where the settlement scan starts.
 *
 * THIS IS LOAD-BEARING, AND IT USED TO BE `0n`. That looked safer — a wider
 * range cannot hide a settlement — but it silently broke every verdict on the
 * site, which is worse than the problem it avoided.
 *
 * `eth_getLogs` is capped by the node, and Base's public RPC caps it at a
 * 10,000-block range: ask for `0n..latest` and it answers with
 * *"eth_getLogs is limited to a 10,000 range"*. `fetchSettlement` catches
 * everything and returns null, so that error did not surface as an error — it
 * surfaced as "this purchase has not been through a dispute". Purchase 9, which
 * really is settled with a real partial refund, rendered as though no verdict
 * existed at all.
 *
 * So the range is now anchored at the escrow's own deploy block and walked in
 * windows the node will actually serve. The previous comment's worry — a stale
 * deploy block silently hiding settlements — is real, which is why the value is
 * an env var that ships beside `NEXT_PUBLIC_ESCROW_ADDRESS`: the two describe
 * one deployment and are changed together. `frontend/.env.example` says so, and
 * the deploy checklist in docs/DEPLOY.md repeats it.
 */
const LOG_RANGE_BLOCKS = 10_000n;

const ESCROW_DEPLOY_BLOCK: bigint = (() => {
  const raw = process.env.NEXT_PUBLIC_ESCROW_DEPLOY_BLOCK?.trim();
  if (raw === undefined || raw === '') return 46_820_927n; // the deployed escrow
  const n = BigInt(raw);
  if (n < 0n) throw new Error(`NEXT_PUBLIC_ESCROW_DEPLOY_BLOCK is negative: ${raw}`);
  return n;
})();

/**
 * Every `[fromBlock, toBlock]` window covering the escrow's life, in the order
 * asked for.
 *
 * One copy, shared by every log read in this module. The boundary arithmetic is
 * the whole reason this module has a scar: ask for a range wider than the node
 * serves and the node refuses, and because these reads catch everything the
 * refusal arrives as *absence of data* rather than as an error. Two copies of
 * this loop that drifted apart would put that bug straight back.
 */
function logWindows(
  floor: bigint,
  latest: bigint,
  newestFirst: boolean,
): { fromBlock: bigint; toBlock: bigint }[] {
  const out: { fromBlock: bigint; toBlock: bigint }[] = [];
  if (newestFirst) {
    for (let end = latest; end >= floor; end -= LOG_RANGE_BLOCKS) {
      const start = end >= floor + LOG_RANGE_BLOCKS - 1n ? end - LOG_RANGE_BLOCKS + 1n : floor;
      out.push({ fromBlock: start, toBlock: end });
    }
    return out;
  }
  for (let start = floor; start <= latest; start += LOG_RANGE_BLOCKS) {
    const end = start + LOG_RANGE_BLOCKS - 1n;
    out.push({ fromBlock: start, toBlock: end > latest ? latest : end });
  }
  return out;
}

/**
 * The `Settled` logs for one purchase, searched from BOTH ends at once.
 *
 * The earlier version walked backwards from the tip and stopped at the first
 * window that hit. That is right for a dispute that settled minutes ago and
 * wrong for every older one, and the escrow only gets older: measured on
 * 2026-09-21, a settlement from five days earlier cost 22 windows and 8.1s
 * walking back from the tip, while the same settlement found from the deploy
 * block cost 5 windows and 1.5s.
 *
 * Neither direction wins on its own — walking forward is worst for a dispute
 * that settled just now, and walking back is worst for one that settled early —
 * and we cannot know which we are in without looking. So both walks advance one
 * window per round, in parallel, and the first to hit wins. That costs at most
 * two requests in flight (where a whole-history scan once cost thirty in
 * series), and time proportional to the *shorter* of the two distances rather
 * than to whichever one the old code happened to pick.
 *
 * A window that throws does not abort the search. `Promise.allSettled` is used
 * deliberately: a settlement is guaranteed to exist here (the caller checked
 * the stage first), so one refused window must cost a retry at the next poll,
 * not a confident "no verdict" — which is the exact failure this module exists
 * to stop repeating. The caller's `catch` still turns a total failure into
 * null.
 *
 * The window builder is a closure so its return type — which carries the
 * `Settled` event's decoded `args` — is inferred by viem rather than written
 * out by hand. A hand-written `ReturnType<…['getLogs']>` erases the event and
 * `log.args` stops existing.
 */
async function getSettledLogs(args: { purchaseId?: bigint }) {
  const client = publicClient();
  const latest = await client.getBlockNumber();
  const floor = ESCROW_DEPLOY_BLOCK > latest ? latest : ESCROW_DEPLOY_BLOCK;

  const window = (fromBlock: bigint, toBlock: bigint) =>
    client.getLogs({
      address: ESCROW.address,
      event: SETTLED_EVENT,
      ...(args.purchaseId === undefined ? {} : { args: { purchaseId: args.purchaseId } }),
      fromBlock,
      toBlock,
    });

  type Logs = Awaited<ReturnType<typeof window>>;

  const forward = logWindows(floor, latest, false);
  const backward = logWindows(floor, latest, true);
  const rounds = Math.max(forward.length, backward.length);

  for (let i = 0; i < rounds; i++) {
    const pending: Promise<Logs>[] = [];
    const f = forward[i];
    const b = backward[i];
    if (f !== undefined) pending.push(window(f.fromBlock, f.toBlock));
    if (b !== undefined) pending.push(window(b.fromBlock, b.toBlock));

    const settled = await Promise.allSettled(pending);
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.length > 0) return r.value;
    }
  }
  return [] as Logs;
}

/**
 * Settlements already found, so a poll never pays for the same answer twice.
 *
 * `settle()` runs at most once per purchase, so a settlement is immutable and
 * safe to hold for the life of the page. **Only hits are cached.** A miss is
 * not a fact about the world — it is either "not settled yet", which flips the
 * moment `settle()` mines, or "the RPC would not answer" — and pinning either
 * of those would leave a settled purchase reading as unjudged forever, which is
 * the precise failure this module was rewritten to stop repeating.
 *
 * Keyed by purchase id alone. That is sound because one build talks to exactly
 * one escrow: `NEXT_PUBLIC_ESCROW_ADDRESS` is inlined at build time, so a
 * redeploy is a new bundle with a new empty map.
 */
const settlementCache = new Map<number, Settlement>();

/**
 * The settlement record for one purchase, or null if it has not settled.
 *
 * ASK THE STAGE FIRST — this is the difference between a page that paints and a
 * page that looks broken. The escrow sets `stage = SETTLED` and emits `Settled`
 * in the same transaction, so `stage !== SETTLED` proves no such log exists and
 * the scan below can be skipped entirely. Without that check, a purchase that
 * has *not* settled is the worst case for the scan rather than the cheapest:
 * there is nothing to find, so it walks the escrow's entire history — 30
 * requests and 16.4 seconds when this was measured on 2026-09-21 — on every
 * load of a disputed case, which is exactly the screen a person stares at while
 * they wait. With the check it is zero log requests.
 *
 * `stage` is passed in by callers that already read the purchase, because every
 * current caller does. When it is omitted — or the purchase could not be read —
 * the stage is fetched here rather than assumed, since assuming "not settled"
 * is the one wrong answer that would hide a real verdict.
 */
export async function fetchSettlement(
  id: number,
  opts: { stage?: number } = {},
): Promise<Settlement | null> {
  const cached = settlementCache.get(id);
  if (cached !== undefined) return cached;

  try {
    const stage = opts.stage ?? (await fetchPurchase(id))?.stage;
    if (stage !== STAGE.SETTLED) return null;

    const logs = await getSettledLogs({ purchaseId: BigInt(id) });
    const log = logs[logs.length - 1];
    if (log === undefined) return null;
    const a = log.args;
    const settlement: Settlement = {
      outcome: Number(a.outcome),
      refundBps: Number(a.refundBps),
      criteriaMetBitmap: Number(a.criteriaMetBitmap),
      buyerAmount: a.buyerAmount ?? 0n,
      sellerAmount: a.sellerAmount ?? 0n,
      bondToBuyer: a.bondToBuyer ?? 0n,
      bondToSeller: a.bondToSeller ?? 0n,
      nonce: a.nonce ?? 0n,
      genlayerTxHash: a.genlayerTxHash ?? `0x${'0'.repeat(64)}`,
      decisionDigest: a.decisionDigest ?? `0x${'0'.repeat(64)}`,
      blockNumber: log.blockNumber ?? 0n,
      txHash: log.transactionHash ?? `0x${'0'.repeat(64)}`,
    };
    settlementCache.set(id, settlement);
    return settlement;
  } catch {
    return null;
  }
}

/**
 * How long a dispute has been open, as far as Base can prove it.
 *
 * `since` is a Unix timestamp; `exact` says whether it is the real opening time
 * or only an upper bound on it. See `fetchDisputeOpened`.
 */
export interface DisputeAge {
  /** Unix seconds. The dispute opened at this time, or at or before it. */
  since: number;
  /** True when `since` is the real opening block's timestamp. */
  exact: boolean;
}

/**
 * Only hits are cached, for the reason `settlementCache` gives: the value is a
 * fact about a block that has already been mined, so it cannot change, but a
 * miss can — a purchase that has no dispute today can be disputed tomorrow.
 */
const disputeCache = new Map<number, DisputeAge>();

/**
 * When the dispute on this purchase was opened, or null if it could not be read.
 *
 * ONE REQUEST ANSWERS IT IN BOTH DIRECTIONS, which is why a screen that has to
 * paint immediately can afford to ask. The waiting screen needs one bit — "has
 * this been pending unusually long?" — and the newest 10,000 blocks settle it
 * either way:
 *
 *   - the log is in that window: its block carries the timestamp, so the age is
 *     exact;
 *   - the log is not in it: the dispute opened before the window began, which
 *     *is* the answer, and the window's opening block turns it into a floor.
 *
 * 10,000 blocks is over five hours of Base, so the second case cannot be
 * confused with a fresh dispute. This deliberately is not the two-directional
 * walk `getSettledLogs` runs: that searches for a log whose position is unknown
 * anywhere in the escrow's life, while this one only ever has to look at the
 * recent end, and `purchaseId` is indexed so the node filters it server-side.
 *
 * A purchase can be disputed only once — `openDispute` requires
 * `stage == DELIVERED`, which a dispute leaves behind — so the first log in the
 * window is the only one.
 *
 * **Callers must already know a dispute exists** (`stage === DISPUTED`). The
 * absence branch is only meaningful as "the dispute is older than the window";
 * on an undisputed purchase it would report an ancient wait that is really just
 * a log that was never written.
 */
export async function fetchDisputeOpened(id: number): Promise<DisputeAge | null> {
  const cached = disputeCache.get(id);
  if (cached !== undefined) return cached;

  try {
    const client = publicClient();
    const latest = await client.getBlockNumber();
    const floor = ESCROW_DEPLOY_BLOCK > latest ? latest : ESCROW_DEPLOY_BLOCK;
    const fromBlock =
      latest >= floor + LOG_RANGE_BLOCKS - 1n ? latest - LOG_RANGE_BLOCKS + 1n : floor;

    const logs = await client.getLogs({
      address: ESCROW.address,
      event: DISPUTE_OPENED_EVENT,
      args: { purchaseId: BigInt(id) },
      fromBlock,
      toBlock: latest,
    });

    const log = logs[0];
    // The anchor is the log's own block when there is one, and the window's
    // opening block when there is not — in which case `exact` is false and the
    // timestamp is a "no later than" rather than a "was".
    const block = await client.getBlock({ blockNumber: log?.blockNumber ?? fromBlock });

    const age: DisputeAge = { since: Number(block.timestamp), exact: log !== undefined };
    disputeCache.set(id, age);
    return age;
  } catch {
    return null;
  }
}

/**
 * Every settled purchase's outcome, keyed by purchase id.
 *
 * Read as **one** log query rather than one per row. The list needs the outcome
 * only to colour a row's stage bar, and calling `fetchSettlement(id)` per
 * settled row would be N round trips against a rate-limited public RPC to
 * produce a single class name. `purchaseId` is an indexed topic on `Settled`,
 * so one unfiltered query returns every settlement and the map is built here.
 *
 * Where a purchase has more than one `Settled` log the last one wins, matching
 * `fetchSettlement`'s "latest log" rule — the two must agree, or the list and
 * the detail page would disagree about the same purchase.
 *
 * The scan is incremental. `Settled` is append-only, so once a block range has
 * been read it never needs reading again: the first call pays for the whole
 * span from the deploy block, and every poll after it asks only for the blocks
 * that arrived since. Without that, the 20-second poll would re-walk nine
 * windows forever against an RPC that is already rate-limited.
 *
 * A failure here is swallowed: it costs the list its colour coding and nothing
 * else, and the rows still render against a neutral bar. That is a better
 * outcome than taking the whole list down over a decoration.
 */
const outcomes = new Map<number, number>();
/** Highest block the cache above has been built through; -1n means "not yet". */
let outcomesScannedThrough = -1n;

export async function fetchSettledOutcomes(): Promise<Map<number, number>> {
  try {
    const client = publicClient();
    const latest = await client.getBlockNumber();
    const floor = ESCROW_DEPLOY_BLOCK > latest ? latest : ESCROW_DEPLOY_BLOCK;
    const start0 = outcomesScannedThrough < floor ? floor : outcomesScannedThrough + 1n;

    for (let start = start0; start <= latest; start += LOG_RANGE_BLOCKS) {
      const end = start + LOG_RANGE_BLOCKS - 1n;
      const logs = await client.getLogs({
        address: ESCROW.address,
        event: SETTLED_EVENT,
        fromBlock: start,
        toBlock: end > latest ? latest : end,
      });
      for (const log of logs) {
        const id = log.args.purchaseId;
        const outcome = log.args.outcome;
        if (id === undefined || outcome === undefined) continue;
        outcomes.set(Number(id), Number(outcome));
      }
      outcomesScannedThrough = end > latest ? latest : end;
    }
  } catch {
    // See above — this costs a colour, not the page. The cursor is deliberately
    // NOT advanced on a throw, so the blocks that failed are retried next poll
    // rather than being skipped over permanently.
  }
  return new Map(outcomes);
}

/** The dispute bond the contract would charge for this price. */
export async function disputeBondFor(price: bigint): Promise<bigint> {
  return (await publicClient().readContract({
    ...ESCROW,
    functionName: 'disputeBond',
    args: [price],
  })) as bigint;
}

/** The permanent per-purchase key the judgment contract is indexed by. */
export async function genlayerKeyFor(id: number): Promise<string> {
  try {
    return (await publicClient().readContract({
      ...ESCROW,
      functionName: 'genlayerKey',
      args: [BigInt(id)],
    })) as string;
  } catch {
    return '';
  }
}

export async function usdcBalance(account: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: await usdcAddress(),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })) as bigint;
}

export async function usdcAllowance(owner: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: await usdcAddress(),
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, ESCROW.address],
  })) as bigint;
}

// --- Writes ----------------------------------------------------------------

/**
 * Approve the escrow to pull `amount`, but only if it needs it.
 *
 * The escrow pulls USDC with `transferFrom`, so both paying and posting a
 * dispute bond need an allowance first. Re-approving when the existing allowance
 * already covers the amount would cost the user a second transaction and a
 * second confirmation prompt for nothing.
 *
 * The approval is for the exact amount, never an unlimited one. An unlimited
 * allowance would save a transaction on the user's *next* purchase and is what
 * most apps do, but it also hands the escrow a standing right to every USDC
 * that wallet will ever hold, and it is the pattern wallet security warnings
 * are aimed at.
 */
export async function ensureAllowance(
  account: Address,
  amount: bigint,
): Promise<`0x${string}` | null> {
  const existing = await usdcAllowance(account);
  if (existing >= amount) return null;

  // Authorisation first, then the network — see the note in `writeEscrow`.
  const from = await ensureAuthorized(account);
  await ensureChain();
  const wallet = walletClient(from);
  return wallet.writeContract({
    address: await usdcAddress(),
    abi: erc20Abi,
    functionName: 'approve',
    args: [ESCROW.address, amount],
  });
}

/** Send one escrow write and return its hash. */
export async function writeEscrow(
  account: Address,
  functionName:
    | 'createOffer'
    | 'cancelOffer'
    | 'purchase'
    | 'submitDelivery'
    | 'acceptDelivery'
    | 'openDispute'
    | 'claimReviewTimeout'
    | 'claimDeadlineRefund',
  args: readonly unknown[],
): Promise<`0x${string}`> {
  // The write path is where the network gets settled, rather than at connect.
  // See the note on `connect()` in ./chain: raising it here means it is raised
  // once, at a moment the user is already signing something and a network
  // prompt is self-explanatory, instead of twice in a row on the first click.
  //
  // It is idempotent and costs one `eth_chainId` round trip when already
  // correct, which is the common case.
  //
  // ORDER MATTERS: authorisation is confirmed before the network is switched,
  // not after. A wallet that has no permission for this site refuses
  // `wallet_switchEthereumChain` as readily as it refuses to sign — MetaMask
  // answers both with 4100, "The requested method and/or account has not been
  // authorized by the user" — so switching first means the failure lands on the
  // network call and the user is told their network is wrong when the real
  // problem is that the site was disconnected. Confirming first also gives the
  // switch an authorised origin to run on.
  const from = await ensureAuthorized(account);
  await ensureChain();

  const wallet = walletClient(from);
  // viem's per-function argument inference narrows `args` to the union of all
  // eight signatures, which it cannot check against a dynamic name. The ABI is
  // the source of truth and every call site is typed at the call, so this is the
  // one place a cast is honest rather than a way around the compiler.
  return wallet.writeContract({
    address: ESCROW.address,
    abi: ESCROW.abi,
    functionName,
    args,
  } as Parameters<typeof wallet.writeContract>[0]) as Promise<`0x${string}`>;
}

/** Wait for a transaction to be mined, then confirm it did not revert. */
export async function confirm(hash: `0x${string}`): Promise<void> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error('The transaction was mined but reverted. Nothing was charged.');
  }
}

// --- Creating an offer -----------------------------------------------------

const OFFER_CREATED = parseAbiItem(
  'event OfferCreated(uint256 indexed purchaseId, address indexed seller, uint96 price, uint64 deliveryDeadline, uint64 reviewWindow, bytes32 promiseHash, bytes32 rubricHash, uint8 criteriaCount)',
);

/**
 * Post an offer and return the id it was given.
 *
 * `createOffer` returns the new id, but a wallet write returns only a
 * transaction hash — the return value lives in the mined receipt's event. So
 * this decodes `OfferCreated` rather than guessing from `purchaseCount()`,
 * which would be wrong the moment two offers are created in the same block.
 *
 * The fallback exists because the offer is already on chain by the time we are
 * decoding: failing here would report an error for a successful transaction,
 * and the seller would post it twice.
 */
export async function createOfferAndGetId(
  account: Address,
  args: {
    price: bigint;
    deliveryDeadline: bigint;
    reviewWindow: bigint;
    promiseText: string;
    rubric: string[];
  },
): Promise<{ hash: `0x${string}`; id: number }> {
  const hash = await writeEscrow(account, 'createOffer', [
    args.price,
    args.deliveryDeadline,
    args.reviewWindow,
    args.promiseText,
    args.rubric,
  ]);

  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error('The offer was mined but reverted. Nothing was posted.');
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ESCROW.address.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: escrowAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'OfferCreated') {
        return { hash, id: Number((decoded.args as unknown as { purchaseId: bigint }).purchaseId) };
      }
    } catch {
      // Not one of the escrow's events; keep looking.
    }
  }

  return { hash, id: await purchaseCount() };
}

// --- Helpers ---------------------------------------------------------------

export function shortAddress(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function isSameAddress(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
