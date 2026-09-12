/**
 * Chain access: one public client for reads, and a wallet client built from the
 * injected provider for writes.
 *
 * No wagmi, no RainbowKit (MEMORY.md D8). The whole wallet surface this app
 * needs is "ask for accounts, switch chain, send a transaction", and that is
 * about eighty lines of EIP-1193 — against two dependencies that each pull a
 * version-sensitive React tree into a build we cannot run locally. The demo
 * connects to one chain and does one thing at a time; a connector framework
 * would be load-bearing for none of it.
 *
 * Reads go through a plain HTTP client rather than the user's wallet, so a
 * visitor without a wallet can still read an offer, a case, or a verdict. Only
 * writes require one.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type PublicClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { escrowAbi } from './abi';

// --- Configuration ---------------------------------------------------------

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing ${name}. Copy frontend/.env.example to frontend/.env.local and fill it in. ` +
        `On Vercel, set it in Project Settings → Environment Variables.`,
    );
  }
  return value.trim();
}

export const CHAIN = baseSepolia;
export const CHAIN_ID = baseSepolia.id; // 84532

/**
 * The escrow address, resolved on first use rather than at module load.
 *
 * A missing `NEXT_PUBLIC_ESCROW_ADDRESS` must not fail the build. Next
 * prerenders every page on the server, so a throw at module scope would turn a
 * forgotten Vercel environment variable into a red deployment whose error
 * points at the build rather than at the setting. Resolving it lazily means the
 * build succeeds and the person who forgot it sees a message in the browser
 * that names the fix. (`NEXT_PUBLIC_*` values are still inlined at build time,
 * so a variable added after a deploy needs a redeploy to take effect — the
 * message says that too.)
 */
let cachedEscrow: Address | null = null;

export function escrowAddress(): Address {
  if (cachedEscrow === null) {
    cachedEscrow = requireEnv(
      'NEXT_PUBLIC_ESCROW_ADDRESS',
      process.env.NEXT_PUBLIC_ESCROW_ADDRESS,
    ) as Address;
  }
  return cachedEscrow;
}

/**
 * A public RPC endpoint. `https://sepolia.base.org` is rate-limited but has no
 * key and works from anywhere, which is what a submitted demo needs.
 */
export const RPC_URL =
  process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org';

/**
 * The endpoint handed to a *wallet* — which is not always the one we read from.
 *
 * `RPC_URL` may be overridden by `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` and can
 * therefore be a private, keyed endpoint (Alchemy, QuickNode, a local node).
 * Writing that into the user's wallet is wrong twice over: it publishes a
 * credential to a third party that now stores and uses it for every request the
 * wallet makes, and it points the wallet at an endpoint MetaMask cannot
 * recognise as Base Sepolia. MetaMask's response to an unrecognised provider
 * for a known chain id is a security warning about the network — the "you could
 * lose funds" dialog — which is exactly the right thing for it to do, and
 * entirely our fault for causing.
 *
 * So the wallet always gets the canonical public endpoint, whether or not this
 * deployment reads through something faster.
 */
export const CANONICAL_BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

export const EXPLORER_URL = 'https://sepolia.basescan.org';

/**
 * The escrow, as the `{ address, abi }` pair viem's `readContract` and
 * `writeContract` take. `address` is an accessor so that spreading this object
 * resolves the address at call time, not at import time.
 */
export const ESCROW = {
  get address(): Address {
    return escrowAddress();
  },
  abi: escrowAbi,
} as const;

// --- Clients ---------------------------------------------------------------

let cachedPublic: PublicClient | null = null;

export function publicClient(): PublicClient {
  if (cachedPublic === null) {
    cachedPublic = createPublicClient({
      chain: baseSepolia,
      transport: http(RPC_URL),
    }) as PublicClient;
  }
  return cachedPublic;
}

/**
 * The provider this app has settled on, chosen by EIP-6963 discovery.
 *
 * Held here rather than passed around because `walletClient` and the reads are
 * called from screens that know nothing about wallets, and threading a provider
 * through every one of them would put connector plumbing into the purchase
 * flow. `./wallet` is the only writer.
 */
let selectedProvider: Eip1193Provider | null = null;

