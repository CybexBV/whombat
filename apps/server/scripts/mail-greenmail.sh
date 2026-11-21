#!/usr/bin/env bash
# Email (IMAP) against a real mail server, GreenMail, once by hand (docs/decisions/connections-more-mail.md CM-M10).
# The container only through agent-resource, which removes it and the workspace afterwards:
#
#   agent-resource run --task "imap test" --ttl 2h --disposable-data -- apps/server/scripts/mail-greenmail.sh "$PWD/apps/server"
#
# GreenMail serves the tests' mail.home.test certificate (made into its keystore here) with the user jo@home.test /
# secret on IMAPS and SMTPS; src/connectors/imap/greenmail.test.ts runs against it.
set -euo pipefail
server="$1"
ws="${AGENT_RESOURCE_WORKSPACE:?}"
# GreenMail's keystore from the tests' mail.home.test certificate.
node -e '
  const s = require("fs").readFileSync(process.argv[1], "utf8");
  const pem = (n) => s.match(new RegExp("export const " + n + " = `([^`]+)`"))[1];
  require("fs").writeFileSync(process.argv[2] + "/cert.pem", pem("MAIL_CERT"));
  require("fs").writeFileSync(process.argv[2] + "/key.pem", pem("MAIL_KEY"));
' "$server/src/test/self-signed.ts" "$ws"
openssl pkcs12 -export -in "$ws/cert.pem" -inkey "$ws/key.pem" -name greenmail -out "$ws/greenmail.p12" -passout pass:changeit
chmod 644 "$ws/greenmail.p12"
c=$(agent-resource docker-run --memory 512m \
  --publish 127.0.0.1::3993 --publish 127.0.0.1::3465 \
  --volume "$ws/greenmail.p12:/tmp/whombat.p12:ro" \
  --env 'GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=jo:secret@home.test -Dgreenmail.users.login=email -Dgreenmail.tls.keystore.file=/tmp/whombat.p12 -Dgreenmail.tls.keystore.password=changeit' \
  greenmail/standalone:2.1.14)
imaps=$(docker port "$c" 3993/tcp | head -1 | sed 's/.*://')
smtps=$(docker port "$c" 3465/tcp | head -1 | sed 's/.*://')
for i in $(seq 1 60); do
  if docker logs "$c" 2>&1 | grep -q 'Started GreenMail'; then break; fi
  sleep 0.5
done
echo "greenmail imaps=$imaps smtps=$smtps"
cd "$server"
WHOMBAT_GREENMAIL="$imaps:$smtps" TMPDIR="${TMPDIR:-/tmp}" npx vitest run src/connectors/imap/greenmail.test.ts
