# pi-lsp-adapter extension — source-deployed
#
# pi loads pi-lsp-adapter directly from ~/src/pi-lsp-adapter (TypeScript source via tsgo).
# Changes to source take effect immediately — no deploy step needed.
# The deploy target exists as a backup/archive copy to the npm location.
#
# Usage:
#   make test        # run interface tests
#   make smoke-test  # quick-check extension loads in a real pi session
#   make deploy      # backup copy to npm location (not required)
#   make verify      # check deploy matches source

RUNTIME = $(HOME)/.pi/agent/npm/node_modules/pi-lsp-adapter
SOURCE = $(HOME)/src/pi-lsp-adapter

.PHONY: deploy verify link-packages link-pi-deps test test-all smoke-test

link-packages:
	@mkdir -p node_modules
	@ln -sfn /home/dev/.pi/agent/npm/node_modules/typebox node_modules/typebox 2>/dev/null; echo "  [link] typebox"
	@for pkg in vscode-uri vscode-jsonrpc vscode-languageserver-protocol vscode-languageserver-types; do \
	  ln -sfn /home/dev/.pi/agent/npm/node_modules/$$pkg node_modules/$$pkg 2>/dev/null; \
	  echo "  [link] $$pkg"; \
	done

link-pi-deps:  ## Ensure pi-lsp-adapter's npm deps are resolvable from pi's extension loader
	@echo "Linking pi-lsp-adapter dependencies into pi-core's node_modules..."
	@PI_NM=/home/dev/.pi/local/pi-coding-agent/node_modules; \
	for pkg in vscode-uri vscode-jsonrpc vscode-languageserver-protocol vscode-languageserver-types; do \
	  src=/home/dev/.pi/agent/npm/node_modules/$$pkg; \
	  dst=$$PI_NM/$$pkg; \
	  if [ ! -e "$$dst" ]; then \
	    ln -sfn "$$src" "$$dst" && echo "  [link] $$pkg -> $$src"; \
	  else \
	    echo "  [skip] $$pkg already exists"; \
	  fi; \
	done
	@echo "Verifying resolution..."
	@for pkg in vscode-uri vscode-jsonrpc/node.js vscode-languageserver-protocol vscode-languageserver-types; do \
	  node -e "try { require.resolve('$$pkg', { paths: ['/home/dev/.pi/local/pi-coding-agent/dist/core/extensions'] }); console.log('  OK: ' + '$$pkg'); } catch(e) { console.log('  FAIL: ' + '$$pkg: ' + e.message); }" 2>&1; \
	done

TSX = /home/dev/src/pi-mono/node_modules/.bin/tsx

test: link-packages link-pi-deps  ## Run all tests
	$(TSX) --test tests/*.test.ts

test-all: test smoke-test  ## Run all tests

smoke-test:  ## Check extension loads in a real pi session
	@echo "Smoke testing pi-lsp-adapter extension in pi..."
	@rm -f /tmp/pi-lsp-smoke.jsonl
	@(timeout 120 pi --mode json --no-session -p "list your available tools" > /tmp/pi-lsp-smoke.jsonl 2>&1) &
	@PID=$$!; \
	  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	    if grep -q 'lsp_diagnostics' /tmp/pi-lsp-smoke.jsonl 2>/dev/null; then \
	      echo "  OK: lsp_diagnostics tool found in pi output"; \
	      kill $$PID 2>/dev/null; exit 0; \
	    fi; \
	    sleep 2; \
	  done; \
	  echo "  WARN: pi not responding — check /tmp/pi-lsp-smoke.jsonl"; \
	  kill $$PID 2>/dev/null; exit 1

deploy: ## Backup copy to npm location (not required — pi loads from source)
	@echo "Backing up pi-lsp-adapter to $(RUNTIME)..."
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
