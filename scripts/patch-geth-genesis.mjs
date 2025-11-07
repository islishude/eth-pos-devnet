#!/usr/bin/env node
import fs from 'node:fs/promises';

async function main() {
  const inPath = process.env.GENESIS_PATH || '/geth/genesis.json';
  const raw = await fs.readFile(inPath, 'utf-8');
  const j = JSON.parse(raw);
  if (!j.config) {
    console.error('No config field in genesis');
    process.exit(1);
  }
  const cfg = j.config;
  const before = { pragueTime: cfg.pragueTime, cancunTime: cfg.cancunTime, shanghaiTime: cfg.shanghaiTime, timestamp: j.timestamp };
  // Remove or neutralize pragueTime to avoid unsupported fork ordering in geth v1.16.x
  if (typeof cfg.pragueTime !== 'undefined') {
    delete cfg.pragueTime;
  }
  // Also remove any blobSchedule.prague if present (not required, but cleaner)
  if (cfg.blobSchedule && cfg.blobSchedule.prague) {
    delete cfg.blobSchedule.prague;
  }
  // Do NOT touch the timestamp here; it must match exactly what the EL/CL genesis builder produced.
  await fs.writeFile(inPath, JSON.stringify(j, null, 2));
  console.log('Patched genesis.json: removed pragueTime (and blobSchedule.prague if present). Before:', before, 'After:', { pragueTime: j.config.pragueTime, cancunTime: j.config.cancunTime, shanghaiTime: j.config.shanghaiTime, timestamp: j.timestamp });
}

main().catch((e) => {
  console.error('Failed to patch genesis:', e);
  process.exit(1);
});
