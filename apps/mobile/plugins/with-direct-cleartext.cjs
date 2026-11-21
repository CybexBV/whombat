// Android: plain WebSockets to the Whombat itself (HE-50; hermes-engine-app.md AP-5377). The app reaches the box first on
// the ways its last welcome named: `ws://` on the local network and `wss://` (or `ws://`) on its Tailscale name. Android
// refuses cleartext by default, and a local-network address is any private IP, which a network security config's
// domain list can't name — so cleartext is allowed in the base config, and for `*.ts.net` by name. Nothing is in the
// clear inside: every byte on such a socket is the Noise session, pinned to the box's identity, and the app opens plain
// sockets only to the box's direct routes (control and the relay are https/wss). Only the system's trust anchors are
// used for TLS. This config replaces `android:usesCleartextTraffic`, which Android ignores once it is set.
const fs = require('node:fs');
const path = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const NAME = 'network_security_config';

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<!-- Plain sockets only to the Whombat's own direct routes; every byte inside them is its Noise session (AP-5377). -->
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">ts.net</domain>
  </domain-config>
</network-security-config>
`;

/** The `<application>` names the config (`@xml/network_security_config`). */
function setNetworkSecurityConfig(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  app.$['android:networkSecurityConfig'] = `@xml/${NAME}`;
  return manifest;
}

/** @param {import('expo/config').ExpoConfig} config */
function withDirectCleartext(config) {
  const named = withAndroidManifest(config, (c) => {
    setNetworkSecurityConfig(c.modResults);
    return c;
  });
  return withDangerousMod(named, [
    'android',
    async (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${NAME}.xml`), NETWORK_SECURITY_CONFIG);
      return c;
    },
  ]);
}

module.exports = withDirectCleartext;
module.exports.NETWORK_SECURITY_CONFIG = NETWORK_SECURITY_CONFIG;
module.exports.setNetworkSecurityConfig = setNetworkSecurityConfig;
