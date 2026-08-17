.DEFAULT_GOAL := help

USER_DIR      := data
NODES_DIR     := $(USER_DIR)/nodes
DEMO_DIR      := demo
DEMO_PID_FILE := $(DEMO_DIR)/.node-red.pid
PACKAGE_DIR   := packages/node-red-agents
PACKAGE_JSON  := $(PACKAGE_DIR)/package.json
TEMPLATE_DIR  := templates/node-package
NODE_RED      := node_modules/.bin/node-red
NODEMON       := node_modules/.bin/nodemon
PID_FILE      := $(USER_DIR)/.node-red.pid
NAME          ?=
BUMP          ?=

.PHONY: help install start dev stop demo demo-install demo-stop new-node-package format lint test test-e2e ci release publish clean

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /|/' | awk -F'|' '{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install Node-RED + dev tooling, and data/'s own declared dependencies (e.g. the theme)
	npm install
	cd $(USER_DIR) && npm install

start: ## Run Node-RED (Ctrl+C to stop; or background it and use 'make stop'), UI at http://localhost:1880
	$(NODE_RED) --userDir ./$(USER_DIR) & \
	echo $$! > $(PID_FILE); \
	wait $$!

dev: ## Run Node-RED and auto-restart when node code changes
	$(NODEMON) --watch $(NODES_DIR) --watch $(PACKAGE_DIR)/nodes --ext js,html,json \
		--exec "$(NODE_RED) --userDir ./$(USER_DIR)" & \
	echo $$! > $(PID_FILE); \
	wait $$!

stop: ## Stop a Node-RED instance started via 'make start'/'make dev' in the background
	@if [ ! -f $(PID_FILE) ]; then \
		echo "No pidfile at $(PID_FILE); nothing to stop."; \
		exit 0; \
	fi; \
	stop_tree() { for CHILD in $$(pgrep -P "$$1" 2>/dev/null); do stop_tree "$$CHILD"; done; kill -TERM "$$1" 2>/dev/null; }; \
	PID=$$(cat $(PID_FILE)); \
	if kill -0 $$PID 2>/dev/null; then \
		stop_tree $$PID && echo "Stopped Node-RED (pid $$PID and its child processes)."; \
	else \
		echo "No process running with pid $$PID (stale pidfile)."; \
	fi; \
	rm -f $(PID_FILE)

demo-install: ## Install demo/'s own declared dependencies (dashboard, theme, node-red-agents)
	cd $(DEMO_DIR) && npm install

demo: demo-install ## Run the demo flow (data/flows.json's public counterpart), UI at http://localhost:1881
	$(NODE_RED) --userDir ./$(DEMO_DIR) & \
	echo $$! > $(DEMO_PID_FILE); \
	wait $$!

demo-stop: ## Stop a demo instance started via 'make demo' in the background
	@if [ ! -f $(DEMO_PID_FILE) ]; then \
		echo "No pidfile at $(DEMO_PID_FILE); nothing to stop."; \
		exit 0; \
	fi; \
	stop_tree() { for CHILD in $$(pgrep -P "$$1" 2>/dev/null); do stop_tree "$$CHILD"; done; kill -TERM "$$1" 2>/dev/null; }; \
	PID=$$(cat $(DEMO_PID_FILE)); \
	if kill -0 $$PID 2>/dev/null; then \
		stop_tree $$PID && echo "Stopped demo Node-RED (pid $$PID and its child processes)."; \
	else \
		echo "No process running with pid $$PID (stale pidfile)."; \
	fi; \
	rm -f $(DEMO_PID_FILE)

new-node-package: ## Scaffold a new node inside packages/node-red-agents/nodes/ (usage: make new-node-package NAME=my-node)
	@test -n "$(NAME)" || (echo "usage: make new-node-package NAME=my-node" && exit 1)
	@test ! -d $(PACKAGE_DIR)/nodes/$(NAME) || (echo "$(PACKAGE_DIR)/nodes/$(NAME) already exists" && exit 1)
	mkdir -p $(PACKAGE_DIR)/nodes/$(NAME)/test
	cp $(TEMPLATE_DIR)/__NAME__.js $(PACKAGE_DIR)/nodes/$(NAME)/$(NAME).js
	cp $(TEMPLATE_DIR)/__NAME__.html $(PACKAGE_DIR)/nodes/$(NAME)/$(NAME).html
	cp $(TEMPLATE_DIR)/__NAME__.spec.js $(PACKAGE_DIR)/nodes/$(NAME)/test/$(NAME).spec.js
	sed -i "s/__NAME__/$(NAME)/g" $(PACKAGE_DIR)/nodes/$(NAME)/$(NAME).js $(PACKAGE_DIR)/nodes/$(NAME)/$(NAME).html $(PACKAGE_DIR)/nodes/$(NAME)/test/$(NAME).spec.js
	node scripts/register-node.js $(NAME)
	@echo "Created $(PACKAGE_DIR)/nodes/$(NAME) and registered it in $(PACKAGE_JSON)."
	@echo "Edit it, add any npm deps with 'cd $(PACKAGE_DIR) && npm install <pkg>',"
	@echo "then restart Node-RED (already linked into data/ via npm workspaces --"
	@echo "no separate 'Manage palette -> Install' step needed)."

test: install ## Run unit + node-level integration tests for node-red-agents (offline, CI's default gate)
	npm test

test-e2e: install ## Run the smoke/E2E suite (boots a real, throwaway Node-RED instance; needs real gh/opencode CLIs on PATH -- not part of 'make test'/CI's default gate)
	node --test test/integration/smoke.spec.js

format: install ## Check formatting with Prettier (use FIX=1 to rewrite files in place)
	node_modules/.bin/prettier $(if $(FIX),--write,--check) .

lint: install ## Lint with ESLint (use FIX=1 to auto-fix what it can)
	node_modules/.bin/eslint $(if $(FIX),--fix,) .

ci: format lint test test-e2e ## Run the full local gate: format check, lint, unit+integration tests, and the E2E suite

release: ## Bump packages/node-red-agents's version and tag the release commit (usage: make release BUMP=patch, minor, or major)
	@case "$(BUMP)" in \
		patch|minor|major) ;; \
		*) echo "usage: make release BUMP=patch|minor|major"; exit 1;; \
	esac
	@git diff --quiet && git diff --cached --quiet || \
		(echo "release: working tree has uncommitted changes -- commit or stash first" && exit 1)
	$(MAKE) test
	cd $(PACKAGE_DIR) && npm version $(BUMP) --no-git-tag-version
	@NEW_VERSION=$$(node -p "require('./$(PACKAGE_JSON)').version"); \
	echo "Bumped $(PACKAGE_DIR) to $$NEW_VERSION"; \
	npm install --package-lock-only --workspaces >/dev/null 2>&1; \
	git add $(PACKAGE_JSON) package-lock.json; \
	git commit -m "release: node-red-agents v$$NEW_VERSION"; \
	git tag -a "node-red-agents@$$NEW_VERSION" -m "release: node-red-agents v$$NEW_VERSION"; \
	echo "Tagged node-red-agents@$$NEW_VERSION on $$(git rev-parse --short HEAD)."; \
	echo "Next: 'git push --follow-tags', then 'make publish' (you'll need to enter your npm OTP -- 2FA)."

