# The deploy check's web server (the maintainers' dev-instance runbook “The deploy check”; Whombat goal-first.md GF-07): a small
# customer server an agent on the DEV box deploys a site to. SSH on 22 for the user `deploy` (its key from the Vault,
# mounted under /etc/ssh/authorized_keys), nginx on 80 serving /var/www/site/current, a symlink to a release folder —
# the layout the agent has to find out for itself.
FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server nginx rsync ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash deploy \
 && mkdir -p /run/sshd /var/www/site/releases/20261001-initial \
 && printf '<!doctype html><title>Example site</title><h1>Example site</h1><p>The first release.</p>\n' \
      > /var/www/site/releases/20261001-initial/index.html \
 && ln -s /var/www/site/releases/20261001-initial /var/www/site/current \
 && chown -R deploy:deploy /var/www/site \
 && rm -f /etc/nginx/sites-enabled/default \
 && printf 'server {\n  listen 80;\n  root /var/www/site/current;\n  index index.html;\n}\n' > /etc/nginx/sites-enabled/site \
 && printf 'PasswordAuthentication no\nAuthorizedKeysFile /etc/ssh/authorized_keys/%%u\n' >> /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
EXPOSE 22 80
CMD ["/bin/sh", "/entrypoint.sh"]
