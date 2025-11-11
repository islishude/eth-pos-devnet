#!/usr/bin/env node
// Refresh Engine API forkchoiceUpdated to current EL head for set1 geth.
// Run inside docker network context (like engine-seed). Requires /data mounted to read jwtsecret.
// Usage (example):
//   docker run --rm --network devnet_default \
//     -v $(pwd)/data:/data:ro -v $(pwd)/scripts:/scripts:ro node:22-alpine \
//     node /scripts/engine-refresh-fcu.mjs

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const ENGINE = {
  name: process.env.ENGINE_NAME || 'geth',
  jwt: process.env.ENGINE_JWT || '/data/geth/geth/jwtsecret',
  engineUrl: process.env.ENGINE_URL || 'http://geth:8551',
  rpcUrl: process.env.ENGINE_RPC_URL || 'http://geth:8545'
};

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function makeJwt(secretBuf) {
  let raw = secretBuf; if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw);
  let s = raw.toString('utf8').trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(s)) { try { key = Buffer.from(s,'hex'); } catch { key = raw; } } else { key = raw; }
  const header = base64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const payload = base64url(JSON.stringify({ iat: Math.floor(Date.now()/1000) }));
  const toSign = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', key).update(toSign).digest();
  return `${toSign}.${base64url(sig)}`;
}

async function rpc(url, jwt, method, params) {
  const res = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json', 'authorization':`Bearer ${jwt}` }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const j = await res.json(); if (j.error) throw new Error(`${method} error: ${j.error.message || j.error.code}`); return j.result;
}
async function ethRpc(url, method, params) {
  const res = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const j = await res.json(); if (j.error) throw new Error(`${method} error: ${j.error.message || j.error.code}`); return j.result;
}

async function main() {
  let secret;
  try { secret = await fs.readFile(ENGINE.jwt); } catch (e) { console.error('engine-refresh-fcu: jwtsecret missing:', e.message); process.exit(1); }
  const token = makeJwt(secret);
  // get current head block hash
  let headHash;
  try {
    const latest = await ethRpc(ENGINE.rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
    headHash = latest?.hash; if (!headHash) throw new Error('no latest.hash');
  } catch (e) { console.error('engine-refresh-fcu: failed to fetch latest block:', e.message); process.exit(1); }

  const state = { headBlockHash: headHash, safeBlockHash: headHash, finalizedBlockHash: headHash };
  const methods = ['engine_forkchoiceUpdatedV3','engine_forkchoiceUpdatedV2','engine_forkchoiceUpdated'];
  for (const m of methods) {
    try {
      const r = await rpc(ENGINE.engineUrl, token, m, [state, null]);
      console.log('engine-refresh-fcu:', m, 'status=', r?.payloadStatus?.status || r?.status || 'OK');
      return;
    } catch (e) {
      console.error('engine-refresh-fcu:', m, 'failed:', e.message);
    }
  }
  console.error('engine-refresh-fcu: all engine_forkchoiceUpdated variants failed');
  process.exit(1);
}

main().catch(e => { console.error('engine-refresh-fcu fatal:', e); process.exit(1); });
