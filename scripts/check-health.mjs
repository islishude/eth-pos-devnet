#!/usr/bin/env node
// Aggregate health check after full fresh start.
// Criteria (devnet):
//  - All beacon nodes reachable and not optimistic (is_optimistic=false)
//  - At least one beacon head_slot > 0
//  - No beacon node actively syncing (is_syncing=false) after initial stabilization
//  - All execution nodes have blockNumber > 0
//  - Execution head spread (max-min) <= 20 (tunable)
// Prints a single SUCCESS line in Japanese when healthy; otherwise prints reasons and exits non-zero.

const beaconUrls = (process.env.BEACON_URLS || 'http://127.0.0.1:3500,http://127.0.0.1:3502,http://127.0.0.1:3503').split(',');
const rpcUrls = (process.env.RPC_URLS || 'http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548').split(',');
const SPREAD_THRESHOLD = parseInt(process.env.HEALTH_SPREAD_THRESHOLD || '20', 10);
const MAX_WAIT_SEC = parseInt(process.env.HEALTH_MAX_WAIT_SEC || '45', 10);
const INTERVAL_MS = parseInt(process.env.HEALTH_POLL_INTERVAL_MS || '3000', 10);
const REQUIRE_GROWTH = (process.env.HEALTH_REQUIRE_GROWTH || '1') === '1';
const GROWTH_WINDOW_SEC = parseInt(process.env.HEALTH_GROWTH_WINDOW_SEC || '10', 10); // 短時間でELが前進すること

async function fetchBeaconStatus(url) {
  const r = await fetch(`${url}/eth/v1/node/syncing`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.data;
}

async function fetchBeaconPeerCount(url) {
  try {
    const r = await fetch(`${url}/eth/v1/node/peer_count`);
    if (!r.ok) return null;
    const j = await r.json();
    // Prysm returns { data: { connected: n, dialing: n, disconnected: n } }
    return parseInt(j?.data?.connected ?? '0', 10);
  } catch (_) {
    return null;
  }
}

async function ethCall(url, method, params = []) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || j.error.code);
  return j.result;
}

function hexToDec(hex) { return parseInt(hex, 16); }

async function checkOnce() {
  const failures = [];
  const beaconStatuses = [];
  const beaconPeers = [];
  for (const url of beaconUrls) {
    try {
      const s = await fetchBeaconStatus(url);
      const peers = await fetchBeaconPeerCount(url);
      beaconStatuses.push({ url, ...s });
      if (peers != null) beaconPeers.push({ url, peers });
    } catch (e) {
      failures.push(`Beacon未到達: ${url} (${e.message})`);
    }
  }

  const allBeaconReached = beaconStatuses.length === beaconUrls.length;
  if (allBeaconReached) {
    beaconStatuses.forEach(s => {
      if (s.is_optimistic) failures.push(`optimistic継続: ${s.url}`);
      if (s.is_syncing) failures.push(`syncing継続: ${s.url}`);
    });
    const headSlots = beaconStatuses.map(s => parseInt(s.head_slot, 10)).filter(n => !isNaN(n));
    if (!headSlots.some(h => h > 0)) failures.push('全Beacon head_slot=0');
    // P2P peers > 0 を要求（取得できた場合）
    beaconPeers.forEach(p => { if ((p.peers|0) <= 0) failures.push(`Beacon peers=0: ${p.url}`); });
  }

  const elHeads = [];
  for (const url of rpcUrls) {
    try {
      const bnHex = await ethCall(url, 'eth_blockNumber');
      const bn = hexToDec(bnHex);
      elHeads.push({ url, bn });
      if (bn === 0) failures.push(`ELブロック未進行: ${url}`);
    } catch (e) {
      failures.push(`EL未到達: ${url} (${e.message})`);
    }
  }
  if (elHeads.length) {
    const nums = elHeads.map(h => h.bn);
    const spread = Math.max(...nums) - Math.min(...nums);
    if (spread > SPREAD_THRESHOLD) failures.push(`ELヘッド乖離(spread=${spread})閾値>${SPREAD_THRESHOLD}`);
  }

  const ok = failures.length === 0;
  return { ok, failures, beaconStatuses, elHeads };
}

(async () => {
  const deadline = Date.now() + MAX_WAIT_SEC * 1000;
  // 成長確認のための初期スナップショット
  const growthStart = Date.now();
  const growthBase = {};
  for (const url of rpcUrls) growthBase[url] = null;
  let last;
  while (Date.now() < deadline) {
    last = await checkOnce();
    // ELヘッド成長判定
    if (REQUIRE_GROWTH && Date.now() - growthStart >= GROWTH_WINDOW_SEC * 1000) {
      try {
        const heads = await Promise.all(rpcUrls.map(async (url) => {
          const bnHex = await ethCall(url, 'eth_blockNumber');
          return { url, bn: parseInt(bnHex, 16) };
        }));
        // 初回スナップショットが空ならセット
        for (const h of heads) {
          if (growthBase[h.url] == null) growthBase[h.url] = h.bn;
        }
        const grown = heads.some(h => growthBase[h.url] != null && h.bn > growthBase[h.url]);
        if (!grown) {
          last.failures.push(`ELヘッドが${GROWTH_WINDOW_SEC}sで前進せず`);
        }
      } catch (_) {}
    }
    if (last.ok) break;
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
  const { ok, failures, beaconStatuses = [], elHeads = [] } = last || { ok: false, failures: ['未評価'] };
  if (ok) {
    const slotInfo = beaconStatuses.map(s => `${s.url.split('//')[1]}:slot=${s.head_slot}`).join(', ');
    const elInfo = elHeads.map(h => `${h.url.split('//')[1]}:block=${h.bn}`).join(', ');
    console.log(`✅ 全ノード正常: Beacon slots[${slotInfo}] EL heads[${elInfo}]`);
    process.exit(0);
  } else {
    console.error('❌ 健康チェック失敗:');
    failures.forEach(f => console.error(' - ' + f));
    process.exit(1);
  }
})();
