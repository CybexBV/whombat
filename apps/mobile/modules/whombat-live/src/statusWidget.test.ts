import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WIDGET_EMPTY_COPY } from '@whombat/client';
import { fixedColors, themeColors } from '@whombat/tokens';
import { describe, expect, it } from 'vitest';
import { createStatusWidgetQueue, type StatusWidgetPayload, shouldClearStatusWidget } from './statusWidget';

const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '..');

function parseAndroidColors(filePath: string): Record<string, string> {
  const xml = readFileSync(filePath, 'utf8');
  return Object.fromEntries(
    [...xml.matchAll(/<color name="([^"]+)">([^<]+)<\/color>/g)].map((m) => [
      m[1] as string,
      (m[2] as string).toLowerCase(),
    ]),
  );
}

function rgbaToAndroidHex(rgba: string): string {
  const m = /^rgba\((\d+),(\d+),(\d+),([.\d]+)\)$/.exec(rgba.replace(/\s+/g, ''));
  if (!m) throw new Error(`Expected rgba(...): ${rgba}`);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const alpha = Math.round(Number(m[4]) * 255);
  return `#${hex(alpha)}${hex(Number(m[1]))}${hex(Number(m[2]))}${hex(Number(m[3]))}`;
}

function parseSwiftPalette(filePath: string): Record<string, { light: string; dark: string }> {
  const swift = readFileSync(filePath, 'utf8');
  return Object.fromEntries(
    [
      ...swift.matchAll(/static let (\w+) = Color\(light: 0x([0-9A-Fa-f]{6}), dark: 0x([0-9A-Fa-f]{6})\)/g),
    ].map((m) => [
      m[1] as string,
      { light: `#${(m[2] as string).toLowerCase()}`, dark: `#${(m[3] as string).toLowerCase()}` },
    ]),
  );
}

