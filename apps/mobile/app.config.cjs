// Expo app config. Android first (DECISIONS D-08); the iPhone gets the same links, passkeys and share sheet
// (docs/app/decisions/ios-parity.md).
// Android allows plain sockets for the Whombat's direct routes (plugins/with-direct-cleartext.cjs, AP-5377); on iOS,
// release builds allow plain HTTP only when built with EXPO_PUBLIC_ALLOW_INSECURE_HTTP=1.
// Icons and splash: the Whombat logo, written by `pnpm --filter @whombat/brand export-icons` (docs/decisions/brand.md).
// Push and live activities: expo-notifications (permission, device token) and modules/whombat-live (the
// Android Live Update notifications and FCM service, the iOS ActivityKit widget); see README.md.
const allowCleartext = process.env.EXPO_PUBLIC_ALLOW_INSECURE_HTTP === '1';
// Magic links of the hosted UI open the app (AP-27)
// (`<ui>/auth/verify#token=…`, Android App Links verified by the UI's assetlinks.json; plain http only for a local
// UI), and so does the computer's sign-in QR code (`<ui>/auth/phone#…`, AP-531) when the phone's camera app reads it.
// The app's own camera scans that code, the QR code on the Whombat's page and the claim card's — asked for only when someone taps “Scan the QR code” — and
// takes a photo for a message (“Take photo” under the paperclip, AP-714), asked for on first use.
const uiOrigins = (process.env.EXPO_PUBLIC_WHOMBAT_UI_URL || 'https://app.whombat.com')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .map((o) => new URL(o));
const CAMERA_TEXT =
  'Whombat uses the camera to take a photo you attach to a message, and to scan QR codes: the one on your Whombat’s page, the sign-in code on your computer and your Whombat’s claim card.';
// Voice typing (docs/decisions/dictation.md): the microphone records only from a composer's mic to Done or Cancel, and
// is asked for the first time the mic is pressed. modules/whombat-voice declares RECORD_AUDIO on Android.
const MICROPHONE_TEXT =
  'Whombat uses the microphone for voice typing: what you say goes to your Whombat, which turns it into text.';
// iOS asks before the app reaches anything on the local network, and the app goes straight to the Whombat at home there
// (its plain `ws://` address; everything inside is the end-to-end encrypted session).
const LOCAL_NETWORK_TEXT =
  'Whombat connects straight to your Whombat when you’re on the same network, which is quicker than going over the internet.';
// A picture's Download opens the share sheet, whose Save Image puts it in the person's photos.
const PHOTO_SAVE_TEXT = 'Whombat saves a picture to your photos only when you choose Save Image.';
// Burrow pages of the hosted UI without a burrow in the path (AP-360, AP-367) that the phone has a screen for: they open
// in the Whombat last used (`?burrow=` picks the burrow). Settings and canvases stay in the browser.
// The person's Chat and Feedback room (and the threads, plans and approvals in them, `?thread=` …), branch rooms, runs,
// automations and the Vault, the audit log, and Work's old address, which opens the Inbox. Search stays in the browser.
const BURROW_SECTIONS = ['pr', 'runs', 'automations', 'automation-runs'];
const BURROW_ROOT_PAGES = ['chat', 'feedback', 'work', 'automations', 'vault', 'log'];
/** The iPhone's ties to the hosted UI (AP-6321): Universal Links and passkeys for each `https` origin without a port. */
const APPLE_DOMAINS = uiOrigins
  .filter((u) => u.protocol === 'https:' && !u.port)
  .flatMap((u) => [`applinks:${u.hostname}`, `webcredentials:${u.hostname}`]);
const BURROW_PAGES = [
  ...BURROW_SECTIONS.map((s) => ({ pathPrefix: `/${s}/` })),
  ...BURROW_ROOT_PAGES.map((s) => ({ path: `/${s}` })),
  // The old form every server writes (emails, pushes, `linkPath()`): `/<burrow>/chat`, `/<burrow>/runs/12` (AP-709).
  ...BURROW_SECTIONS.map((s) => ({ pathPattern: `/.*/${s}/.*` })),
  ...BURROW_ROOT_PAGES.map((s) => ({ pathPattern: `/.*/${s}` })),
];

