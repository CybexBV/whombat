// Android: no contrast film over the system's area under the tab bar (fold-bar.md AP-2751). React Native asks Android to
// keep that area readable (`enforceNavigationBarContrast`), and where Android draws a film for it (the unfolded screen's
// stashed taskbar, the three buttons) it was white over the dark bar: React Native picks light or dark once, at start.
// The tab bar has its own solid colour there, so the film isn't needed; `modules/whombat-system-bars` tells Android
// the theme instead, so the handle and buttons stay readable. React Native reads this attribute from the theme.
const { AndroidConfig, withAndroidStyles } = require('expo/config-plugins');

/** @param {import('expo/config').ExpoConfig} config */
module.exports = function withNavigationBar(config) {
  return withAndroidStyles(config, (c) => {
    c.modResults = AndroidConfig.Styles.assignStylesValue(c.modResults, {
      add: true,
      parent: AndroidConfig.Styles.getAppThemeGroup(),
      name: 'android:enforceNavigationBarContrast',
      value: 'false',
      targetApi: '29',
    });
    return c;
  });
};
