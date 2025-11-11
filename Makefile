define LOAD_DEFAULT_ENV
TOTAL_TARGET_TPS=$${TOTAL_TARGET_TPS:-400} \
TOTAL_WORKERS=$${TOTAL_WORKERS:-300} \
DURATION_SEC=$${DURATION_SEC:-20}
endef
define RESTART_DEFAULT_ENV
RESTART_INTERVAL_SEC=$${RESTART_INTERVAL_SEC:-20}
endef
init:
	docker compose -f docker-compose-init.yaml up && docker compose -f docker-compose-init.yaml down

start:
	docker compose -f docker-compose-set1.yml up -d geth prysm
	node ./scripts/bootstrap-enode.mjs
	- node ./scripts/bootstrap-enr.mjs || true
	docker compose -f docker-compose-set2.yml up -d geth-2 prysm-2
	docker compose -f docker-compose-set3.yml up -d geth-3 prysm-3
	- node ./scripts/bootstrap-enode-all.mjs || true
	- node ./scripts/bootstrap-enr-all.mjs || true

stop:
	docker compose -f docker-compose-init.yaml down
	docker compose -f docker-compose-set3.yml down
	docker compose -f docker-compose-set2.yml down
	docker compose -f docker-compose-set1.yml down

reset: stop
	rm -Rf ./data && sleep 1

start-validators:
	docker compose -f docker-compose-set1.yml up -d validator
	docker compose -f docker-compose-set2.yml up -d validator-2
	docker compose -f docker-compose-set3.yml up -d validator-3

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
	  -e SECONDS_PER_SLOT=$${SECONDS_PER_SLOT:-2} \
	  node:22-alpine node /scripts/engine-seed.mjs
	# Multi-bootstrap refresh after peers are up
	- $(MAKE) bootstrap-all || true
	# Start validators and wait for EL head to advance
	$(MAKE) start-validators
	RPC_URLS="http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548" node ./scripts/wait-el-head.mjs
	# Sanity TX and health summary
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	node ./scripts/send-tx.mjs
	node ./scripts/check-health.mjs || true

fresh-load:
	$(MAKE) fresh
	$(LOAD_DEFAULT_ENV) ENDPOINTS=$${ENDPOINTS:-http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548} DIRECT_TRANSFER=$${DIRECT_TRANSFER:-1} node ./scripts/load-parallel.mjs

 
