#!/usr/bin/env node
// Warm up Engine API on set1 geth by calling forkchoiceUpdated with payloadAttributes
// to ensure EL can return a non-nil payloadId for upcoming block production.
// Intended to mitigate "Received nil payload ID on VALID engine response" after restarts.
// Run inside docker network with /data mounted read-only.

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
async function httpJson(url, body) {
  const res = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json(); return j;
}
async function ethRpc(url, method, params) {
  const res = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const j = await res.json(); if (j.error) throw new Error(`${method} error: ${j.error.message || j.error.code}`); return j.result;
}

function toHex(n) { return '0x' + n.toString(16); }
function rand32() { return '0x' + crypto.randomBytes(32).toString('hex'); }

async function main() {
  const retries = parseInt(process.env.WARM_RETRIES || '5', 10);
  const intervalMs = parseInt(process.env.WARM_INTERVAL_MS || '600', 10);
  const V3_ONLY = (process.env.WARM_V3_ONLY || '0') === '1';
  const REQUIRE_BEACON = (process.env.WARM_REQUIRE_BEACON || '0') === '1';
  let secret;
  try { secret = await fs.readFile(ENGINE.jwt); } catch (e) { console.error('engine-warm: jwtsecret missing:', e.message); process.exit(1); }
  const token = makeJwt(secret);

  const BEACON_URL = process.env.BEACON_URL;
  const ALIGN_BEACON = (process.env.WARM_ALIGN_BEACON || '1') !== '0';
  const VERIFY = (process.env.WARM_VERIFY || '0') === '1';
  let disableV2 = false;

  for (let attempt = 1; attempt <= retries; attempt++) {
    // refresh latest head and parent timestamp every attempt
    let latest;
    try { latest = await ethRpc(ENGINE.rpcUrl, 'eth_getBlockByNumber', ['latest', false]); }
    catch (e) { console.error('engine-warm: failed to fetch latest block:', e.message); process.exit(1); }
    const headHash = latest?.hash;
    const parentTsHex = latest?.timestamp || '0x0';
    const parentTs = Number.parseInt(String(parentTsHex), 16) || 0;
    if (!headHash) { console.error('engine-warm: no latest.hash'); process.exit(1); }
    // also try to fetch safe and finalized tags to provide better state to EL
    let safeHash = headHash;
    let finalizedHash = headHash;
    try {
      const safe = await ethRpc(ENGINE.rpcUrl, 'eth_getBlockByNumber', ['safe', false]);
      if (safe && safe.hash) safeHash = safe.hash;
    } catch (_) {}
    try {
      const finalized = await ethRpc(ENGINE.rpcUrl, 'eth_getBlockByNumber', ['finalized', false]);
      if (finalized && finalized.hash) finalizedHash = finalized.hash;
    } catch (_) {}

    // compute next timestamp
    let nextTs = Math.floor(Date.now()/1000);
    let parentBeaconBlockRoot = null;
    if (BEACON_URL && ALIGN_BEACON) {
      try {
        const gj = await (await fetch(`${BEACON_URL}/eth/v1/beacon/genesis`)).json();
        const sj = await (await fetch(`${BEACON_URL}/eth/v1/config/spec`)).json();
        const hj = await (await fetch(`${BEACON_URL}/eth/v1/beacon/headers/head`)).json();
        const genesisTime = parseInt(gj?.data?.genesis_time || '0', 10);
        const secondsPerSlot = parseInt(sj?.data?.SECONDS_PER_SLOT || '3', 10);
        parentBeaconBlockRoot = hj?.data?.root || null;
        if (genesisTime > 0 && secondsPerSlot > 0) {
          const now = Math.floor(Date.now()/1000);
          const curSlot = Math.max(0, Math.floor((now - genesisTime) / secondsPerSlot));
          const parentSlot = Math.max(0, Math.floor((parentTs - genesisTime) / secondsPerSlot));
          const nextSlot = Math.max(curSlot + 1, parentSlot + 1);
          nextTs = genesisTime + nextSlot * secondsPerSlot; // strict slot-aligned timestamp strictly > parent
        } else {
          nextTs = Math.max(nextTs, parentTs + 1);
        }
      } catch (e) {
        console.error('engine-warm: beacon align failed (attempt', attempt + '):', e.message);
        nextTs = Math.max(nextTs, parentTs + 1);
      }
    } else {
      nextTs = Math.max(nextTs, parentTs + 1);
    }

    if (REQUIRE_BEACON && !parentBeaconBlockRoot) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }
    }

  const state = { headBlockHash: headHash, safeBlockHash: safeHash, finalizedBlockHash: finalizedHash };
    // Fetch real prevRandao from beacon head block if available
    let prevRandao = rand32(); // fallback
    if (BEACON_URL) {
      try {
        const bh = await (await fetch(`${BEACON_URL}/eth/v2/beacon/blocks/head`)).json();
        const maybeRandao = bh?.data?.message?.body?.randao;
        if (maybeRandao && /^0x[0-9a-fA-F]{64}$/.test(maybeRandao)) {
          prevRandao = maybeRandao;
        }
      } catch (e) {
        console.error('engine-warm: could not fetch beacon randao:', e.message);
      }
    }
    const attrsV2 = {
      timestamp: toHex(nextTs),
      prevRandao,
      suggestedFeeRecipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      withdrawals: []
    };
    const attrsV3 = { ...attrsV2 };
    if (parentBeaconBlockRoot) attrsV3.parentBeaconBlockRoot = parentBeaconBlockRoot;

    const variants = [];
    if (parentBeaconBlockRoot) variants.push({ method: 'engine_forkchoiceUpdatedV3', params: [state, attrsV3] });
    if (!V3_ONLY && !disableV2) variants.push({ method: 'engine_forkchoiceUpdatedV2', params: [state, attrsV2] });
    if (variants.length === 0) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }
    }

  // ensure timestamp monotonic while keeping slot alignment preference
  const nowTs = Math.floor(Date.now()/1000);
  let ts = nextTs;
  if (ts <= parentTs) ts = parentTs + 1; // safety
  if (ts < nowTs) ts = nowTs; // do not go into the past
    attrsV2.timestamp = toHex(ts);
    if (attrsV3) attrsV3.timestamp = attrsV2.timestamp;

    for (const v of variants) {
      try {
        const r = await rpc(ENGINE.engineUrl, token, v.method, v.params);
        const status = r?.payloadStatus?.status || r?.status || 'OK';
        const pid = r?.payloadId || null;
        const validationError = r?.payloadStatus?.validationError || null;
        console.log('engine-warm: attempt', attempt, v.method, 'status=', status, 'payloadId=', pid || 'null', 'timestamp=', attrsV2.timestamp, validationError ? ('validationError='+validationError) : '');
        if (pid && VERIFY) {
          // Try getPayload to ensure it's materialized
          try {
            try { await rpc(ENGINE.engineUrl, token, 'engine_getPayloadV3', [pid]); }
            catch { await rpc(ENGINE.engineUrl, token, 'engine_getPayloadV2', [pid]); }
            console.log('engine-warm: verified payload fetched for', pid);
          } catch (e) {
            console.error('engine-warm: getPayload verify failed:', e.message);
          }
        }
        if (pid) return; // success
        // If VALID but no payloadId, nudge timestamp and retry once immediately for this variant
        if (!pid && String(status).toUpperCase() === 'VALID') {
          const bumped = Math.max(parseInt(attrsV2.timestamp, 16) + 1, parentTs + attempt + 1);
          attrsV2.timestamp = toHex(bumped);
          if (attrsV3) attrsV3.timestamp = attrsV2.timestamp;
          try {
            const r2 = await rpc(ENGINE.engineUrl, token, v.method, v.params);
            const pid2 = r2?.payloadId || null;
            const status2 = r2?.payloadStatus?.status || r2?.status || 'OK';
            console.log('engine-warm: immediate retry', v.method, 'status=', status2, 'payloadId=', pid2 || 'null', 'timestamp=', attrsV2.timestamp);
            if (pid2) return;
          } catch (e2) {
            console.error('engine-warm:', v.method, 'immediate retry failed:', e2.message);
          }
        }
      } catch (e) {
        console.error('engine-warm:', v.method, 'attempt', attempt, 'failed:', e.message);
        if (v.method === 'engine_forkchoiceUpdatedV2' && /Unsupported fork/i.test(e.message)) {
          disableV2 = true; // don't keep trying V2
        }
      }
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, intervalMs));
  }
  // Final fallback legacy FCU
  try {
    const latest = await ethRpc(ENGINE.rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
    const headHash = latest?.hash;
    if (headHash) {
      const state = { headBlockHash: headHash, safeBlockHash: headHash, finalizedBlockHash: headHash };
      const r = await rpc(ENGINE.engineUrl, token, 'engine_forkchoiceUpdated', [state, null]);
      console.log('engine-warm: fallback legacy FCU status=', r?.status || 'OK');
    }
  } catch (e) {
    console.error('engine-warm: fallback legacy FCU failed:', e.message);
  }
  process.exit(2); // signal no payloadId obtained
}

main().catch(e => { console.error('engine-warm fatal:', e); process.exit(1); });
