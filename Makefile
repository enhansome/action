# enhansome/action — developer targets.
# act is driven with the flags below (colima on Apple Silicon -> linux/amd64).
ACT_FLAGS := --container-architecture linux/amd64 --container-daemon-socket -

.PHONY: help install build test shellcheck e2e act-list ci

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install JS dependencies
	npm ci

build: ## Typecheck (tsc)
	npm run build

test: ## Run the vitest unit suite (hermetic, no network)
	npm test

shellcheck: ## Lint entrypoint.sh
	shellcheck entrypoint.sh

e2e: ## Run the e2e job locally with act
	act $(ACT_FLAGS) --job e2e

act-list: ## List workflow jobs act can see
	act $(ACT_FLAGS) -l

ci: test shellcheck ## Local CI checks (no Docker). Use 'make e2e' for integration.
