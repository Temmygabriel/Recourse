/**
 * The one file that knows what the GenLayer SDK looks like.
 *
 * Everything the relayer needs from genlayer-js is behind the five functions at
 * the bottom of this file. Nothing else in the codebase imports the SDK, so when
 * a release candidate renames something — and release candidates do — exactly
 * one file changes.
 *
 * WHY THE SDK IS LOADED DYNAMICALLY AND TYPED AS `unknown`.
 *
 * This project is developed on a machine that cannot run `npm install` (see
 * MEMORY.md), so a hard `import { createClient } from 'genlayer-js'` would be a
 * compile error nobody can see until CI runs, and a wrong guess about an export
 * name would fail there with a message about modules rather than about the
 * actual problem. Loading by string and checking each capability at runtime
 * turns "the SDK moved" into a precise, self-describing error:
 *
 *     genlayer-js has no `writeContract` — it exports: createClient, ...
 *
 * which is a five-second fix rather than a bisect. The cost is that the compiler
 * cannot check these five call sites; the mitigations are that they are few, and
 * that `describeSdk()` prints the real surface once at startup under LOG_LEVEL=debug.
 *
 * SUCCESS IS STATUS *AND* EXECUTION RESULT. Per the Consensus v0.6 migration
 * doc, a transaction is successful only when the consensus status is
 * ACCEPTED/FINALIZED *and* the execution result is FINISHED_WITH_RETURN. The SDK
 * ships `isSuccessful` for this and it is used when available; the fallback
 * below is a transcription of the same rule and is labelled as such.
 */

import type { Address, Hex } from 'viem';

import { log } from './log.ts';

/** A minimal structural view of the client, for our own call sites. */
export interface GenLayerClient {
  readContract(args: {
    address: Address;
    functionName: string;
    args: unknown[];
    [k: string]: unknown;
  }): Promise<unknown>;
  writeContract(args: Record<string, unknown>): Promise<unknown>;
  estimateTransactionFeesForWrite?(args: Record<string, unknown>): Promise<unknown>;
  waitForFinalization?(args: { hash: unknown }): Promise<unknown>;
  waitForTransactionReceipt?(args: { hash: unknown; waitUntil?: string }): Promise<unknown>;
  [k: string]: unknown;
}

export class GenLayerSdkError extends Error {}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) {
    throw new GenLayerSdkError(`${what} is not an object (got ${typeof v})`);
  }
  return v as Record<string, unknown>;
}

async function loadSdk(): Promise<Record<string, unknown>> {
  try {
    return asRecord(await import('genlayer-js'), 'the genlayer-js module');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new GenLayerSdkError(
      `could not import genlayer-js (${msg}). It is ESM-only — if this is running from a ` +
        `CommonJS context, or if the pinned "2.0.0-rc.1" does not exist on the registry, ` +
        `that is the cause.`,
    );
  }
}

async function loadChains(): Promise<Record<string, unknown>> {
  try {
    return asRecord(await import('genlayer-js/chains'), 'the genlayer-js/chains module');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new GenLayerSdkError(`could not import genlayer-js/chains (${msg})`);
  }
}

/**
 * The export names and chain ids of genlayer-js 2.0.0-rc.1, read out of the
 * published package rather than recalled from documentation.
 *
 * These were verified by downloading the tarball and inspecting it, because the
 * v0.6 migration doc and the package disagree on the spelling of the Studio dev
 * chain — the doc writes it "studio-dev", the package exports `studioDevnet`,
 * and a name that does not match falls through to the id lookup below. The ids
 * are what the escrow actually checks (`sourceChainId`), so they are the part
 * that must be right.
 *
 * NOTE THE COLLISION: `testnetAsimov` and `testnetBradbury` BOTH declare
 * `id: 4221` in this release — Bradbury appears to have superseded Asimov at the
 * same id. That is why the id lookup below refuses to guess when more than one
 * chain matches; picking the first would be a coin flip between two different
 * networks, and the failure would surface as a `sourceChainId` mismatch long
 * after the fact. Name the chain you mean.
 */
const VERIFIED_CHAIN_IDS: Record<string, number> = {
  localnet: 61127,
  studioDevnet: 61997,
  studionet: 61999,
  testnetAsimov: 4221,
  testnetBradbury: 4221,
};

/**
 * Spellings people actually write, mapped to the real export name.
 *
 * Keys are lowercased with separators stripped, so `studio-dev`, `studio_dev`
 * and `studioDev` all arrive here as `studiodev`. An explicit table rather than
 * fuzzy matching, because `studioDevnet` and `studioDev` are one character apart
 * and a fuzzy rule that conflates them would happily point at the wrong chain.
 */
const CHAIN_ALIASES: Record<string, string> = {
  localnet: 'localnet',
  studionet: 'studionet',
  studiodevnet: 'studioDevnet',
  studiodev: 'studioDevnet',
  devnet: 'studioDevnet',
  testnetasimov: 'testnetAsimov',
  asimov: 'testnetAsimov',
  testnetbradbury: 'testnetBradbury',
  bradbury: 'testnetBradbury',
};

