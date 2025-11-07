#!/usr/bin/env node
// Seed Engine API forkchoice on all EL nodes to help Prysm exit optimistic mode quickly.
// Usage: invoked via `make engine-seed` inside a node:22-alpine container with /data mounted read-only.
// If SEED_CONTINUOUS=1 it will keep re-seeding for SEED_MAX_SLOTS (default 60) every SEED_SLOTS slots.
// Requires: jwtsecret files under /data/*/geth/jwtsecret, network access to http://geth[-2|-3]:8551

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const ENGINES = [
	{ name: 'geth',    jwt: '/data/geth/geth/jwtsecret',    engineUrl: 'http://geth:8551',    rpcUrl: 'http://geth:8545' },
	{ name: 'geth-2',  jwt: '/data/geth-2/geth/jwtsecret',  engineUrl: 'http://geth-2:8551',  rpcUrl: 'http://geth-2:8545' },
	{ name: 'geth-3',  jwt: '/data/geth-3/geth/jwtsecret',  engineUrl: 'http://geth-3:8551',  rpcUrl: 'http://geth-3:8545' }
];

const SECONDS_PER_SLOT = parseInt(process.env.SECONDS_PER_SLOT || '3', 10);
const SEED_CONTINUOUS = process.env.SEED_CONTINUOUS === '1';
const SEED_SLOTS = parseInt(process.env.SEED_SLOTS || '3', 10); // how many slots between attempts
const SEED_MAX_SLOTS = parseInt(process.env.SEED_MAX_SLOTS || '60', 10);

function base64url(buf) {
	return Buffer.from(buf).toString('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

function makeJwt(secretBuf) {
	// JWT secret file is typically 32 raw bytes OR 64 hex chars with no newline.
	let raw = secretBuf;
	if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw);
	// Detect hex encoding (only 0-9a-f and length 64). If so, decode.
	let asString = raw.toString('utf8').trim();
	if (asString.startsWith('0x') || asString.startsWith('0X')) {
		asString = asString.slice(2);
	}
	let key;
	if (/^[0-9a-fA-F]{64}$/.test(asString)) {
		try {
			key = Buffer.from(asString, 'hex');
		} catch (e) {
			console.error('engine-seed: failed to decode hex jwtsecret, falling back to raw bytes');
			key = raw;
		}
	} else {
		key = raw;
	}
	if (key.length !== 32) {
		console.warn('engine-seed: jwtsecret length is', key.length, '(expected 32). Token may be rejected.');
	}
	const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const payload = base64url(JSON.stringify({ iat: Math.floor(Date.now() / 1000) }));
	const toSign = `${header}.${payload}`;
	const sig = crypto.createHmac('sha256', key).update(toSign).digest();
	return `${toSign}.${base64url(sig)}`;
}

async function rpc(url, jwt, method, params) {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'authorization': `Bearer ${jwt}`
		},
		body
	});
	if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
	const json = await res.json();
	if (json.error) throw new Error(`${method} error: ${json.error.message || json.error.code}`);
	return json.result;
}

async function ethRpc(url, method, params) {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
	const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
	if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
	const json = await res.json();
	if (json.error) throw new Error(`${method} error: ${json.error.message || json.error.code}`);
	return json.result;
}

async function testCapabilities(engName, engineUrl, jwtToken) {
	try {
		const caps = await rpc(engineUrl, jwtToken, 'engine_exchangeCapabilities', []);
		console.log('engine-seed:', engName, 'capabilities=', Array.isArray(caps) ? caps.join(',') : caps);
	} catch (e) {
		console.error('engine-seed:', engName, 'exchangeCapabilities failed:', e.message);
	}
}

async function seedOnce() {
	for (const eng of ENGINES) {
		let secret;
			try { secret = await fs.readFile(eng.jwt); } catch (e) {
			console.error('engine-seed: missing jwtsecret for', eng.name, e.message); continue;
		}
		const token = makeJwt(secret);
		// Quick capability probe (best-effort, ignore failure)
		await testCapabilities(eng.name, eng.engineUrl, token);
			let genesisHash;
		try {
				const block0 = await ethRpc(eng.rpcUrl, 'eth_getBlockByNumber', ['0x0', false]);
				genesisHash = block0?.hash;
			if (!genesisHash) throw new Error('no hash for genesis');
		} catch (e) {
				console.error('engine-seed: cannot fetch genesis block for', eng.name, e.message); continue;
		}
		// Try engine_forkchoiceUpdated* variants (V3->V2->legacy). Geth 1.16.x expects 2 params: (state, payloadAttributes)
		const forkchoiceState = {
			headBlockHash: genesisHash,
			safeBlockHash: genesisHash,
			finalizedBlockHash: genesisHash
		};
		const methods = ['engine_forkchoiceUpdatedV3', 'engine_forkchoiceUpdatedV2', 'engine_forkchoiceUpdated'];
		let seeded = false;
		for (const m of methods) {
			try {
				const params = [forkchoiceState, null];
				const result = await rpc(eng.engineUrl, token, m, params);
				console.log('engine-seed:', eng.name, m, 'status=', result?.payloadStatus?.status || result?.status || 'OK');
				seeded = true; break;
			} catch (e) {
				console.error('engine-seed:', eng.name, m, 'failed:', e.message || e);
				// Continue to next variant
			}
		}
		if (!seeded) console.error('engine-seed: all forkchoiceUpdated variants failed for', eng.name);
	}
}

async function main() {
	console.log('engine-seed: seeding forkchoice on execution clients');
	await seedOnce();
	if (!SEED_CONTINUOUS) return;
	console.log('engine-seed: continuous mode enabled for', SEED_MAX_SLOTS, 'slots (interval', SEED_SLOTS, 'slots)');
	const start = Date.now();
	let attempts = 0;
	while ((Date.now() - start) / 1000 < SEED_MAX_SLOTS * SECONDS_PER_SLOT) {
		await new Promise(r => setTimeout(r, SEED_SLOTS * SECONDS_PER_SLOT * 1000));
		attempts++;
		console.log('engine-seed: continuous attempt', attempts);
		await seedOnce();
	}
	console.log('engine-seed: continuous mode finished');
}

main().catch(e => { console.error('engine-seed: fatal', e); process.exit(1); });

