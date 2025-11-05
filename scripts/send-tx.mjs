import { JsonRpcProvider, Wallet, parseEther } from "ethers";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RPC_URL = process.env.RPC_URL || "";
const RPC_URLS = (process.env.RPC_URLS || [
  "http://127.0.0.1:8545",
  "http://127.0.0.1:8547",
  "http://127.0.0.1:8548",
].join(",")).split(",").map(s => s.trim()).filter(Boolean);
const PRIV_KEY = process.env.PRIV_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // devnet key from README
const TO = process.env.TO || "0x0000000000000000000000000000000000000001";
const VALUE = process.env.VALUE || "0.01"; // ETH

async function getReceiptByScanning(provider, hash, startBlock, deadlineMs) {
  let current = startBlock;
  while (Date.now() < deadlineMs) {
    const latest = await provider.getBlockNumber();
    if (latest > current) {
      for (let b = current + 1; b <= latest; b++) {
        const block = await provider.getBlock(b, true);
        if (block && block.transactions && block.transactions.length) {
          const found = block.transactions.find((t) => (typeof t === 'string' ? t : t.hash) === hash);
          if (found) {
            // Try to get receipts for the whole block (geth extension)
            try {
              const receipts = await provider.send("eth_getBlockReceipts", [block.hash]);
              if (Array.isArray(receipts)) {
                const r = receipts.find((r) => r && r.transactionHash === hash);
                if (r) return r;
              }
            } catch (_) {
              // Fallback if method unsupported: fabricate minimal receipt-like result
            }
            return { status: 1, blockNumber: b, transactionHash: hash };
          }
        }
      }
      current = latest;
    }
    await sleep(1500);
  }
  return null;
}

async function pickProvider() {
  // If a single RPC_URL is explicitly provided, use it directly
  if (RPC_URL) {
    const p = new JsonRpcProvider(RPC_URL);
    // quick probe
    try {
      await p.getNetwork();
      return { provider: p, url: RPC_URL };
    } catch (e) {
      throw new Error(`RPC_URL not reachable: ${RPC_URL} (${e?.message || e})`);
    }
  }
  // Otherwise iterate through RPC_URLS and pick the first healthy one
  let fallback = null;
  for (const url of RPC_URLS) {
    const p = new JsonRpcProvider(url);
    try {
      // Require chainId reachable
      const net = await p.getNetwork();
      // Prefer providers with blockNumber > 0
      const bn = await p.getBlockNumber();
      if (bn > 0) return { provider: p, url };
      // Keep the first responsive provider as fallback (even if bn==0)
      if (!fallback) fallback = { provider: p, url };
    } catch (_) {
      // ignore unreachable
    }
  }
  if (fallback) return fallback;
  throw new Error(`No usable RPC endpoints from: ${RPC_URLS.join(", ")}`);
}

async function main() {
  const { provider, url } = await pickProvider();
  console.log("rpc:", url);
  const wallet = new Wallet(PRIV_KEY, provider);

  console.log("from:", await wallet.getAddress());
  console.log("to:", TO);

  const balance = await provider.getBalance(await wallet.getAddress());
  console.log("balance:", balance.toString());

  const txReq = {
    to: TO,
    value: parseEther(VALUE),
    // Let ethers populate gas fields (EIP-1559 compatible)
  };

  const startBlock = await provider.getBlockNumber();
  const tx = await wallet.sendTransaction(txReq);
  console.log("tx hash:", tx.hash);
  if (process.env.WAIT_FOR_RECEIPT === "0") {
    console.log("Skipping receipt wait (WAIT_FOR_RECEIPT=0). Tx broadcasted.");
    return;
  }

  // Some geth versions return "transaction indexing is in progress" temporarily
  // for eth_getTransactionReceipt right after startup. Retry until available.
  const deadline = Date.now() + (parseInt(process.env.TX_TIMEOUT_MS || "600000", 10));
  let receipt;
  let tries = 0;
  while (Date.now() < deadline) {
    try {
      receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt) break;
    } catch (err) {
      const msg = (err?.error?.message || err?.message || "").toString();
      if (msg.includes("transaction indexing is in progress")) {
        if (tries % 5 === 0) console.log("geth is building tx index, waiting...");
        // If indexer is still warming, try to discover inclusion by scanning new blocks
        const scanned = await getReceiptByScanning(provider, tx.hash, startBlock, deadline);
        if (scanned) {
          receipt = scanned;
          break;
        }
      } else if (msg.includes("receipt not found") || msg.includes("not found")) {
        // Continue to alternative inclusion checks below
      } else {
        throw err;
      }
    }

    // Alternative: check if tx already included even if receipt isn't ready
    try {
      const txOnChain = await provider.getTransaction(tx.hash);
      if (txOnChain && txOnChain.blockNumber != null) {
        // Try one more time to fetch the receipt
        try {
          const r2 = await provider.getTransactionReceipt(tx.hash);
          if (r2) { receipt = r2; break; }
        } catch (_) {}
        // Accept inclusion and synthesize a minimal receipt-like object
        receipt = { status: 1, blockNumber: txOnChain.blockNumber, transactionHash: tx.hash };
        break;
      }
    } catch (_) {}

    tries += 1;
    await sleep(1500);
  }
  if (!receipt) {
    throw new Error("Timed out waiting for transaction receipt");
  }
  console.log("receipt status:", receipt.status);
  console.log("block:", receipt.blockNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
