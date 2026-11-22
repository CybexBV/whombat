/**
 * Every word on the screens. The console's words are verbatim from the text console
 * (console/internal/screen/render.go, CC-08) so the runbook, the text fallback and this page say the same thing;
 * the rest is new, in Whombat's voice (short, warm, plain; ’ “ ” … ·). The installer speaks of “this machine”: the
 * same ISO installs a dedicated computer and a virtual machine (CG-30).
 * The guide is Hazel, the wombat who gives the tips in the app's sign-in and claim pages (CG-35): an illustration,
 * not the Whombat's agent, which is made at the claim and named in setup (CG-338).
 */
import { LINK_OFFER_TEXT } from '../../vendor/whombat-contracts/link-price';
import type { CheckId, CheckStatus, DiskReason, InstallStep } from './api';

/** The text console's words (render.go), unchanged. */
export const WORD = {
  starting: 'Starting Whombat…',
  waiting: 'Connecting to Whombat…',
  waitingHint: 'Check the network cable. The claim code appears once this Whombat is online.',
  claimTitle: 'Claim this Whombat',
  // The claim link is the box's own address (or its tailnet name, below): it opens from anywhere.
  claimOpen: (url: string) => `On a computer or phone, open ${url} and enter`,
  claimRotates: 'The code changes after a wrong try.',
  // No address a person can open (the server sends no claimUrl/appUrl; Whombat LNK-55).
  claimNoAddress: 'The code appears once this Whombat has a secure address: Whombat Link or Tailscale.',
  // While Tailscale asks for a sign-in or HTTPS (the Expert choice), the claim line names only Tailscale's steps.
  claimAfterTailscale: 'After you sign in to Tailscale and turn on HTTPS, the code appears here.',
  claimAfterHttps: 'After you turn on HTTPS in Tailscale, the code appears here.',
  // No address to open, but one on this network: the Whombat app there claims it.
  claimInApp: (address: string) => `In the Whombat app on this network, type ${address} and enter`,
  // Only an IPv6 address on this network: the app takes an IPv4 one, so that is another way, under the line above.
  claimIpv4:
    'This network gave this Whombat only an IPv6 address. If it also gets an IPv4 address, the code appears here and you can claim it in the Whombat app.',
  // Under the claim link at the box's own address, which others on the internet can keep busy: a way they can't reach.
  claimElseInApp: (address: string) =>
    `If that page doesn’t open: in the Whombat app on this network, type ${address}.`,
  claimElseTailnet: (url: string) => `If that page doesn’t open: on a device on your tailnet, open ${url}.`,
  // New letters were asked for at this screen: they stay for a while, whatever is tried.
  claimStays: (min: number) => `These letters stay for ${min} min.`,
  backoff: (min: number) => `Too many wrong codes. Try again in ${min} min.`,
  claimed: 'This Whombat is set up.',
  claimedOpen: (url: string) => `Open ${url} to use it.`,
  claimedApp: 'Use it in the Whombat app on this network.',
  // A device waiting to sign in at this screen (Whombat BX-06, CG-150), over every claimed scene.
  signInKicker: 'NEW DEVICE',
  signInTitle: (name: string) => `${name} wants to sign in`,
  signInType: 'Type these letters on that device.',
  signInIgnore: (min: number) => `Didn’t ask for this? Ignore it: the code goes away in ${min} min.`,
  // Whombat Link and Tailscale (contracts 4.4, CG-402, CG-404). A claim link on the box's tailnet name says where.
  claimOpenTailnet: (url: string) => `On a device on your tailnet, open ${url} and enter`,
  linkTitle: 'Turn on Whombat Link',
  linkOpen: (url: string) => `On a computer or phone, open ${url} and enter`,
  linkConfirm: 'Sign in or create an account there, then confirm this Whombat.',
  linkRotates: (min: number) => `The code changes in ${min} min.`,
  linkWaiting: 'Waiting for this Whombat’s web address…',
  linkWaitingHint:
    'Whombat Link is on. New web addresses are handed out in turn, and this one usually comes within a few minutes. This Whombat asks again every minute by itself; this screen changes when the address is ready.',
  linkStarting: 'Starting Whombat Link…',
  linkGrace: (day: string) =>
    `Whombat Link ends on ${day}. Turn on Tailscale in the Whombat app to keep a way in, and check your paper backup details.`,
  linkEnded:
    'Whombat Link has ended. Subscribe again at app.whombat.com, or turn on Tailscale: in the Whombat app at home, or in the recovery menu (hold Space at power-on).',
  tailscaleLogin: (url: string) => `Sign in to Tailscale: open ${url} on a computer or phone.`,
  tailscaleHttps:
    'Turn on HTTPS in Tailscale: in the Tailscale admin console, open DNS and turn on HTTPS Certificates. This Whombat checks again by itself.',
  // Why the first start can't finish (CG-409), in place of “Starting Whombat…”.
  startTitle: 'Whombat can’t start yet',
  startReleaseMissing: (release: string) =>
    `This Whombat can’t find its version, ${release}, on the update server. Install it again with the newest Whombat installer.`,
  startReleaseMissingNoId:
    'This Whombat can’t find its version on the update server. Install it again with the newest Whombat installer.',
  startOffline: 'This Whombat can’t reach the update server. Check the network cable.',
  startFailed: 'Something went wrong while this Whombat set itself up.',
  startRetry: 'It tries again by itself. To try now, restart it.',
} as const;

