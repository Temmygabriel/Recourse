/**
 * Everything the relayer does to Base Sepolia.
 *
 * Three properties this file is built around:
 *
 * 1.  IT NEVER TRUSTS ITS OWN ARITHMETIC. Every hash it computes is compared
 *     against the escrow's own view function before it is used
 *     (`verifyCommitments`). That check is cheap, runs before any GenLayer fee
 *     is spent, and is the single thing standing between a one-byte encoding
 *     difference and a dispute that can never be judged.
 *
 * 2.  IT NEVER GUESSES WHAT THE ESCROW EXPECTS. `sourceChainId`,
 *     `sourceContract`, and the GenLayer key are all *read from the escrow*
 *     rather than configured. `sourceChainId` and `sourceContract` are
 *     immutable, so a compromised owner key cannot repoint them, and reading
 *     them removes an entire class of drift: the relayer physically cannot
 *     build a decision that fails checks 6 or 7. `genlayerKey()` is used for
 *     the same reason — the key format is defined by the contract that will
 *     verify the settlement, so deriving it a second time here would be
 *     inventing a second source of truth for no benefit.
 *
 * 3.  IT REPORTS REJECTIONS IN THE CONTRACT'S OWN WORDS. A revert reason from
 *     `settle()` ("nonce used", "promise mismatch") is extracted and logged,
 *     so the 16-item rejection list is legible at the moment it fires.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import { escrowAbi, STAGE } from './abi.ts';
import { evidenceRootHex, rubricHashHex, sha256Hex } from './hashes.ts';

export interface Purchase {
  readonly seller: Address;
  readonly buyer: Address;
  readonly price: bigint;
  readonly deliveryDeadline: bigint;
  readonly reviewWindow: bigint;
  readonly deliveredAt: bigint;
  readonly criteriaCount: number;
  readonly stage: number;
  readonly disputeBond: bigint;
  readonly disputedBitmap: number;
  readonly promiseText: string;
  readonly rubric: readonly string[];
  readonly deliveryNotes: string;
  readonly disputeNotes: string;
}

/** What the escrow itself says the commitments are. */
export interface ChainCommitments {
  readonly promiseHash: Hex;
  readonly rubricHash: Hex;
  readonly deliveryHash: Hex;
  readonly disputeHash: Hex;
  readonly evidenceRoot: Hex;
}

/** What the relayer computes they should be, having read the same text. */
export interface LocalCommitments {
  readonly promiseHash: Hex;
  readonly rubricHash: Hex;
  readonly deliveryHash: Hex;
  readonly disputeHash: Hex;
  readonly evidenceRoot: Hex;
}

export class EscrowMismatch extends Error {}

/**
 * Both chain clients, built once, with their types DERIVED rather than declared.
 *
 * Writing `PublicClient<Transport, Chain>` by hand is what broke this build. It
 * looked equivalent and was not: `baseSepolia` is an OP-stack chain, so
 * `createPublicClient({ chain: baseSepolia })` returns a client whose
 * `getBlock()` admits `type: "deposit"` transactions — a strictly different type
 * from the generic one. Assigning the specific to the generic is not allowed,
 * and tsc reported it as TS2719 "two different types with this name exist, but
 * they are unrelated", which reads like a duplicated dependency and is not.
 *
 * Deriving the type from the factory keeps the two identical by construction, so
 * this cannot drift again when viem changes what a chain-specific client looks
 * like. The alternative — casting at the boundary — would have silenced the
 * error while leaving the declared type a lie about what the client actually
 * returns.
 */
function buildClients(rpcUrl: string, account: PrivateKeyAccount) {
  const transport = http(rpcUrl, { retryCount: 3, timeout: 30_000 });
  return {
    publicClient: createPublicClient({ chain: baseSepolia, transport }),
    walletClient: createWalletClient({ account, chain: baseSepolia, transport }),
  };
}

type BuiltClients = ReturnType<typeof buildClients>;

export interface BaseContext {
  readonly publicClient: BuiltClients['publicClient'];
  readonly walletClient: BuiltClients['walletClient'];
  readonly account: PrivateKeyAccount;
  readonly escrow: Address;
}

export function createBaseContext(rpcUrl: string, escrow: Address, privateKey: `0x${string}`): BaseContext {
  const account = privateKeyToAccount(privateKey);
  return { account, escrow, ...buildClients(rpcUrl, account) };
}

