#!/usr/bin/env node
// Patch ./config/genesis.json with a deterministic near-future timestamp so
// CL (prysmctl --genesis-time-delay) and EL share the same genesis time.
// Rationale: original upstream sets a fixed time before building both sides;
// this fork's Makefile calls this script first in `make init`.
// We choose: now + GENESIS_TIME_OFFSET_SEC (default 30s) rounded to seconds.

import fs from 'node:fs/promises';
import path from 'node:path';

const OFFSET = parseInt(process.env.GENESIS_TIME_OFFSET_SEC || '30', 10);
const targetTs = Math.floor(Date.now() / 1000) + OFFSET; // unix seconds
const hexTs = '0x' + targetTs.toString(16);

async function main() {
  const genesisPath = path.resolve('./config/genesis.json');
  let raw;
  try {
    raw = await fs.readFile(genesisPath, 'utf-8');
  } catch (e) {
    console.error('set-genesis-time: cannot read', genesisPath, e.message);
    process.exit(1);
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) {
    console.error('set-genesis-time: invalid JSON', e.message);
    process.exit(1);
  }

  const before = j.timestamp;
  j.timestamp = hexTs; // geth expects hex string

  await fs.writeFile(genesisPath, JSON.stringify(j, null, 2));
  console.log('set-genesis-time: updated timestamp', { before, after: j.timestamp });
  console.log('unix', targetTs, 'hex', hexTs);
  console.log('NOTE: run `make init` immediately so prysmctl delay (10s) stays aligned.');
}

main().catch(e => { console.error('set-genesis-time: fatal', e); process.exit(1); });
