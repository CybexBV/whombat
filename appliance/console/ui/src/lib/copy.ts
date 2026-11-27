/**
 * Every word on the screens. The console's words are verbatim from the text console
 * (console/internal/screen/render.go, CC-08) so the runbook, the text fallback and this page say the same thing;
 * the rest is new, in Whombat's voice (short, warm, plain; ’ “ ” … ·). The installer speaks of “this machine”: the
 * same ISO installs a dedicated computer and a virtual machine (CG-30).
 * The guide is Hazel, the wombat who gives the tips in the app's sign-in and claim pages (CG-35): an illustration,
 * not the Whombat's agent, which is made at the claim and named in setup (CG-338).
 */

import { english, localized, type Translate } from '../i18n/translate';
import type { CheckId, CheckStatus, Disk, DiskPart, DiskReason, InstallStep } from './api';
import { formatSize } from './installer';

/** The text console's words (render.go), unchanged. */
export const wordCopy = localized(
  (t) =>
    ({
      starting: t('claim.starting'),
      waiting: t('claim.waiting'),
      waitingHint: t('claim.waitingHint'),
      claimTitle: t('claim.claimTitle'),
      // The claim link is the box's own address (or its tailnet name, below): it opens from anywhere.
      claimOpen: (url: string) => t('claim.claimOpen', { url }),
      claimRotates: t('claim.claimRotates'),
      // A browser has the claim link open: only where to type the letters.
      claimPageOpen: t('claim.claimPageOpen'),
      // No address a person can open (the server sends no claimUrl/appUrl; Whombat LNK-55).
      claimNoAddress: t('claim.claimNoAddress'),
      // While Tailscale asks for a sign-in or HTTPS (the Expert choice), the claim line names only Tailscale's steps.
      claimAfterTailscale: t('claim.claimAfterTailscale'),
      claimAfterHttps: t('claim.claimAfterHttps'),
      // No address to open, but one on this network: the Whombat app there claims it.
      claimInApp: (address: string) => t('claim.claimInApp', { address }),
      // Only an IPv6 address on this network: the app takes an IPv4 one, so that is another way, under the line above.
      claimIpv4: t('claim.claimIpv4'),
      // Under the claim link at the box's own address, which others on the internet can keep busy: a way they can't reach.
      claimElseInApp: (address: string) => t('claim.claimElseInApp', { address }),
      claimElseTailnet: (url: string) => t('claim.claimElseTailnet', { url }),
      // New letters were asked for at this screen: they stay for a while, whatever is tried.
      claimStays: (min: number) => t('claim.claimStays', { min }),
      backoff: (min: number) => t('claim.backoff', { min }),
      claimed: t('claim.claimed'),
      claimedOpen: (url: string) => t('claim.claimedOpen', { url }),
      claimedApp: t('claim.claimedApp'),
      // A device waiting to sign in at this screen (Whombat BX-06, CG-150), over every claimed scene.
      signInKicker: t('claim.signInKicker'),
      signInTitle: (name: string) => t('claim.signInTitle', { name }),
      signInType: t('claim.signInType'),
      signInIgnore: (min: number) => t('claim.signInIgnore', { min }),
      // Whombat Link and Tailscale (contracts 4.4, CG-402, CG-404). A claim link on the box's tailnet name says where.
      claimOpenTailnet: (url: string) => t('claim.claimOpenTailnet', { url }),
      linkTitle: t('claim.linkTitle'),
      linkOpen: (url: string) => t('claim.claimOpen', { url }),
      linkConfirm: t('claim.linkConfirm'),
      linkRotates: (min: number) => t('claim.linkRotates', { min }),
      linkWaiting: t('claim.linkWaiting'),
      linkWaitingHint: t('claim.linkWaitingHint'),
      // Under the wait for the web address once it took long: the Whombat app on this network claims the box already.
      linkWaitingInApp: (address: string, letters: string) =>
        t('claim.linkWaitingInApp', { address, letters }),
      linkStarting: t('claim.linkStarting'),
      linkGrace: (day: string) => t('claim.linkGrace', { day }),
      linkEnded: t('claim.linkEnded'),
      tailscaleLogin: (url: string) => t('claim.tailscaleLogin', { url }),
      tailscaleHttps: t('claim.tailscaleHttps'),
      // Tailscale's step and the claim, numbered while Tailscale asks for something and the claim has no address to open:
      // the sign-in first, and the claim's line says the app on this network works right away.
      stepOne: '1 · ',
      stepTwo: '2 · ',
      claimInAppNow: (address: string) => t('claim.claimInAppNow', { address }),
      // Why the first start can't finish (CG-409), in place of “Starting Whombat…”.
      startTitle: t('claim.startTitle'),
      startReleaseMissing: (release: string) => t('claim.startReleaseMissing', { release }),
      startReleaseMissingNoId: t('claim.startReleaseMissingNoId'),
      startOffline: t('claim.startOffline'),
      startFailed: t('claim.startFailed'),
      startRetry: t('claim.startRetry'),
    }) as const,
);
export const WORD = wordCopy();

