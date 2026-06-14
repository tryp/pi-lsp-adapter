# pi-lsp-adapter extension — copy-based deployment
#
# Usage:
#   make deploy      # copy fork files to runtime npm location
#   make verify      # check deployed files match source

RUNTIME = $(HOME)/.pi/agent/npm/node_modules/pi-lsp-adapter
SOURCE = $(HOME)/src/pi-lsp-adapter

# Files needed at runtime (extension loads from src/index.ts via tsgo)
DEPLOY_DIRS = \
	src \
	node_modules

DEPLOY_FILES = \
	package.json \
	README.md \
	LICENSE

.PHONY: deploy verify link-packages test

link-packages:
	@mkdir -p node_modules
	@ln -sfn /home/dev/.pi/agent/npm/node_modules/typebox node_modules/typebox 2>/dev/null; echo "  [link] typebox"

TSX = /home/dev/src/pi-mono/node_modules/.bin/tsx

test: link-packages  ## Run interface tests
	$(TSX) --test tests/interface.test.ts

deploy: ## Copy fork files to runtime npm location
	@echo "Deploying pi-lsp-adapter to $(RUNTIME)..."
	cp "$(SOURCE)/package.json" "$(RUNTIME)/package.json"
	cp "$(SOURCE)/README.md" "$(RUNTIME)/README.md" 2>/dev/null || true
	cp "$(SOURCE)/LICENSE" "$(RUNTIME)/LICENSE" 2>/dev/null || true
	rm -rf "$(RUNTIME)/src"
	cp -a "$(SOURCE)/src" "$(RUNTIME)/src"
	# Don't overwrite node_modules — it's managed by npm in the runtime
	@echo "Done. Verify with 'make verify'"

verify: ## Check deployed files match source
	@echo "Verifying pi-lsp-adapter deploy..."
	@diff -q "$(SOURCE)/src/index.ts" "$(RUNTIME)/src/index.ts" && \
	  echo "  src/index.ts: OK" || echo "  src/index.ts: MISMATCH"
	@diff -q "$(SOURCE)/package.json" "$(RUNTIME)/package.json" && \
	  echo "  package.json: OK" || echo "  package.json: MISMATCH"
	@echo "Verify complete"
