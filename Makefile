init:
	docker compose -f docker-compose-init.yaml up
	docker compose -f docker-compose-init.yaml down

start:
	docker compose up -d

stop:
	docker compose -f docker-compose-init.yaml down
	docker compose down

reset: stop
	rm -Rf ./data
	sleep 1

# Start 3-node stack in proper order and write Prysm ENR into .env automatically.
start3:
	# 1) bring up base EL+CL+validator
	docker compose up -d geth prysm validator
	# 2) write EL bootnode and wait for Prysm ENR into .env
	node ./scripts/bootstrap-enode.mjs
	node ./scripts/bootstrap-enr.mjs
	# 3) bring up the rest using the now-populated .env
	docker compose up -d geth-2 geth-3 prysm-2 prysm-3 validator-2 validator-3

# Send a sample transaction via ethers (uses local RPC :8545)
tx:
	node ./scripts/send-tx.mjs
