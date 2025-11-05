// Wait until the Execution Layer (geth) is ready to serve receipts reliably.
// Conditions to exit (relaxed):
//  - chainId responds
//  - eth_syncing is false OR txIndexRemainingBlocks == 0
// Note: We no longer require eth_blockNumber > 0 because some setups keep it at 0 for a while
//       even though the node is operational and indexing is complete.

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const TIMEOUT_MS = parseInt(process.env.WAIT_READY_TIMEOUT_MS || "600000", 10); // 10 min default
const INTERVAL_MS = 1500;

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!res.ok) throw new Error(`RPC HTTP error: ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message || json.error.code}`);
  return json.result;
}

function hexToBigInt(hex) {
  if (!hex || typeof hex !== "string") return 0n;
  return BigInt(hex);
}

async function isReady() {
  // 1) EL reachable
  try { await rpc("eth_chainId", []); } catch { return false; }

  // 2) Latest block is retrievable (genesisも含む)
  try {
    const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
    if (latest) return true;
  } catch (_) {
    // ignore and fallback to syncing checks
  }

  // 3) Syncing state: if not syncing, OK
  let syncing;
  try { syncing = await rpc("eth_syncing", []); } catch { syncing = false; }
  if (syncing === false) return true;

  // 4) If syncing object, but tx index remaining is zero OR 指標が無ければOK
  try {
    const remaining = hexToBigInt(syncing.txIndexRemainingBlocks);
    if (remaining === 0n) return true;
  } catch (_) {
    return true;
  }

  return false;
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastLog = 0;
  process.stdout.write(`Waiting for EL at ${RPC_URL} to be ready (chainId reachable and not syncing/indexing) (timeout ${TIMEOUT_MS/1000}s)\n`);
  while (Date.now() < deadline) {
    try {
      if (await isReady()) {
        console.log("EL ready: engine reachable and indexing done (or not syncing)");
        return;
      }
    } catch (e) {
      // ignore transient errors
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
  console.log("...waiting for EL (engine reachable + not syncing/indexing)");
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  throw new Error("Timed out waiting for EL to be ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
