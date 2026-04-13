NODE_VERSION := 22.22.2

.PHONY: help install dev build typecheck lint test test-integration \
        rebuild-native docker-build docker-run clean

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace dependencies and rebuild native addons for pinned Node
	volta run --node $(NODE_VERSION) pnpm install
	volta run --node $(NODE_VERSION) pnpm rebuild better-sqlite3

dev: ## Start the app in dev mode (tsx watch)
	volta run --node $(NODE_VERSION) pnpm dev

build: ## Compile all packages with tsup
	volta run --node $(NODE_VERSION) pnpm build

typecheck: ## Run tsc --noEmit across all packages
	volta run --node $(NODE_VERSION) pnpm typecheck

lint: ## ESLint across all packages
	volta run --node $(NODE_VERSION) pnpm lint

test: ## Run unit tests across all packages
	volta run --node $(NODE_VERSION) pnpm test

test-integration: ## Run integration tests across all packages
	volta run --node $(NODE_VERSION) pnpm test:integration

rebuild-native: ## Rebuild better-sqlite3 for the pinned Node version
	volta run --node $(NODE_VERSION) pnpm rebuild better-sqlite3

docker-build: ## Build the uplnk Docker image
	docker build -t uplnk-dev .

docker-run: ## Run the uplnk Docker image (mounts ~/.uplnk)
	docker run -it -v ~/.uplnk:/home/uplnk/.uplnk uplnk-dev

clean: ## Remove all node_modules and dist artifacts
	find . -name 'node_modules' -type d -prune -exec rm -rf {} + 2>/dev/null || true
	find . -path '*/packages/*/dist' -type d -prune -exec rm -rf {} + 2>/dev/null || true
