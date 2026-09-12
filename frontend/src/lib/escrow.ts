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

import { ensureChain, ESCROW, publicClient, usdcAddress, walletClient } from './chain';
import type { Purchase } from './abi';
import { erc20Abi, escrowAbi } from './abi';

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

/**
 * The settlement record for one purchase, or null if it has not settled.
 *
 * `fromBlock: 0n` is deliberate. The escrow's deploy block would be a cheaper
 * start, but a stale or misconfigured deploy block silently hides settlements,
 * and on a testnet the extra range costs a slightly slower call and nothing
 * else.
 */
export async function fetchSettlement(id: number): Promise<Settlement | null> {
  try {
    const logs = await publicClient().getLogs({
      address: ESCROW.address,
      event: SETTLED_EVENT,
      args: { purchaseId: BigInt(id) },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    const log = logs[logs.length - 1];
    if (log === undefined) return null;
    const a = log.args;
    return {
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
 * A failure here is swallowed: it costs the list its colour coding and nothing
 * else, and the rows still render against a neutral bar. That is a better
 * outcome than taking the whole list down over a decoration.
 */
export async function fetchSettledOutcomes(): Promise<Map<number, number>> {
  const outcomes = new Map<number, number>();
  try {
    const logs = await publicClient().getLogs({
      address: ESCROW.address,
      event: SETTLED_EVENT,
      fromBlock: 0n,
      toBlock: 'latest',
    });
    for (const log of logs) {
      const id = log.args.purchaseId;
      const outcome = log.args.outcome;
      if (id === undefined || outcome === undefined) continue;
      outcomes.set(Number(id), Number(outcome));
    }
  } catch {
    // See above — this costs a colour, not the page.
  }
  return outcomes;
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

  await ensureChain();
  const wallet = walletClient(account);
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
  await ensureChain();

  const wallet = walletClient(account);
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