/**
 * Fail fast if the address, the ABI, or the key is wrong.
 *
 * The `relayer()` check is the important one. It catches the two mistakes that
 * would otherwise surface as an opaque revert at the very end of a long,
 * fee-spending pipeline: pointing at the wrong escrow, and running with a key
 * that is not the escrow's relayer. Both are configuration errors and both are
 * detectable in one call.
 */
export async function preflight(ctx: BaseContext): Promise<{
  sourceChainId: bigint;
  sourceContract: Address;
  purchaseCount: number;
}> {
  const [relayer, sourceChainId, sourceContract, count] = await Promise.all([
    ctx.publicClient.readContract({
      address: ctx.escrow,
      abi: escrowAbi,
      functionName: 'relayer',
    }),
    ctx.publicClient.readContract({
      address: ctx.escrow,
      abi: escrowAbi,
      functionName: 'sourceChainId',
    }),
    ctx.publicClient.readContract({
      address: ctx.escrow,
      abi: escrowAbi,
      functionName: 'sourceContract',
    }),
    ctx.publicClient.readContract({
      address: ctx.escrow,
      abi: escrowAbi,
      functionName: 'purchaseCount',
    }),
  ]);

  if (relayer.toLowerCase() !== ctx.account.address.toLowerCase()) {
    throw new EscrowMismatch(
      `This escrow's relayer is ${relayer}, but the configured key signs as ` +
        `${ctx.account.address}. Every settlement would revert with "bad relayer ` +
        `signature" after the GenLayer fee was already spent.`,
    );
  }

  const purchaseCount = Number(count);
  if (purchaseCount < 0 || !Number.isSafeInteger(purchaseCount)) {
    throw new EscrowMismatch(`purchaseCount() returned a nonsensical value: ${count}`);
  }

  // Structural decode check: if the address points at something that merely
  // *has* these selectors (a proxy, a different build, a stale deployment), the
  // scalar getters above can still succeed while `getPurchase` decodes garbage.
  // Reading one real purchase is what confirms the struct layout matches.
  if (purchaseCount > 0) {
    const p = await getPurchase(ctx, 1);
    if (p.criteriaCount !== 0 && (p.criteriaCount < 2 || p.criteriaCount > 4)) {
      throw new EscrowMismatch(
        `getPurchase(1).criteriaCount is ${p.criteriaCount}, which the contract's own ` +
          `MIN_CRITERIA/MAX_CRITERIA rule forbids. The ABI in relayer/src/abi.ts does ` +
          `not match the deployed contract — refusing to relay against a misdecoded struct.`,
      );
    }
    if (p.stage < 0 || p.stage > STAGE.SETTLED) {
      throw new EscrowMismatch(
        `getPurchase(1).stage is ${p.stage}, outside the Stage enum. The ABI in ` +
          `relayer/src/abi.ts does not match the deployed contract.`,
      );
    }
  }

  return { sourceChainId, sourceContract, purchaseCount };
}

export async function getPurchase(ctx: BaseContext, id: number): Promise<Purchase> {
  const p = await ctx.publicClient.readContract({
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: 'getPurchase',
    args: [BigInt(id)],
  });
  // viem types `rubric` as a mutable array from the ABI; widen it to the
  // readonly form the rest of the relayer uses without copying.
  return { ...p, rubric: p.rubric as readonly string[] };
}

export async function genlayerKey(ctx: BaseContext, id: number): Promise<string> {
  return ctx.publicClient.readContract({
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: 'genlayerKey',
    args: [BigInt(id)],
  });
}

export async function chainCommitments(ctx: BaseContext, id: number): Promise<ChainCommitments> {
  const idArg = BigInt(id);
  const [promiseHash, rubricHash, deliveryHash, disputeHash, evidenceRoot] = await Promise.all([
    ctx.publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: 'promiseHash', args: [idArg] }),
    ctx.publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: 'rubricHash', args: [idArg] }),
    ctx.publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: 'deliveryHash', args: [idArg] }),
    ctx.publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: 'disputeHash', args: [idArg] }),
    ctx.publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: 'evidenceRoot', args: [idArg] }),
  ]);
  return { promiseHash, rubricHash, deliveryHash, disputeHash, evidenceRoot };
}

/** Recompute every commitment from the purchase text, locally. */
export function localCommitments(p: Purchase): LocalCommitments {
  const deliveryHash = sha256Hex(p.deliveryNotes);
  const disputeHash = sha256Hex(p.disputeNotes);
  return {
    promiseHash: sha256Hex(p.promiseText),
    rubricHash: rubricHashHex(p.rubric),
    deliveryHash,
    disputeHash,
    evidenceRoot: evidenceRootHex(deliveryHash, disputeHash),
  };
}

