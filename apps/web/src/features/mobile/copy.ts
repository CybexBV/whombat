/**
 * What the web's “Mobile app” page and the `/auth/phone` landing say (AP-521…AP-528). Curly quotes, the middle dot and
 * sentence case, like the rest of the app.
 */
import type { PairingErrorKey } from '@whombat/client/managed';
import type { PhoneSignInError, PhoneSignInNotice } from './phoneSignIn';

export const MOBILE_TEXT = {
  kicker: 'PHONE APP',
  title: 'Get Whombat on your phone',
  sub: 'Answer questions, say yes to requests and hear when something needs you. Scan the code with the app and your phone is in.',
  /** The same on a phone's own screen, which can't scan itself. */
  subPhone:
    'Answer questions, say yes to requests and hear when something needs you. Get the app, then open it from here.',
  subSelfHosted:
    'Answer questions, say yes to requests and hear when something needs you. On Android and iPhone.',
  tip: 'Signing in by QR code never asks for your email: this computer vouches for your phone, and you confirm it here.',
  tipSelfHosted: 'In the app, sign in with the same email you use here.',
  back: '← Back to Whombat',
  backToWhombats: '← Back to your Whombats',

  signIn: {
    label: 'SIGN IN ON YOUR PHONE',
    title: 'Scan to sign in',
    /** The same card on a phone's own screen: the code is for a different phone. */
    titleOther: 'Signing in another phone?',
    /** The card's title once a phone scanned the code (on every width). */
    titleBusy: 'Your phone is signing in',
    /** The last step once a phone scanned: what is still to come. */
    stepLetIn: { title: 'Let it in here', body: 'Your phone asks to come in, and you check it here.' },
    steps: [
      {
        title: 'Install Whombat on your phone',
        body: 'No app yet? Point your phone’s camera at this code: it opens the download.',
      },

      { title: 'Open the app and tap “Scan the QR code”', body: null },
      {
        title: 'Point your phone at this code',
        body: 'Your phone signs in, and you let it in here.',
      },
    ],
    /** Step 1's line when no Android app is published here: the camera would open a page without a download. */
    installNone: 'The Android app isn’t published here yet. On an iPhone, join the test under Get the app.',
    qrLabel: 'QR code that signs your phone in to Whombat',
    onThisPhone: 'Have the app on this phone already?',
    into: (whombat: string) => `It signs your phone in as you and asks ${whombat} to let it in.`,
    intoNone: 'It signs your phone in as you.',
    refreshesIn: (time: string) => `New code in ${time}`,
    making: 'Making a code…',
    notice: {
      refused:
        'That answer didn’t come from the phone that scanned the code, so nothing was let in. Here’s a new code.',
      declined: 'Not let in. Here’s a new code.',
      timedOut: 'That took too long. Here’s a new code.',
    } satisfies Record<PhoneSignInNotice, string>,

    scannedTitle: 'Your phone scanned the code',
    scannedWaiting: (whombat: string) => `Waiting for it to ask ${whombat}…`,
    scannedSigningIn: 'Waiting for it to sign in…',
    lookingUp: 'Checking your phone with your Whombat…',

    confirmLabel: 'YOUR PHONE IS ASKING TO COME IN',
    confirmTitle: (name: string) => `Let ${name} in?`,
    confirmInto: (whombat: string) => `It gets the same access to ${whombat} as this browser.`,
    fingerprintLabel: 'FINGERPRINT',
    sameOnPhone: 'Check that your phone shows',
    compare: 'If they don’t match, choose “Not my phone”.',
    letIn: 'Let it in',
    lettingIn: 'Letting it in…',
    notMine: 'Not my phone',
    decideNote: {
      failed: 'That didn’t work. Try again.',
      rateLimited: 'Too many tries. Wait a few minutes, then try again.',
    } as Partial<Record<PairingErrorKey, string>>,

    successTitle: (name: string) => `${name} is in`,
    successBody: (whombat: string) => `Your phone is signed in to ${whombat}. Pick it up and carry on there.`,
    /** On the phone that was let in. */
    successBodyHere: (whombat: string) =>
      `Your phone is signed in to ${whombat}. Open the Whombat app and carry on there.`,
    doneTitle: 'Your phone is signed in',
    doneBody: (whombat: string | null) =>
      whombat
        ? `It was already let in to ${whombat}, so there’s nothing to confirm.`
        : 'Pick a Whombat in the app. You let it in from a computer that’s already in.',
    another: 'Sign in another phone',
    seeDevices: 'See your devices',

    errorTitle: 'No code right now',

    errors: {
      unreachable: 'Couldn’t reach Whombat’s service. Check your connection and try again.',
      rateLimited: 'Too many codes in a short time. Wait a minute, then try again.',
      signedOut: 'You were signed out. Sign in again, then come back here.',
    },
    pairingErrors: {
      badCode: 'Your phone’s request is gone from your Whombat. Scan a new code.',
      expired: 'Your phone’s request expired. Scan a new code.',
      fingerprintChanged: 'Another device took over that request. Nothing was let in. Scan a new code.',
      rateLimited: 'Too many tries. Wait a few minutes, then try again.',
      failed: 'That didn’t work. Try again.',
    } satisfies Record<PairingErrorKey, string>,
    tryAgain: 'Try again',
  },

  download: {
    label: 'GET THE APP',
    name: 'Whombat for Android',
    button: 'Download for Android',
    /** No version or file type: the app updates itself, and the size is what matters on a phone. */
    meta: (_version: string, size: string) => `${size} · Updates itself`,
    hint: 'The first time, Android asks to allow installs from your browser. Allow it, then open the file.',
    iphoneName: 'Whombat for iPhone',
    iphoneMeta: 'In testing on Apple’s TestFlight',
    iphoneJoin: 'Join on TestFlight',
    /** The public TestFlight link: anyone with it can install the app, no invite needed. */
    iphoneLink: 'https://testflight.apple.com/join/YM62X9Kw',
    none: 'The Android app isn’t published here yet. Check back soon.',
    loading: 'Looking for the latest version…',
    failed: 'Couldn’t check for the app just now.',
    retry: 'Try again',
  },

  selfHosted: 'On this server, the app signs in with your email, like this browser did.',

  landing: {
    kicker: 'PHONE APP',
    title: 'Open this with the Whombat app',
    sub: 'This code signs a phone in to Whombat. It works in the app, not in a browser.',
    open: 'Open in the Whombat app',
    noApp: 'No app yet? Install it, then scan the code again.',
    computer: 'On a computer? This code is for your phone: scan it with the Whombat app.',
    broken: 'This link is incomplete or already used. Show a new code on your computer.',
    tip: 'Once the app is installed, scan the code on your computer again, or come back here and tap Open in the Whombat app.',
  },

  /** `/mobile` signed out (AP-526): where the phone app's “Update the app” leads. */
  public: {
    title: 'Get Whombat for your phone',
    sub: 'Install the app, open it and tap “Scan the QR code”. Then scan the code under Phone app in Settings on your computer.',
    signIn: 'Sign in on this device',
    tip: 'Updating? Download the new version and open it: Android installs it over the one you have, and you stay signed in.',
  },
} as const;

export function signInErrorText(error: PhoneSignInError): string {
  return typeof error === 'string'
    ? MOBILE_TEXT.signIn.errors[error]
    : MOBILE_TEXT.signIn.pairingErrors[error.pairing];
}

/** An APK's size the way Android shows it: `41 MB`, `8.4 MB`, `950 kB` (decimal units). */
export function formatDownloadSize(bytes: number): string {
  if (bytes >= 10_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000_000) return `${(Math.round(bytes / 100_000) / 10).toString()} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} kB`;
}
