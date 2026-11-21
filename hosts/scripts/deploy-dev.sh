#!/usr/bin/env bash
# Retired (2026-10-17, One Whombat). This repository now builds Whombat's
# hosts service (whombat-hosts, whombat-agent), which runs headless inside
# the Whombat appliance (the appliance: nix/modules/hosts.nix) and in
# the appliance's dev stack. The old Rackoon development hub and its agents
# stay on the last Rackoon build: deploying this tree there would rename
# the agent and its paths under running hosts.
echo "deploy-dev: retired. The Rackoon dev hub stays on Rackoon builds; whombat-hosts ships with the Whombat appliance (AGENTS.md)." >&2
exit 1
