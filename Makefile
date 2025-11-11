SLOT := $(shell awk '/^SECONDS_PER_SLOT:/ {print $$2}' config/config.yml)

# Default load parameters (env-overridable)
define LOAD_DEFAULT_ENV
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
BURST_MULTIPLIER=$${BURST_MULTIPLIER:-1}
endef
init:
	docker compose -f docker-compose-init.yaml up && docker compose -f docker-compose-init.yaml down

start:
	docker compose -f docker-compose-set1.yml up -d geth prysm
	node ./scripts/bootstrap-enode.mjs
	- node ./scripts/bootstrap-enr.mjs || true
	docker compose -f docker-compose-set2.yml up -d geth-2 prysm-2
	docker compose -f docker-compose-set3.yml up -d geth-3 prysm-3

stop:
	docker compose -f docker-compose-init.yaml down
	docker compose -f docker-compose-set3.yml down
	docker compose -f docker-compose-set2.yml down
	docker compose -f docker-compose-set1.yml down

reset: stop
	rm -Rf ./data && sleep 1

# Start 3-node stack in proper order and write Prysm ENR into .env automatically.

start-validators:
	docker compose -f docker-compose-set1.yml up -d validator
	docker compose -f docker-compose-set2.yml up -d validator-2
	docker compose -f docker-compose-set3.yml up -d validator-3

# Full clean run (reset -> init -> start -> wait-el -> wait-cl -> engine-seed -> start-validators -> wait-el-head -> tx -> health)
fresh:
	$(MAKE) reset
	$(MAKE) init
	$(MAKE) start
	# Wait for EL and CL readiness
	node ./scripts/wait-el-ready.mjs
	BEACON_URLS="http://127.0.0.1:3500,http://127.0.0.1:3502,http://127.0.0.1:3503" node ./scripts/wait-cl-ready.mjs
	# Seed Engine API forkchoice at genesis on all ELs
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e SECONDS_PER_SLOT=$${SECONDS_PER_SLOT:-$(SLOT)} \
	  node:22-alpine node /scripts/engine-seed.mjs
	# Start validators and wait for EL head to advance
	$(MAKE) start-validators
	RPC_URLS="http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548" node ./scripts/wait-el-head.mjs
	# Sanity TX and health summary
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	node ./scripts/send-tx.mjs
	node ./scripts/check-health.mjs || true

# End-to-end: full bring-up then run load generator in one command
# One-shot: fresh bring-up then run the default load parameters (env-overridable) in one command
fresh-default-load:
	$(MAKE) fresh
	$(LOAD_DEFAULT_ENV) node ./scripts/load-parallel.mjs

# High-gas fresh bring-up (override gasLimit via env)
fresh-highgas:
	$(MAKE) reset
	GENESIS_GAS_LIMIT=$${GENESIS_GAS_LIMIT:-100000000} docker compose -f docker-compose-init.yaml up && docker compose -f docker-compose-init.yaml down
	$(MAKE) start
	node ./scripts/wait-el-ready.mjs
	BEACON_URLS="http://127.0.0.1:3500,http://127.0.0.1:3502,http://127.0.0.1:3503" node ./scripts/wait-cl-ready.mjs
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e SECONDS_PER_SLOT=$${SECONDS_PER_SLOT:-$(SLOT)} \
	  node:22-alpine node /scripts/engine-seed.mjs
	$(MAKE) start-validators
	RPC_URLS="http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548" node ./scripts/wait-el-head.mjs

# Pre-populate worker accounts into genesis via .env then build & start
genesis-fund-workers:
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	COUNT=$${COUNT:-300} OFFSET=$${OFFSET:-0} ETH=$${ETH:-200} node ./scripts/genesis-fund-workers.mjs --count $$COUNT --offset $$OFFSET --eth $$ETH

fresh-workers:
	$(MAKE) reset
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	COUNT=$${COUNT:-300} OFFSET=$${OFFSET:-0} ETH=$${ETH:-200} node ./scripts/genesis-fund-workers.mjs --count $$COUNT --offset $$OFFSET --eth $$ETH
	$(MAKE) init
	$(MAKE) start
	node ./scripts/wait-el-ready.mjs
	BEACON_URLS="http://127.0.0.1:3500,http://127.0.0.1:3502,http://127.0.0.1:3503" node ./scripts/wait-cl-ready.mjs
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e SECONDS_PER_SLOT=$${SECONDS_PER_SLOT:-$(SLOT)} \
	  node:22-alpine node /scripts/engine-seed.mjs
	$(MAKE) start-validators
	RPC_URLS="http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548" node ./scripts/wait-el-head.mjs
# (Intentionally minimal command surface; auxiliary checks are run inside fresh)


