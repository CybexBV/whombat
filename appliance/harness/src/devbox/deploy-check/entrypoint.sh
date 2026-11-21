#!/bin/sh
# Host keys once per container, nginx in the background, sshd in the foreground.
set -e
ssh-keygen -A >/dev/null
chmod 755 /etc/ssh/authorized_keys 2>/dev/null || true
nginx
exec /usr/sbin/sshd -D -e
