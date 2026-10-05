# pi-lsp-adapter deployment helpers.
#
# This checkout is the source of truth. Pi loads the deployed npm-location
# mirror, not ~/src/pi-lsp-adapter. Never edit the runtime copy directly;
# commit source changes, run `make deploy`, and restart/reload Pi as needed.
#
# Usage:
#   make test        # run interface tests
#   make smoke-test  # load only the deployed extension in a fresh pi
#   make deploy      # copy, stamp, verify, and smoke-test
#   make verify      # verify source/runtime content and deployment stamp

RUNTIME ?= $(HOME)/.pi/agent/npm/node_modules/pi-lsp-adapter
SOURCE = $(HOME)/src/pi-lsp-adapter
SMOKE_SCRIPT ?= /home/dev/src/pi-session-analysis/scripts/predeploy_smoke.py
SMOKE_TIMEOUT ?= 90

# Verify that every configured LSP server can actually start. A server that
# cannot start is silent: pi launches it, waits, and moves on, and the only
# symptom is diagnostics for that filetype quietly ceasing to arrive.
LSP_CHECK_SCRIPT ?= /home/dev/src/pi-session-analysis/scripts/check_lsp_servers.py
LSP_CONFIG ?= $(HOME)/.pi/agent/lsp.json
LSP_CHECK_DEADLINE ?= 15
# The gate fails only on statuses a loaded machine cannot explain: a missing
# binary, an entry point whose interpreter is gone, or a crash. no_response is
# the only status that depends on the deadline, so it warns instead - a gate
# that blocks a deploy because a server was slow is a gate people bypass, which
# is worse than no gate. Set LSP_CHECK_FAIL_ON=all to gate on every failure.
LSP_CHECK_FAIL_ON ?= not_installed,interpreter_missing,crashed

.PHONY: deploy verify link-packages link-pi-deps test test-all smoke-test check-lsp-servers

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
	  node -e "require.resolve('$$pkg', { paths: ['/home/dev/.pi/local/pi-coding-agent/dist/core/extensions'] }); console.log('  OK: ' + '$$pkg')" || exit 1; \
	done

TSX = /home/dev/src/pi-mono/node_modules/.bin/tsx

test: link-packages link-pi-deps  ## Run all tests
	$(TSX) --test tests/*.test.ts

test-all: test smoke-test  ## Run all tests

deploy: ## Copy this checkout, verify it, and smoke-test the deployed extension
	@test -z "$$(git status --porcelain)" || { echo "ERROR: commit source changes before deploying" >&2; git status --short >&2; exit 1; }
	@test -d "$(RUNTIME)" || mkdir -p "$(RUNTIME)"
	@echo "Deploying pi-lsp-adapter to $(RUNTIME)..."
	cp "$(SOURCE)/package.json" "$(RUNTIME)/package.json"
	cp "$(SOURCE)/package-lock.json" "$(RUNTIME)/package-lock.json"
	cp "$(SOURCE)/README.md" "$(RUNTIME)/README.md"
	cp "$(SOURCE)/LICENSE" "$(RUNTIME)/LICENSE"
	rm -rf "$(RUNTIME)/src"
	cp -a "$(SOURCE)/src" "$(RUNTIME)/src"
	@printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\n\nThis is a deployed artifact. Do not edit files here.\nEdit the source checkout and run `make deploy`.\n' \
		"$(SOURCE)" "$$(git -C "$(SOURCE)" rev-parse --abbrev-ref HEAD)" "$$(git -C "$(SOURCE)" rev-parse HEAD)" "$$(date '+%Y-%m-%d %H:%M:%S %z')" \
		> "$(RUNTIME)/.deployed-commit"
	@$(MAKE) --no-print-directory verify
	@$(MAKE) --no-print-directory smoke-test

verify: ## Check deployed files, dependencies, and source commit
	@test -d "$(RUNTIME)" || { echo "ERROR: $(RUNTIME) missing" >&2; exit 1; }
	@test -f "$(RUNTIME)/.deployed-commit" || { echo "ERROR: no .deployed-commit marker" >&2; exit 1; }
	@test "$$(sed -n 's/^commit: //p' "$(RUNTIME)/.deployed-commit")" = "$$(git -C "$(SOURCE)" rev-parse HEAD)" || { echo "ERROR: deployed commit != source HEAD" >&2; exit 1; }
	@diff -qr "$(SOURCE)/src" "$(RUNTIME)/src" >/dev/null || { echo "ERROR: deployed source drift" >&2; exit 1; }
	@cmp -s "$(SOURCE)/package.json" "$(RUNTIME)/package.json" || { echo "ERROR: deployed package.json drift" >&2; exit 1; }
	@cmp -s "$(SOURCE)/package-lock.json" "$(RUNTIME)/package-lock.json" || { echo "ERROR: deployed package-lock.json drift" >&2; exit 1; }
	@node -e "for (const p of ['typebox','vscode-uri','vscode-jsonrpc/node.js','vscode-languageserver-protocol','vscode-languageserver-types']) require.resolve(p, {paths: ['$(RUNTIME)']}); console.log('OK: runtime dependencies resolve')"
	@$(MAKE) --no-print-directory check-lsp-servers
	@echo "OK: $(RUNTIME) matches $(SOURCE) @ $$(git -C "$(SOURCE)" rev-parse --short HEAD)"

check-lsp-servers:  ## Verify every LSP server in $(LSP_CONFIG) can start (ARGS="--json")
	@test -f "$(LSP_CHECK_SCRIPT)" || { echo "ERROR: $(LSP_CHECK_SCRIPT) missing" >&2; exit 1; }
	@python3 "$(LSP_CHECK_SCRIPT)" --config "$(LSP_CONFIG)" --project-root "$(SOURCE)" \
		--deadline "$(LSP_CHECK_DEADLINE)" --fail-on "$(LSP_CHECK_FAIL_ON)" $(ARGS)

smoke-test: ## Load only the deployed extension in a fresh pi process
	python3 "$(SMOKE_SCRIPT)" --extension "$(RUNTIME)/src/index.ts" --tool lsp_list_workspace_roots \
		--timeout "$(SMOKE_TIMEOUT)" \
		--prompt 'Call lsp_list_workspace_roots, report that it loaded, and stop.'

deployed-commit: ## Show which source commit is deployed
	@cat "$(RUNTIME)/.deployed-commit" 2>/dev/null || echo "no .deployed-commit marker"