export const GUIDE = 'Hazel';
/** The guide's alt text: who she is on this screen. */
export const GUIDE_LABEL = `${GUIDE}, your guide`;

/** What the wombats say on the console's screens. */
export const SAY = {
  starting: 'Just waking up. This takes a minute.',
  startProblem: 'Hmm. Something’s in my way.',
  waiting: 'Sniffing for the way out to the internet…',
  claimable: 'Four letters. I’ll hold the sign.',
  backoff: 'Let’s take a little break.',
  celebrate: 'Welcome home!',
  link: 'I’ll hold the sign while you type it.',
  linkWaiting: 'Digging a new front door. Almost there.',
  linkStarting: 'Getting the tunnel ready…',
} as const;

export const CONSOLE = {
  claimCode: 'Claim code',
  /** The button that asks for new claim letters (the text console says “Press N for new letters.”). */
  newLetters: 'New letters',
  /** The key that does the same, shown on the button. */
  newLettersKey: 'N',
  linkCode: 'Whombat Link code',
  notes: 'How to reach this Whombat',
  retryIn: 'Try again in',
  claimed: 'Claimed!',
  factKicker: 'WOMBAT FACT',
  connecting: 'Connecting to this Whombat’s console…',
  reconnecting: 'Reconnecting…',
  /**
   * A certificate for the box's own address it didn't ask for (contracts 4.3 `own_address_foreign`), in the words of
   * the runtime's notice (Whombat OWA-10). The page knows no address, so it names none.
   */
  alertForeignTitle: 'Don’t use this Whombat’s address for now',
  alertForeign:
    'Someone got a security certificate for your Whombat’s address that your Whombat didn’t ask for. Until you know why, don’t use that address. Use the app on your phone or your home network.',
} as const;

