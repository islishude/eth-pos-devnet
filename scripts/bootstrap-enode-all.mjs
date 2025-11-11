#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ENV_PATH = new URL('../.env', import.meta.url).pathname;

const EL_SERVICES = [
  { name: 'geth',    dataDir: './data/geth'   },
  { name: 'geth-2',  dataDir: './data/geth-2' },
  { name: 'geth-3',  dataDir: './data/geth-3' },
];

function getContainerId(service) {
  const id = execSync(`docker compose ps -q ${service}`, { encoding: 'utf8' }).trim();
  if (!id) throw new Error(`container id not found: ${service}`);
  return id;
}

function getContainerIp(containerId) {
  return execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerId}`, { encoding: 'utf8' }).trim();
}

function getEnode(service) {
  const cmd = `docker compose exec -T ${service} geth attach --exec admin.nodeInfo.enode /root/.ethereum/geth.ipc`;
  const raw = execSync(cmd, { encoding: 'utf8' }).trim().replace(/^"|"$/g, '');
  const ip = getContainerIp(getContainerId(service));
  return raw.replace(/@[^:]+:(\d+)/, (_m, p1) => `@${ip}:${p1}`);
}

function upsertEnvVar(path, key, value) {
  let content = '';
  if (fs.existsSync(path)) content = fs.readFileSync(path, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  const kv = `${key}=${value}`;
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = kv; else lines.push(kv);
  fs.writeFileSync(path, lines.join('\n') + '\n');
}

function writeStaticNodes(dataDir, enodes) {
  const file = `${dataDir}/static-nodes.json`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(enodes, null, 2));
}

function addPeer(service, enode) {
  try {
    execSync(`docker compose exec -T ${service} geth attach --exec \"admin.addPeer(\\\"${enode}\\\")\" /root/.ethereum/geth.ipc`, { stdio: 'ignore' });
  } catch (e) {
    // non-fatal
  }
}

async function main() {
  // Collect enodes for all EL services
  const enodes = {};
  for (const s of EL_SERVICES) {
    try { enodes[s.name] = getEnode(s.name); } catch (e) { console.error('bootstrap-enode-all:', s.name, e.message); }
  }
  const list = Object.values(enodes).filter(Boolean);
  if (list.length) {
    // geth accepts comma-separated bootnodes list
    upsertEnvVar(ENV_PATH, 'EL_BOOTNODE', list.join(','));
    // also write numbered vars
    list.forEach((v, i) => upsertEnvVar(ENV_PATH, `EL_BOOTNODE_${i+1}`, v));
  }
  // Write static-nodes.json for persistence and add peers live
  for (const s of EL_SERVICES) {
    const others = list.filter(v => v !== enodes[s.name]);
    if (others.length) {
      writeStaticNodes(s.dataDir, others);
      for (const peer of others) addPeer(s.name, peer);
    }
  }
  console.log('bootstrap-enode-all: updated .env and static-nodes.json for EL');
}

main().catch(e => { console.error(e); process.exit(1); });