export const GUIDE = 'Hazel';
/** The guide's alt text: who she is on this screen. */
export const guideLabelCopy = localized((t) => t('guide.label'));
export const GUIDE_LABEL = guideLabelCopy();

/** What the wombats say on the console's screens. */
export const sayCopy = localized(
  (t) =>
    ({
      starting: t('claim.guide.starting'),
      startProblem: t('claim.guide.startProblem'),
      waiting: t('claim.guide.waiting'),
      claimable: t('claim.guide.claimable'),
      backoff: t('claim.guide.backoff'),
      celebrate: t('claim.guide.celebrate'),
      link: t('claim.guide.link'),
      linkWaiting: t('claim.guide.linkWaiting'),
      linkStarting: t('claim.guide.linkStarting'),
    }) as const,
);

export const consoleCopy = localized(
  (t) =>
    ({
      claimCode: t('console.claimCode'),
      /** The button that asks for new claim letters (the text console says “Press N for new letters.”). */
      newLetters: t('console.newLetters'),
      /** The key that does the same, shown on the button. */
      newLettersKey: 'N',
      linkCode: t('console.linkCode'),
      /** A QR code's name for a screen reader: the address it opens. */
      qr: (url: string) => t('console.qr', { url }),
      /** Under every QR code: what to do with it. */
      scan: t('console.scan'),
      notes: t('console.notes'),
      retryIn: t('console.retryIn'),
      claimed: t('console.claimed'),
      factKicker: t('console.factKicker'),
      connecting: t('console.connecting'),
      reconnecting: t('console.reconnecting'),
      /**
       * A certificate for the box's own address it didn't ask for (contracts 4.3 `own_address_foreign`), in the words of
       * the runtime's notice (Whombat OWA-10). The page knows no address, so it names none.
       */
      alertForeignTitle: t('console.alertForeignTitle'),
      alertForeign: t('console.alertForeign'),
    }) as const,
);
export const CONSOLE = consoleCopy();