/**
 * The release version (`apps/web/package.json`, the app's one version, what `app-vX.Y.Z` tags) and its build number, AP-259: `versionCode` is
 * `major × 1 000 000 + minor × 1 000 + patch` (0.12.0 → 12000), the same number the hosted web carries
 * (`buildNumberOfVersion` in `@whombat/client/managed`; src/data/app-config.test.ts checks they agree). It was a fixed 1
 * before 0.12.0, so any Android client floor above 1 would have locked every build out.
 */
const VERSION = require('../web/package.json').version;
function versionCodeOf(version) {
  const m = /^(\d{1,4})\.(\d{1,3})\.(\d{1,3})(?:[-+].*)?$/.exec(version);
  if (!m) throw new Error(`app.config: the app version ${version} (apps/web/package.json) isn't X.Y.Z`);
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

/** tokens `themeColors.light.bg` / `themeColors.dark.bg` (checked by src/data/app-config.test.ts). */
const BG = { light: '#fbf9f5', dark: '#1c1815' };
/** tokens `brandColors`: the Ink icon tile, and cocoa for the notification accent. */
const BRAND = { ink: '#2b221d', cocoa: '#7d6353' };

module.exports = {
  name: 'Whombat',
  slug: 'whombat',
  version: VERSION,
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  scheme: 'whombat',
  icon: './assets/icon.png',
  backgroundColor: BG.light,
  android: {
    package: 'com.whombat.mobile',
    versionCode: versionCodeOf(VERSION),
    // The Ink tile: the paper face on burrow ink; Android 13 themed icons use the face's alpha.
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/adaptive-icon.png',
      backgroundColor: BRAND.ink,
    },
    softwareKeyboardLayoutMode: 'resize',
    // Android 13+'s predictive back: the system's back gesture previews where it goes (the screen under this one, or
    // home from a tab's root); in-app back (stacks, sheets, BackHandler) runs through the same dispatcher.
    predictiveBackGestureEnabled: true,
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: uiOrigins.every((u) => u.protocol === 'https:'),
        // Magic links, owners' links and appliance links (the secrets are in the fragment).
        data: uiOrigins.flatMap((u) => [
          {
            scheme: u.protocol.replace(':', ''),
            host: u.hostname,
            ...(u.port ? { port: u.port } : {}),
            path: '/auth/verify',
          },
          // The computer's sign-in QR code (CT-190, AP-531), read by the phone's camera app.
          {
            scheme: u.protocol.replace(':', ''),
            host: u.hostname,
            ...(u.port ? { port: u.port } : {}),
            path: '/auth/phone',
          },
          // An owner's links (get back in, join) and links that name an appliance (MR-45).
          {
            scheme: u.protocol.replace(':', ''),
            host: u.hostname,
            ...(u.port ? { port: u.port } : {}),
            pathPrefix: '/appliances/',
          },
          // A provider's answer to a sign-in the phone started (phone-connect.md PC-05, AP-2905): Google's,
          // Microsoft's and a catalog entry's `/connect/<id>?code=…&state=…`, finished over the app's session. The
          // hosted UI serves nothing else under `/connect/`.
          {
            scheme: u.protocol.replace(':', ''),
            host: u.hostname,
            ...(u.port ? { port: u.port } : {}),
            pathPrefix: '/connect/',
          },
          // Control's invitation to an organization (G-01).
          {
            scheme: u.protocol.replace(':', ''),
            host: u.hostname,
            ...(u.port ? { port: u.port } : {}),
            path: '/invitations/accept',
          },
          // Claiming (AP-48): what the Whombat's screen names, and the card's QR code (card in the fragment).
          {
            scheme: u.protocol.replace(':', ''),
            host: u.hostname,
            ...(u.port ? { port: u.port } : {}),
            path: '/claim',
          },
          ...BURROW_PAGES.map((page) => ({
            scheme: u.protocol.replace(':', ''),
            host: u.hostname,
            ...(u.port ? { port: u.port } : {}),
            ...page,
          })),
        ]),
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
    ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}),
  },
  ios: {
    bundleIdentifier: 'com.whombat.mobile',
    buildNumber: String(versionCodeOf(VERSION)),
    supportsTablet: false,
    // The hosted UI's links open the app as Android's App Links do, and its passkeys work here (AP-6320, AP-6321); the
    // UI's /.well-known/apple-app-site-association says which paths and grants the passkeys.
    associatedDomains: APPLE_DOMAINS,
    infoPlist: {
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: allowCleartext, NSAllowsLocalNetworking: true },
      NSLocalNetworkUsageDescription: LOCAL_NETWORK_TEXT,
      ITSAppUsesNonExemptEncryption: false,
      NSMicrophoneUsageDescription: MICROPHONE_TEXT,
      // The share sheet's Save Image, on a picture's Download: iOS ends an app that saves to Photos without it.
      NSPhotoLibraryAddUsageDescription: PHOTO_SAVE_TEXT,
    },
  },
  plugins: [
    ['expo-secure-store', { faceIDPermission: false }],
    'expo-font',
    // Release builds shrink (android-slim.md): R8 drops unused code and resources (AP-892), and native libraries are
    // compressed in the APK (AP-893) — people download it from control and the app downloads every update itself.
    // iOS adopts the UIKit scene lifecycle (ios-build.md AP-5772): built with the iOS 27 SDK, an app without it stops at
    // launch. SDK 58's template has it, so the option goes then.
    [
      'expo-build-properties',
      {
        android: {
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          useLegacyPackaging: true,
        },
        ios: { enableSceneSupport: true },
      },
    ],
    // The logo on the theme's `bg`: ink on light, paper on dark (no light flash on a dark launch).
    [
      'expo-splash-screen',
      {
        backgroundColor: BG.light,
        image: './assets/splash-icon.png',
        imageWidth: 180,
        dark: { backgroundColor: BG.dark, image: './assets/splash-icon-dark.png' },
      },
    ],
    ['./plugins/with-dark-window-background.cjs', { backgroundColor: BG.dark }],
    // No white film over the area under the tab bar on the unfolded screen (AP-2751).
    './plugins/with-navigation-bar.cjs',
    './plugins/with-english-resources.cjs',
    // Plain WebSockets to the box's direct routes on its local network and Tailscale name (AP-5377).
    './plugins/with-direct-cleartext.cjs',
    // Push notifications' status-bar icon: the small symbol, white on transparent.
    [
      'expo-notifications',
      {
        enableBackgroundRemoteNotifications: false,
        icon: './assets/notification-icon.png',
        color: BRAND.cocoa,
      },
    ],
    './modules/whombat-live/app.plugin.cjs',
    // Attachments (docs/decisions/bp-attachments.md): photos from the system picker (no library permission), the camera
    // for “Take photo” (AP-714); iOS asks with these texts. Documents through the system file picker. The microphone is
    // voice typing's: `false` here would remove its text on iOS and block RECORD_AUDIO on Android.
    [
      'expo-image-picker',
      {
        photosPermission: 'Whombat opens your photos only when you attach one to a message.',
        // Photos for messages (AP-714); the QR scanner uses the same permission.
        cameraPermission: CAMERA_TEXT,
        microphonePermission: MICROPHONE_TEXT,
      },
    ],
    'expo-document-picker',
    // Share to Whombat (AP-715, AP-6322): the share sheet offers the app for text, links, photos and any file, one or
    // several. On Android the activity stays singleTask, so a share while the app runs reaches it as a new intent; on
    // iPhone a share extension keeps the share in the app group (`group.com.whombat.mobile`) and opens the app. Apple
    // signs the extension only once that group is registered on its developer site (no API registers one): until then
    // the iPhone build leaves it out.
    [
      'expo-share-intent',
      {
        disableIOS: true,
        iosShareExtensionDisplayName: 'Whombat',
        iosActivationRules: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsWebPageWithMaxCount: 1,
          NSExtensionActivationSupportsImageWithMaxCount: 10,
          NSExtensionActivationSupportsMovieWithMaxCount: 10,
          NSExtensionActivationSupportsFileWithMaxCount: 10,
        },
        androidIntentFilters: ['text/*', 'image/*', '*/*'],
        androidMultiIntentFilters: ['image/*', '*/*'],
        androidMainActivityAttributes: { 'android:launchMode': 'singleTask' },
      },
    ],
    [
      'expo-camera',
      { cameraPermission: CAMERA_TEXT, microphonePermission: MICROPHONE_TEXT, recordAudioAndroid: false },
    ],
  ],
  extra: {
    allowCleartext,
  },
};