.PHONY: metrics
metrics:
	mkdir -p ./metrics
	ENDPOINTS=$${ENDPOINTS:-http://127.0.0.1:8545,http://127.0.0.1:8547,http://127.0.0.1:8548} \
	BEACON_URLS=$${BEACON_URLS:-http://127.0.0.1:3500,http://127.0.0.1:3502,http://127.0.0.1:3503} \
	INTERVAL_MS=$${INTERVAL_MS:-1000} \
	DURATION_SEC=$${DURATION_SEC:-0} \
	node ./scripts/metrics-sample2.mjs

.PHONY: bootstrap-all
bootstrap-all:
	node ./scripts/bootstrap-enode-all.mjs
	node ./scripts/bootstrap-enr-all.mjs

.PHONY: downup-set3
downup-set3:
	docker compose -f docker-compose-set3.yml down || true
	# Ensure latest boot info is written before restarting set3 so clients can form peers
	- $(MAKE) bootstrap-all || true
	docker compose -f docker-compose-set3.yml up -d geth-3 prysm-3
	RPC_URL=http://127.0.0.1:8548 node ./scripts/wait-el-ready.mjs
	# Pre-warm for set3 geth/prysm before validator
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e ENGINE_NAME=geth-3 \
	  -e ENGINE_JWT=/data/geth-3/geth/jwtsecret \
	  -e ENGINE_URL=http://geth-3:8551 \
	  -e ENGINE_RPC_URL=http://geth-3:8545 \
	  node:22-alpine node /scripts/engine-refresh-fcu.mjs || true
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e ENGINE_NAME=geth-3 \
	  -e ENGINE_JWT=/data/geth-3/geth/jwtsecret \
	  -e ENGINE_URL=http://geth-3:8551 \
	  -e ENGINE_RPC_URL=http://geth-3:8545 \
	  -e BEACON_URL=http://prysm-3:3500 \
	  -e WARM_V3_ONLY=1 -e WARM_REQUIRE_BEACON=1 \
	  -e WARM_RETRIES=$${WARM_RETRIES:-9} -e WARM_INTERVAL_MS=$${WARM_INTERVAL_MS:-600} \
	  node:22-alpine node /scripts/engine-warm.mjs || true
	sleep 1
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e ENGINE_NAME=geth-3 \
	  -e ENGINE_JWT=/data/geth-3/geth/jwtsecret \
	  -e ENGINE_URL=http://geth-3:8551 \
	  -e ENGINE_RPC_URL=http://geth-3:8545 \
	  -e BEACON_URL=http://prysm-3:3500 \
	  -e WARM_V3_ONLY=1 -e WARM_REQUIRE_BEACON=1 \
	  -e WARM_RETRIES=$${WARM_RETRIES:-9} -e WARM_INTERVAL_MS=$${WARM_INTERVAL_MS:-600} \
	  node:22-alpine node /scripts/engine-warm.mjs || true
	sleep 2
	# Wait for beacon-3 readiness and peer formation before starting validator-3
	BEACON_URLS="http://127.0.0.1:3503" WAIT_CL_TIMEOUT_MS=$${WAIT_CL_TIMEOUT_MS:-60000} node ./scripts/wait-cl-ready.mjs || true
	docker compose -f docker-compose-set3.yml up -d validator-3
	sleep $${SECONDS_PER_SLOT:-2}
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e ENGINE_NAME=geth-3 \
	  -e ENGINE_JWT=/data/geth-3/geth/jwtsecret \
	  -e ENGINE_URL=http://geth-3:8551 \
	  -e ENGINE_RPC_URL=http://geth-3:8545 \
	  node:22-alpine node /scripts/engine-refresh-fcu.mjs || true
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e ENGINE_NAME=geth-3 \
	  -e ENGINE_JWT=/data/geth-3/geth/jwtsecret \
	  -e ENGINE_URL=http://geth-3:8551 \
	  -e ENGINE_RPC_URL=http://geth-3:8545 \
	  -e BEACON_URL=http://prysm-3:3500 \
	  -e WARM_VERIFY=1 \
	  -e WARM_V3_ONLY=1 \
	  -e WARM_RETRIES=$${WARM_RETRIES:-12} -e WARM_INTERVAL_MS=$${WARM_INTERVAL_MS:-600} \
	  node:22-alpine node /scripts/engine-warm.mjs || true
	sleep 1
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e ENGINE_NAME=geth-3 \
	  -e ENGINE_JWT=/data/geth-3/geth/jwtsecret \
	  -e ENGINE_URL=http://geth-3:8551 \
	  -e ENGINE_RPC_URL=http://geth-3:8545 \
	  -e BEACON_URL=http://prysm-3:3500 \
	  -e WARM_VERIFY=1 \
	  -e WARM_V3_ONLY=1 \
	  -e WARM_RETRIES=$${WARM_RETRIES:-8} -e WARM_INTERVAL_MS=$${WARM_INTERVAL_MS:-600} \
	  node:22-alpine node /scripts/engine-warm.mjs || true
	RPC_URLS="http://127.0.0.1:8548" node ./scripts/wait-el-head.mjs || true
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	RPC_URLS="http://127.0.0.1:8548" BEACON_URLS="http://127.0.0.1:3503" HEALTH_MAX_WAIT_SEC=$${HEALTH_MAX_WAIT_SEC:-40} node ./scripts/check-health.mjs || true
	- $(MAKE) bootstrap-all || true

.PHONY: downup-set3-every
downup-set3-every:
	$(RESTART_DEFAULT_ENV) while true; do sleep $$RESTART_INTERVAL_SEC; $(MAKE) downup-set3; done