export const installerCopy = localized(
  (t) =>
    ({
      kicker: t('installer.kicker'),
      step: (n: number, of: number) => t('installer.step', { n, of }),
      back: t('bluetooth.back'),
      continue: t('installer.continue'),

      welcomeTitle: t('installer.welcomeTitle'),
      welcomeSub: t('installer.welcomeSub'),
      welcomeNext: t('installer.welcomeNext'),
      start: t('installer.start'),
      welcomeSay: t('installer.welcomeSay'),

      // How the box will be reached (Whombat LNK-12, ONE-12): Easy or Expert, the same words as Settings → This Whombat →
      // Reach; the offer sentence is the contracts' (LINK_OFFER_TEXT, ONE-07).
      reachTitle: t('installer.reachTitle'),
      reachSub: t('installer.reachSub'),
      reachSay: t('installer.reachSay'),
      reachEasy: t('installer.reachEasy'),
      reachLink: 'Whombat Link',
      reachRecommended: t('installer.reachRecommended'),
      reachLinkPrice: t('installer.reachLinkPrice'),
      reachLinkPoints: [
        t('installer.reachLinkPoints.openYourWhombat'),
        t('installer.reachLinkPoints.itsOwnSecureHint'),
        t('installer.reachLinkPoints.notificationsOnYourHint'),
        t('installer.reachLinkPoints.theWhombatAppsHint'),
        t('installer.reachLinkPoints.signInsLikeHint'),
        t('installer.reachLinkPoints.supportsWhombatsOpenHint'),
      ],
      reachExpert: t('installer.reachExpert'),
      reachTailscale: t('installer.reachTailscale'),
      reachFree: t('installer.reachFree'),
      reachTailscaleNote: t('installer.reachTailscaleNote'),
      reachTailscalePoints: [
        t('installer.reachTailscalePoints.noNotificationsOn'),
        t('installer.reachTailscalePoints.someSignInsHint'),
      ],
      reachLoginServer: t('installer.reachLoginServer'),
      reachLoginServerHint: t('installer.reachLoginServerHint'),
      reachLoginServerBad: t('installer.reachLoginServerBad'),

      checksTitle: t('installer.checksTitle'),
      checksSub: t('installer.checksSub'),
      checkAgain: t('installer.checkAgain'),
      checksRunning: t('installer.checksRunning'),
      checksOk: t('installer.checksOk'),
      /** Every check passed: one line, the rows behind Details. */
      checksAllGood: t('installer.checksAllGood'),
      checksLooking: t('installer.checksLooking'),
      /** The rows that passed, folded under the line or under a problem. */
      checksDetails: t('installer.checksDetails'),
      checksHideDetails: t('installer.checksHideDetails'),
      checksWarn: t('installer.checksWarn'),
      checksFail: t('installer.checksFail'),
      checksSay: {
        running: t('installer.checksSay.running'),
        ok: t('installer.checksSay.ok'),
        warn: t('installer.checksSay.warn'),
        fail: t('installer.checksSay.fail'),
      },

      diskTitle: t('installer.diskTitle'),
      diskSub: t('installer.diskSub'),
      diskSay: t('installer.diskSay'),
      diskNone: t('installer.diskNone'),

      eraseTitle: t('installer.eraseTitle'),
      /**
       * The disk by its size and model, as a person knows it; its device name (sda) only where it must be typed. `model` is
       * “ (QEMU HARDDISK)” with its space, or nothing.
       */
      eraseSub: (size: string, model: string) => t('installer.eraseSub', { size, model }),
      /** An empty disk: nothing to lose, so a button press confirms. */
      eraseEmptySub: (size: string, model: string) => t('installer.eraseEmptySub', { size, model }),
      eraseLabel: (name: string) => t('installer.eraseLabel', { name }),
      erase: (name: string) => t('installer.erase', { name }),
      eraseEmpty: t('installer.eraseTitle'),
      erasing: t('installer.erasing'),
      eraseSay: t('installer.eraseSay'),
      eraseRefused: t('installer.eraseRefused'),
      eraseBusy: t('installer.eraseBusy'),

      installingTitle: t('installer.installingTitle'),
      installingSub: t('installer.installingSub'),
      showDetails: t('installer.showDetails'),
      hideDetails: t('installer.checksHideDetails'),
      progressLabel: t('installer.progressLabel'),

      doneTitle: t('installer.doneTitle'),
      doneSub: t('installer.doneSub'),
      doneMedium: t('installer.doneMedium'),
      restart: t('installer.restart'),
      restarting: t('installer.restarting'),
      doneSay: t('installer.doneSay'),

      failedTitle: t('installer.failedTitle'),
      failedSub: (step: string | null) =>
        step
          ? t('installer.failedSub.WithValue', { step: step.toLowerCase() })
          : t('installer.failedSub.Fallback'),
      failedLog: t('installer.failedLog'),
      tryAgain: t('bluetooth.tryAgain'),
      failedSay: t('installer.failedSay'),
    }) as const,
);
export const INSTALLER = installerCopy();

export const checkLabelCopy = localized(
  (t): Record<CheckId, string> => ({
    uefi: t('installer.check.uefi'),
    cpu: t('installer.check.cpu'),
    memory: t('installer.check.memory'),
    disk: t('installer.check.disk'),
    network: t('installer.check.network'),
    'reach-api': t('installer.check.reach-api'),
    'reach-updates': t('installer.check.reach-updates'),
    'reach-relay': t('installer.check.reach-relay'),
    'reach-login': t('installer.check.reach-login'),
  }),
);

/**
 * A line under a check that isn't ok. `value` is the server's plain value (a host, “2 cores”, …); `disks` what the disk
 * check found, so its line says what stops each one.
 */
export function checkNote(
  id: CheckId,
  status: CheckStatus,
  value: string,
  disks: Disk[] = [],
  t: Translate = english,
): string | null {
  if (status === 'ok' || status === 'running') return null;
  const warn = status === 'warn';
  switch (id) {
    case 'uefi':
      return t('copy.thisMachineStartedInBios');
    case 'cpu':
      return warn ? t('copy.fewerThanCoresWhombatRuns') : t('copy.whombatNeedsAtLeastCores');
    case 'memory':
      return warn ? t('copy.lessThanGibAgentsMay') : t('copy.whombatNeedsAtLeastGib');
    case 'disk':
      return diskNote(disks, t);
    case 'network':
      return t('copy.noNetworkAddressYetWhombat');
    default:
      return value ? t('copy.cantReachWhombatNeedsIt', { value }) : t('copy.cantReachItWhombatNeeds');
  }
}

