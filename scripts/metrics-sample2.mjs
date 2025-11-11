#!/usr/bin/env node
/**
 * metrics-sample2.mjs
 * 目的: 毎秒のEL/CL/Validatorとネットワーク全体のユニーク指標をCSVに分割出力。
 * 方針: 数値中心、bool/hash不要、重複集約はしない（ネットワークCSVはAPI由来のみ）。
 * 環境変数: ENDPOINTS, BEACON_URLS, INTERVAL_MS, DURATION_SEC のみ。
 */

import fs from 'node:fs';
import path from 'node:path';

function parseList(v, def) {
  const s = (v ?? def).trim();
  return s ? s.split(/[\s,]+/).filter(Boolean) : [];
}

const EL_ENDPOINTS = parseList(process.env.ENDPOINTS, 'http://geth:8545,http://geth-2:8545,http://geth-3:8545');
const CL_ENDPOINTS = parseList(process.env.BEACON_URLS, 'http://prysm:3500,http://prysm-2:3500,http://prysm-3:3500');
const EL_INDEX = Object.fromEntries(EL_ENDPOINTS.map((e,i)=>[e,i]));
const CL_INDEX = Object.fromEntries(CL_ENDPOINTS.map((e,i)=>[e,i]));
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1000);
const DURATION_SEC = Number(process.env.DURATION_SEC || 0);

// slots per epoch は config/config.yml から読む（なければ6）
function readSlotsPerEpoch() {
  try {
    const cfgPath = path.join(process.cwd(), 'config', 'config.yml');
    if (fs.existsSync(cfgPath)) {
      const txt = fs.readFileSync(cfgPath, 'utf8');
      const m = txt.match(/SLOTS_PER_EPOCH\s*:\s*(\d+)/i);
      if (m) return Number(m[1]);
    }
  } catch {}
  return 6;
}
const SLOTS_PER_EPOCH = readSlotsPerEpoch();

// コンテナ名はサービス種別 + 1始まりインデックスで記録 (例: geth-1,geth-2 / prysm-1,prysm-2)
function elContainerName(i) { return `geth-${i+1}`; }
function clContainerName(i) { return `prysm-${i+1}`; }
// 分割出力用のCSVファイル（EL/CL/Validator）
let EL_CSV = '';
let CL_CSV = '';
let VAL_CSV = '';
let NET_CSV = '';
function tsBase() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function initCsvFiles() {
  const dir = './metrics';
  fs.mkdirSync(dir, { recursive: true });
  const base = tsBase();
  EL_CSV = path.join(dir, `el-${base}.csv`);
  CL_CSV = path.join(dir, `cl-${base}.csv`);
  VAL_CSV = path.join(dir, `validator-${base}.csv`);
  NET_CSV = path.join(dir, `net-${base}.csv`);
  const elHeader = [
    // 動的指標のみ（静的/布尔は除外）
    'ts_ms','container_name','latency_ms',
    'block_number','basefee_wei','gasprice_wei','block_gas_used','block_gas_limit','peer_count','txpool_pending','txpool_queued',
    'block_tx_count'
  ].join(',') + '\n';
  const clHeader = [
    // 動的指標のみ（bool/hashは除外）
    'ts_ms','container_name','latency_ms','peer_connected',
    'sync_distance','head_slot','justified_epoch','finalized_epoch',
    'current_epoch','head_finality_gap_slots'
  ].join(',') + '\n';
  const valHeader = [
    // boolは出力しない
    'ts_ms','source_container','active_validator_count','avg_effective_balance_gwei'
  ].join(',') + '\n';
  const netHeader = [
    // ネットワーク全体API由来のユニークな指標（重複/集約は含めない）
    'ts_ms',
    // Finality/進捗に関わるネットワーク状態
    'head_slot','current_epoch','justified_epoch','finalized_epoch','finality_gap_slots','finality_gap_epochs',
    // 集約的に意味を持つ最小限のバリデータ指標
    'validators_total','activation_queue_len','exit_queue_len','active_validator_count'
  ].join(',') + '\n';
  fs.writeFileSync(EL_CSV, elHeader);
  fs.writeFileSync(CL_CSV, clHeader);
  fs.writeFileSync(VAL_CSV, valHeader);
  fs.writeFileSync(NET_CSV, netHeader);
}

function unixMs() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function jsonRpc(url, method, params = []) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const t1 = Date.now();
  const latency = t1 - t0;
  if (!res.ok) throw Object.assign(new Error(`${method} HTTP ${res.status}`), { latency });
  const json = await res.json();
  if (json.error) throw Object.assign(new Error(`${method} error: ${json.error.message || json.error.code}`), { latency });
  return { result: json.result, latency };
}

async function beaconGet(url, path) {
  const t0 = Date.now();
  const res = await fetch(url.replace(/\/$/, '') + path, { headers: { 'accept': 'application/json' } });
  const t1 = Date.now();
  const latency = t1 - t0;
  if (!res.ok) throw Object.assign(new Error(`${path} HTTP ${res.status}`), { latency });
  const json = await res.json();
  return { json, latency };
}

