#!/usr/bin/env node

import { JsonRpcProvider } from "ethers";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = parseInt(process.env.WAIT_EL_HEAD_TIMEOUT_MS || "300000", 10); // 5m
const POLL_MS = 1500;
const START = Date.now();

const RPC_URL = process.env.RPC_URL || "";
const RPC_URLS = (process.env.RPC_URLS || [
  "http://127.0.0.1:8545",
  "http://127.0.0.1:8547",
  "http://127.0.0.1:8548",
].join(",")).split(",").map(s => s.trim()).filter(Boolean);

async function getBlockNumber(url) {
  const p = new JsonRpcProvider(url);
  try {
    return await p.getBlockNumber();
  } catch (e) {
    return null;
  }
}

(async () => {
  console.log(`Waiting for EL head to advance (>0) on any endpoint (timeout ${Math.floor(TIMEOUT_MS/1000)}s)`);
  while (true) {
    // First, if a single RPC_URL is set, prioritize it
    if (RPC_URL) {
      const bn = await getBlockNumber(RPC_URL);
      if (bn != null) {
        if (bn > 0) {
          console.log(`EL head ready on ${RPC_URL}: blockNumber=${bn}`);
          process.exit(0);
        } else {
          console.log(`...waiting on ${RPC_URL}: blockNumber=${bn}`);
        }
      } else {
        console.log(`...endpoint not reachable: ${RPC_URL}`);
      }
    }

    // Otherwise probe the list
    let anyReady = false;
    for (const url of RPC_URLS) {
      const bn = await getBlockNumber(url);
      if (bn == null) {
        console.log(`...endpoint not reachable: ${url}`);
        continue;
      }
      if (bn > 0) {
        console.log(`EL head ready on ${url}: blockNumber=${bn}`);
        process.exit(0);
      }
      anyReady = true; // reachable but not yet advanced
      console.log(`...waiting on ${url}: blockNumber=${bn}`);
    }

    if (Date.now() - START > TIMEOUT_MS) {
      console.error(`Error: Timed out waiting for EL head to advance on any endpoint: ${[RPC_URL, ...RPC_URLS].filter(Boolean).join(', ')}`);
      process.exit(1);
    }
    await sleep(POLL_MS);
  }
})();
