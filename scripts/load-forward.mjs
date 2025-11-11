#!/usr/bin/env node
/**
 * SimpleForwarder load generator using ethers v6.
 * - Concurrent workers each send signed tx calling forward(recipient) on predeployed SimpleForwarder.
 * - Rotates across WS and HTTP RPC endpoints with sticky per-worker selection and failure fallback.
 * - Funds worker wallets on first run using deployer key if balances are low.
 */
import { JsonRpcProvider, WebSocketProvider, Wallet, Interface, parseEther, toQuantity } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SimpleForwarder ABI loader (lazy; only when DIRECT_TRANSFER=0)
function resolveAbiPath() {
  const candidates = [
    path.resolve(__dirname, './contracts/build/SimpleForwarder.json'),
    path.resolve(__dirname, '../contracts/build/SimpleForwarder.json')
  ];
  for (const p of candidates) {
    try { fs.accessSync(p); return p; } catch { /* ignore */ }
  }
  return null;
}
let simpleIface = null;

// Config
const DURATION_SEC = Number(process.env.DURATION_SEC || 20);
const WORKERS = Number(process.env.WORKERS || 4);
const INFLIGHT_PER_WORKER = Number(process.env.INFLIGHT_PER_WORKER || 4);
const TARGET_TPS = Number(process.env.TARGET_TPS || 0); // 0 = unlimited
const BUCKET_INTERVAL_MS = Number(process.env.BUCKET_INTERVAL_MS || 100);
const BURST_MULTIPLIER = Number(process.env.BURST_MULTIPLIER || 2);
const VALUE_ETH = process.env.VALUE_ETH || '0.02';
const GAS_LIMIT = Number(process.env.GAS_LIMIT || 160000);
const GAS_PRICE_GWEI = Number(process.env.GAS_PRICE_GWEI || 1);
const URL_OFFSET = Number(process.env.URL_OFFSET || 0);
const ACCOUNT_OFFSET = Number(process.env.ACCOUNT_OFFSET || 0);
let RPC_URLS = (process.env.RPC_URLS || 'ws://127.0.0.1:8546,ws://127.0.0.1:8549,ws://127.0.0.1:8550,http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548')
  .split(/[\s,]+/).filter(Boolean);
const ONLY_HTTP = process.env.ONLY_HTTP === '1' || process.env.ONLY_HTTP === 'true';
if (ONLY_HTTP) {
  RPC_URLS = RPC_URLS.filter(u => u.startsWith('http'));
}
const SIMPLE_FORWARDER_ADDRESS = process.env.SIMPLE_FORWARDER_ADDRESS || resolveContractAddress();
const RECIPIENTS = (process.env.TRANSFER_RECIPIENTS || '0x70997970c51812dc3a010c7d01b50e0d17dc79c8,0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc,0x15d34aaf54267db7d7c367839aaf71a00a2c6a65')
  .split(/[\s,]+/).filter(Boolean).map(a => a.trim().toLowerCase());
const FUND_TARGET_ETH = process.env.WORKER_TARGET_ETH || '200';
const FUND_WORKERS = process.env.FUND_WORKERS === '0' || process.env.FUND_WORKERS === 'false' ? false : true;
const FUND_TOP_N = Number(process.env.FUND_TOP_N || WORKERS);
const FUND_WAIT = process.env.FUND_WAIT === '0' || process.env.FUND_WAIT === 'false' ? false : true;
const DEPLOYER_PK = process.env.DEPLOYER_PK || process.env.CONTRACT_DEPLOYER_PK;

// Enforce contract address only when we actually call the contract
// (DIRECT_TRANSFER=1 の場合は前方コントラクトを使わない)
function ensureForwarderReadyIfNeeded(directTransfer) {
  if (directTransfer) return; // not needed
  if (!SIMPLE_FORWARDER_ADDRESS) {
    console.error('Missing SimpleForwarder address. Set SIMPLE_FORWARDER_ADDRESS');
    process.exit(1);
  }
  if (!simpleIface) {
    const abiPath = resolveAbiPath();
    if (!abiPath) {
      console.error('Unable to locate SimpleForwarder ABI. Provide scripts/contracts/build/SimpleForwarder.json or contracts/build/SimpleForwarder.json');
      process.exit(1);
    }
    const simpleAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8')).abi;
    simpleIface = new Interface(simpleAbi);
  }
}
function resolveContractAddress() { return undefined; }

// Provider factory with graceful fallback
function createProvider(url) {
  if (url.startsWith('ws')) {
    return new WebSocketProvider(url);
  }
  return new JsonRpcProvider(url);
}

function pickHttpUrl() {
  const http = RPC_URLS.find(u => u.startsWith('http'));
  return http || 'http://127.0.0.1:8545';
}