describe('home-screen status widget tokens and copy', () => {
  it('mirrors @whombat/tokens in Android light and dark colors.xml', () => {
    const light = parseAndroidColors(join(ROOT, 'android/src/main/res/values/colors.xml'));
    const dark = parseAndroidColors(join(ROOT, 'android/src/main/res/values-night/colors.xml'));
    for (const [themeName, actual] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const tokens = themeColors[themeName];
      expect(actual).toEqual({
        whombat_widget_bg: tokens.bg,
        whombat_widget_border: rgbaToAndroidHex(tokens.line),
        whombat_widget_ink: tokens.ink,
        whombat_widget_mut: tokens.mut,
        whombat_widget_logo: tokens.logo,
        whombat_widget_ok: tokens.ok,
        whombat_widget_warn: tokens.warn,
        whombat_widget_bad: tokens.bad,
      });
    }
  });

  it('mirrors @whombat/tokens in the iOS widget Palette', () => {
    const palette = parseSwiftPalette(join(ROOT, 'ios/widget/WhombatLiveWidget.swift'));
    for (const key of [
      'bg',
      'sf',
      'sf2',
      'ink',
      'ink2',
      'mut',
      'logo',
      'btn',
      'btnfg',
      'ok',
      'warn',
      'bad',
    ] as const) {
      expect(palette[key]).toEqual({ light: themeColors.light[key], dark: themeColors.dark[key] });
    }
    expect(palette.progress).toEqual({ light: fixedColors.progress, dark: fixedColors.progress });
  });

  it('uses the shared empty-state copy on Android and iOS', () => {
    const stringsXml = readFileSync(join(ROOT, 'android/src/main/res/values/strings.xml'), 'utf8');
    const strings = Object.fromEntries(
      [...stringsXml.matchAll(/<string name="([^"]+)">([^<]+)<\/string>/g)].map((m) => [
        m[1] as string,
        m[2] as string,
      ]),
    );
    expect(strings.whombat_widget_empty_box).toBe(WIDGET_EMPTY_COPY.boxName);
    expect(strings.whombat_widget_empty_status).toBe(WIDGET_EMPTY_COPY.status);
    expect(strings.whombat_widget_empty_as_of).toBe(WIDGET_EMPTY_COPY.asOf);

    const swift = readFileSync(join(ROOT, 'ios/widget/WhombatStatusWidget.swift'), 'utf8');
    expect(swift).toContain(`static let boxName = "${WIDGET_EMPTY_COPY.boxName}"`);
    expect(swift).toContain(`static let status = "${WIDGET_EMPTY_COPY.status}"`);
    expect(swift).toContain(`static let asOf = "${WIDGET_EMPTY_COPY.asOf}"`);
  });

  it('uses only Android @RemoteView tags in widget layouts', () => {
    const allowed = new Set(['FrameLayout', 'LinearLayout', 'RelativeLayout', 'ImageView', 'TextView']);
    for (const name of ['whombat_status_widget.xml', 'whombat_status_widget_preview.xml']) {
      const xml = readFileSync(join(ROOT, 'android/src/main/res/layout', name), 'utf8');
      const tags = [...xml.matchAll(/<([A-Za-z][A-Za-z0-9_.]*)\b/g)].map((m) => m[1] as string);
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(allowed.has(tag)).toBe(true);
    }
  });

  it('keeps the iOS module and widget extension storage keys and widget kind aligned', () => {
    const moduleSwift = readFileSync(join(ROOT, 'ios/WhombatLiveModule.swift'), 'utf8');
    const widgetSwift = readFileSync(join(ROOT, 'ios/widget/WhombatStatusWidget.swift'), 'utf8');
    for (const shared of [
      '"WhombatStatusWidgetAppGroup"',
      '"com.whombat.live.widget.status"',
      '"WhombatStatusWidget"',
    ]) {
      expect(moduleSwift).toContain(shared);
      expect(widgetSwift).toContain(shared);
    }
  });

  it('filters conditional widget clears by applianceId and source on both Android and iOS', () => {
    const storeKt = readFileSync(
      join(ROOT, 'android/src/main/java/com/whombat/live/StatusWidgetStore.kt'),
      'utf8',
    );
    const moduleKt = readFileSync(
      join(ROOT, 'android/src/main/java/com/whombat/live/WhombatLiveModule.kt'),
      'utf8',
    );
    const moduleSwift = readFileSync(join(ROOT, 'ios/WhombatLiveModule.swift'), 'utf8');

    expect(storeKt).toContain('val source: String');
    expect(storeKt).toContain('source: String? = null');
    expect(storeKt).toContain('requestedSource == "cloud"');
    expect(moduleKt).toContain('applianceId: String?, source: String?');
    expect(moduleSwift).toContain('(applianceId: String?, source: String?)');
    expect(moduleSwift).toContain('obj["source"]');
    expect(moduleSwift).toContain('filterSource == "cloud"');
  });

  it('stores updatedAt (not pre-formatted labels) and formats at draw time with midnight rollover on Android and iOS', () => {
    const storeKt = readFileSync(
      join(ROOT, 'android/src/main/java/com/whombat/live/StatusWidgetStore.kt'),
      'utf8',
    );
    const providerKt = readFileSync(
      join(ROOT, 'android/src/main/java/com/whombat/live/WhombatStatusWidgetProvider.kt'),
      'utf8',
    );
    const manifestXml = readFileSync(join(ROOT, 'android/src/main/AndroidManifest.xml'), 'utf8');
    const infoXml = readFileSync(
      join(ROOT, 'android/src/main/res/xml/whombat_status_widget_info.xml'),
      'utf8',
    );
    const widgetSwift = readFileSync(join(ROOT, 'ios/widget/WhombatStatusWidget.swift'), 'utf8');

    // Neither Android nor iOS stores pre-formatted “as of” labels in the snapshot.
    for (const src of [storeKt, widgetSwift]) {
      expect(src).not.toContain('asOfEarlier');
      expect(src).not.toContain('asOfDay');
      expect(src).toContain('as of yesterday ');
    }
    expect(storeKt).not.toContain('val asOf:');
    expect(storeKt).toContain('updatedAt <= 0L');
    expect(storeKt).toContain('fun nextRolloverAtMs');

    // Android redraws at midnight via non-waking AlarmManager.RTC, on clock/date/zone changes, and cleans up on disable.
    expect(providerKt).toContain('AlarmManager.RTC');
    expect(providerKt).not.toContain('RTC_WAKEUP');
    expect(providerKt).not.toContain('setAndAllowWhileIdle');
    expect(providerKt).toContain('scheduleNextRollover');
    expect(providerKt).toContain('onDisabled');
    expect(providerKt).toContain('Intent.ACTION_TIME_CHANGED');
    expect(providerKt).toContain('Intent.ACTION_TIMEZONE_CHANGED');
    expect(providerKt).toContain('Intent.ACTION_DATE_CHANGED');
    expect(manifestXml).toContain('android.intent.action.DATE_CHANGED');
    expect(manifestXml).toContain('android.intent.action.TIME_SET');
    expect(manifestXml).toContain('android.intent.action.TIMEZONE_CHANGED');
    const periodMatch = /android:updatePeriodMillis="(\d+)"/.exec(infoXml);
    expect(Number(periodMatch?.[1])).toBeLessThanOrEqual(1_800_000);

    // iOS formats from updatedAt and schedules multi-step midnight timeline entries (today → yesterday → date).
    const swiftSnapshotMatch = /private struct StatusWidgetSnapshot: Decodable \{[\s\S]*?\n\}/.exec(
      widgetSwift,
    );
    expect(swiftSnapshotMatch?.[0]).toBeTruthy();
    expect(swiftSnapshotMatch?.[0]).not.toContain('let asOf:');
    expect(widgetSwift).toContain('snapshot.updatedAt > 0');
    expect(widgetSwift).toContain('rolloverDates(after: now)');
  });
});

