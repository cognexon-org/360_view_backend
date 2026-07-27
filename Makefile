.PHONY: up down logs reset test

up:
	cp -n .env.example .env || true
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f api worker vision

reset:
	docker compose down -v

test:
	docker compose run --rm api npm test
	docker compose run --rm vision pytest -q
