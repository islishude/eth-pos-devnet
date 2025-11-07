# Copilot instructions for this repo

Purpose: Make AI coding agents productive immediately in this PoS Ethereum devnet repo (EL: geth, CL: Prysm) with Pectra-ready genesis and 3-node topology. Keep edits minimal, follow existing Make/compose workflows.

## Big picture
- Services: 3x geth (execution) + 3x Prysm beacon + 3x Prysm validators (disabled by default), wired by docker-compose.
- Init flow (run via `make init`):
  1) `docker-compose-init.yaml` runs `genesis/index.mjs` to patch/fund EL genesis, then `prysmctl` generates CL genesis (Electra fork), then `geth init` seeds data dirs for geth/geth-2/geth-3.
  2) Optional: `.env` can define extra funded accounts and bytecode. Keys like `GENESIS_ADDRESS`, `GENESIS_BALANCE_default`, `GENESIS_BALANCE_0x..`, `GENESIS_CODE_0x..`, `GENESIS_NONCE_0x..` (see README example). Script writes to `data/geth/genesis.json`.
- Run flow (via `make start`/`start3`): bring up base EL+CL, then auto-write boot info into `.env` and start peers. Validators are started separately.
- Timing: slots/epochs tuned in `config/config.yml` (defaults SECONDS_PER_SLOT=3, SLOTS_PER_EPOCH=6).

## Core commands (Make targets)
- `make reset` → wipe `./data`, stop all services.
- `make init` → compose init pipeline to build EL/CL genesis.
- `make start` (alias of `start3`) → start geth+prysm, bootstrap EL enode and CL ENR into `.env`, then start secondary nodes.
- `make start-validators` → launch 3 validator containers (interop wallets).
- `make wait-el` / `wait-cl` / `wait-el-head` → readiness helpers using `scripts/wait-*.mjs`.
- `make engine-seed` → seed Engine API forkchoice on all ELs from a node:22-alpine container (mounts ./data for JWT). Use after fresh init to align EL heads.
- `make tx` / `tx-no-wait` → sends a sample transfer using ethers v6 (RPCs: :8545/:8547/:8548).
- `make fresh` → `reset → init → start → wait-el → wait-cl → engine-seed → start-validators → wait-el-head → tx`.

## Compose details
- `docker-compose.yml` exposes:
  - geth: :8545/8546, authrpc :8551 with JWT from `data/geth/geth/jwtsecret`.
  - prysm: beacon API :3500 and gRPC :4000, execution via geth IPC, `--suggested-fee-recipient` set to dev key.
  - peers `geth-2/geth-3` use `EL_BOOTNODE` from `.env`; prysm-2/3 use `PRYSM_BOOTSTRAP_ENR`.
- `docker-compose-init.yaml` order:
  - custom-geth-genesis (node) → create-beacon-chain-genesis (prysmctl) → init-geth-genesis (3x geth init).

## Scripts you’ll reuse
- `scripts/bootstrap-enode.mjs` → resolves `admin.nodeInfo.enode` via geth IPC, normalizes container IP, writes `EL_BOOTNODE=...` to `.env`.
- `scripts/bootstrap-enr.mjs` → polls Prysm identity ENR from beacon API and writes `PRYSM_BOOTSTRAP_ENR=...` to `.env`.
- `scripts/wait-el-ready.mjs` / `wait-el-head.mjs` / `wait-cl-ready.mjs` → relaxed readiness checks (not strict BN>0 for EL-ready; EL-head>0 requires validators).
- `scripts/send-tx.mjs` → ethers v6, rotates across RPC_URLS if not provided; includes fallbacks when tx index warmup delays receipts.
- `genesis/index.mjs` → merges `.env`-driven alloc/bytecode/nonce overrides into genesis alloc.
- `scripts/patch-geth-genesis.mjs` → removes `pragueTime` and `blobSchedule.prague` fields if present to avoid geth v1.16.x fork ordering issues.

## Conventions & pitfalls
- Don’t start validators until EL+CL are up and ENR/bootnode are written (use `make start` then `make start-validators`).
- Readiness:
  - `wait-el` checks chainId + not syncing/indexing; `wait-el-head` requires BN>0 (needs validators producing blocks).
  - `wait-cl` requires all beacon endpoints reachable and at least one non-optimistic.
- JWT secrets are generated inside geth data dirs and consumed by Prysm (`--jwt-secret`). Don’t delete `data/geth/.../jwtsecret` mid-run.
- Chain id is 48815 everywhere (EL and Prysm `--chain-id`).
- Fee recipient uses the dev account from README. Private key is public; never reuse on live chains.

## Typical flows
- Fresh network with tx:
  1) `make fresh` (does all, including engine seed and tx) or stepwise: `make reset init start wait-el wait-cl engine-seed start-validators wait-el-head tx`.
- Change slot timing: edit `config/config.yml` (SECONDS_PER_SLOT/SLOTS_PER_EPOCH), then rerun `make reset init`.
- Fund custom accounts/bytecode at genesis: create `.env` with GENESIS_* keys, run `make init` again.

## Integration points
- External images: geth v1.16.4, prysm v6.1.2, node:22-alpine.
- RPC:
  - EL JSON-RPC: http://127.0.0.1:8545 (others at :8547/:8548)
  - Beacon API: http://127.0.0.1:3500 (others :3502/:3503)
- Scripts use ethers v6 (see `scripts/package.json`). When extending scripts, keep type="module" and ESM imports.

## When adding features
- Prefer wiring via Makefile targets and compose services rather than ad-hoc commands.
- If you add new readiness or bootstrap logic, follow the `scripts/*-ready.mjs` pattern and take endpoints from env (RPC_URL/RPC_URLS, BEACON_URL/BEACON_URLS).
- For genesis tweaks, modify `genesis/index.mjs` or add a dedicated step in `docker-compose-init.yaml` before `create-beacon-chain-genesis`.
