SHELL := /bin/bash

.PHONY: up down services services-down init dev clean check-env load-dummy-data check-db prod-deploy

check-env:
	@if [ ! -f .env ]; then \
		echo "No .env found. Running initialization..."; \
		$(MAKE) init; \
	else \
		echo ".env exists, skipping initialization"; \
	fi

check-db:
	@echo "Checking database..."
	@set -a && . .env && set +a && \
	if ! pnpm --filter @tutly/db with-env prisma db execute --stdin <<< "SELECT 1" >/dev/null 2>&1; then \
		echo "Database connection failed. Setting up database..." && \
		pnpm --filter @tutly/db with-env prisma db push || exit 1 && \
		$(MAKE) load-dummy-data; \
	else \
		echo "Database connection successful. Checking for data..." && \
		USER_COUNT=$$(pnpm --filter @tutly/db with-env prisma db execute --stdin <<< "SELECT COUNT(*) FROM \"User\";" 2>/dev/null | grep -o '[0-9]*') && \
		if [ "$$USER_COUNT" = "0" ]; then \
			echo "Database is empty. Loading dummy data..." && \
			$(MAKE) load-dummy-data; \
		else \
			echo "Database already populated with $$USER_COUNT users"; \
		fi \
	fi

services:
	docker compose -f docker-compose.local.yml up -d
	@echo "Waiting for MinIO to be ready..."
	@until docker compose -f docker-compose.local.yml exec -T minio mc ready local >/dev/null 2>&1; do \
		echo "Waiting for MinIO..."; \
		sleep 2; \
	done
	@echo "MinIO is ready!"
	@echo "Waiting for PostgreSQL to be ready..."
	@until docker compose -f docker-compose.local.yml exec -T db pg_isready -U postgres >/dev/null 2>&1; do \
		echo "Waiting for PostgreSQL..."; \
		sleep 2; \
	done
	@echo "PostgreSQL is ready!"

services-down:
	docker compose -f docker-compose.local.yml down

clean:
	docker compose -f docker-compose.local.yml down -v
	rm -f .env

init:
	@echo "Initializing Tutly..."
	cp .env.example .env
	@echo "Installing dependencies..."
	pnpm install
	@echo "Setting up services..."
	make services
	@echo "Setting up database..."
	pnpm --filter @tutly/db with-env prisma generate
	pnpm --filter @tutly/db with-env prisma db push
	@echo "Loading initial data..."
	make load-dummy-data
	@echo "Initialization complete!"

dev:
	@echo "Starting development server..."
	pnpm run dev:web

studio:
	@echo "Starting Prisma Studio..."
	pnpm --filter @tutly/db with-env prisma studio

load-dummy-data:
	@echo "Loading dummy data..."
	@pnpm --filter @tutly/db seed && echo "Dummy data loaded successfully" || echo "Failed to load dummy data"

up: check-env services check-db
	@echo ""
	@echo "All services are ready. Now you can run one of these commands in a new terminal:"
	@echo "  make dev     - Start the web application"
	@echo "  make studio  - Start Prisma Studio for database management"
	@echo ""

down:
	$(MAKE) services-down
	@pkill -f "prisma studio" || true
	@echo "All services have been stopped"

prod-deploy:
	@echo "Building and deploying production Docker image..."
	@# Check if the network exists, create it if not
	@docker network inspect app_network >/dev/null 2>&1 || docker network create app_network
	docker compose -f docker-compose.prod.yml up -d --build 