const canonicalize = (s: string): string => s.trim().toLowerCase().replace(/[-_\s]/g, '');

/**
 * Find a chain definition without over-depending on its export name.
 *
 * Resolution order: the exact export name, then the alias table, then the chain
 * id. The id path exists because the id is the thing that is load-bearing —
 * nothing but `sourceChainId` is compared across the bridge — but it is
 * deliberately the last resort and only fires on a unique match.
 */
export async function resolveChain(name: string, idOverride?: number): Promise<unknown> {
  const chains = await loadChains();
  const wanted = canonicalize(name);
  const available = Object.keys(chains).sort();
  const describe = () => `genlayer-js/chains exports: ${available.join(', ')}.`;

  // 1. Exact export name, case- and separator-insensitive.
  for (const [key, value] of Object.entries(chains)) {
    if (canonicalize(key) === wanted && isChainLike(value)) return value;
  }

  // 2. A known spelling of a known chain.
  const canonical = CHAIN_ALIASES[wanted];
  if (canonical !== undefined) {
    const value = chains[canonical];
    if (isChainLike(value)) return value;
  }

  // 3. By chain id, but only when it identifies exactly one chain.
  const wantedId = idOverride ?? (canonical === undefined ? undefined : VERIFIED_CHAIN_IDS[canonical]);
  if (wantedId !== undefined) {
    const matches = Object.entries(chains).filter(
      ([, value]) => isChainLike(value) && (value as { id?: unknown }).id === wantedId,
    );
    if (matches.length === 1) return matches[0]![1];
    if (matches.length > 1) {
      throw new GenLayerSdkError(
        `chain id ${wantedId} is ambiguous in this genlayer-js release: it matches ` +
          `${matches.map(([k]) => k).join(' and ')}. Two different networks share this id, so ` +
          `resolving by number would be a coin flip. Set GENLAYER_CHAIN to the name you mean ` +
          `rather than GENLAYER_CHAIN_ID. ${describe()}`,
      );
    }
  }

  throw new GenLayerSdkError(
    `no chain definition found for "${name}"` +
      `${wantedId === undefined ? '' : ` (chain id ${wantedId})`}. ` +
      (canonical === undefined
        ? `That is not a chain this relayer knows. ${describe()}`
        : `It maps to the export "${canonical}", which this release does not provide. ${describe()}`) +
      ` Set GENLAYER_CHAIN to one of those names, or GENLAYER_CHAIN_ID to its numeric id.`,
  );
}

function isChainLike(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'number';
}


export interface Sdk {
  readonly client: GenLayerClient;
  readonly isSuccessful: (tx: unknown) => boolean;
  readonly raw: Record<string, unknown>;
}

export async function createSdk(args: {
  chainName: string;
  chainIdOverride?: number;
  account: unknown;
}): Promise<Sdk> {
  const sdk = await loadSdk();
  const createClient = sdk['createClient'];
  if (typeof createClient !== 'function') {
    throw new GenLayerSdkError(
      `genlayer-js has no createClient — it exports: ${Object.keys(sdk).join(', ')}`,
    );
  }
  const chain = await resolveChain(args.chainName, args.chainIdOverride);
  const client = (createClient as (a: Record<string, unknown>) => unknown)({
    chain,
    account: args.account,
  }) as GenLayerClient;

  for (const method of ['readContract', 'writeContract'] as const) {
    if (typeof client[method] !== 'function') {
      throw new GenLayerSdkError(
        `the genlayer-js client has no ${method}(). Available: ` +
          `${Object.keys(client).filter((k) => typeof client[k] === 'function').join(', ')}. ` +
          `This is the adapter's problem, not the contract's — see relayer/src/genlayer.ts.`,
      );
    }
  }

  const isSuccessfulExport = sdk['isSuccessful'];
  return {
    client,
    raw: sdk,
    isSuccessful:
      typeof isSuccessfulExport === 'function'
        ? (isSuccessfulExport as (tx: unknown) => boolean)
        : fallbackIsSuccessful,
  };
}

/** Diagnostic for the first run: what does this SDK actually look like? */
export function describeSdk(sdk: Sdk): Record<string, unknown> {
  return {
    exports: Object.keys(sdk.raw).sort(),
    clientMethods: Object.keys(sdk.client)
      .filter((k) => typeof sdk.client[k] === 'function')
      .sort(),
    hasIsSuccessfulExport: sdk.raw['isSuccessful'] !== undefined,
  };
}

/**
 * Transcription of the documented success rule, used only if the SDK does not
 * export `isSuccessful`. Both conditions are required: a FINISHED_WITH_RETURN
 * execution result under a status that never reached consensus is not success,
 * and a FINALIZED status whose execution reverted is not success either.
 */
function fallbackIsSuccessful(tx: unknown): boolean {
  const t = tx as Record<string, unknown>;
  const status = String(t['statusName'] ?? t['status'] ?? '').toUpperCase();
  const result = String(t['txExecutionResultName'] ?? t['txExecutionResult'] ?? '').toUpperCase();
  const statusOk = status.includes('ACCEPTED') || status.includes('FINALIZED');
  const resultOk = result.includes('FINISHED_WITH_RETURN');
  return statusOk && resultOk;
}

