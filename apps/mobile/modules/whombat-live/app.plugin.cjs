// Config plugin for whombat-live's iOS side (Android needs nothing: the module's manifest brings the FCM
// service, home-screen widget provider and permissions). On `expo prebuild --platform ios` it
//   1. turns Live Activities on in the app's Info.plist (NSSupportsLiveActivities, frequent updates);
//   2. copies the widget extension's sources (ios/widget/*, ios/WhombatLiveAttributes.swift) to
//      ios/WhombatLiveWidget/;
//   3. adds the "WhombatLiveWidget" app-extension target to the Xcode project, embedded in the app.
//
// When `iosStatusWidget: true` (switched on once Apple has registered the App Group `group.com.whombat.mobile`),
// it also adds the App Group entitlement to both the app and the widget extension, copies the home-screen status
// widget (`WhombatStatusWidget.swift`) and its privacy manifest, writes `WhombatStatusWidgetAppGroup` to both
// Info.plists and defines `WHOMBAT_STATUS_WIDGET` on the widget target. With `iosStatusWidget: false` (default),
// the generated iOS project is unchanged so signing and builds need no App Group.
// Idempotent. Build and sign on macOS: apps/mobile/README.md "iOS".
const fs = require('node:fs');
const path = require('node:path');
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const TARGET = 'WhombatLiveWidget';
const BASE_SOURCES = ['WhombatLiveWidget.swift', 'WhombatLiveAttributes.swift'];
const STATUS_WIDGET_SOURCE = 'WhombatStatusWidget.swift';
const PRIVACY_MANIFEST = 'PrivacyInfo.xcprivacy';
const ENTITLEMENTS_FILE = `${TARGET}.entitlements`;
const DEFAULT_APP_GROUP = 'group.com.whombat.mobile';
const APP_GROUP_INFO_KEY = 'WhombatStatusWidgetAppGroup';
const DEPLOYMENT_TARGET = '16.4';

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function widgetEntitlementsXml(appGroup) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${escapeXml(appGroup)}</string>
  </array>