/**
 * The self-check described at the top of this file.
 *
 * Runs before any GenLayer fee is spent. If it throws, the relayer has an
 * encoding or (far less likely) an ABI bug, and no amount of retrying will
 * help — so the caller treats it as fatal for that purchase rather than
 * retrying into a loop.
 */
export function verifyCommitments(
  id: number,
  local: LocalCommitments,
  chain: ChainCommitments,
): void {
  const fields: ReadonlyArray<readonly [string, Hex, Hex]> = [
    ['promiseHash', local.promiseHash, chain.promiseHash],
    ['rubricHash', local.rubricHash, chain.rubricHash],
    ['deliveryHash', local.deliveryHash, chain.deliveryHash],
    ['disputeHash', local.disputeHash, chain.disputeHash],
    ['evidenceRoot', local.evidenceRoot, chain.evidenceRoot],
  ];
  for (const [name, mine, theirs] of fields) {
    if (mine.toLowerCase() !== theirs.toLowerCase()) {
      throw new EscrowMismatch(
        `purchase ${id}: locally computed ${name} is ${mine} but the escrow says ${theirs}. ` +
          `The relayer's hashing disagrees with Solidity — refusing to submit a package ` +
          `GenLayer would reject. See docs/vectors/hash-vectors.json.`,
      );
    }
  }
}

/**
 * Pre-flight the settlement against the chain itself before spending anything.
 *
 * `simulateContract` runs `settle()` as an `eth_call` from the relayer's
 * address with the exact arguments we would send. That means checks 2–16 of the
 * rejection list are exercised for real — including the signature recovery —
 * without a transaction, a nonce, or a gas cost. If the decision is malformed
 * in some way this file did not anticipate, it is caught here, where the
 * rejection reason is readable, instead of as a reverted broadcast.
 */
export async function simulateSettle(
  ctx: BaseContext,
  decision: Parameters<typeof encodeDecisionCall>[0],
  signature: Hex,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await ctx.publicClient.simulateContract({
      address: ctx.escrow,
      abi: escrowAbi,
      functionName: 'settle',
      args: [encodeDecisionCall(decision), signature],
      account: ctx.account,
    });
    return { ok: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reason };
  }
}

/**
 * viem represents a struct argument as an object keyed by component name, which
 * is what `settlementDecisionComponentNames` describes. Kept as a named
 * identity function so the call sites read as "this is the struct" rather than
 * "this is an object that happens to line up".
 */
export function encodeDecisionCall(d: {
  purchaseId: bigint;
  nonce: bigint;
  sourceChainId: bigint;
  sourceContract: Address;
  genlayerTxHash: Hex;
  promiseHash: Hex;
  rubricHash: Hex;
  evidenceRoot: Hex;
  decisionDigest: Hex;
  outcome: number;
  refundBps: number;
  criteriaMetBitmap: number;
  finalized: boolean;
}) {
  return d;
}

export async function sendSettle(
  ctx: BaseContext,
  decision: Parameters<typeof encodeDecisionCall>[0],
  signature: Hex,
): Promise<Hex> {
  return ctx.walletClient.writeContract({
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: 'settle',
    args: [encodeDecisionCall(decision), signature],
    chain: baseSepolia,
    account: ctx.account,
  });
}

export async function nonceUsed(ctx: BaseContext, nonce: bigint): Promise<boolean> {
  return ctx.publicClient.readContract({
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: 'nonceUsed',
    args: [nonce],
  });
}

/**
 * `hashDecision` as computed by the escrow.
 *
 * The relayer does NOT sign this value — it signs the EIP-712 struct, and the
 * escrow computes this internally. It is read back only to prove that the
 * relayer's EIP-712 implementation and the contract's agree before a broadcast,
 * which is the one part of signing that viem and Solidity could plausibly
 * differ on (field encoding of `uint8`/`uint16`/`bool`, typehash string,
 * domain). A cheap, decisive check.
 */
export async function chainHashDecision(
  ctx: BaseContext,
  decision: Parameters<typeof encodeDecisionCall>[0],
): Promise<Hex> {
  return ctx.publicClient.readContract({
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: 'hashDecision',
    args: [encodeDecisionCall(decision)],
  });
}

export async function chainDomainSeparator(ctx: BaseContext): Promise<Hex> {
  return ctx.publicClient.readContract({
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: 'domainSeparator',
  });
}