function createTokenBucket() {
  if (!(TARGET_TPS > 0)) return null;
  const capacity = Math.max(1, Math.ceil(TARGET_TPS * BURST_MULTIPLIER));
  const bucket = { capacity, tokens: capacity, timer: null };
  const addPerTick = Math.max(1, Math.floor(TARGET_TPS * BUCKET_INTERVAL_MS / 1000));
  bucket.timer = setInterval(() => {
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + addPerTick);
  }, BUCKET_INTERVAL_MS);
  return bucket;
}

async function acquireToken(bucket, endAt) {
  if (!bucket) return true; // unlimited
  while (Date.now() < endAt) {
    if (bucket.tokens > 0) { bucket.tokens--; return true; }
    await sleep(1);
  }
  return false;
}

// Round-robin across urls
function urlForWorker(i) {
  for (let k = 0; k < RPC_URLS.length; k++) {
    const idx = (i + URL_OFFSET + k) % RPC_URLS.length;
    const u = RPC_URLS[idx];
    if (u) return u;
  }
  return RPC_URLS[0];
}

// Simple forward data encoding
function encodeForward(to) {
  return simpleIface.encodeFunctionData('forward', [to]);
}

function workerKey(i) {
  // 0x000...001, 0x...002, ...
  const v = BigInt(i + ACCOUNT_OFFSET + 1).toString(16).padStart(64, '0');
  return '0x' + v;
}

async function fundWorkersIfNeeded(provider, receiptProvider) {
  if (!DEPLOYER_PK || !FUND_WORKERS) return;
  const wallet = new Wallet(DEPLOYER_PK, provider);
  const chainId = (await provider.getNetwork()).chainId;
  const target = parseEther(FUND_TARGET_ETH);
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  // WORKERS に依存せず FUND_TOP_N 件まで資金補充 (並列ランナーで総ワーカー数分を渡すケース対応)
  const max = FUND_TOP_N;
  for (let i = 0; i < max; i++) {
    const w = new Wallet(workerKey(i));
    const bal = await provider.getBalance(w.address);
    if (bal < target) {
      const topUp = target - bal;
      const tx = {
        to: w.address,
        value: topUp,
        gasLimit: 21000n,
        gasPrice: BigInt(GAS_PRICE_GWEI) * 1_000_000_000n,
        nonce: nonce++,
        chainId
      };
      try {
        const sent = await wallet.sendTransaction(tx);
        if (FUND_WAIT) {
          await (receiptProvider || provider).waitForTransaction(sent.hash);
        }
        console.log(`funded ${w.address} with ${topUp} wei, tx ${sent.hash}`);
      } catch (e) {
        console.log(`fund failed for ${w.address}: ${e?.message}`);
      }
    }
  }
}

const TX_TIMEOUT_MS = Number(process.env.TX_TIMEOUT_MS || 4000);
const GRACE_EXIT_MS = Number(process.env.GRACE_EXIT_MS || 3000);
const RECEIPT_DRAIN_MS = Number(process.env.RECEIPT_DRAIN_MS || 0);
const USE_RAW_SEND = process.env.USE_RAW_SEND === '1' || process.env.USE_RAW_SEND === 'true';
const DIRECT_TRANSFER = process.env.DIRECT_TRANSFER === '1' || process.env.DIRECT_TRANSFER === 'true';