</dict>
</plist>
`;
}

function widgetInfoPlistWithGroup(plistXml, appGroup) {
  const entry = `  <key>${APP_GROUP_INFO_KEY}</key>\n  <string>${escapeXml(appGroup)}</string>\n</dict>`;
  return plistXml.replace(/<\/dict>\s*<\/plist>/, `${entry}\n</plist>`);
}

function withLiveActivitiesPlist(config, opts) {
  return withInfoPlist(config, (c) => {
    c.modResults.NSSupportsLiveActivities = true;
    c.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    if (opts.iosStatusWidget) {
      c.modResults[APP_GROUP_INFO_KEY] = opts.iosAppGroup;
    } else {
      delete c.modResults[APP_GROUP_INFO_KEY];
    }
    return c;
  });
}

function withAppGroupEntitlement(config, opts) {
  if (!opts.iosStatusWidget) return config;
  return withEntitlementsPlist(config, (c) => {
    const existing = Array.isArray(c.modResults['com.apple.security.application-groups'])
      ? c.modResults['com.apple.security.application-groups']
      : [];
    // Deduplicate in case the share extension plugin also added the same group.
    c.modResults['com.apple.security.application-groups'] = [...new Set([...existing, opts.iosAppGroup])];
    return c;
  });
}

function withWidgetSources(config, opts) {
  return withDangerousMod(config, [
    'ios',
    async (c) => {
      const from = path.join(__dirname, 'ios');
      const to = path.join(c.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(path.join(from, 'widget', 'WhombatLiveWidget.swift'), path.join(to, BASE_SOURCES[0]));
      fs.copyFileSync(path.join(from, 'WhombatLiveAttributes.swift'), path.join(to, BASE_SOURCES[1]));
      const rawPlist = fs.readFileSync(path.join(from, 'widget', 'Info.plist'), 'utf8');
      fs.writeFileSync(
        path.join(to, 'Info.plist'),
        opts.iosStatusWidget ? widgetInfoPlistWithGroup(rawPlist, opts.iosAppGroup) : rawPlist,
      );
      if (opts.iosStatusWidget) {
        fs.copyFileSync(path.join(from, 'widget', STATUS_WIDGET_SOURCE), path.join(to, STATUS_WIDGET_SOURCE));
        fs.copyFileSync(path.join(from, 'widget', PRIVACY_MANIFEST), path.join(to, PRIVACY_MANIFEST));
        fs.writeFileSync(path.join(to, ENTITLEMENTS_FILE), widgetEntitlementsXml(opts.iosAppGroup));
      }
      return c;
    },
  ]);
}

function withWidgetTarget(config, opts) {
  return withXcodeProject(config, (c) => {
    const project = c.modResults;
    if (project.pbxTargetByName(TARGET)) return c;
    const bundleId = `${c.ios?.bundleIdentifier ?? 'com.whombat.mobile'}.${TARGET}`;
    const pref = (file) => `${TARGET}/${file}`;
    const sources = (opts.iosStatusWidget ? [...BASE_SOURCES, STATUS_WIDGET_SOURCE] : BASE_SOURCES).map(pref);
    const resources = (opts.iosStatusWidget ? [PRIVACY_MANIFEST] : []).map(pref);
    const groupFiles = (
      opts.iosStatusWidget
        ? [...BASE_SOURCES, STATUS_WIDGET_SOURCE, 'Info.plist', PRIVACY_MANIFEST, ENTITLEMENTS_FILE]
        : [...BASE_SOURCES, 'Info.plist']
    ).map(pref);

    // `addTarget` makes the app depend on the extension only when these sections exist.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    const target = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);

    // Use target-prefixed file paths on a pathless group so shared filenames (`PrivacyInfo.xcprivacy`,
    // `Info.plist`) never collide with another extension target (e.g. ShareExtension) in `xcode`'s path lookup.
    const group = project.addPbxGroup(groupFiles, TARGET, '""');
    if (group.pbxGroup) delete group.pbxGroup.path;
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);

    project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase(resources, 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    // SwiftUI, WidgetKit and ActivityKit are linked by Swift's auto-linking of the imports.
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

    const lists = project.pbxXCConfigurationList();
    const list = lists[target.pbxNativeTarget.buildConfigurationList];
    const configurations = project.pbxXCBuildConfigurationSection();
    const appTeam = Object.values(configurations).find(
      (cfg) => cfg && typeof cfg === 'object' && cfg.buildSettings?.DEVELOPMENT_TEAM,
    )?.buildSettings.DEVELOPMENT_TEAM;
    for (const { value } of list.buildConfigurations) {
      Object.assign(configurations[value].buildSettings, {
        INFOPLIST_FILE: `${TARGET}/Info.plist`,
        PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}"`,
        PRODUCT_NAME: '"$(TARGET_NAME)"',
        IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: c.ios?.supportsTablet ? '"1,2"' : '1',
        MARKETING_VERSION: c.version ?? '1.0.0',
        CURRENT_PROJECT_VERSION: c.ios?.buildNumber ?? '1',
        CODE_SIGN_STYLE: 'Automatic',
        GENERATE_INFOPLIST_FILE: 'NO',
        CLANG_ENABLE_MODULES: 'YES',
        SKIP_INSTALL: 'YES',
        ...(appTeam ? { DEVELOPMENT_TEAM: appTeam } : {}),
        ...(opts.iosStatusWidget
          ? {
              CODE_SIGN_ENTITLEMENTS: `${TARGET}/${ENTITLEMENTS_FILE}`,
              SWIFT_ACTIVE_COMPILATION_CONDITIONS: '"$(inherited) WHOMBAT_STATUS_WIDGET"',
            }
          : {}),
      });
    }
    return c;
  });
}

function normalizeOptions(props = {}) {
  return {
    iosStatusWidget: props.iosStatusWidget === true,
    iosAppGroup:
      typeof props.iosAppGroup === 'string' && props.iosAppGroup.trim()
        ? props.iosAppGroup.trim()
        : DEFAULT_APP_GROUP,
  };
}

function withWhombatLive(config, props) {
  const opts = normalizeOptions(props);
  return withWidgetTarget(
    withWidgetSources(withAppGroupEntitlement(withLiveActivitiesPlist(config, opts), opts), opts),
    opts,
  );
}

module.exports = withWhombatLive;
module.exports.widgetEntitlementsXml = widgetEntitlementsXml;
module.exports.widgetInfoPlistWithGroup = widgetInfoPlistWithGroup;
module.exports.APP_GROUP_INFO_KEY = APP_GROUP_INFO_KEY;
module.exports.DEFAULT_APP_GROUP = DEFAULT_APP_GROUP;
