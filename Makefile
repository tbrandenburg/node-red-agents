.DEFAULT_GOAL := help

USER_DIR      := data
NODES_DIR     := $(USER_DIR)/nodes
PACKAGES_DIR  := custom-nodes
TEMPLATE_DIR  := templates/node-package
NODE_RED      := node_modules/.bin/node-red
NODEMON       := node_modules/.bin/nodemon
PID_FILE      := $(USER_DIR)/.node-red.pid
NAME          ?=

.PHONY: help install start dev stop new-node-package clean

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /|/' | awk -F'|' '{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install Node-RED + dev tooling, and data/'s own declared dependencies (e.g. the theme)
	npm install
	cd $(USER_DIR) && npm install

start: ## Run Node-RED (Ctrl+C to stop; or background it and use 'make stop'), UI at http://localhost:1880
	setsid $(NODE_RED) --userDir ./$(USER_DIR) & \
	echo $$! > $(PID_FILE); \
	wait $$!

dev: ## Run Node-RED and auto-restart when node code changes
	setsid $(NODEMON) --watch $(NODES_DIR) --watch $(PACKAGES_DIR) --ext js,html,json \
		--exec "$(NODE_RED) --userDir ./$(USER_DIR)" & \
	echo $$! > $(PID_FILE); \
	wait $$!

stop: ## Stop a Node-RED instance started via 'make start'/'make dev' in the background
	@if [ ! -f $(PID_FILE) ]; then \
		echo "No pidfile at $(PID_FILE); nothing to stop."; \
		exit 0; \
	fi; \
	PID=$$(cat $(PID_FILE)); \
	if kill -0 $$PID 2>/dev/null; then \
		kill -TERM -$$PID 2>/dev/null && echo "Stopped Node-RED (pid $$PID, and its process group)."; \
	else \
		echo "No process running with pid $$PID (stale pidfile)."; \
	fi; \
	rm -f $(PID_FILE)

new-node-package: ## Scaffold a new node package skeleton in custom-nodes/ (usage: make new-node-package NAME=my-node)
	@test -n "$(NAME)" || (echo "usage: make new-node-package NAME=my-node" && exit 1)
	@test ! -d $(PACKAGES_DIR)/$(NAME) || (echo "$(PACKAGES_DIR)/$(NAME) already exists" && exit 1)
	mkdir -p $(PACKAGES_DIR)/$(NAME)
	cp $(TEMPLATE_DIR)/package.json $(PACKAGES_DIR)/$(NAME)/package.json
	cp $(TEMPLATE_DIR)/__NAME__.js $(PACKAGES_DIR)/$(NAME)/$(NAME).js
	cp $(TEMPLATE_DIR)/__NAME__.html $(PACKAGES_DIR)/$(NAME)/$(NAME).html
	sed -i "s/__NAME__/$(NAME)/g" $(PACKAGES_DIR)/$(NAME)/package.json $(PACKAGES_DIR)/$(NAME)/$(NAME).js $(PACKAGES_DIR)/$(NAME)/$(NAME).html
	@echo "Created $(PACKAGES_DIR)/$(NAME) -- it's a plain, uninstalled npm package."
	@echo "Edit it, add any npm deps with 'cd $(PACKAGES_DIR)/$(NAME) && npm install <pkg>',"
	@echo "then load it from the editor: Menu -> Manage palette -> Install tab ->"
	@echo "full path to $(PACKAGES_DIR)/$(NAME)"

clean: ## Remove installed dependencies and generated runtime state
	rm -rf node_modules $(USER_DIR)/node_modules $(USER_DIR)/package-lock.json
	rm -f $(USER_DIR)/flows.json $(USER_DIR)/flows_cred.json $(USER_DIR)/.config.*.json $(PID_FILE)