function sdkString(t: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = t[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/**
 * Submit `evaluate` and wait for finality.
 *
 * Fees are estimated immediately before the write and passed through verbatim.
 * A gasless deployment reports no fee value, and passing `fees` there is what
 * the migration doc warns about — so the field is omitted entirely when the
 * estimate reports nothing to charge. `GENLAYER_FEES_JSON` overrides this with
 * a checked-in profile for deployments where simulating before every write is
 * not wanted (the doc's guidance for application flows).
 */
export async function evaluate(args: {
  sdk: Sdk;
  contract: Address;
  purchaseKey: string;
  packageJson: string;
}): Promise<Hex> {
  const { sdk } = args;
  const write: Record<string, unknown> = {
    address: args.contract,
    functionName: 'evaluate',
    args: [args.purchaseKey, args.packageJson],
  };

  const override = process.env['GENLAYER_FEES_JSON'];
  let fees: unknown;
  if (override !== undefined && override.trim() !== '') {
    try {
      fees = JSON.parse(override);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new GenLayerSdkError(`GENLAYER_FEES_JSON is not valid JSON: ${msg}`);
    }
  } else if (typeof sdk.client.estimateTransactionFeesForWrite === 'function') {
    const estimate = await sdk.client.estimateTransactionFeesForWrite(write);
    log.debug('genlayer fee estimate', { estimate: safeJson(estimate) });
    fees = pickFees(estimate);
  } else {
    log.warn(
      'this genlayer-js client has no estimateTransactionFeesForWrite, so no fee ' +
        'distribution will be attached. Correct on a gasless Studio deployment, wrong ' +
        'on a fee-charging one — the write will fail there rather than underpay.',
    );
  }

  const txId = await sdk.client.writeContract(fees === undefined ? write : { ...write, fees });
  if (typeof txId !== 'string' || !/^0x[0-9a-fA-F]+$/.test(txId)) {
    throw new GenLayerSdkError(
      `writeContract returned something that is not a transaction hash: ${safeJson(txId)}`,
    );
  }
  return txId as Hex;
}

/**
 * Choose the fee fields to forward.
 *
 * Returns `undefined` when the estimate carries no charge — see the note in
 * `evaluate`. When it does carry one, `distribution` and `feeValue` are passed
 * back **unchanged**, which is what the migration doc requires: the estimate's
 * values are a quote for a specific submission, and recomputing or rescaling
 * them is how a write ends up underfunded.
 */
function pickFees(estimate: unknown): unknown {
  if (typeof estimate !== 'object' || estimate === null) return undefined;
  const e = estimate as Record<string, unknown>;
  const distribution = e['distribution'];
  const feeValue = e['feeValue'];
  if (distribution === undefined || feeValue === undefined || feeValue === null) return undefined;
  try {
    if (BigInt(feeValue as bigint) === 0n) return undefined;
  } catch {
    // Not a numeric fee value — pass it through untouched and let the node judge.
  }
  return { distribution, feeValue };
}

export interface FinalizedTx {
  readonly ok: boolean;
  readonly statusName: string;
  readonly executionResultName: string;
  readonly raw: Record<string, unknown>;
}

/** Wait for finality, tolerating either SDK spelling of the wait call. */
export async function waitForFinality(sdk: Sdk, txId: Hex): Promise<FinalizedTx> {
  let tx: unknown;
  if (typeof sdk.client.waitForFinalization === 'function') {
    tx = await sdk.client.waitForFinalization({ hash: txId });
  } else if (typeof sdk.client.waitForTransactionReceipt === 'function') {
    tx = await sdk.client.waitForTransactionReceipt({ hash: txId, waitUntil: 'finalized' });
  } else {
    throw new GenLayerSdkError(
      'the genlayer-js client has neither waitForFinalization nor ' +
        'waitForTransactionReceipt — cannot confirm consensus.',
    );
  }
  const raw = asRecord(tx, 'the awaited transaction');
  return {
    ok: sdk.isSuccessful(tx),
    statusName: sdkString(raw, 'statusName', 'status'),
    executionResultName: sdkString(raw, 'txExecutionResultName', 'txExecutionResult'),
    raw,
  };
}

/**
 * Read the stored verdict back.
 *
 * Read from the contract rather than taken from the write's return value, on
 * purpose: the write's own return value is the leader's output, while
 * `get_decision` returns what consensus actually stored. Hashing the stored
 * value is what makes `decisionDigest` independently reproducible by a third
 * party, which is its entire purpose.
 */
export async function readDecision(
  sdk: Sdk,
  contract: Address,
  purchaseKey: string,
): Promise<unknown> {
  return sdk.client.readContract({
    address: contract,
    functionName: 'get_decision',
    args: [purchaseKey],
  });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val}n` : val));
  } catch {
    return String(v);
  }
}
