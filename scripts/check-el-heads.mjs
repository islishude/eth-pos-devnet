#!/usr/bin/env node
import fetch from 'node-fetch';

const rpcs = [
  { name: 'geth', url: 'http://127.0.0.1:8545' },
  { name: 'geth-2', url: 'http://127.0.0.1:8547' },
  { name: 'geth-3', url: 'http://127.0.0.1:8548' },
];

async function call(url, method, params=[]) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || j.error.code);
  return j.result;
}

function hexToDec(hex) { return parseInt(hex, 16); }

(async () => {
  const heads = [];
  for (const rpc of rpcs) {
    try {
      const bn = await call(rpc.url, 'eth_blockNumber');
      heads.push({ name: rpc.name, hex: bn, dec: hexToDec(bn) });
    } catch (e) {
      heads.push({ name: rpc.name, error: e.message });
    }
  }
  heads.forEach(h => {
    if (h.error) console.log(`${h.name}: error ${h.error}`); else console.log(`${h.name}: block=${h.dec} (hex ${h.hex})`);
  });
  const numeric = heads.filter(h => !h.error).map(h => h.dec);
  if (numeric.length) {
    const min = Math.min(...numeric); const max = Math.max(...numeric);
    const spread = max - min;
    console.log(`Spread: max-min=${spread}`);
    if (spread > 50) console.log('WARNING: Large EL head spread indicates CL forkchoice desync.');
  }
})();
