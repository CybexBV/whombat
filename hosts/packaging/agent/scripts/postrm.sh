#!/bin/sh
# whombat-agent postrm: purge removes the agent identity and its buffer.
set -e
if [ "$1" = "purge" ]; then
	rm -rf /etc/whombat-agent /var/lib/whombat-agent
fi
if [ -d /run/systemd/system ]; then
	systemctl daemon-reload >/dev/null 2>&1 || true
fi
exit 0