interface MockXcodeProject {
  hash: { project: { objects: Record<string, Record<string, unknown>> } };
  phases: { files: string[]; type: string; name: string }[];
  groups: { files: string[]; name: string }[];
  buildSettings: Record<string, unknown>;
  pbxTargetByName(name: string): unknown;
  addTarget(
    name: string,
    type: string,
    subfolder: string,
    bundleId: string,
  ): {
    uuid: string;
    pbxNativeTarget: { buildConfigurationList: string };
  };
  addPbxGroup(files: string[], name: string, path: string): { uuid: string };
  getFirstProject(): { firstProject: { mainGroup: string } };
  addToPbxGroup(uuid: string, parent: string): void;
  addBuildPhase(files: string[], type: string, name: string, targetUuid: string): void;
  pbxXCConfigurationList(): Record<string, { buildConfigurations: { value: string }[] }>;
  pbxXCBuildConfigurationSection(): Record<string, { buildSettings: Record<string, unknown> }>;
}

function createMockXcodeProject(): MockXcodeProject {
  const buildSettings: Record<string, unknown> = {};
  const phases: MockXcodeProject['phases'] = [];
  const groups: MockXcodeProject['groups'] = [];
  let addedTarget: { uuid: string; pbxNativeTarget: { buildConfigurationList: string } } | null = null;
  return {
    hash: { project: { objects: {} } },
    phases,
    groups,
    buildSettings,
    pbxTargetByName: (name) =>
      name === 'WhombatLiveWidget' && addedTarget ? addedTarget.pbxNativeTarget : null,
    addTarget: () => {
      addedTarget = { uuid: 'target-uuid', pbxNativeTarget: { buildConfigurationList: 'cfg-list' } };
      return addedTarget;
    },
    addPbxGroup(files, name) {
      groups.push({ files, name });
      return { uuid: 'group-uuid' };
    },
    getFirstProject: () => ({ firstProject: { mainGroup: 'main-group' } }),
    addToPbxGroup() {},
    addBuildPhase(files, type, name) {
      phases.push({ files, type, name });
    },
    pbxXCConfigurationList: () => ({ 'cfg-list': { buildConfigurations: [{ value: 'cfg-release' }] } }),
    pbxXCBuildConfigurationSection: () => ({ 'cfg-release': { buildSettings } }),
  };
}

