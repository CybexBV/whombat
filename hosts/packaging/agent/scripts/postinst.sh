#!/bin/sh
# whombat-agent postinst: (re)start the agent when it is enrolled.
set -e
if [ "$1" = "configure" ] || [ "$1" = "abort-upgrade" ]; then
	if [ -d /run/systemd/system ]; then
		systemctl daemon-reload >/dev/null 2>&1 || true
		systemctl enable whombat-agent.service >/dev/null 2>&1 || true
		if [ -f /etc/whombat-agent/agent.toml ]; then
			systemctl restart whombat-agent.service || true
		else
			echo "whombat-agent: not enrolled yet. Run:"
			echo "  whombat-agent enroll --hub wss://HUB:8443 --ca-sha256 PIN --token TOKEN"
			echo "  systemctl start whombat-agent"
		fi
	fi
fi
exit 0
