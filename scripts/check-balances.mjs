#!/usr/bin/env node
/**
 * Recourse — Base Sepolia balance check.
 *
 * Pure Node (global fetch), no dependencies, no npm install. Reads ETH and
 * USDC balances for any address so you can confirm a faucet deposit landed
 * before a deploy fails halfway through on gas.
 *
 * Usage:
 *   node scripts/check-balances.mjs                        # reads .secrets/*.json
 *   node scripts/check-balances.mjs 0xabc... 0xdef...      # explicit addresses
 */

import fs from 'node:fs';
import path from 'node:path';

const RPCS = [
  'https://sepolia.base.org',
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.gateway.tenderly.co',
];

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_DECIMALS = 6;
const EXPLORER = 'https://sepolia.basescan.org/address/';

/** Selector for `balanceOf(address)`. */
const BALANCE_OF = '0x70a08231';

async function rpc(method, params) {
  let lastError;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`all RPCs failed: ${lastError?.message}`);
}

const formatUnits = (value, decimals) => {
  const s = value.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};

function loadAddresses() {
  const explicit = process.argv.slice(2).filter((a) => a.startsWith('0x'));
  if (explicit.length) return explicit.map((a) => ({ label: 'cli', address: a }));

  const dir = path.resolve('.secrets');
  if (!fs.existsSync(dir)) {
    console.error('no .secrets/ directory and no addresses given');
    process.exit(1);
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { label: f.replace(/\.json$/, ''), address: j.address };
    });
}

const entries = loadAddresses();
if (!entries.length) {
  console.error('no addresses to check');
  process.exit(1);
}

console.log('Base Sepolia — chain 84532\n');

for (const { label, address } of entries) {
  const padded = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  const [ethWei, usdcRaw] = await Promise.all([
    rpc('eth_getBalance', [address, 'latest']),
    rpc('eth_call', [{ to: USDC, data: BALANCE_OF + padded }, 'latest']),
  ]);

  const eth = formatUnits(BigInt(ethWei), 18);
  const usdc = formatUnits(BigInt(usdcRaw), USDC_DECIMALS);
  const gasOk = BigInt(ethWei) > 0n;
  const usdcOk = BigInt(usdcRaw) > 0n;

  console.log(`${label}  ${address}`);
  console.log(`  ETH   ${eth.padEnd(20)} ${gasOk ? 'ok' : 'EMPTY — needs gas'}`);
  console.log(`  USDC  ${usdc.padEnd(20)} ${usdcOk ? 'ok' : 'empty'}`);
  console.log(`  ${EXPLORER}${address}\n`);
}
