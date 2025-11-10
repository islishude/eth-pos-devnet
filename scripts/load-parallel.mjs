#!/usr/bin/env node
/**
 * load-parallel.mjs
 * 3ノード (任意個数) に対して scripts/load-forward.mjs を並列起動し、結果を集計するヘルパー。
 * 使い方 (例):
 *   PER_NODE_TARGET_TPS=50 PER_NODE_WORKERS=60 DURATION_SEC=30 ENDPOINTS=http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548 node scripts/load-parallel.mjs
 * もしくは TOTAL_TARGET_TPS=150 TOTAL_WORKERS=180 で自動均等割り。
 * 環境変数:
 *   ENDPOINTS              カンマ区切り RPC URL (必須)
 *   PER_NODE_TARGET_TPS    ノードごとの TARGET_TPS 指定 (TOTAL_TARGET_TPS より優先)
 *   TOTAL_TARGET_TPS       全体 TPS 指定 (均等割り)
 *   PER_NODE_WORKERS       ノードごとの WORKERS 指定 (TOTAL_WORKERS より優先)
 *   TOTAL_WORKERS          全体 worker 数 (均等割り)
 *   DURATION_SEC           実行秒数 (各子プロセスへ継承)
 *   EXTRA_ENV              追加で子へ渡したい "KEY=VAL KEY2=VAL2" 形式 (任意)
 *   SIMPLE_FORWARDER_ADDRESS forwarder コントラクトアドレス (load-forward に必要)
 * 既定で ONLY_HTTP=1 USE_RAW_SEND=1 BURST_MULTIPLIER=1 を付与。
 */
import { spawn } from 'child_process';

function parseList(v) {
  return (v || '').split(/[,\s]+/).filter(Boolean);
}

const endpoints = parseList(process.env.ENDPOINTS);
if (endpoints.length === 0) {
  console.error('ERROR: ENDPOINTS を指定してください (例: ENDPOINTS=http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548)');
  process.exit(1);
}

const n = endpoints.length;
const perNodeTps = process.env.PER_NODE_TARGET_TPS ? Number(process.env.PER_NODE_TARGET_TPS) : null;
const totalTps = process.env.TOTAL_TARGET_TPS ? Number(process.env.TOTAL_TARGET_TPS) : null;
const perNodeWorkers = process.env.PER_NODE_WORKERS ? Number(process.env.PER_NODE_WORKERS) : null;
const totalWorkers = process.env.TOTAL_WORKERS ? Number(process.env.TOTAL_WORKERS) : null;
const duration = Number(process.env.DURATION_SEC || 30);

// 均等割りヘルパー (余りは先頭ノードへ順次加算)
function evenSplit(total, parts) {
  const base = Math.floor(total / parts);
  const arr = Array(parts).fill(base);
  let rem = total - base * parts;
  for (let i = 0; i < parts && rem > 0; i++, rem--) arr[i]++;
  return arr;
}

let tpsList, workersList;
if (perNodeTps != null) {
  tpsList = Array(n).fill(perNodeTps);
} else if (totalTps != null) {
  tpsList = evenSplit(totalTps, n);
} else {
  // デフォルト: TPS未指定 (unlimited) → 0 を渡す
  tpsList = Array(n).fill(0);
}

if (perNodeWorkers != null) {
  workersList = Array(n).fill(perNodeWorkers);
} else if (totalWorkers != null) {
  workersList = evenSplit(totalWorkers, n);
} else {
  // デフォルト worker 少数
  workersList = Array(n).fill(8);
}

const extraEnvPairs = (process.env.EXTRA_ENV || '').trim();
function parseExtraEnv(str) {
  if (!str) return {};
  const out = {};
  str.split(/\s+/).filter(Boolean).forEach(kv => {
    const idx = kv.indexOf('=');
    if (idx > 0) {
      const k = kv.slice(0, idx);
      const v = kv.slice(idx + 1);
      out[k] = v;
    }
  });
  return out;
}
const extraEnv = parseExtraEnv(extraEnvPairs);

console.log(`Parallel load start: duration=${duration}s nodes=${n}`);
console.log('Per-node plan:');
for (let i = 0; i < n; i++) {
  console.log(`  [${i}] endpoint=${endpoints[i]} TARGET_TPS=${tpsList[i]} WORKERS=${workersList[i]}`);
}

