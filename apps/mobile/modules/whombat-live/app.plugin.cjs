// Config plugin for whombat-live's iOS side (Android needs nothing: the module's manifest brings the FCM
// service and permissions). On `expo prebuild --platform ios` it
//   1. turns Live Activities on in the app's Info.plist (NSSupportsLiveActivities, frequent updates);
//   2. copies the widget extension's sources (ios/widget/*, ios/WhombatLiveAttributes.swift) to
//      ios/WhombatLiveWidget/;
//   3. adds the "WhombatLiveWidget" app-extension target to the Xcode project, embedded in the app.
// Idempotent. Build and sign on macOS: apps/mobile/README.md "iOS".
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withInfoPlist, withXcodeProject } = require('expo/config-plugins');

const TARGET = 'WhombatLiveWidget';
const SOURCES = ['WhombatLiveWidget.swift', 'WhombatLiveAttributes.swift'];
const DEPLOYMENT_TARGET = '16.4';

function withLiveActivitiesPlist(config) {
  return withInfoPlist(config, (c) => {
    c.modResults.NSSupportsLiveActivities = true;
    c.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    return c;
  });
}

function withWidgetSources(config) {
  return withDangerousMod(config, [
    'ios',
    async (c) => {
      const from = path.join(__dirname, 'ios');
      const to = path.join(c.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(path.join(from, 'widget', 'WhombatLiveWidget.swift'), path.join(to, SOURCES[0]));
      fs.copyFileSync(path.join(from, 'WhombatLiveAttributes.swift'), path.join(to, SOURCES[1]));
      fs.copyFileSync(path.join(from, 'widget', 'Info.plist'), path.join(to, 'Info.plist'));
      return c;
    },
  ]);
}

function withWidgetTarget(config) {
  return withXcodeProject(config, (c) => {
    const project = c.modResults;
    if (project.pbxTargetByName(TARGET)) return c;
    const bundleId = `${c.ios?.bundleIdentifier ?? 'com.whombat.mobile'}.${TARGET}`;
    // `addTarget` makes the app depend on the extension only when these sections exist.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    const target = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);

    const group = project.addPbxGroup([...SOURCES, 'Info.plist'], TARGET, TARGET);
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);

    project.addBuildPhase(SOURCES, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
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
      });
    }
    return c;
  });
}

module.exports = function withWhombatLive(config) {
  return withWidgetTarget(withWidgetSources(withLiveActivitiesPlist(config)));
};