/**
 * Whether `./wallet` has finished deciding.
 *
 * Distinguishes "no selection has been made yet, fall back to
 * `window.ethereum`" from "a selection was made and it is deliberately
 * nothing". The second happens in a browser with two wallets before the user
 * has picked one: there is no safe provider to bind to, and falling back would
 * mean reading an account out of whichever extension loaded last — the exact
 * bug EIP-6963 discovery exists to fix.
 */
let selectionMade = false;

/**
 * Point the app at one wallet's provider.
 *
 * Called by `./wallet` once discovery has run — with the single wallet found,
 * with the one the user picked out of several, or with `null` to mean "there is
 * no provider to use", which is not the same as "not decided yet".
 */
export function rememberProvider(provider: Eip1193Provider | null): void {
  selectedProvider = provider;
  selectionMade = true;
}

/**
 * The provider to use, or null when there is no wallet in this browser.
 *
 * Deliberately does not throw: every read-only screen has to keep working
 * without one, and the pages decide what to say.
 *
 * A selected provider wins over `window.ethereum`. That ordering is the whole
 * point — with two wallets installed, `window.ethereum` is whichever extension
 * happened to load last, and using it is how an app connects to a wallet the
 * user is not looking at.
 */
export function injected(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  if (selectionMade) return selectedProvider;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export class WalletError extends Error {}

/**
 * Ask the wallet for an account.
 *
 * ASKS FOR AN ACCOUNT AND NOTHING ELSE. It does not switch networks, and that
 * is a deliberate product decision rather than an omission.
 *
 * This used to call `ensureChain` on the way out, which meant a first click on
 * "Connect wallet" produced two wallet dialogs in a row: the account prompt,
 * then a network prompt. The second one is the problem. If the wallet has never
 * seen Base Sepolia it is an *add network* dialog, and wallets — correctly —
 * treat that as a security decision: an RPC endpoint the wallet does not
 * recognise can lie about balances and censor or rewrite transactions, so the
 * dialog says so, in the strongest terms it has. A user who clicked one button
 * labelled "Connect wallet" is suddenly being asked to accept a risk of losing
 * funds, on a screen that never explained why.
 *
 * Nothing about that dialog is inaccurate. It is just the wrong moment: a
 * person connecting to look at a page is not transacting yet, and asking them
 * to weigh a network's trustworthiness before they have read a single offer is
 * how you lose them. So connecting connects. The network is raised when it
 * matters — at the first write, where the user is already signing something and
 * the question is obviously about the thing in front of them — and an explicit
 * button in the header covers the user who would rather switch first.
 */
export async function connect(): Promise<Address> {
  const provider = injected();
  if (provider === null) {
    throw new WalletError(
      'No wallet found in this browser. Install MetaMask (or any EVM wallet) and reload.',
    );
  }

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const first = accounts[0];
  if (first === undefined) {
    throw new WalletError('The wallet returned no accounts.');
  }

  return first as Address;
}

/** Currently-selected account, without prompting. Null if not connected. */
export async function currentAccount(): Promise<Address | null> {
  const provider = injected();
  if (provider === null) return null;
  try {
    const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
    return (accounts[0] as Address | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Move the wallet to Base Sepolia, adding the chain first if it has never seen
 * it.
 *
 * `wallet_switchEthereumChain` fails with code 4902 when the wallet has no
 * entry for the chain id, so that case is caught and answered with an
 * add-then-switch. Without it, a user whose wallet defaults to Ethereum
 * mainnet gets a confusing "chain mismatch" on their first write and no way
 * forward.
 *
 * Exported because it is called from two places that are both deliberate: the
 * write path (see `writeEscrow`), where the user is about to sign and the
 * network has to be right, and an explicit "Switch to Base Sepolia" button in
 * the header, so the user can settle the question before they start rather than
 * being interrupted mid-action.
 *
 * It is NOT called from `connect()`. See the note there.
 */
export async function ensureChain(): Promise<void> {
  const provider = injected();
  if (provider === null) {
    throw new WalletError('No wallet found in this browser.');
  }

  const current = (await provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) === CHAIN_ID) return;

  const hexId = `0x${CHAIN_ID.toString(16)}`;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexId }],
    });
    return;
  } catch (e) {
    const code = (e as { code?: number }).code;

    // 4001 is the user declining. Reporting that as "could not switch" buries
    // the one fact that matters — they said no — and leaves them looking for a
    // fault that is not there. It also leaves the app on the wrong chain, which
    // the message has to say, because the next write will fail.
    if (code === 4001) {
      throw new WalletError(
        `This purchase settles on ${baseSepolia.name}, and the request to switch was declined. ` +
          `Switch to ${baseSepolia.name} in your wallet to continue.`,
      );
    }

    if (code !== 4902) {
      throw new WalletError(
        `Could not switch the wallet to ${baseSepolia.name}. ` +
          `Switch to it manually and try again.`,
      );
    }
  }

  await provider.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: hexId,
        chainName: baseSepolia.name,
        nativeCurrency: baseSepolia.nativeCurrency,
        // CANONICAL, not RPC_URL. See the note on that constant: this is the one
        // value here that is written into the user's wallet and kept there.
        rpcUrls: [CANONICAL_BASE_SEPOLIA_RPC],
        blockExplorerUrls: [EXPLORER_URL],
      },
    ],
  });

  // Most wallets switch to a chain they have just been given. Not all do, and
  // the ones that do not would otherwise leave the app reporting a successful
  // switch while the next transaction goes to the wrong network.
  const after = (await provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(after, 16) !== CHAIN_ID) {
    throw new WalletError(
      `Added ${baseSepolia.name} to your wallet, but it is not selected. ` +
        `Choose it in your wallet to continue.`,
    );
  }
}

