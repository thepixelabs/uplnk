.PHONY: help install dev build typecheck lint test test-integration \
        docker-build docker-run clean

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace dependencies
	pnpm install

dev: ## Start the app in dev mode under Bun
	pnpm dev

build: ## Compile all packages with tsup
	pnpm build

typecheck: ## Run tsc --noEmit across all packages
	pnpm typecheck

lint: ## ESLint across all packages
	pnpm lint

test: ## Run unit tests across all packages (vitest under Bun)
	pnpm test

test-integration: ## Run integration tests across all packages
	pnpm test:integration

docker-build: ## Build the uplnk Docker image
	docker build -t uplnk .

docker-run: ## Run the uplnk Docker image (mounts ~/.uplnk)
	docker run -it -v ~/.uplnk:/home/uplnk/.uplnk uplnk

clean: ## Remove all node_modules and dist artifacts
	find . -name 'node_modules' -type d -prune -exec rm -rf {} + 2>/dev/null || true
	find . -path '*/packages/*/dist' -type d -prune -exec rm -rf {} + 2>/dev/null || true
