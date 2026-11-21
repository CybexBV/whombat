// Android: only English resources go into the APK (android-slim.md AP-896). The app's own copy is English; the
// libraries brought translations of their few strings for ~100 locales, which made `resources.arsc` (stored
// uncompressed) the largest file after the code — and showed some of those strings in the phone's language
// next to English copy.
const { withAppBuildGradle } = require('expo/config-plugins');

const LINE = 'resourceConfigurations += ["en"]';

/** @param {import('expo/config').ExpoConfig} config */
module.exports = function withEnglishResources(config) {
  return withAppBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes(LINE))
      c.modResults.contents = c.modResults.contents.replace(
        /defaultConfig\s*\{/,
        (open) => `${open}\n        ${LINE}`,
      );
    return c;
  });
};
