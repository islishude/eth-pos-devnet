import { execSync } from "node:child_process";
import fs from "node:fs";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

function getEnode() {
  // Query geth's enode via IPC inside the container
  const cmd = "docker compose exec geth geth attach --exec admin.nodeInfo.enode /root/.ethereum/geth.ipc";
  const out = execSync(cmd, { encoding: "utf8" });
  // Output is quoted string, e.g. "enode://<id>@127.0.0.1:30303"
  return out.trim().replace(/^"|"$/g, "");
}

function toServiceHost(enode) {
  return enode.replace(/@[^:]+:(\d+)/, (_m, p1) => `@geth:${p1}`);
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

function main() {
  const enode = getEnode();
  const svcEnode = toServiceHost(enode);
  upsertEnvVar(ENV_PATH, "EL_BOOTNODE", svcEnode);
  console.log("Wrote EL_BOOTNODE to .env:", svcEnode);
}

main();
