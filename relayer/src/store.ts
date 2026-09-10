/**
 * Durable state, so a restart is not a restart of the whole pipeline.
 *
 * The relayer sits between two chains and spends real (testnet) fees at the
 * GenLayer step. Losing its place after that step costs a second evaluation;
 * losing it after the *signing* step costs a second settlement attempt whose
 * nonce is already spent, which reverts. Neither is fatal, but both are
 * avoidable, and the demo is much better if stopping and starting the process
 * mid-flow is unremarkable.
 *
 * Two design choices earn that:
 *
 *   THE TRANSACTION HASH IS WRITTEN *BEFORE* THE WAIT. `evaluating` is recorded
 *   with the GenLayer tx hash as soon as the write is accepted, so a crash
 *   during the (potentially long) wait for finality resumes by waiting on that
 *   same transaction rather than submitting a second evaluation. This is the
 *   only ordering that is safe, and it is why the status is written twice.
 *
 *   WRITES ARE ATOMIC. State is written to a temporary file and renamed over the
 *   target. A crash mid-write therefore leaves the previous good state in place
 *   instead of a truncated JSON file — which on restart would look like "no
 *   state at all" and silently re-evaluate everything.
 *
 * Bigints (the nonce) are stored as decimal strings: `JSON.stringify` throws on
 * a bigint, and storing one as a JSON number would lose precision above 2^53,
 * which a keccak-derived nonce always is.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { log } from './log.ts';

export type PurchaseStatus =
  /** Seen disputed on Base; nothing submitted yet. */
  | 'discovered'
  /** An evaluate() write was accepted; `genlayerTxHash` is set. */
  | 'evaluating'
  /** A verdict came back and passed validation; `verdictJson` is set. */
  | 'evaluated'
  /** settle() confirmed on Base. Terminal. */
  | 'settled'
  /** Gave up. Terminal for this run; `lastError` says why. */
  | 'failed';

export interface PurchaseState {
  id: number;
  status: PurchaseStatus;
  genlayerKey: string;
  genlayerTxHash?: string;
  verdictJson?: string;
  decisionDigest?: string;
  /** Decimal string — see the note about bigints above. */
  nonce?: string;
  baseTxHash?: string;
  attempts: number;
  lastError?: string;
  updatedAt: string;
}

interface FileShape {
  version: 1;
  updatedAt: string;
  purchases: Record<string, PurchaseState>;
}

const EMPTY: FileShape = { version: 1, updatedAt: '', purchases: {} };

export class Store {
  private readonly path: string;
  private data: FileShape;
  /** Serialises mutations within the process; there is one writer by design. */
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    this.data = Store.read(path);
  }

  private static read(path: string): FileShape {
    if (!existsSync(path)) return { ...EMPTY, purchases: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `state file ${path} exists but is not valid JSON (${msg}). Refusing to start: ` +
          `continuing would re-evaluate and re-settle purchases already handled. Move ` +
          `the file aside to start fresh.`,
      );
    }
    const obj = parsed as Partial<FileShape>;
    if (obj.version !== 1 || typeof obj.purchases !== 'object' || obj.purchases === null) {
      throw new Error(`state file ${path} has an unrecognised shape; refusing to guess`);
    }
    return { version: 1, updatedAt: obj.updatedAt ?? '', purchases: obj.purchases };
  }

  private persist(): void {
    this.data.updatedAt = new Date().toISOString();
    const dir = dirname(this.path);
    if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }

  get(id: number): PurchaseState | undefined {
    return this.data.purchases[String(id)];
  }

  all(): PurchaseState[] {
    return Object.values(this.data.purchases).sort((a, b) => a.id - b.id);
  }

  /**
   * Apply a patch to one purchase and persist.
   *
   * Mutations are queued rather than run concurrently so two overlapping ticks
   * cannot interleave read-modify-write on the same record.
   */
  async update(id: number, patch: Partial<PurchaseState>): Promise<PurchaseState> {
    let result!: PurchaseState;
    this.chain = this.chain.then(() => {
      const key = String(id);
      const existing: PurchaseState = this.data.purchases[key] ?? {
        id,
        status: 'discovered',
        genlayerKey: '',
        attempts: 0,
        updatedAt: new Date().toISOString(),
      };
      result = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
      this.data.purchases[key] = result;
      this.persist();
    });
    await this.chain;
    return result;
  }

  /** Record a failed attempt without making the failure terminal. */
  async recordError(id: number, message: string, terminal: boolean): Promise<void> {
    const prev = this.get(id);
    await this.update(id, {
      status: terminal ? 'failed' : (prev?.status ?? 'discovered'),
      attempts: (prev?.attempts ?? 0) + 1,
      lastError: message,
    });
  }

  /** Purchases that still need work, oldest first. */
  pending(): PurchaseState[] {
    return this.all().filter((p) => p.status !== 'settled' && p.status !== 'failed');
  }

  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.all()) out[p.status] = (out[p.status] ?? 0) + 1;
    return out;
  }
}

/** Log the state file's contents at startup so a resume is visible, not silent. */
export function logResume(store: Store): void {
  const pending = store.pending();
  if (pending.length === 0) {
    log.info('state file loaded; nothing in flight', { summary: store.summary() });
    return;
  }
  for (const p of pending) {
    log.info('resuming purchase', {
      purchaseId: p.id,
      status: p.status,
      attempts: p.attempts,
      genlayerTxHash: p.genlayerTxHash ?? null,
      lastError: p.lastError ?? null,
    });
  }
}
