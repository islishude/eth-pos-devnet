import { execSync } from "node:child_process";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

function getEnodeOnce() {
  // Query geth's enode via IPC inside the container
  const cmd = "docker compose exec -T geth geth attach --exec admin.nodeInfo.enode /root/.ethereum/geth.ipc";
  const out = execSync(cmd, { encoding: "utf8" });
  // Output is quoted string, e.g. "enode://<id>@127.0.0.1:30303"
  return out.trim().replace(/^"|"$/g, "");
}

async function getEnodeWithRetry(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const e = getEnodeOnce();
      if (e && e.startsWith("enode://")) return e;
    } catch (e) {
      // likely IPC not ready yet
    }
    await sleep(2000);
  }
  throw new Error("Timed out waiting for geth enode via IPC");
}

function getServiceContainerId(service = "geth") {
  const cmd = `docker compose ps -q ${service}`;
  const id = execSync(cmd, { encoding: "utf8" }).trim();
  if (!id) throw new Error(`Could not resolve container id for service: ${service}`);
  return id;
}

function getContainerIp(containerId) {
  const cmd = `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerId}`;
  const ip = execSync(cmd, { encoding: "utf8" }).trim();
  if (!ip) throw new Error(`Could not resolve IP for container: ${containerId}`);
  return ip;
}

// Normalize the enode to use the container's IP (numeric), which geth accepts.
function normalizeEnode(enode) {
  try {
    const id = getServiceContainerId("geth");
    const ip = getContainerIp(id);
    return enode.replace(/@[^:]+:(\d+)/, (_m, p1) => `@${ip}:${p1}`);
  } catch (e) {
    // Fallback to raw value if any resolution step fails
    return enode;
  }
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
  const enode = await getEnodeWithRetry();
  const normalized = normalizeEnode(enode);
  upsertEnvVar(ENV_PATH, "EL_BOOTNODE", normalized);
  console.log("Wrote EL_BOOTNODE to .env:", normalized);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
