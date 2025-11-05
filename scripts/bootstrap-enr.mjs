import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const BEACON_URL = process.env.BEACON_URL || "http://127.0.0.1:3500";
const ENV_PATH = new URL("../.env", import.meta.url).pathname;

async function fetchENR() {
  const res = await fetch(`${BEACON_URL}/eth/v1/node/identity`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const enr = json?.data?.enr;
  if (!enr || typeof enr !== "string") throw new Error("ENR not found");
  return enr.trim();
}

async function waitForENR(timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const enr = await fetchENR();
      return enr;
    } catch (e) {
      await sleep(2000);
    }
  }
  throw new Error("Timed out waiting for Prysm identity ENR");
}

function upsertEnvVar(path, key, value) {
  let content = "";
  if (fs.existsSync(path)) content = fs.readFileSync(path, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const kv = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = kv; else lines.push(kv);
  fs.writeFileSync(path, lines.join("\n") + "\n");
}

async function main() {
  const enr = await waitForENR();
  upsertEnvVar(ENV_PATH, "PRYSM_BOOTSTRAP_ENR", enr);
  console.log("Wrote PRYSM_BOOTSTRAP_ENR to .env");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