async function runWorker(i, endAt, stats, receiptProvider, bucket) {
  let urlIdx = 0;
  let url = urlForWorker(i);
  let provider = createProvider(url);
  const wallet = new Wallet(workerKey(i), provider);
  const value = parseEther(VALUE_ETH);
  const gasLimit = BigInt(DIRECT_TRANSFER ? 21000 : GAS_LIMIT);
  const gasPrice = BigInt(GAS_PRICE_GWEI) * 1_000_000_000n + BigInt(i + 1) * 100_000_000n;
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  let recipientIdx = i % RECIPIENTS.length;

  const network = await provider.getNetwork();
  const sendWithTimeout = async (tx) => {
    const sendPromise = (async () => {
      if (USE_RAW_SEND) {
        // Ensure chainId on the tx for signing
        const txWithChain = { ...tx, chainId: network.chainId };
        const raw = await wallet.signTransaction(txWithChain);
        return provider.send('eth_sendRawTransaction', [raw]).then((hash) => ({ hash }));
      } else {
        return wallet.sendTransaction(tx);
      }
    })();
    return Promise.race([
      sendPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('tx-send-timeout')), TX_TIMEOUT_MS))
    ]);
  };

  const pending = new Set();

  const launchSend = async () => {
    const to = RECIPIENTS[recipientIdx % RECIPIENTS.length];
    recipientIdx++;
    const data = DIRECT_TRANSFER ? undefined : encodeForward(to);
    const toAddr = DIRECT_TRANSFER ? to : SIMPLE_FORWARDER_ADDRESS;
    const tx = {
      to: toAddr,
      value,
      gasLimit,
      gasPrice,
      nonce: nonce++,
      ...(DIRECT_TRANSFER ? {} : { data })
    };
    const doSend = async () => {
      try {
        const sent = await sendWithTimeout(tx);
        stats.sent++;
        // Use receiptProvider for wait to avoid WS subscribe churn
        const h = sent.hash || sent; // raw send returns hash string wrapper
        receiptProvider.waitForTransaction(h).then(() => { stats.succ++; }).catch(() => {});
      } catch (e) {
        stats.fail++;
        const msg = (e && e.message) || 'error';
        if (/insufficient funds/i.test(msg)) {
          await sleep(50);
        }
        if (/tx-send-timeout|connection|ECONNRESET|socket|timeout|closed/i.test(msg)) {
          try { await provider.destroy?.(); } catch {}
          urlIdx = (urlIdx + 1) % RPC_URLS.length;
          url = RPC_URLS[urlIdx];
          provider = createProvider(url);
          const rebound = new Wallet(wallet.privateKey, provider);
          nonce = await provider.getTransactionCount(rebound.address, 'pending');
        } else {
          if (nonce > 0) nonce--;
        }
      }
    };
    const p = doSend().finally(() => pending.delete(p));
    pending.add(p);
  };

  while (Date.now() < endAt) {
    while (pending.size < INFLIGHT_PER_WORKER && Date.now() < endAt) {
      // Rate limit: acquire one token for each send when TARGET_TPS is set
      const ok = await acquireToken(bucket, endAt);
      if (!ok) break;
      await launchSend();
    }
    // 待ち合わせ：1つでも完了するまで待つ（スピン回避の微スリープ）
    if (pending.size > 0) {
      await Promise.race([...pending, sleep(1)]);
    } else {
      await sleep(1);
    }
  }
  // 終了時、保留分を待つ（短いグレース期間に委ねてもOK）
  await Promise.allSettled(pending);
  // cleanup provider so websocket doesn't keep process alive
  try { await provider.destroy?.(); } catch {}
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function main() {
  console.log(`Load params: duration=${DURATION_SEC}s workers=${WORKERS} value=${VALUE_ETH} SIMPLE_FORWARDER_ADDRESS=${SIMPLE_FORWARDER_ADDRESS}`);
  if (ACCOUNT_OFFSET) {
    console.log(`Account offset: ${ACCOUNT_OFFSET} (worker keys start at index ${ACCOUNT_OFFSET})`);
  }
  // Prepare forwarder dependency only if needed
  ensureForwarderReadyIfNeeded(DIRECT_TRANSFER);
  const primary = createProvider(RPC_URLS[0]);
  const net = await primary.getNetwork();
  console.log(`chainId=${net.chainId} block=${await primary.getBlockNumber()}`);
  // Dedicated HTTP provider for receipt polling to avoid WS subscription races
  const receiptProvider = new JsonRpcProvider(pickHttpUrl());
  const bucket = createTokenBucket();
  if (bucket) {
    console.log(`Rate limiting enabled: TARGET_TPS=${TARGET_TPS} capacity=${bucket.capacity} interval=${BUCKET_INTERVAL_MS}ms addPerTick≈${Math.max(1, Math.floor(TARGET_TPS * BUCKET_INTERVAL_MS / 1000))}`);
  }
  await fundWorkersIfNeeded(primary, receiptProvider);

  const endAt = Date.now() + DURATION_SEC * 1000;
  const stats = { sent: 0, succ: 0, fail: 0 };
  // Dedicated HTTP provider for receipt polling to avoid WS subscription races
  const tasks = [];
  for (let i = 0; i < WORKERS; i++) {
    tasks.push(runWorker(i, endAt, stats, receiptProvider, bucket));
  }
  // Hard stop watchdog (in case a send hangs beyond duration)
  const watchdog = setTimeout(() => {
    console.error('Watchdog: forcing exit after grace period');
    // 統一して aggregator が拾えるよう "done:" で出力
    console.log(`done: sent=${stats.sent} succ=${stats.succ} fail=${stats.fail}`);
    process.exit(0);
  }, DURATION_SEC * 1000 + GRACE_EXIT_MS);

  await Promise.allSettled(tasks);
  // 送信完了後、任意でレシート取り込みの猶予を与える
  if (RECEIPT_DRAIN_MS > 0) {
    await sleep(RECEIPT_DRAIN_MS);
  }
  clearTimeout(watchdog);
  try { await primary.destroy?.(); } catch {}
  console.log(`done: sent=${stats.sent} succ=${stats.succ} fail=${stats.fail}`);
  // Explicit exit to avoid lingering websockets
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