// 子プロセス生成
const children = []; // { idx, proc, stats }
const summaries = []; // 集計行テキスト格納

function launchNode(i) {
  const env = {
    ...process.env,
    TARGET_TPS: String(tpsList[i]),
    WORKERS: String(workersList[i]),
    DURATION_SEC: String(duration),
    RPC_URLS: endpoints[i], // 単一 endpoint 固定
    ONLY_HTTP: '1',
    USE_RAW_SEND: '1',
    BURST_MULTIPLIER: process.env.BURST_MULTIPLIER || '1',
  // FUND_WORKERS/FUND_TOP_N が明示的に与えられていればそれを優先、なければ子0のみ資金補充
  FUND_WORKERS: process.env.FUND_WORKERS !== undefined ? process.env.FUND_WORKERS : (i === 0 ? '1' : '0'),
  FUND_TOP_N: process.env.FUND_TOP_N !== undefined ? process.env.FUND_TOP_N : (i === 0 ? String(workersList.reduce((a,b)=>a+b,0)) : '0'),
  FUND_WAIT: process.env.FUND_WAIT || '1',
    URL_OFFSET: String(i),
    ACCOUNT_OFFSET: String(workersList.slice(0, i).reduce((a,b)=>a+b,0)),
    ...extraEnv
  };
  // Failoverさせるため、各子に全ENDPOINTSを渡す（load-forward側がURL_OFFSETで分散）
  env.RPC_URLS = endpoints.join(',');
  const proc = spawn('node', ['scripts/load-forward.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = { idx: i, proc, endpoint: endpoints[i] };
  children.push(child);
  proc.stdout.on('data', d => handleOutput(child, d.toString(), false));
  proc.stderr.on('data', d => handleOutput(child, d.toString(), true));
  proc.on('exit', (code) => {
    console.log(`[node ${i}] exited code=${code}`);
  });
}

function handleOutput(child, text, isErr) {
  text.split(/\r?\n/).filter(Boolean).forEach(line => {
    // done: sent=123 succ=120 fail=0
    const m = line.match(/\b(?:done|final): sent=(\d+) succ=(\d+) fail=(\d+)/);
    if (m) {
      summaries.push(JSON.stringify({ idx: child.idx, sent: Number(m[1]), succ: Number(m[2]), fail: Number(m[3]) }));
    }
    const prefix = isErr ? `[node ${child.idx} ERR]` : `[node ${child.idx}]`;
    console.log(prefix + ' ' + line);
  });
}

// funding 子(0)を先に起動し、残りは遅延起動して資金反映待ちを軽減
const FUND_LAUNCH_DELAY_MS = Number(process.env.FUND_LAUNCH_DELAY_MS || 4000);
launchNode(0);

function startAggregation() {
  // 全子終了待ち → 集計
  Promise.all(children.map(c => new Promise(res => c.proc.on('exit', res)))).then(() => {
    let totalSent = 0, totalSucc = 0, totalFail = 0;
    const perNode = [];
    summaries.forEach(s => {
      try {
        const o = JSON.parse(s);
        totalSent += o.sent; totalSucc += o.succ; totalFail += o.fail; perNode.push(o);
      } catch { /* ignore */ }
    });
    perNode.sort((a,b)=>a.idx-b.idx);
    console.log('==== Parallel summary ====');
    perNode.forEach(o => console.log(`node${o.idx}: sent=${o.sent} succ=${o.succ} fail=${o.fail}`));
    console.log(`TOTAL: sent=${totalSent} succ=${totalSucc} fail=${totalFail}`);
    // 簡易TPS (成功のみ / duration)
    const tps = (totalSucc / duration).toFixed(2);
    console.log(`Approx TPS (succ/duration): ${tps}`);
    process.exit(0);
  }).catch(e => {
    console.error('Parallel load error', e);
    process.exit(1);
  });
}

// 集約開始は残りの子を起動した直後に行う（children 配列が全て揃ってから）
setTimeout(() => {
  for (let i = 1; i < n; i++) launchNode(i);
  // 少しだけ出力ハンドラ登録を待ってから集約開始
  setTimeout(startAggregation, 50);
}, FUND_LAUNCH_DELAY_MS);
