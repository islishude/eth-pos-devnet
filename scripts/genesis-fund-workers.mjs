#!/usr/bin/env node
/**
 * genesis-fund-workers.mjs
 * Pre-populate worker accounts into EL genesis by writing GENESIS_BALANCE_0x.. lines into .env.
 * - Key derivation matches load-forward.mjs workerKey(i): PK = 0x( (i+1+offset).toString(16).padStart(64,'0') )
 * - Address is computed via ethers.Wallet(privateKey).address
 *
 * CLI:
 *   node scripts/genesis-fund-workers.mjs --count 300 --offset 0 --eth 200
 *   # or specify wei directly:
 *   node scripts/genesis-fund-workers.mjs --count 300 --wei 200000000000000000000
 *
 * Notes:
 * - Idempotent: existing GENESIS_BALANCE_ lines for these addresses are replaced with the new amount.
 * - After running this, re-run `make init` (or fresh-workers) to regenerate genesis.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, parseEther } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      if (v !== undefined) args[k.slice(2)] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { args[a.slice(2)] = argv[++i]; }
      else args[a.slice(2)] = '1';
    }
  }
  return args;
}

function pkForIndex(i, offset) {
  const v = BigInt(i + 1 + offset).toString(16).padStart(64, '0');
  return '0x' + v;
}

function toWeiDecimal({ eth, wei }) {
  if (wei) return BigInt(wei).toString(10);
  const e = eth ? String(eth) : '200';
  return parseEther(e).toString();
}

async function ensureEnvUpdated(lines, addrToWei) {
  const out = [];
  const lowerSet = new Set(Object.keys(addrToWei));
  // Filter out existing lines for target addresses
  for (const line of lines) {
    const m = line.match(/^\s*GENESIS_BALANCE_(0x[0-9a-fA-F]{40})\s*=\s*(\S+)/);
    if (m) {
      const addrLower = m[1].toLowerCase();
      if (lowerSet.has(addrLower)) {
        // skip (will replace later)
        continue;
      }
    }
    out.push(line);
  }
  // Append header and new entries
  const ts = new Date().toISOString();
  out.push('', `# === Auto-generated worker funding (${ts}) ===`);
  for (const [addrLower, amountWei] of Object.entries(addrToWei)) {
    out.push(`GENESIS_BALANCE_${addrLower}=${amountWei}`);
  }
  out.push('');
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const count = Number(args.count || 300);
  const offset = Number(args.offset || 0);
  const amountWei = toWeiDecimal({ eth: args.eth, wei: args.wei });

  if (!(count > 0)) {
    console.error('Invalid --count');
    process.exit(1);
  }
  if (offset < 0) {
    console.error('Invalid --offset');
    process.exit(1);
  }

  const addrToWei = {};
  for (let i = 0; i < count; i++) {
    const pk = pkForIndex(i, offset);
    const addr = new Wallet(pk).address.toLowerCase();
    addrToWei[addr] = amountWei;
  }

  const envPath = path.resolve(repoRoot, '.env');
  let lines = [];
  try {
    const cur = await fs.readFile(envPath, 'utf8');
    lines = cur.split(/\r?\n/);
  } catch { /* no .env yet */ }

  const next = await ensureEnvUpdated(lines, addrToWei);
  await fs.writeFile(envPath, next.join('\n'), 'utf8');
  console.log(`Wrote ${Object.keys(addrToWei).length} GENESIS_BALANCE_ entries to ${envPath}`);
  console.log(`Example: GENESIS_BALANCE_${Object.keys(addrToWei)[0]}=${amountWei}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