publish: ## Verify preconditions, run npm publish, and create the matching GitHub Release for packages/node-red-agents (you complete the npm 2FA/OTP prompt yourself; PUBLISH_DRY_RUN=1 to rehearse without publishing or releasing)
	@git diff --quiet && git diff --cached --quiet || \
		(echo "publish: working tree has uncommitted changes -- aborting" && exit 1)
	@VERSION=$$(node -p "require('./$(PACKAGE_JSON)').version"); \
	if ! git rev-parse -q --verify "refs/tags/node-red-agents@$$VERSION" >/dev/null; then \
		echo "publish: no tag node-red-agents@$$VERSION found -- run 'make release BUMP=...' first"; \
		exit 1; \
	fi; \
	TAG_TREE=$$(git rev-parse "node-red-agents@$$VERSION:$(PACKAGE_DIR)"); \
	HEAD_TREE=$$(git rev-parse "HEAD:$(PACKAGE_DIR)"); \
	if [ "$$TAG_TREE" != "$$HEAD_TREE" ]; then \
		echo "publish: $(PACKAGE_DIR) at HEAD doesn't match what node-red-agents@$$VERSION tagged -- rerun 'make release BUMP=...' or checkout the tag"; \
		exit 1; \
	fi
	$(MAKE) test
	cd $(PACKAGE_DIR) && npm pack --dry-run
	@npm whoami >/dev/null 2>&1 || (echo "publish: not logged in to npm -- run 'npm login' first" && exit 1)
	@VERSION=$$(node -p "require('./$(PACKAGE_JSON)').version"); \
	echo "About to publish node-red-agents@$$VERSION -- you'll be prompted for your npm OTP."
	cd $(PACKAGE_DIR) && npm publish --access public $(if $(PUBLISH_DRY_RUN),--dry-run,)
	@if [ -n "$(PUBLISH_DRY_RUN)" ]; then \
		echo "PUBLISH_DRY_RUN set -- skipping GitHub Release creation (nothing was actually published)."; \
		exit 0; \
	fi; \
	VERSION=$$(node -p "require('./$(PACKAGE_JSON)').version"); \
	TAG="node-red-agents@$$VERSION"; \
	if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then \
		echo "gh not installed/authenticated -- skipping GitHub Release. Create it yourself with:"; \
		echo "  gh release create $$TAG --title \"node-red-agents v$$VERSION\" --generate-notes"; \
		exit 0; \
	fi; \
	if gh release view "$$TAG" >/dev/null 2>&1; then \
		echo "GitHub release $$TAG already exists -- skipping."; \
	else \
		gh release create "$$TAG" --title "node-red-agents v$$VERSION" --generate-notes; \
		echo "Created GitHub release $$TAG."; \
	fi

clean: ## Remove installed dependencies and generated runtime state
	rm -rf node_modules $(USER_DIR)/node_modules $(USER_DIR)/package-lock.json
	rm -f $(USER_DIR)/flows.json $(USER_DIR)/flows_cred.json $(USER_DIR)/.config.*.json $(PID_FILE)
