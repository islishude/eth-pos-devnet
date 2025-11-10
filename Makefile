SLOT := $(shell awk '/^SECONDS_PER_SLOT:/ {print $$2}' config/config.yml)
init:
	docker compose -f docker-compose-init.yaml up
	docker compose -f docker-compose-init.yaml down

start:
	# Start set1 (geth-1 + prysm-1), then bootstrap env for others
	docker compose -f docker-compose-set1.yml up -d geth prysm
	node ./scripts/bootstrap-enode.mjs
	- node ./scripts/bootstrap-enr.mjs || true
	# Start set2 and set3 (geth-2/prysm-2, geth-3/prysm-3)
	docker compose -f docker-compose-set2.yml up -d geth-2 prysm-2
	docker compose -f docker-compose-set3.yml up -d geth-3 prysm-3

stop:
	docker compose -f docker-compose-init.yaml down
	docker compose -f docker-compose-set3.yml down
	docker compose -f docker-compose-set2.yml down
	docker compose -f docker-compose-set1.yml down

reset: stop
	rm -Rf ./data
	sleep 1

# Start 3-node stack in proper order and write Prysm ENR into .env automatically.

start-validators:
	docker compose -f docker-compose-set1.yml up -d validator
	docker compose -f docker-compose-set2.yml up -d validator-2
	docker compose -f docker-compose-set3.yml up -d validator-3

# Send a sample transaction via ethers (uses local RPC :8545)
tx:
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	node ./scripts/send-tx.mjs

tx-no-wait:
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	WAIT_FOR_RECEIPT=0 node ./scripts/send-tx.mjs

# Simple forward-load using ethers v6 script

# Convenience: full clean run (reset -> init -> start -> wait-el -> wait-cl(all) -> engine-seed -> start-validators -> tx)
fresh: reset init start wait-el wait-cl engine-seed start-validators wait-el-head tx diagnose health

# End-to-end: full bring-up then run load generator in one command
# One-shot: fresh bring-up then run the default load parameters (env-overridable) in one command
fresh-default-load:
	$(MAKE) fresh
	ENDPOINTS=$${ENDPOINTS:-"http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548"} \
	TOTAL_TARGET_TPS=$${TOTAL_TARGET_TPS:-450} \
	TOTAL_WORKERS=$${TOTAL_WORKERS:-300} \
	DURATION_SEC=$${DURATION_SEC:-20} \
	DIRECT_TRANSFER=$${DIRECT_TRANSFER:-1} \
	ONLY_HTTP=$${ONLY_HTTP:-1} \
	USE_RAW_SEND=$${USE_RAW_SEND:-1} \
	FUND_WORKERS=$${FUND_WORKERS:-0} \
	FUND_TOP_N=$${FUND_TOP_N:-0} \
	RECEIPT_DRAIN_MS=$${RECEIPT_DRAIN_MS:-4000} \
	BURST_MULTIPLIER=$${BURST_MULTIPLIER:-1} \
	node ./scripts/load-parallel.mjs

# Back-compat alias (uses default params, not "last chosen")
fresh-last-load: fresh-default-load

# High-gas fresh bring-up (override gasLimit via env)
fresh-highgas:
	$(MAKE) reset
	GENESIS_GAS_LIMIT=$${GENESIS_GAS_LIMIT:-100000000} docker compose -f docker-compose-init.yaml up
	docker compose -f docker-compose-init.yaml down
	$(MAKE) start wait-el wait-cl engine-seed start-validators wait-el-head

# Pre-populate worker accounts into genesis via .env then build & start
genesis-fund-workers:
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	COUNT=$${COUNT:-300} OFFSET=$${OFFSET:-0} ETH=$${ETH:-200} node ./scripts/genesis-fund-workers.mjs --count $$COUNT --offset $$OFFSET --eth $$ETH

fresh-workers:
	$(MAKE) reset
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	COUNT=$${COUNT:-300} OFFSET=$${OFFSET:-0} ETH=$${ETH:-200} node ./scripts/genesis-fund-workers.mjs --count $$COUNT --offset $$OFFSET --eth $$ETH
	$(MAKE) init start wait-el wait-cl engine-seed start-validators wait-el-head
# Consolidated health check (prints success message or reasons)
health:
	node ./scripts/check-health.mjs || true

# Seed Engine API forkchoice at genesis on all ELs. Helps CL exit optimistic sooner.
engine-seed:
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e SECONDS_PER_SLOT=$${SECONDS_PER_SLOT:-$(SLOT)} \
	  node:22-alpine node /scripts/engine-seed.mjs

# Continuous seeding for several dozen slots (optional)
engine-seed-cont:
	docker run --rm \
	  --network devnet_default \
	  -e SEED_CONTINUOUS=1 \
	  -e SEED_MAX_SLOTS=$${SEED_MAX_SLOTS:-60} \
	  -e SEED_SLOTS=$${SEED_SLOTS:-3} \
	  -e SECONDS_PER_SLOT=$${SECONDS_PER_SLOT:-$(SLOT)} \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  node:22-alpine node /scripts/engine-seed.mjs

# Kickstart flow: seed forkchoice, restart CL to bind new head, then start validators, wait for EL head
kickstart: engine-seed
	docker compose restart prysm prysm-2 prysm-3
	sleep 3
	$(MAKE) start-validators
	$(MAKE) wait-el-head

# Quick sanity: print chainId and latest block from local EL
check:
	@echo "chainId:" && curl -s http://127.0.0.1:8545 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | jq -r .result
	@echo "blockNumber:" && curl -s http://127.0.0.1:8545 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":2}' | jq -r .result

# Wait until EL is ready to serve receipts reliably (blockNumber>0 and tx index warmed up)
wait-el:
	node ./scripts/wait-el-ready.mjs

# Wait until CL is not optimistic (beacon API is_optimistic=false)
wait-cl:
	BEACON_URLS="http://127.0.0.1:3500,http://127.0.0.1:3502,http://127.0.0.1:3503" node ./scripts/wait-cl-ready.mjs

# Wait until any EL endpoint has blockNumber>0 (requires validators to be running)
wait-el-head:
	RPC_URLS="http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548" node ./scripts/wait-el-head.mjs

# Diagnose helpers
diagnose:
	@echo "== Consensus syncing =="
	node ./scripts/check-cl-sync.mjs || true
	@echo "== Execution heads =="
	node ./scripts/check-el-heads.mjs || true


