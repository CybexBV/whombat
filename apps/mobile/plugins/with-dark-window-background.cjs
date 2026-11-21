// Android: the window behind the React Native root (`activityBackground`, from `backgroundColor`) follows
// the system theme, so a dark-mode launch never flashes the light background between the splash screen and
// the first frame. Values are the tokens' `bg` (light / dark); `src/data/app-config.test.ts` checks them.
const { AndroidConfig, withAndroidColorsNight } = require('expo/config-plugins');

/** @param {import('expo/config').ExpoConfig} config @param {{ backgroundColor: string }} props */
module.exports = function withDarkWindowBackground(config, props) {
  return withAndroidColorsNight(config, (c) => {
    c.modResults = AndroidConfig.Colors.assignColorValue(c.modResults, {
      name: 'activityBackground',
      value: props.backgroundColor,
    });
    return c;
  });
};
