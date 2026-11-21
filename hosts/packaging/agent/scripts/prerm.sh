#!/bin/sh
# whombat-agent prerm: stop the agent before removal.
set -e
if [ "$1" = "remove" ] && [ -d /run/systemd/system ]; then
	systemctl stop whombat-agent.service >/dev/null 2>&1 || true
	systemctl disable whombat-agent.service >/dev/null 2>&1 || true
fi
exit 0
