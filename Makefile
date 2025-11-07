init:
	docker compose -f docker-compose-init.yaml up
	docker compose -f docker-compose-init.yaml down

start: start3
	@true

stop:
	docker compose -f docker-compose-init.yaml down
	docker compose down

reset: stop
	rm -Rf ./data
	sleep 1

# Start 3-node stack in proper order and write Prysm ENR into .env automatically.

start3:
	# 1) bring up base EL+CL (validatorsは後で起動)
	docker compose up -d geth prysm
	# 2) write EL bootnode and wait for Prysm ENR into .env
	node ./scripts/bootstrap-enode.mjs
	- node ./scripts/bootstrap-enr.mjs || true
	# 3) bring up the rest using the now-populated .env (validatorsは後で起動)
	docker compose up -d geth-2 geth-3 prysm-2 prysm-3

start-validators:
	 docker compose up -d validator validator-2 validator-3

# Send a sample transaction via ethers (uses local RPC :8545)
tx:
	# Ensure deps for scripts are installed
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	node ./scripts/send-tx.mjs

tx-no-wait:
	# Ensure deps for scripts are installed
	npm --prefix ./scripts ci || npm --prefix ./scripts i
	WAIT_FOR_RECEIPT=0 node ./scripts/send-tx.mjs

# Convenience: full clean run (reset -> init -> start -> wait-el -> wait-cl(all) -> start-validators -> tx)
fresh: reset init start wait-el wait-cl start-validators wait-el-head tx diagnose health
# Consolidated health check (prints success message or reasons)
health:
	node ./scripts/check-health.mjs || true

# Seed Engine API forkchoice at genesis on all ELs. Helps CL exit optimistic sooner.
engine-seed:
	docker run --rm \
	  --network devnet_default \
	  -v $$(pwd)/data:/data:ro \
	  -v $$(pwd)/scripts:/scripts:ro \
	  -e SECONDS_PER_SLOT=$${SECONDS_PER_SLOT:-3} \
	  node:22-alpine node /scripts/engine-seed.mjs

# Continuous seeding for several dozen slots (optional)
engine-seed-cont:
	docker run --rm \
	  --network devnet_default \
	  -e SEED_CONTINUOUS=1 \
	  -e SEED_MAX_SLOTS=$${SEED_MAX_SLOTS:-60} \
	  -e SEED_SLOTS=$${SEED_SLOTS:-3} \
	  -e SECONDS_PER_SLOT=$${SECONDS_PER_SLOT:-3} \
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
	npx --yes node-fetch >/dev/null 2>&1 || true
	node ./scripts/check-cl-sync.mjs || true
	@echo "== Execution heads =="
	node ./scripts/check-el-heads.mjs || true

# Fresh run + immediate diagnostics in one step
fresh-diagnose: fresh diagnose