/**
 * A wallet client bound to `account` on Base Sepolia.
 *
 * **The return type is deliberately inferred, not annotated `: WalletClient`.**
 * Do not "tidy" it back to the bare alias. The bare `WalletClient` defaults its
 * generics to `chain = Chain | undefined` and `account = Account | undefined`,
 * and viem's `IsUndefined<T> = [undefined] extends [T] ? true : false` evaluates
 * that union as TRUE. That flips `GetChainParameter` from its optional branch
 * (`{ chain?: ... }`) to its required one (`{ chain: ... }`), so every
 * `writeContract` on the result demands an explicit `chain` and fails to
 * typecheck with "Property 'chain' is missing" — which is exactly how this
 * broke the first Vercel build, reported against a call site in escrow.ts that
 * was itself correct.
 *
 * Letting TypeScript infer the return type keeps the concrete `typeof
 * baseSepolia` and `Address` in the signature, so `chain` and `account` are
 * already bound and the per-call parameters stay optional. A future caller
 * gets a client it can just use.
 */
export function walletClient(account: Address) {
  const provider = injected();
  if (provider === null) {
    throw new WalletError('No wallet found in this browser.');
  }
  return createWalletClient({
    account,
    chain: baseSepolia,
    transport: custom(provider),
  });
}

// --- USDC ------------------------------------------------------------------

export const USDC_DECIMALS = 6;

/**
 * The token address, read from the escrow rather than configured.
 *
 * The escrow knows which token it custodies and will not accept another, so
 * asking it removes a class of "the UI approved the wrong token" bug by
 * construction. Cached because it cannot change — the escrow's `usdc` is
 * immutable.
 */
let cachedUsdc: Address | null = null;

export async function usdcAddress(): Promise<Address> {
  if (cachedUsdc === null) {
    cachedUsdc = (await publicClient().readContract({
      ...ESCROW,
      functionName: 'usdc',
    })) as Address;
  }
  return cachedUsdc;
}

/** Format a USDC base-unit amount for display, e.g. `1500000n` → `1.50`. */
export function formatUsdc(amount: bigint, opts?: { withSymbol?: boolean }): string {
  const s = formatUnits(amount, USDC_DECIMALS);
  // Two decimals is what a price needs; keep a third only when it is non-zero
  // so an odd bond amount is not silently rounded away.
  const [whole, frac = ''] = s.split('.');
  const trimmed = frac.length > 2 && frac[2] !== '0' ? frac.slice(0, 3) : frac.slice(0, 2);
  const out = trimmed.length > 0 ? `${whole}.${trimmed.padEnd(2, '0')}` : `${whole}.00`;
  return opts?.withSymbol === false ? out : `${out} USDC`;
}

/** Parse a user-typed USDC amount into base units. Throws on malformed input. */
export function parseUsdc(input: string): bigint {
  const clean = input.trim();
  if (clean === '') throw new Error('Enter an amount.');
  if (!/^\d*\.?\d*$/.test(clean)) throw new Error('Use digits and a single decimal point.');
  const value = parseUnits(clean, USDC_DECIMALS);
  if (value <= 0n) throw new Error('Amount must be greater than zero.');
  return value;
}
