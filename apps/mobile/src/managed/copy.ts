/**
 * Words of the phone's managed journeys (AP-22, AP-27): the shared `COPY` of the web, with the few lines that name
 * a browser said for a phone, and what only the phone does (scanning the claim card, saving the kit through the share
 * sheet, notifications). Curly quotes and the middle dot as in the mocks.
 */
import { COPY as SHARED, MANAGED_TEXT as SHARED_STATUS } from '@whombat/client/managed';
import { VERSION_REFUSAL_COPY } from '@whombat/protocol/session';

export const COPY = {
  ...SHARED,
  signIn: {
    ...SHARED.signIn,
    sent: (email: string) => `We sent a sign-in link to ${email}. Open it on this phone.`,
    openHint: 'The link opens this app. If it opens a browser instead, sign in there or open it here again.',
    /** QR first (AP-530): the computer shows the code, the phone scans it. */
    scanTitle: 'Sign in with your computer',
    scanSub:
      'On your computer, open Whombat and choose Mobile app in the sidebar. Then scan the code it shows.',
    scan: 'Scan the QR code',
    scanTip:
      'One scan signs you in and asks your Whombat to let this phone in. You confirm it on your computer.',
    withEmail: 'Sign in with email instead',
    withScan: 'Scan the QR code instead',
    emailTitle: 'Sign in with email',
  },
  /** Signing in by the computer's QR code (CT-190, AP-530…AP-539). */
  phone: {
    kicker: 'SIGN IN',
    scanTitle: 'Point the camera at the code on your computer',
    scanWrong: 'That isn’t a Whombat sign-in code. On your computer, open Whombat and choose Mobile app.',
    scanDenied: 'Whombat can’t use the camera. Allow it in Settings, or sign in with email instead.',
    scanDeniedSignedIn: 'Whombat can’t use the camera. Allow it in Settings, or pair with a code instead.',
    scanClose: 'Close the camera',
    workingTitle: 'Signing you in…',
    askingTitle: 'Letting this phone in…',
    workingSub: 'This takes a few seconds. Keep Whombat open on your computer.',
    confirmTitle: 'Confirm on your computer',
    confirmSub:
      'Your computer asks whether to let this phone in. Check that it shows the same fingerprint, then confirm.',
    stages: {
      signingIn: 'Signing you in',
      asking: 'Asking your Whombat to let this phone in',
      confirm: 'Confirm on your computer',
    },
    stageState: { done: 'done', active: 'in progress', todo: 'to do', failed: 'didn’t work' },
    thisPhone: 'THIS PHONE',
    fingerprint: 'FINGERPRINT',
    same: 'Check that your computer shows the same.',
    waiting: 'Waiting for your computer…',
    cancel: 'Cancel',
    scanAgain: 'Scan again',
    tryAgain: 'Try again',
    backToSignIn: 'Back to sign in',
    backToList: 'Back to your Whombats',
    withEmail: 'Sign in with email instead',
    pairScan: 'Scan the QR code from your computer',
    pairScanHint:
      'On your computer, open Whombat and choose Mobile app. Scanning its code lets this phone in.',
    pairOr: 'OR SHOW A CODE',
    codeMismatchTitle: 'This code doesn’t match your Whombat',
    codeMismatch:
      'The code names a different identity for this Whombat than the one Whombat’s servers gave, so nothing was sent to it. Someone could be trying to intercept your connection. Show a new code on a computer that’s already set up.',
    errors: {
      expired: {
        title: 'This code has expired',
        text: 'Show a new one on your computer and scan again.',
      },
      over: {
        title: 'This code has expired',
        text: 'That took too long. Show a new code on your computer and scan again.',
      },
      tooMany: {
        title: 'Too many tries',
        text: 'Too many sign-in attempts for now. Wait a few minutes, then scan a new code.',
      },
      unreachable: {
        title: 'Couldn’t reach Whombat',
        text: 'Check your connection and try again.',
      },
      notInOrg: {
        title: 'This Whombat isn’t in your organization',
        text: 'You’re signed in, but the Whombat your computer has open isn’t in your organization, so this phone can’t join it.',
      },
      retired: {
        title: 'This Whombat was retired',
        text: 'You’re signed in, but the Whombat your computer has open was retired, so this phone can’t join it.',
      },
      whombatUnreachable: {
        title: 'Couldn’t reach your Whombat',
        text: 'You’re signed in, but your Whombat didn’t answer. Check that it’s on and connected, then try again.',
      },
      denied: {
        title: 'This phone wasn’t let in',
        text: 'Your computer declined this phone. If that was a mistake, show a new code there and scan again.',
      },
      pairExpired: {
        title: 'Nobody confirmed in time',
        text: 'Your computer didn’t confirm this phone in time. Show a new code there and scan again.',
      },
      failed: { title: 'That didn’t work', text: 'Something went wrong while signing in. Try again.' },
    },
  },
  claim: {
    ...SHARED.claim,
    cardSub: 'Scan the QR code on the claim card from the box, or type what’s on it.',
    scan: 'Scan the QR code',
    scanTitle: 'Point the camera at the card’s QR code',
    scanClose: 'Close the camera',
    scanDenied: 'Whombat can’t use the camera. Allow it in Settings, or type the card instead.',
    scanWrong: 'That QR code isn’t a Whombat claim card.',
    typeIt: 'Type the card instead',
    scanned: 'Card scanned. Check the fields, then claim it.',
  },
  kit: {
    ...SHARED.kit,
    download: 'Save the kit',
    saveHint: 'Save it to Files or a drive, or print it. Then come back here.',
  },
  pair: {
    ...SHARED.pair,
    sub: 'This phone isn’t trusted by this Whombat yet. Approve it from a device that already is.',
  },
  connection: {
    ...SHARED.connection,
    clientTooOldTitle: 'This app needs an update',
    /** A box of another protocol major (HE-52): the contracts' words. */
    clientTooOld: VERSION_REFUSAL_COPY.client,
    applianceTooOld: VERSION_REFUSAL_COPY.appliance,
    unsupported: 'This phone can’t keep a device key safely.',
    belowFloor:
      'For your security, your Whombat no longer lets this version of the app in. Update the app, then open it again.',
  },
  /**
   * Until the app is in the Play Store, Android downloads and installs the published APK itself (AP-813); the iPhone
   * and a phone without one published get the hosted UI's Mobile app page (AP-537).
   */
  update: {
    label: 'Update the app',
    phoneTooOld: 'Update the app to the newest version.',
    /** After “1 item needs a newer version of the app.” while no newer app is out (AP-701). */
    soon: 'The update will be here soon.',
    /** A newer build is out though nothing needs it (SS-71): a calm row, not a warning. */
    available: 'Update available',
    /** “0.37.0 · 58 MB · Download and install it over this app.” */
    availableMeta: (version: string, size: number) =>
      `${version} · ${Math.max(1, Math.round(size / 1_000_000))} MB · Download and install it over this app.`,
    /** The row's button: downloads the APK. */
    install: 'Update',
    /** The pop-up when a newer build is out, once per version (update-check.md). */
    newTitle: 'A new version of Whombat',
    /** “Version 3.155.0 (37 MB) is ready. It takes a minute, and you stay signed in.” */
    newLead: (version: string, size: number) =>
      `Version ${version} (${Math.max(1, Math.round(size / 1_000_000))} MB) is ready. It takes a minute, and you stay signed in.`,
    later: 'Later',
    /** The app updates itself (AP-813): the button while the APK downloads into the app. */
    downloading: (percent: number) => `Downloading ${percent}%`,
    /** “0.44.0 · 34 of 96 MB” */
    downloadingMeta: (version: string, received: number, total: number) =>
      `${version} · ${Math.round(received / 1_000_000)} of ${Math.max(1, Math.round(total / 1_000_000))} MB`,
    /** Android asks once whether Whombat may install apps (“Install unknown apps”). */
    allow: 'Allow installs',
    /** Where Android sent the person to allow installs: the setting, the app's page instead, or nowhere. */
    allowWhere: {
      setting: 'Allow Whombat to install apps in Android’s settings, then come back here.',
      details:
        'Android opened Whombat’s app info instead. Allow it to install unknown apps there, then come back here.',
      none: 'Android couldn’t open its settings. In Settings, find Whombat under Apps, allow it to install unknown apps, then come back here.',
    },
    /** Downloaded; Android's installer opens on it. */
    ready: 'Install',
    readyMeta: (version: string) => `${version} · Downloaded. Android asks before it installs.`,
    retry: 'Try again',
    failed: {
      network: 'The download didn’t finish. Check the connection and try again.',
      verify: 'The download didn’t check out, so nothing was installed. Try again.',
      signature: 'This update isn’t signed like this app, so Android can’t install it over it.',
      failed: 'Android’s installer didn’t open. Try again.',
    },
  },
  notifications: {
    label: 'NOTIFICATIONS',
    /** Under the settings sheet's Notifications group (SS-30): push on this phone. */
    onThisPhone: 'ON THIS PHONE',
    on: 'On',
    onMeta: 'You get a short note when something needs you. What happened stays on your Whombat.',
    /** A self-hosted server's push (MN-05). */
    off: 'Off',
    offMeta: 'Turn them on to hear when something needs you.',
    turnOn: 'Turn on',
    denied: 'Not allowed',
    deniedMeta: 'Notifications are off for Whombat in this phone’s settings.',
    openSettings: 'Open settings',
    unavailable: 'Not available',
    unavailableMeta: 'This build of the app can’t receive notifications.',
    registering: 'Setting up…',
    failed: 'Couldn’t set up',
    failedMeta: 'Whombat’s service didn’t answer. It tries again the next time you open the app.',
    lastReceived: (ago: string) => `Last one ${ago}`,
    /** Android lets some through and holds others back (pushView.ts). */
    partly: 'Partly on',
    channelsOff: (names: string) => `${names} notifications are off in this phone’s settings.`,
    heldBack: 'Held back',
    restrictedMeta: 'Battery use for Whombat is restricted, so notifications can’t arrive while it’s closed.',
    runsOff: (name: string) => `“${name}” notifications are off, so runs don’t show while they work.`,
    liveUpdatesOff: 'Live Updates are off for Whombat, so runs show as ordinary notifications.',
    batteryMeta: 'This phone may hold Whombat’s notifications back to save battery.',
    opening: 'Opening what needs you…',
  },
  /** The parts' names are the shared `THIS_WHOMBAT_TEXT.parts` (this-whombat-sections-android.md AP-1252). */
  whombat: {
    title: 'This Whombat',
    switch: 'Switch Whombat',
    signOut: 'Sign out',
  },
  /**
   * The BACKUP FILE section on This Whombat → Backups and the phone's own words on its screen (backup-file-android.md
   * AP-1211…; AP-1246); the panels' words are the contracts' (`BACKUP_COPY`) and the client's (`BACKUP_FILE_TEXT`).
   */
  backupFile: {
    title: 'Backup file',
    meta: 'Download a file of what you choose, or restore from one.',
    open: 'Open',
    openHint: 'Opens Backup file',
    /** A Backup file screen restored on a Whombat without `backup.file`. */
    /** The picked file's provider didn't say how big it is (it can't be staged). */
    noSize: 'Whombat can’t tell how big that file is. Save it on this phone first, then choose it again.',
    /** “Save as” (or the folder) couldn't make the file. */
    saveFailed: 'The file couldn’t be saved there. Try again, or choose another place.',
    /** Under a download or an upload while it runs: leaving the screen stops it. */
    stay: 'Stay on this screen until it’s done.',
    leave: {
      downloadTitle: 'Stop the download?',
      downloadText: 'The file isn’t saved yet.',
      uploadTitle: 'Stop the upload?',
      uploadText: 'Choose the same file later to go on from where it stopped.',
      stay: 'Keep going',
      stop: 'Stop',
    },
  },
  /**
   * The phone's own words in REMOTE HELP on About (app remote-help.md AP-4476, AP-4477); the rest are the contracts'
   * (`REMOTE_HELP_WORDS`) and the client's (`REMOTE_HELP_TEXT`).
   */
  remoteHelp: {
    /** The command line's sheet shows the start of a long record; Share and Download give all of it. */
    cut: 'Only the start shows here. Share or download it to read all of it.',
    share: 'Share',
  },
} as const;

export const MANAGED_TEXT = {
  ...SHARED_STATUS,
  thisBrowser: 'This phone',
  addHelp: 'On the new device, choose “Let this device in”, then type the code it shows.',
} as const;
