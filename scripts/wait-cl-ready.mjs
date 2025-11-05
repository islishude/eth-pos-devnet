#!/usr/bin/env node

// Wait for Prysm (beacon API at :3500) to exit optimistic mode.
// Success criteria: HTTP 200 and data.is_optimistic === false
// Optional: also ensure data.is_syncing === false (we'll log it but not block on it if optimistic=false)

const DEFAULT_TIMEOUT_MS = parseInt(process.env.WAIT_CL_TIMEOUT_MS || '', 10) || 10 * 60 * 1000; // 10m
const POLL_INTERVAL_MS = 2000;
const urlsEnv = process.env.BEACON_URLS || process.env.BEACON_URL || 'http://127.0.0.1:3500';
const BEACON_URLS = urlsEnv.split(',').map(s => s.trim()).filter(Boolean);

const start = Date.now();

async function getSyncing(url) {
  const res = await fetch(`${url}/eth/v1/node/syncing`);
  if (!res.ok) {
    throw new Error(`Beacon API not ready: ${url} HTTP ${res.status}`);
  }
  const j = await res.json();
  return j.data || j; // some implementations might not wrap with data
}

(async () => {
  process.stdout.write(`Waiting for CL (Prysm) to exit optimistic mode at ${BEACON_URLS.join(', ')} (timeout ${DEFAULT_TIMEOUT_MS/1000}s)\n`);
  while (true) {
    try {
      let anyNonOptimistic = false;
      let allReachable = true;
      for (const url of BEACON_URLS) {
        try {
          const data = await getSyncing(url);
          const isOptimistic = !!data.is_optimistic;
          const isSyncing = !!data.is_syncing;
          const headSlotStr = data.head_slot ?? '0';
          const headSlot = Number.parseInt(String(headSlotStr), 10) || 0;
          console.log(`${isOptimistic ? '...waiting' : 'CL ready'} @ ${url}: optimistic=${isOptimistic}, syncing=${isSyncing}, head_slot=${headSlot}`);
          if (!isOptimistic) anyNonOptimistic = true;
        } catch (e) {
          console.log(`...beacon not ready yet @ ${url}: ${(e && e.message) || e}`);
          allReachable = false;
        }
      }
      // Success if: 全ビーコンが応答し、かつ少なくとも1台が非optimistic
      if (allReachable && anyNonOptimistic) {
        process.exit(0);
      }
    } catch (err) {
      console.log(`...beacon not ready yet: ${(err && err.message) || err}`);
    }

    if (Date.now() - start > DEFAULT_TIMEOUT_MS) {
      console.error('Error: Timed out waiting for CL readiness (need all reachable and at least one non-optimistic)');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
})();
