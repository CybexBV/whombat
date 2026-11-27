// Keep the Android resources for the two languages Whombat supports.
const { withAppBuildGradle } = require('expo/config-plugins');

const LINE = 'resourceConfigurations += ["en", "nl"]';

/** @param {import('expo/config').ExpoConfig} config */
module.exports = function withEnglishResources(config) {
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = c.modResults.contents.replace('resourceConfigurations += ["en"]', LINE);
    if (!c.modResults.contents.includes(LINE))
      c.modResults.contents = c.modResults.contents.replace(
        /defaultConfig\s*\{/,
        (open) => `${open}\n        ${LINE}`,
      );
    return c;
  });
};
