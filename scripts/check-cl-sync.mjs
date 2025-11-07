#!/usr/bin/env node

const endpoints = [
  { name: 'prysm', url: 'http://127.0.0.1:3500' },
  { name: 'prysm-2', url: 'http://127.0.0.1:3502' },
  { name: 'prysm-3', url: 'http://127.0.0.1:3503' },
];

async function syncStatus(url) {
  const r = await fetch(`${url}/eth/v1/node/syncing`);
  const j = await r.json();
  return j.data;
}

(async () => {
  for (const ep of endpoints) {
    try {
      const d = await syncStatus(ep.url);
      console.log(`${ep.name}: head_slot=${d.head_slot} sync_distance=${d.sync_distance} is_syncing=${d.is_syncing} optimistic=${d.is_optimistic} el_offline=${d.el_offline}`);
    } catch (e) {
      console.log(`${ep.name}: error ${e.message}`);
    }
  }
})();