export const INSTALLER = {
  kicker: 'WHOMBAT INSTALLER',
  step: (n: number, of: number) => `INSTALL · STEP ${n} OF ${of}`,
  back: 'Back',
  continue: 'Continue',

  welcomeTitle: 'Let’s set up your Whombat',
  welcomeSub:
    'This installs Whombat on this machine. It takes a few minutes, and everything on the disk you choose is erased.',
  welcomeNext: 'After a restart, the screen shows a code to claim your Whombat.',
  start: 'Start',
  welcomeSay: `Hi, I’m ${GUIDE}. I’ll show you the way. It’s mostly digging.`,

  // How the box will be reached (Whombat LNK-12, ONE-12): Easy or Expert, the same words as Settings → This Whombat →
  // Reach; the offer sentence is the contracts' (LINK_OFFER_TEXT, ONE-07).
  reachTitle: 'How will you reach this Whombat?',
  reachSub: 'You can change this later in Settings.',
  reachSay: 'Pick how you’ll find your way back to the burrow.',
  reachEasy: 'Easy',
  reachLink: 'Whombat Link',
  reachRecommended: 'Recommended',
  reachLinkPrice: LINK_OFFER_TEXT,
  reachLinkPoints: [
    'Open your Whombat from anywhere, without port forwarding',
    'Its own secure web address',
    'Notifications on your iPhone and Android phone',
    'The Whombat apps away from home',
    'Sign-ins like Google work',
    'Supports Whombat’s open-source work',
  ],
  reachExpert: 'Expert',
  reachTailscale: 'Tailscale or Headscale',
  reachFree: 'Free',
  reachTailscaleNote: 'You set up Tailscale on each of your devices.',
  reachTailscalePoints: [
    'No notifications on your phone while the app is closed',
    'Some sign-ins, like Google, aren’t available',
  ],
  reachLoginServer: 'Your own login server (optional)',
  reachLoginServerHint: 'For Headscale. Leave it empty to use Tailscale’s own.',
  reachLoginServerBad: 'Enter an https address, like https://headscale.example.com.',

  checksTitle: 'Checking this machine',
  checksSub:
    'Whombat needs UEFI, enough memory and a big enough disk. It also looks for the internet it needs after the restart.',
  checkAgain: 'Check again',
  checksRunning: 'Checking…',
  checksOk: 'All good.',
  checksWarn: 'Read the warnings, then continue.',
  checksFail: 'Fix the marked items first.',
  checksSay: {
    running: 'Sniffing around…',
    ok: 'Everything looks good to me.',
    warn: 'A few things to know. We can still go on.',
    fail: 'We can’t dig here yet.',
  },

  diskTitle: 'Choose a disk',
  diskSub: 'Whombat takes the whole disk. Everything on it is erased.',
  diskSay: 'Pick a spot. I need at least 110 GiB.',
  diskNone: 'No disk is big enough. Whombat needs one of 110 GiB or more.',

  eraseTitle: 'Erase and install',
  eraseSub: (name: string, what: string) =>
    `Everything on ${name} (${what}) is erased. This can’t be undone.`,
  eraseLabel: (name: string) => `Type ${name} to confirm`,
  erase: (name: string) => `Erase ${name} and install`,
  erasing: 'Starting…',
  eraseSay: 'Last chance to change your mind. After this, I dig.',
  eraseRefused: 'That didn’t work. Check the disk and the checks, then try again.',
  eraseBusy: 'An installation is already running.',

  installingTitle: 'Installing Whombat',
  installingSub: 'This takes a few minutes. Keep this machine running.',
  showDetails: 'Show details',
  hideDetails: 'Hide details',
  progressLabel: 'Installation progress',

  doneTitle: 'Whombat is installed',
  doneSub: 'Restart to start it. The screen then shows a code to claim your Whombat.',
  doneMedium:
    'If the installer starts again after the restart, remove the USB stick or detach the ISO, then restart.',
  restart: 'Restart',
  restarting: 'Restarting…',
  doneSay: 'Burrow dug. See you on the other side!',

  failedTitle: 'The installation didn’t finish',
  failedSub: (step: string | null) =>
    step ? `It stopped while ${step.toLowerCase()}.` : 'It stopped before it could begin.',
  failedLog: 'What happened',
  tryAgain: 'Try again',
  failedSay: 'Hmm. That didn’t work. Let’s look at it together.',
} as const;

export const CHECK_LABEL: Record<CheckId, string> = {
  uefi: 'UEFI firmware',
  cpu: 'Processor',
  memory: 'Memory',
  disk: 'Disk',
  network: 'Network',
  'reach-api': 'Whombat service',
  'reach-updates': 'Updates',
  'reach-relay': 'Relay',
  'reach-login': 'Tailscale login',
};

/** A line under a check that isn't ok. `value` is the server's plain value (a host, “2 cores”, …). */
export function checkNote(id: CheckId, status: CheckStatus, value: string): string | null {
  if (status === 'ok' || status === 'running') return null;
  const warn = status === 'warn';
  switch (id) {
    case 'uefi':
      return 'This machine started in BIOS mode. Switch its firmware to UEFI and start the installer again.';
    case 'cpu':
      return warn ? 'Fewer than 4 cores. Whombat runs, but slowly.' : 'Whombat needs at least 2 cores.';
    case 'memory':
      return warn
        ? 'Less than 8 GiB. Agents may run short of memory.'
        : 'Whombat needs at least 4 GiB of memory.';
    case 'disk':
      return 'No disk of 110 GiB or more to install on.';
    case 'network':
      return 'No network address yet. Whombat needs the network after the restart.';
    default:
      return value
        ? `Can’t reach ${value}. Whombat needs it when it first starts.`
        : 'Can’t reach it. Whombat needs it when it first starts.';
  }
}

export const DISK_REASON: Record<Exclude<DiskReason, ''>, string> = {
  'too-small': 'Smaller than 110 GiB',
  'installer-medium': 'The installer runs from it',
  'in-use': 'In use',
  usb: 'Connected by USB',
};

export const STEP_LABEL: Record<InstallStep, string> = {
  partition: 'Partitioning the disk',
  filesystems: 'Creating file systems',
  copy: 'Copying the system',
  boot: 'Setting up the boot loader',
  finish: 'Finishing',
};

export const STEP_SAY: Record<InstallStep, string> = {
  partition: 'Marking out the burrow…',
  filesystems: 'Shoring up the walls…',
  copy: 'Carrying everything in…',
  boot: 'Hanging the front door…',
  finish: 'Sweeping up…',
};