describe('whombat-live iOS config plugin', () => {
  const withWhombatLive = require('../app.plugin.cjs') as (
    config: Record<string, unknown>,
    props?: { iosStatusWidget?: boolean; iosAppGroup?: string },
  ) => {
    mods?: {
      ios?: {
        infoPlist?: (c: Record<string, unknown>) => Promise<Record<string, unknown>>;
        entitlements?: (c: Record<string, unknown>) => Promise<Record<string, unknown>>;
        dangerous?: (c: Record<string, unknown>) => Promise<Record<string, unknown>>;
        xcodeproj?: (c: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
    };
  };

  async function runPlugin(
    props?: { iosStatusWidget?: boolean; iosAppGroup?: string },
    existingXcode?: MockXcodeProject,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'whombat-live-plugin-'));
    try {
      const configured = withWhombatLive(
        {
          name: 'Whombat',
          slug: 'whombat',
          version: '3.0.0',
          ios: { bundleIdentifier: 'com.whombat.mobile', buildNumber: '3000000' },
        },
        props,
      );
      const mods = configured.mods?.ios ?? {};
      const infoPlist: Record<string, unknown> = {};
      if (mods.infoPlist) await mods.infoPlist({ modResults: infoPlist, modRequest: {} });

      const entitlements: Record<string, unknown> = {
        'com.apple.security.application-groups': ['group.com.whombat.mobile'],
      };
      const hadEntitlementsMod = typeof mods.entitlements === 'function';
      if (mods.entitlements) await mods.entitlements({ modResults: entitlements, modRequest: {} });

      if (mods.dangerous) await mods.dangerous({ modResults: {}, modRequest: { platformProjectRoot: dir } });

      const xcode = existingXcode ?? createMockXcodeProject();
      if (mods.xcodeproj) {
        await mods.xcodeproj({
          ios: { bundleIdentifier: 'com.whombat.mobile', buildNumber: '3000000' },
          version: '3.0.0',
          modResults: xcode,
          modRequest: {},
        });
      }

      const targetDir = join(dir, 'WhombatLiveWidget');
      const files = {
        liveWidget: existsSync(join(targetDir, 'WhombatLiveWidget.swift')),
        attributes: existsSync(join(targetDir, 'WhombatLiveAttributes.swift')),
        statusWidget: existsSync(join(targetDir, 'WhombatStatusWidget.swift')),
        privacy: existsSync(join(targetDir, 'PrivacyInfo.xcprivacy')),
        entitlements: existsSync(join(targetDir, 'WhombatLiveWidget.entitlements')),
        entitlementsContent: existsSync(join(targetDir, 'WhombatLiveWidget.entitlements'))
          ? readFileSync(join(targetDir, 'WhombatLiveWidget.entitlements'), 'utf8')
          : null,
        infoPlistContent: readFileSync(join(targetDir, 'Info.plist'), 'utf8'),
      };
      return { infoPlist, hadEntitlementsMod, entitlements, xcode, files };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps the iOS build unchanged with iosStatusWidget off (no App Group or status widget)', async () => {
    const out = await runPlugin({ iosStatusWidget: false, iosAppGroup: 'group.com.whombat.mobile' });
    expect(out.infoPlist.NSSupportsLiveActivities).toBe(true);
    expect(out.infoPlist.WhombatStatusWidgetAppGroup).toBeUndefined();
    expect(out.hadEntitlementsMod).toBe(false);
    expect(out.files.liveWidget).toBe(true);
    expect(out.files.attributes).toBe(true);
    expect(out.files.statusWidget).toBe(false);
    expect(out.files.privacy).toBe(false);
    expect(out.files.entitlements).toBe(false);
    expect(out.files.infoPlistContent).not.toContain('WhombatStatusWidgetAppGroup');
    const sourcesPhase = out.xcode.phases.find((p) => p.type === 'PBXSourcesBuildPhase');
    expect(sourcesPhase?.files).toEqual([
      'WhombatLiveWidget/WhombatLiveWidget.swift',
      'WhombatLiveWidget/WhombatLiveAttributes.swift',
    ]);
    expect(out.xcode.buildSettings.CODE_SIGN_ENTITLEMENTS).toBeUndefined();
    expect(out.xcode.buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toBeUndefined();
  });

  it('adds the App Group, widget source, privacy manifest and build flag when iosStatusWidget is on', async () => {
    const out = await runPlugin({ iosStatusWidget: true, iosAppGroup: 'group.com.whombat.mobile' });
    expect(out.infoPlist.WhombatStatusWidgetAppGroup).toBe('group.com.whombat.mobile');
    expect(out.hadEntitlementsMod).toBe(true);
    // Deduplicated even when the share extension already added the same group.
    expect(out.entitlements['com.apple.security.application-groups']).toEqual(['group.com.whombat.mobile']);
    expect(out.files.statusWidget).toBe(true);
    expect(out.files.privacy).toBe(true);
    expect(readFileSync(join(ROOT, 'ios/widget/PrivacyInfo.xcprivacy'), 'utf8')).toContain('1C8F.1');
    expect(out.files.entitlements).toBe(true);
    expect(out.files.entitlementsContent).toContain('group.com.whombat.mobile');
    expect(out.files.infoPlistContent).toContain('WhombatStatusWidgetAppGroup');
    expect(out.files.infoPlistContent).toContain('group.com.whombat.mobile');
    const sourcesPhase = out.xcode.phases.find((p) => p.type === 'PBXSourcesBuildPhase');
    const resourcesPhase = out.xcode.phases.find((p) => p.type === 'PBXResourcesBuildPhase');
    expect(sourcesPhase?.files).toContain('WhombatLiveWidget/WhombatStatusWidget.swift');
    expect(resourcesPhase?.files).toContain('WhombatLiveWidget/PrivacyInfo.xcprivacy');
    // Target-prefixed paths keep PrivacyInfo.xcprivacy distinct from ShareExtension's own manifest.
    expect(out.xcode.groups[0]?.files).toContain('WhombatLiveWidget/PrivacyInfo.xcprivacy');
    expect(out.xcode.groups[0]?.files).not.toContain('PrivacyInfo.xcprivacy');
    expect(out.xcode.buildSettings.CODE_SIGN_ENTITLEMENTS).toBe(
      'WhombatLiveWidget/WhombatLiveWidget.entitlements',
    );
    expect(String(out.xcode.buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS)).toContain(
      'WHOMBAT_STATUS_WIDGET',
    );
  });

  it('stays idempotent when iosStatusWidget matches the existing target and refuses incremental flips', async () => {
    // Generated with iosStatusWidget off: re-running off succeeds, flipping on refuses with clean-prebuild guidance.
    const off = await runPlugin({ iosStatusWidget: false, iosAppGroup: 'group.com.whombat.mobile' });
    await expect(
      runPlugin({ iosStatusWidget: false, iosAppGroup: 'group.com.whombat.mobile' }, off.xcode),
    ).resolves.toBeDefined();
    await expect(
      runPlugin({ iosStatusWidget: true, iosAppGroup: 'group.com.whombat.mobile' }, off.xcode),
    ).rejects.toThrow(/expo prebuild --clean/);

    // Generated with iosStatusWidget on: re-running on succeeds, flipping off refuses with clean-prebuild guidance.
    const on = await runPlugin({ iosStatusWidget: true, iosAppGroup: 'group.com.whombat.mobile' });
    await expect(
      runPlugin({ iosStatusWidget: true, iosAppGroup: 'group.com.whombat.mobile' }, on.xcode),
    ).resolves.toBeDefined();
    await expect(
      runPlugin({ iosStatusWidget: false, iosAppGroup: 'group.com.whombat.mobile' }, on.xcode),
    ).rejects.toThrow(/expo prebuild --clean/);
  });
});

describe('createStatusWidgetQueue invalidation', () => {
  const makePayload = (
    applianceId: string,
    status: string,
    source: 'cloud' | 'community' = 'cloud',
  ): StatusWidgetPayload => ({
    applianceId,
    source,
    boxName: applianceId,
    status,
    tone: 'ok',
    timeZone: 'Europe/Amsterdam',
    updatedAt: 1_763_730_300_000,
  });

  it('drops matching writes still waiting in the native queue when a clear arrives while keeping non-matching writes', async () => {
    let stored: StatusWidgetPayload | null = null;
    const calls: string[] = [];
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let holdFirst = true;

    const queue = createStatusWidgetQueue(() => ({
      async setStatusWidget(json) {
        const parsed = JSON.parse(json) as StatusWidgetPayload;
        if (holdFirst) {
          holdFirst = false;
          enteredFirst();
          await firstGate;
        }
        calls.push(`set:${parsed.applianceId}:${parsed.status}`);
        stored = parsed;
      },
      async clearStatusWidget(applianceId, source) {
        calls.push(`clear:${applianceId ?? '*'}:${source ?? '*'}`);
        const filter =
          applianceId || source
            ? { ...(applianceId ? { applianceId } : {}), ...(source ? { source } : {}) }
            : undefined;
        if (shouldClearStatusWidget(stored, filter)) stored = null;
      },
    }));

    const notified: unknown[] = [];
    const unsubscribe = queue.onClearStatusWidget((filter) => notified.push(filter));

    const w1 = queue.setStatusWidget(makePayload('wb-a', 'first'));
    await firstEntered;
    const w2 = queue.setStatusWidget(makePayload('wb-a', 'stale-queued'));
    const w3 = queue.setStatusWidget(makePayload('wb-b', 'other-box', 'community'));
    const c1 = queue.clearStatusWidget('wb-a');
    releaseFirst();

    await Promise.all([w1, w2, w3, c1]);
    expect(notified).toEqual(['wb-a']);
    // w2 was cancelled before touching native storage; w3 (for wb-b) survived and wasn't wiped by wb-a's clear.
    expect(calls).toEqual(['set:wb-a:first', 'set:wb-b:other-box', 'clear:wb-a:*']);
    expect(stored).toMatchObject({ applianceId: 'wb-b', status: 'other-box' });

    unsubscribe();
  });
});
