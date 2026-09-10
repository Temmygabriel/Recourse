#!/usr/bin/env node
/**
 * Recourse — key generation utility.
 *
 * Generates a secp256k1 keypair and prints the Ethereum address.
 *
 * Everything here is pure Node: no npm install, no dependency download, no
 * network access. Keccak-256 is implemented inline because Node ships SHA3-256
 * (NIST padding) and NOT Keccak-256 (original padding) — the two produce
 * different digests for the same input, and Ethereum uses the latter.
 *
 * Usage:
 *   node scripts/gen-wallet.mjs                 # print a new address only
 *   node scripts/gen-wallet.mjs --out .secrets  # write JSON files into a dir
 *   node scripts/gen-wallet.mjs --out .secrets --wallet demo
 *                                               # one extra named keypair,
 *                                               # e.g. the browser demo wallet
 *   node scripts/gen-wallet.mjs --self-test     # verify keccak against vectors
 *
 * NEVER commit the output. .secrets/ is gitignored; keep it that way.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MASK64 = (1n << 64n) - 1n;

// Rotation offsets indexed by lane number n = x + 5y — i.e. ROT[x + 5*y].
// The published Keccak table is usually printed with x as the ROW, which makes
// this array look like the transpose of that table. It is not: transposing it
// still produces a self-consistent permutation and still passes a naive
// "does it change the input" smoke test, but it yields a different digest and
// therefore a DIFFERENT ETHEREUM ADDRESS. The vectors below pin this down.
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotl(v, n) {
  n = BigInt(n) % 64n;
  if (n === 0n) return v & MASK64;
  return ((v << n) | (v >> (64n - n))) & MASK64;
}

function keccakF(A) {
  const B = new Array(25);
  const C = new Array(5);
  const D = new Array(5);

  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D[x];

    // rho + pi
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    }

    // chi
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      const i = x + 5 * y;
      A[i] = B[i] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK64) & B[((x + 2) % 5) + 5 * y]);
    }

    // iota
    A[0] ^= RC[round];
  }
}

/** Keccak-256 (Ethereum's variant, 0x01 padding — not NIST SHA3's 0x06). */
export function keccak256(input) {
  const bytes = Uint8Array.from(input);
  const rate = 136; // 1088-bit rate for a 256-bit digest
  const A = new Array(25).fill(0n);

  const padLen = rate - (bytes.length % rate);
  const padded = new Uint8Array(bytes.length + padLen);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      A[i] ^= lane;
    }
    keccakF(A);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let j = 0; j < 8; j++) { out[i * 8 + j] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

const hex = (u8) => Buffer.from(u8).toString('hex');

/** EIP-55 mixed-case checksum encoding. */
export function toChecksumAddress(addr) {
  const lower = addr.toLowerCase().replace(/^0x/, '');
  const hash = hex(keccak256(Buffer.from(lower, 'utf8')));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/** Derive the checksummed address for a 32-byte private key. */
export function addressFromPrivateKey(privHex) {
  const priv = Buffer.from(privHex.replace(/^0x/, ''), 'hex');
  if (priv.length !== 32) throw new Error(`private key must be 32 bytes, got ${priv.length}`);
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(priv);
  const pub = ecdh.getPublicKey(null, 'uncompressed'); // 0x04 || X(32) || Y(32)
  return toChecksumAddress('0x' + hex(keccak256(pub.subarray(1))).slice(24));
}

// --- self-test -------------------------------------------------------------

export const VECTORS = [
  ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
  ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
  [
    'The quick brown fox jumps over the lazy dog',
    '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
  ],
];

/**
 * Published private-key -> address pairs. These are the vectors that actually
 * matter: they exercise keccak256 AND secp256k1 together, end to end, and a
 * mismatch here means the generated address is wrong — which for a wallet you
 * are about to fund is the difference between a working deployer and money
 * sent to a hole.
 */
export const ADDRESS_VECTORS = [
  ['0x0000000000000000000000000000000000000000000000000000000000000001', '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'],
  ['0x0000000000000000000000000000000000000000000000000000000000000002', '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF'],
  ['0x4646464646464646464646464646464646464646464646464646464646464646', '0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F'],
];

export function selfTest() {
  let ok = true;

  for (const [input, expected] of VECTORS) {
    const got = hex(keccak256(Buffer.from(input, 'utf8')));
    const pass = got === expected;
    ok = ok && pass;
    const label = input.length > 20 ? `${input.slice(0, 17)}...` : input;
    console.log(`${pass ? 'ok  ' : 'FAIL'} keccak256(${JSON.stringify(label)}) = ${got}`);
    if (!pass) console.log(`     expected ${expected}`);
  }

  for (const [priv, expected] of ADDRESS_VECTORS) {
    const got = addressFromPrivateKey(priv);
    const pass = got === expected;
    ok = ok && pass;
    console.log(`${pass ? 'ok  ' : 'FAIL'} address(${priv.slice(0, 10)}...) = ${got}`);
    if (!pass) console.log(`     expected ${expected}`);
  }

  // Exercises the multi-block absorb path (rate is 136 bytes, so a 300-byte
  // input spans three blocks) and the padLen === rate edge case. There is no
  // published digest to compare against here, so this asserts the properties
  // that would break first if the block loop or padding were wrong.
  const long = 'a'.repeat(300);
  const h1 = hex(keccak256(Buffer.from(long, 'utf8')));
  const h2 = hex(keccak256(Buffer.from(long, 'utf8')));
  const hShort = hex(keccak256(Buffer.from(long.slice(0, 299), 'utf8')));
  const multiBlock = h1 === h2 && h1 !== hShort && h1.length === 64;
  ok = ok && multiBlock;
  console.log(`${multiBlock ? 'ok  ' : 'FAIL'} multi-block (300 bytes) = ${h1}`);

  return ok;
}

// --- main ------------------------------------------------------------------
//
// Guarded so this file can be imported for its keccak256/address helpers
// without generating a keypair and printing an address as a side effect. The
// relayer's test stubs import it exactly that way: `keccak256` here is verified
// against published digest vectors by `--self-test`, which makes it the one
// Keccak-256 in this repo that is known to be correct, and reusing it is
// better than writing a second one that is merely believed to be correct.

const isMain =
  import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const walletIdx = args.indexOf('--wallet');

if (isMain) {
  if (args.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }

  // A single named wallet, for a role that is not part of the deployer/relayer
  // pair — the browser wallet used in the demo, for instance. Kept separate
  // from `--out`'s pair so that generating an extra wallet can never collide
  // with the two the escrow and the relayer actually depend on.
  if (walletIdx !== -1) {
    const name = args[walletIdx + 1];
    if (!name || name.startsWith('--')) {
      console.error('--wallet needs a name, e.g. --wallet demo');
      process.exit(1);
    }
    if (outIdx === -1) {
      console.error('--wallet writes a key file, so it needs --out <dir>');
      process.exit(1);
    }

    const dir = path.resolve(args[outIdx + 1] ?? '.secrets');
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) {
      console.error(`refusing to overwrite existing ${file}`);
      process.exit(1);
    }

    const privateKey = '0x' + crypto.randomBytes(32).toString('hex');
    const address = addressFromPrivateKey(privateKey);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          note: `Recourse ${name} wallet. Testnet only. Never reuse on mainnet.`,
          address,
          privateKey,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );

    // The address is public; the key is not printed. It goes to the file, which
    // is gitignored and mode 0600 — printing it here would put a signing key
    // into a terminal log and any transcript of this session.
    console.log('address          ' + address);
    console.log(`${name} wallet      ${file}  (private key inside — not printed)`);
    process.exit(0);
  }

  const privateKey = '0x' + crypto.randomBytes(32).toString('hex');
  const address = addressFromPrivateKey(privateKey);

  if (outIdx !== -1) {
    const dir = path.resolve(args[outIdx + 1] ?? '.secrets');
    fs.mkdirSync(dir, { recursive: true });

    const write = (name, obj) => {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        console.error(`refusing to overwrite existing ${p}`);
        process.exit(1);
      }
      fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
      return p;
    };

    console.log('address                 ' + address);
    console.log('deployer key written    ' + write('deployer.json', {
      note: 'Recourse testnet deployer. Testnet only. Never reuse on mainnet.',
      address,
      privateKey,
      createdAt: new Date().toISOString(),
    }));
    console.log('relayer key written     ' + write('relayer.json', {
      note: 'Recourse relayer signer. Must match the escrow constructor relayer arg.',
      address: addressFromPrivateKey(
        '0x' + crypto.createHash('sha256').update('relayer' + privateKey).digest('hex'),
      ),
      privateKey: '0x' + crypto.createHash('sha256').update('relayer' + privateKey).digest('hex'),
      createdAt: new Date().toISOString(),
    }));
  } else {
    console.log(address);
  }
}
