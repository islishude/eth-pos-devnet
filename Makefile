init:
	docker-compose -f docker-compose-init.yaml up
	docker-compose -f docker-compose-init.yaml down

start:
	docker compose up -d

stop:
	docker-compose -f docker-compose-init.yaml down
	docker-compose down

reset: stop
	rm -Rf ./data
	sleep 1