/** Why no disk can take Whombat, in one line: what stops each disk the installer found. */
export function diskNote(disks: Disk[], t: Translate = english): string {
  const refused = disks.filter((d) => !d.eligible && d.reason !== '');
  if (refused.length === 0) return t('copy.noDiskFoundToInstall');
  return t('copy.noDiskToInstallOn', { value: refused.map((disk) => diskWhy(disk, t)).join('; ') });
}

/** Each disk by its size first, as a person knows it, with its device name quiet after it. */
function diskWhy(d: Disk, t: Translate = english): string {
  const disk = t('copy.theDisk', { value: formatSize(d.sizeBytes, t.locale), name: d.name });
  switch (d.reason) {
    case 'too-small':
      return t('copy.isSmallerThanTheGib', { disk });
    case 'installer-medium':
      return t('copy.holdsThisInstaller', { disk });
    case 'in-use':
      return t('copy.isInUse', { disk });
    default:
      return t('copy.isConnectedByUsb', { disk });
  }
}

/** What a file system says to a person: what made it, in everyday words. */
const fsWordsCopy = localized(
  (t): Record<string, string> => ({
    ntfs: t('installer.fileSystem.ntfs'),
    BitLocker: t('installer.fileSystem.BitLocker'),
    vfat: t('installer.fileSystem.vfat'),
    exfat: t('installer.fileSystem.exfat'),
    ext2: t('installer.fileSystem.ext2'),
    ext3: t('installer.fileSystem.ext2'),
    ext4: t('installer.fileSystem.ext2'),
    btrfs: t('installer.fileSystem.ext2'),
    xfs: t('installer.fileSystem.ext2'),
    f2fs: t('installer.fileSystem.ext2'),
    apfs: t('installer.fileSystem.apfs'),
    hfsplus: t('installer.fileSystem.apfs'),
    crypto_LUKS: t('installer.fileSystem.crypto_LUKS'),
    LVM2_member: t('installer.fileSystem.LVM2_member'),
    zfs_member: t('installer.fileSystem.zfs_member'),
    linux_raid_member: t('installer.fileSystem.linux_raid_member'),
    swap: t('installer.fileSystem.swap'),
    iso9660: t('installer.fileSystem.iso9660'),
  }),
);

function partWords(p: DiskPart, t: Translate = english): string {
  const FS_WORDS = fsWordsCopy(t);

  const what = FS_WORDS[p.fsType] ?? t('copy.otherData');
  const size =
    p.sizeBytes >= 1024 ** 3
      ? formatSize(p.sizeBytes, t.locale)
      : `${Math.max(1, Math.round(p.sizeBytes / 1024 ** 2))} MiB`;
  return p.label ? `${what} (“${p.label}”, ${size})` : `${what} (${size})`;
}

/**
 * What is on a disk that isn't empty, in plain words, for the erase step: “It isn’t empty: it holds Windows files
 * (“OS”, 475 GiB), FAT files (100 MiB) and 2 more parts.” Null when the page doesn't know (an older server).
 */
export function diskHolds(d: Disk, t: Translate = english): string | null {
  const parts = d.parts ?? [];
  if (d.empty || parts.length === 0) return null;
  const named = parts.slice(0, 3).map((item) => partWords(item, t));
  const more = parts.length - named.length;
  if (more > 0) named.push(more === 1 ? t('copy.morePart') : t('copy.moreParts', { more }));
  const list =
    named.length === 1
      ? named[0]
      : t('copy.and', { value: named.slice(0, -1).join(', '), named: named.at(-1) });
  return t('copy.itIsntEmptyItHolds', { list });
}

export const diskReasonCopy = localized(
  (t): Record<Exclude<DiskReason, ''>, string> => ({
    'too-small': t('installer.diskReason.too-small'),
    'installer-medium': t('installer.diskReason.installer-medium'),
    'in-use': t('installer.diskReason.in-use'),
    usb: t('installer.diskReason.usb'),
  }),
);

export const stepLabelCopy = localized(
  (t): Record<InstallStep, string> => ({
    partition: t('installer.installStep.partition'),
    filesystems: t('installer.installStep.filesystems'),
    copy: t('installer.installStep.copy'),
    boot: t('installer.installStep.boot'),
    finish: t('installer.installStep.finish'),
  }),
);

export const stepSayCopy = localized(
  (t): Record<InstallStep, string> => ({
    partition: t('installer.installGuide.partition'),
    filesystems: t('installer.installGuide.filesystems'),
    copy: t('installer.installGuide.copy'),
    boot: t('installer.installGuide.boot'),
    finish: t('installer.installGuide.finish'),
  }),
);
