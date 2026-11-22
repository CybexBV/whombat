import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildNumberOfVersion } from '@whombat/client/managed';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../app.config.cjs') as {
  version: string;
  android: {
    package: string;
    versionCode: number;
    intentFilters: { data: { path?: string; pathPrefix?: string; pathPattern?: string }[] }[];
  };
  ios: { buildNumber: string; bundleIdentifier: string; associatedDomains: string[] };
};
const app = require('../../../web/package.json') as { version: string };
const assetLinks = require('../../../web/public/.well-known/assetlinks.json') as {
  relation: string[];
  target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
}[];
/** React Native's debug keystore: public, in every checkout, so the hosted UI must never vouch for it. */
const RN_DEBUG_KEY =
  'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C';

describe('the Android version (AP-259)', () => {
  it('is the release version, and versionCode is its build number (the web’s too)', () => {
    expect(config.version).toBe(app.version);
    expect(config.android.versionCode).toBe(buildNumberOfVersion(app.version));
    expect(config.android.versionCode).toBeGreaterThan(1);
    expect(config.ios.buildNumber).toBe(String(config.android.versionCode));
  });
});

describe('the hosted UI’s assetlinks.json (AP-291, AP-798)', () => {
  it('lets this app handle the UI’s links and use its passkeys, signed with the release key only', () => {
    expect(assetLinks).toHaveLength(1);
    const [link] = assetLinks;
    expect(link?.relation).toEqual([
      'delegate_permission/common.handle_all_urls',
      'delegate_permission/common.get_login_creds',
    ]);
    expect(link?.target.namespace).toBe('android_app');
    expect(link?.target.package_name).toBe(config.android.package);
    expect(link?.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
    for (const fp of link?.target.sha256_cert_fingerprints ?? []) {
      expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect(fp).not.toBe(RN_DEBUG_KEY);
    }
  });
});

describe('the hosted UI’s apple-app-site-association (ios-parity.md AP-6320, AP-6321)', () => {
  it('opens on iPhone exactly the links Android opens, and lets the app use the UI’s passkeys', () => {
    const aasa = JSON.parse(
      readFileSync(require.resolve('../../../web/public/.well-known/apple-app-site-association'), 'utf8'),
    ) as {
      applinks: { details: { appIDs: string[]; components: { '/': string }[] }[] };
      webcredentials: { apps: string[] };
    };
    const appId = `4R8P9MTF9T.${config.ios.bundleIdentifier}`;
    expect(aasa.webcredentials.apps).toEqual([appId]);
    expect(aasa.applinks.details).toHaveLength(1);
    expect(aasa.applinks.details[0]?.appIDs).toEqual([appId]);
    // Android's path, prefix and pattern in Apple's glob: `*` for a prefix's rest and for `.*`.
    const android = config.android.intentFilters
      .flatMap((f) => f.data)
      .map(
        (d) => d.path ?? (d.pathPrefix ? `${d.pathPrefix}*` : (d.pathPattern ?? '').replaceAll('.*', '*')),
      );
    expect(aasa.applinks.details[0]?.components.map((c) => c['/'])).toEqual([...new Set(android)]);
  });

  it('is what the iPhone app claims for each https UI', () => {
    try {
      delete require.cache[require.resolve('../../app.config.cjs')];
      process.env.EXPO_PUBLIC_WHOMBAT_UI_URL = 'https://dev.whombat.com,http://localhost:5180';
      const dev = require('../../app.config.cjs') as typeof config;
      expect(dev.ios.associatedDomains).toEqual([
        'applinks:dev.whombat.com',
        'webcredentials:dev.whombat.com',
      ]);
    } finally {
      delete process.env.EXPO_PUBLIC_WHOMBAT_UI_URL;
      delete require.cache[require.resolve('../../app.config.cjs')];
    }
  });
});

describe('the Android passkey origin (PK-02)', () => {
  it('is the release key the UI vouches for: what the Whombat and control accept', async () => {
    const { PASSKEY_ANDROID_ORIGINS } = await import('@whombat/protocol/session');
    const fp = assetLinks[0]?.target.sha256_cert_fingerprints[0] ?? '';
    const bytes = Buffer.from(fp.replaceAll(':', ''), 'hex');
    expect(PASSKEY_ANDROID_ORIGINS).toEqual([`android:apk-key-hash:${bytes.toString('base64url')}`]);
  });
});

describe('Android app links of burrow pages (AP-367, AP-709)', () => {
  it('open the pages the phone has a screen for, in both forms, and nothing outside the burrow app', async () => {
    const { isBurrowRoutePath } = await import('@whombat/client');
    const { appScreenUrlForPath } = await import('../navigation/routes');
    try {
      delete require.cache[require.resolve('../../app.config.cjs')];
      const managed = require('../../app.config.cjs') as {
        android: {
          intentFilters: { data: { path?: string; pathPrefix?: string; pathPattern?: string }[] }[];
        };
      };
      const data = managed.android.intentFilters.flatMap((f) => f.data);
      // The hosted UI's own pages, and a provider's answer to a sign-in the phone started (`/connect/`, AP-2905).
      const own = [
        '/auth/verify',
        '/auth/phone',
        '/appliances/',
        '/invitations/accept',
        '/claim',
        '/connect/',
      ];
      expect(data.some((d) => d.pathPrefix === '/connect/')).toBe(true);
      const pages = data
        .map((d) => d.path ?? d.pathPrefix)
        .filter((p): p is string => !!p && !own.includes(p));
      // The person's rooms with the agent, no channels, DMs or agents' pages (one-agent.md AP-4962).
      expect([...new Set(pages)]).toEqual([
        '/pr/',
        '/runs/',
        '/automations/',
        '/automation-runs/',
        '/chat',
        '/feedback',
        '/work',
        '/automations',
        '/vault',
        '/log',
      ]);
      const sample = (p: string) => (p.endsWith('/') ? `${p}12` : p);
      for (const p of pages) {
        expect(isBurrowRoutePath(sample(p))).toBe(true);
        expect(appScreenUrlForPath(sample(p))).not.toBeNull();
      }
      // The old form (`/<burrow>/chat`): Android's simple glob, `.*` standing for the burrow's slug.
      const patterns = [...new Set(data.flatMap((d) => (d.pathPattern ? [d.pathPattern] : [])))];
      expect(patterns).toHaveLength(10);
      for (const pattern of patterns) {
        const path = sample(pattern.replace('/.*/', '/burrow-hq/').replace(/\.\*$/, ''));
        expect(appScreenUrlForPath(path)).not.toBeNull();
      }
    } finally {
      delete require.cache[require.resolve('../../app.config.cjs')];
    }
  });
});

describe('plain sockets to the box itself (AP-5377)', () => {
  it('allows cleartext with the system trust anchors only, names ts.net, and is wired into the app', async () => {
    const plugin = require('../../plugins/with-direct-cleartext.cjs') as {
      NETWORK_SECURITY_CONFIG: string;
      setNetworkSecurityConfig: (m: unknown) => {
        manifest: { application: { $: Record<string, string> }[] };
      };
    };
    const xml = plugin.NETWORK_SECURITY_CONFIG;
    expect(xml).toMatch(/<base-config cleartextTrafficPermitted="true">/);
    expect(xml).toMatch(/<certificates src="system" \/>/);
    expect(xml).not.toMatch(/src="user"/);
    expect(xml).toMatch(/<domain includeSubdomains="true">ts\.net<\/domain>/);
    const manifest = plugin.setNetworkSecurityConfig({
      manifest: { $: {}, application: [{ $: { 'android:name': '.MainApplication' } }] },
    });
    expect(manifest.manifest.application[0]?.$['android:networkSecurityConfig']).toBe(
      '@xml/network_security_config',
    );
    delete require.cache[require.resolve('../../app.config.cjs')];
    const config = require('../../app.config.cjs') as { plugins: unknown[] };
    expect(config.plugins).toContain('./plugins/with-direct-cleartext.cjs');
  });
});

describe('the iPhone app’s associated domains (own-address.md)', () => {
  it('never carries a wildcard: a file at a parent host Cybex runs would let any app it names use box passkeys', () => {
    expect(config.ios.associatedDomains.length).toBeGreaterThan(0);
    for (const entry of config.ios.associatedDomains) {
      expect(entry).not.toContain('*');
      expect(entry).not.toMatch(/(box|dev)\.whombat\.app$/);
    }
  });
});

describe('the iPhone App Group flag for the Share Extension and home-screen widget', () => {
  it('keeps both gated off together until Apple has group.com.whombat.mobile registered', () => {
    const plugins = (config as unknown as { plugins: unknown[] }).plugins;
    const share = plugins.find((p) => Array.isArray(p) && p[0] === 'expo-share-intent') as
      | [string, { disableIOS?: boolean }]
      | undefined;
    const live = plugins.find((p) => Array.isArray(p) && p[0] === './modules/whombat-live/app.plugin.cjs') as
      | [string, { iosStatusWidget?: boolean; iosAppGroup?: string }]
      | undefined;
    expect(share?.[1]?.disableIOS).toBe(true);
    expect(live?.[1]?.iosStatusWidget).toBe(false);
    expect(live?.[1]?.iosAppGroup).toBe('group.com.whombat.mobile');
    // whombat-live runs after expo-share-intent so the App Group entitlement deduplicates when both turn on.
    expect(plugins.indexOf(live)).toBeGreaterThan(plugins.indexOf(share));
    // Privacy manifest entry for App Group UserDefaults (`1C8F.1`) stays gated on the same flag.
    expect((config.ios as { privacyManifests?: unknown }).privacyManifests).toBeUndefined();
    const rawConfig = readFileSync(require.resolve('../../app.config.cjs'), 'utf8');
    expect(rawConfig).toContain("'1C8F.1'");
  });
});