async function beaconGetRaw(url, path) {
  const t0 = Date.now();
  const res = await fetch(url.replace(/\/$/, '') + path);
  const t1 = Date.now();
  const latency = t1 - t0;
  return { status: res.status, latency };
}

function csvEsc(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function appendCsvRow(file, columns) { fs.appendFileSync(file, columns.map(csvEsc).join(',') + '\n'); }

function hexToNum(h) { try { return Number(BigInt(h)); } catch { return null; } }

const MISSING = -1;

async function sampleEl(endpoint) {
  const ts_ms = unixMs();
  const endpoint_idx = EL_INDEX[endpoint] ?? MISSING;
  const containerName = elContainerName(endpoint_idx);
  let el_latency = MISSING;
  let blockNumber = MISSING, basefee = MISSING, gasprice = MISSING, gasUsed = MISSING, gasLimit = MISSING;
  let peerCount = MISSING, pend = MISSING, que = MISSING, errorFlag = 0;
  let blockTxCount = MISSING;
  // syncing (bool) は出力対象外のため取得省略
  try { const { result: gp } = await jsonRpc(endpoint, 'eth_gasPrice', []); gasprice = hexToNum(gp) ?? MISSING; } catch { errorFlag = 1; }
  try { const { result: bn, latency: l1 } = await jsonRpc(endpoint, 'eth_blockNumber', []); el_latency = l1; blockNumber = hexToNum(bn) ?? MISSING; } catch { errorFlag = 1; }
  try { const { result: blk } = await jsonRpc(endpoint, 'eth_getBlockByNumber', ['latest', false]); if (blk) { basefee = hexToNum(blk.baseFeePerGas) ?? MISSING; gasUsed = hexToNum(blk.gasUsed) ?? MISSING; gasLimit = hexToNum(blk.gasLimit) ?? MISSING; } } catch { errorFlag = 1; }
  try { const { result: txc } = await jsonRpc(endpoint, 'eth_getBlockTransactionCountByNumber', ['latest']); blockTxCount = hexToNum(txc) ?? MISSING; } catch { errorFlag = 1; }
  try { const { result: pc } = await jsonRpc(endpoint, 'net_peerCount', []); peerCount = hexToNum(pc) ?? MISSING; } catch { errorFlag = 1; }
  try { const { result: st } = await jsonRpc(endpoint, 'txpool_status', []); pend = hexToNum(st?.pending) ?? MISSING; que = hexToNum(st?.queued) ?? MISSING; } catch { errorFlag = 1; }
  appendCsvRow(EL_CSV,[
    ts_ms,containerName,
    el_latency,
    blockNumber,basefee,gasprice,gasUsed,gasLimit,
    peerCount,pend,que,
    blockTxCount
  ]);
  return { ts_ms, containerName, el_latency, blockNumber, basefee, gasprice, gasUsed, gasLimit, peerCount, pend, que, blockTxCount };
}

async function sampleCl(endpoint) {
  const ts_ms = unixMs();
  const endpoint_idx = CL_INDEX[endpoint] ?? MISSING;
  const containerName = clContainerName(endpoint_idx);
  let cl_latency = MISSING, pConn = MISSING;
  let syncDistance = MISSING, headSlot = MISSING, justEpoch = MISSING, finEpoch = MISSING, errorFlag = 0;
  try { const { latency: l } = await beaconGetRaw(endpoint, '/eth/v1/node/health'); cl_latency = l; } catch { errorFlag = 1; }
  try { const { json } = await beaconGet(endpoint, '/eth/v1/node/peer_count'); const d = json.data || {}; pConn = Number(d.connected ?? d?.peer_count ?? MISSING); } catch { errorFlag = 1; }
  try { const { json } = await beaconGet(endpoint, '/eth_v1/node/syncing'.replace('_','/')); const data = json.data || {}; syncDistance = Number(data.sync_distance ?? MISSING); if (data.head_slot !== undefined) headSlot = Number(data.head_slot); } catch { errorFlag = 1; }
  try { const { json } = await beaconGet(endpoint, '/eth/v1/beacon/headers/head'); const d = json.data || {}; headSlot = headSlot !== MISSING ? headSlot : Number(d?.header?.message?.slot ?? d?.slot ?? MISSING); } catch { errorFlag = 1; }
  try { const { json } = await beaconGet(endpoint, '/eth/v1/beacon/states/head/finality_checkpoints'); const d = json.data || {}; justEpoch = Number(d?.current_justified?.epoch ?? MISSING); finEpoch = Number(d?.finalized?.epoch ?? MISSING); } catch { errorFlag = 1; }
  const finSlot = (finEpoch !== MISSING && Number.isFinite(SLOTS_PER_EPOCH)) ? finEpoch * SLOTS_PER_EPOCH : MISSING;
  const curEpoch = (headSlot !== MISSING && Number.isFinite(SLOTS_PER_EPOCH)) ? Math.floor(headSlot / SLOTS_PER_EPOCH) : MISSING;
  const headFinalGap = (headSlot !== MISSING && finSlot !== MISSING) ? Math.max(0, headSlot - finSlot) : MISSING;
  appendCsvRow(CL_CSV,[
    ts_ms,containerName,
    cl_latency,pConn,
    syncDistance,headSlot,justEpoch,finEpoch,
    curEpoch,headFinalGap
  ]);
  return { ts_ms, containerName, cl_latency, pConn, syncDistance, headSlot, justEpoch, finEpoch, curEpoch, headFinalGap };
}

async function sampleNetwork() {
  const endpoint = CL_ENDPOINTS[0];
  const ts_ms = unixMs();
  // head/epoch/finality 関連
  let headSlot = -1, curEpoch = -1, justEpoch = -1, finEpoch = -1;
  let finGapSlots = -1, finGapEpochs = -1;
  let cPendInit = -1, cPendQueue = -1, cActOngo = -1, cActExit = -1;
  try { const { json } = await beaconGet(endpoint, '/eth/v1/beacon/headers/head'); const d = json.data || {}; headSlot = Number(d?.header?.message?.slot ?? d?.slot ?? -1); } catch {}
  try { const { json } = await beaconGet(endpoint, '/eth/v1/beacon/states/head/finality_checkpoints'); const d = json.data || {}; justEpoch = Number(d?.current_justified?.epoch ?? -1); finEpoch = Number(d?.finalized?.epoch ?? -1); } catch {}
  curEpoch = (headSlot >= 0 && Number.isFinite(SLOTS_PER_EPOCH)) ? Math.floor(headSlot / SLOTS_PER_EPOCH) : -1;
  const finSlot = (finEpoch >= 0 && Number.isFinite(SLOTS_PER_EPOCH)) ? finEpoch * SLOTS_PER_EPOCH : -1;
  finGapSlots = (headSlot >= 0 && finSlot >= 0) ? Math.max(0, headSlot - finSlot) : -1;
  finGapEpochs = (curEpoch >= 0 && finEpoch >= 0) ? Math.max(0, curEpoch - finEpoch) : -1;
  async function countStatus(statuses) {
    try {
      const { json } = await beaconGet(endpoint, `/eth/v1/beacon/states/head/validators?status=${statuses}`);
      return Array.isArray(json?.data) ? json.data.length : -1;
    } catch { return -1; }
  }
  cPendInit = await countStatus('pending_initialized');
  cPendQueue = await countStatus('pending_queued');
  cActOngo = await countStatus('active_ongoing');
  cActExit = await countStatus('active_exiting');
  const total = [cPendInit,cPendQueue,cActOngo,cActExit].filter(n=>n>=0).reduce((a,b)=>a+b,0) || -1;
  const activationQueueLen = (cPendInit>=0 && cPendQueue>=0) ? (cPendInit + cPendQueue) : -1;
  const exitQueueLen = cActExit;
  const activeValidatorCount = cActOngo;
  appendCsvRow(NET_CSV,[
    ts_ms,
    headSlot, curEpoch, justEpoch, finEpoch, finGapSlots, finGapEpochs,
    total, activationQueueLen, exitQueueLen, activeValidatorCount
  ]);
}

async function sampleValidators() {
  const ts_ms = unixMs();
  // 代表として最初の CL エンドポイントを使用
  const endpoint = CL_ENDPOINTS[0];
  let activeCount = -1, avgBal = -1;
  let source = 'validator-1';
  try {
    const { json } = await beaconGet(endpoint, '/eth/v1/beacon/states/head/validators?status=active');
    const arr = (json.data || []).map(v => Number(v?.balance ?? v?.effective_balance ?? -1)).filter(n => n >= 0);
    if (arr.length) {
      activeCount = arr.length;
      let sum = 0;
      for (const b of arr) { sum += b; }
      avgBal = Math.round(sum / arr.length);
    }
  } catch {}
  appendCsvRow(VAL_CSV,[ts_ms, source, activeCount, avgBal]);
}

async function main() {
  // graceful stop on Ctrl+C / SIGTERM
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });
  initCsvFiles();
  const endAt = DURATION_SEC > 0 ? Date.now() + DURATION_SEC * 1000 : Number.POSITIVE_INFINITY;
  // 固定レート(既定1秒)でサンプリング: 処理時間を含めて厳密に1Hzを目指す
  let nextAt = Date.now();
  while (!stop && Date.now() < endAt) {
    await Promise.allSettled([
      ...EL_ENDPOINTS.map(e => sampleEl(e)),
      ...CL_ENDPOINTS.map(b => sampleCl(b)),
      sampleValidators(),
      sampleNetwork(),
    ]);
    nextAt += INTERVAL_MS; // 次のターゲット時刻
    const now = Date.now();
    const delay = Math.max(0, nextAt - now);
    if (delay > 0) await sleep(delay);
  }
  console.log('metrics-sample2: done');
}

main().catch(e => { console.error('metrics-sample2 fatal:', e); process.exit(1); });
