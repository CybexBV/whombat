// Android: the launcher icon is an adaptive icon of vectors under a name of its own, `@mipmap/whombat_launcher`
// (docs/decisions/brand.md), sharp at every size where Expo's `adaptiveIcon` writes bitmaps. A phone still showing
// an earlier icon after an update keeps a copy of its own (Samsung's Theme Park bakes every app's icon when a style is
// applied; applying it again picks up the new one): nothing in the app changes that. The layers are generated from the logo
// (`assets/android/whombat_launcher_*.xml`, `pnpm --filter @whombat/brand export-icons`); the background is the Ink
// tile's colour. Below Android 8 (no adaptive icons) the name points at Expo's `ic_launcher` bitmap.
const fs = require('node:fs');
const path = require('node:path');
const {
  AndroidConfig,
  withAndroidColors,
  withAndroidManifest,
  withDangerousMod,
} = require('expo/config-plugins');

const NAME = 'whombat_launcher';
const LAYERS = ['foreground', 'monochrome'];

const ADAPTIVE = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/${NAME}_background" />
  <foreground android:drawable="@drawable/${NAME}_foreground" />
  <monochrome android:drawable="@drawable/${NAME}_monochrome" />
</adaptive-icon>
`;

const LEGACY = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:drawable="@mipmap/ic_launcher" />
</layer-list>
`;

/** @param {import('expo/config').ExpoConfig} config @param {{ background: string }} props */
module.exports = function withLauncherIcon(config, props) {
  config = withDangerousMod(config, [
    'android',
    (c) => {
      const res = path.join(c.modRequest.platformProjectRoot, 'app/src/main/res');
      const write = (dir, file, text) => {
        fs.mkdirSync(path.join(res, dir), { recursive: true });
        fs.writeFileSync(path.join(res, dir, file), text);
      };
      for (const layer of LAYERS) {
        const file = `${NAME}_${layer}.xml`;
        write(
          'drawable',
          file,
          fs.readFileSync(path.join(c.modRequest.projectRoot, 'assets/android', file), 'utf8'),
        );
      }
      write('mipmap-anydpi-v26', `${NAME}.xml`, ADAPTIVE);
      write('mipmap', `${NAME}.xml`, LEGACY);
      return c;
    },
  ]);
  config = withAndroidColors(config, (c) => {
    c.modResults = AndroidConfig.Colors.assignColorValue(c.modResults, {
      name: `${NAME}_background`,
      value: props.background,
    });
    return c;
  });
  return withAndroidManifest(config, (c) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    app.$['android:icon'] = `@mipmap/${NAME}`;
    app.$['android:roundIcon'] = `@mipmap/${NAME}`;
    return c;
  });
};
