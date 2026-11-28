# Whombat hosts service build (formerly Rackoon). Tools come from mise (see mise.toml).
# The hub binary is whombat-hosts, the agent whombat-agent (docs/WHOMBAT.md).
# `dev` unless given: this repository's tags are the app's and the contracts' (app-v…, contracts-v…), which say nothing
# about an agent, and agents can't order a version made from them.
VERSION ?= dev
GO      ?= mise exec -- go
PNPM    ?= mise exec -- pnpm
LDFLAGS := -s -w -X main.version=$(VERSION)
DIST    := dist

.PHONY: visual visual-update all web agents agents-unsigned agent-windows-check headless hub test test-go test-web lint lint-go ci clean dev-hub dev-web dev-fixtures deb deploy-dev

all: hub

## web: build the SPA into web/dist
web:
	cd web && $(PNPM) install --frozen-lockfile && $(PNPM) build

## agents: static agent binaries for Linux, macOS and Windows, amd64 and arm64, signed for self-update
# The update key (cmd/rackoon-sign: $RACKOON_SIGNING_KEY or
# ~/.config/rackoon/update-signing.key, created on first use, never in the
# repository) is built into the agents; dist/agent/manifest.json carries
# each binary's SHA-256 and signature.
# AGENT_TARGETS are the agent builds: Linux, macOS and Windows (cgo-free),
# each for amd64 and arm64. A Windows build's file ends in .exe.
AGENT_TARGETS := linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64 windows-arm64
AGENT_FILES := $(foreach t,$(AGENT_TARGETS),whombat-agent-$(t)$(if $(filter windows-%,$(t)),.exe))

agents:
	mkdir -p $(DIST)/agent
	set -e; \
	KEY=$$($(GO) run ./cmd/rackoon-sign pubkey); test -n "$$KEY"; \
	for t in $(AGENT_TARGETS); do \
		CGO_ENABLED=0 GOOS=$${t%-*} GOARCH=$${t#*-} $(GO) build -trimpath \
			-ldflags "$(LDFLAGS) -X rackoon/internal/agent.UpdatePublicKey=$$KEY" \
			-o $(DIST)/agent/whombat-agent-$$t$$(case $$t in windows-*) echo .exe;; esac) ./cmd/whombat-agent; \
	done
	$(GO) run ./cmd/rackoon-sign manifest --version '$(VERSION)' --dir $(DIST)/agent $(AGENT_FILES)

## agents-unsigned: the agent builds without an update key (self-update off),
## as the appliance's DEV image packages them
agents-unsigned:
	mkdir -p $(DIST)/agent
	for t in $(AGENT_TARGETS); do \
		CGO_ENABLED=0 GOOS=$${t%-*} GOARCH=$${t#*-} $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
			-o $(DIST)/agent/whombat-agent-$$t$$(case $$t in windows-*) echo .exe;; esac) ./cmd/whombat-agent || exit 1; \
	done

## headless: the hub binary without the web UI (serve --headless, docs/WHOMBAT.md)
headless:
	mkdir -p $(DIST)
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/whombat-hosts ./cmd/whombat-hosts

## hub: hub binary with the SPA embedded
hub: web agents
	CGO_ENABLED=0 $(GO) build -trimpath -tags embedweb -ldflags '$(LDFLAGS)' -o $(DIST)/whombat-hosts ./cmd/whombat-hosts
	../scripts/scan-artifacts.sh $(DIST)

test: test-go test-web

## test-go: vet and the Go tests with the race detector (needs cgo: gcc)
test-go: agent-windows-check
	$(GO) vet ./...
	CGO_ENABLED=1 $(GO) test -race ./...

## agent-windows-check: the agent's Windows build vets and builds (its Windows-only files build nowhere else)
agent-windows-check:
	for a in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=windows GOARCH=$$a $(GO) vet ./cmd/whombat-agent ./internal/agent/winpc || exit 1; \
		CGO_ENABLED=0 GOOS=windows GOARCH=$$a $(GO) build -o /dev/null ./cmd/whombat-agent || exit 1; \
	done

test-web:
	cd web && $(PNPM) test

## lint: formatting, the TypeScript type check and no forbidden text (the repository's scripts/check-forbidden.sh)
lint: lint-go
	cd web && $(PNPM) typecheck
	../scripts/check-forbidden.sh

## lint-go: gofmt only (no web toolchain needed). Modules are fetched first: on a machine without them
## `go fmt` reports each download, which isn't a file it changed.
lint-go:
	@$(GO) list ./... > /dev/null
	@test -z "$$($(GO) fmt ./... 2>&1 | tee /dev/stderr)" || (echo "gofmt changed files" >&2; exit 1)

## visual: compare key pages with the screenshot baselines (fixture mode, in the Playwright image)
PLAYWRIGHT_IMAGE := mcr.microsoft.com/playwright:v1.64.0-noble
visual:
	docker run --rm --network host -v "$(CURDIR)":/work -w /work/web $(PLAYWRIGHT_IMAGE) npx playwright test -c scripts/playwright.config.ts visual

## visual-update: re-render the baselines after an intended UI change (review the diff)
visual-update:
	docker run --rm --network host -v "$(CURDIR)":/work -w /work/web $(PLAYWRIGHT_IMAGE) npx playwright test -c scripts/playwright.config.ts visual --update-snapshots

## ci: everything a change must pass (lint, tests, a full build)
ci: lint test hub

## dev-hub: run the hub locally (UI from web/dist, agents from dist/agent)
dev-hub:
	$(GO) run ./cmd/whombat-hosts serve --data ./tmp/hub-data --listen :8080 --agent-listen :8443 \
		--public-url http://localhost:8080 --web-dir web/dist --agent-dist $(DIST)/agent

## dev-web: Vite dev server proxying /api to the local hub
dev-web:
	cd web && $(PNPM) dev

## dev-fixtures: UI against the hand-off fixtures, no hub needed
dev-fixtures:
	cd web && $(PNPM) dev:fixtures

## deb: Debian packages of the agent, amd64 and arm64 (needs nfpm)
# dpkg versions must start with a digit: "v1.2.3" -> "1.2.3", "b31a458" -> "0.0.0~b31a458".
DEB_VERSION := $(shell echo '$(VERSION)' | sed -E 's/^v([0-9])/\1/; s/^([^0-9])/0.0.0~\1/')
deb: agents
	cd packaging/agent && for a in amd64 arm64; do VERSION=$(DEB_VERSION) ARCH=$$a nfpm package -p deb -t ../../$(DIST)/ || exit 1; done
	../scripts/scan-artifacts.sh $(DIST)

## deploy-dev: retired: the Rackoon dev hub stays on Rackoon builds (AGENTS.md)
deploy-dev:
	scripts/deploy-dev.sh

clean:
	rm -rf $(DIST) web/dist
