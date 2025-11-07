import fs from "node:fs";
import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BEACON_URL = process.env.BEACON_URL || "http://127.0.0.1:3500";
const ENV_PATH = new URL("../.env", import.meta.url).pathname;

async function fetchIdentity() {
  const res = await fetch(`${BEACON_URL}/eth/v1/node/identity`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json?.data;
}

async function waitForENR(timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = await fetchIdentity();
      const enr = data?.enr;
      if (enr && typeof enr === "string") return data; // return full identity data once ENR is available
    } catch (e) {
      await sleep(2000);
    }
  }
  throw new Error("Timed out waiting for Prysm identity ENR");
}

function getServiceContainerIp(service = "prysm") {
  try {
    const id = execSync(`docker compose ps -q ${service}`, { encoding: "utf8" }).trim();
    if (!id) return null;
    const ip = execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${id}`, { encoding: "utf8" }).trim();
    return ip || null;
  } catch (_e) {
    return null;
  }
}

function patchEnrIp(enr, ip) {
  // Best-effort patch: replace any '/ip4/<addr>/' segment with the container IP.
  // This does not modify the RLP inside ENR, but helps when downstream tools parse multiaddrs from ENR string.
  // If not present, return original.
  if (!ip) return enr;
  return enr.replace(/(\/ip4\/)(\d+\.\d+\.\d+\.\d+)(\/)/g, `$1${ip}$3`);
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
  // Wait until Prysm exposes identity with ENR to avoid transient fetch errors (e.g., ECONNRESET)
  const data = await waitForENR();
  if (!data) throw new Error("identity not available");
  const enrRaw = data.enr;
  const ip = getServiceContainerIp("prysm");
  const enr = patchEnrIp(enrRaw, ip);
  upsertEnvVar(ENV_PATH, "PRYSM_BOOTSTRAP_ENR", enr);
  // Also write a static multiaddr peer for robust peering
  const addrs = Array.isArray(data.p2p_addresses) ? data.p2p_addresses : [];
  const peer = addrs.find(a => /\/ip4\//.test(a)) || addrs[0];
  if (peer) {
    const peerPatched = ip ? peer.replace(/(\/ip4\/)(\d+\.\d+\.\d+\.\d+)(\/)/, `$1${ip}$3`) : peer;
    upsertEnvVar(ENV_PATH, "PRYSM_BOOTSTRAP_PEER", peerPatched);
  }
  console.log("Wrote PRYSM_BOOTSTRAP_ENR to .env");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
