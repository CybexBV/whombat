/**
 * Words of the phone's managed journeys (AP-22, AP-27): the shared `COPY` of the web, with the few lines that name
 * a browser said for a phone, and what only the phone does (scanning the claim card, saving the kit through the share
 * sheet, notifications). Curly quotes and the middle dot as in the mocks.
 */

import { clientTranslator } from '@whombat/client/i18n';
import { claimStepKicker, managedCopyText, managedText as sharedStatus } from '@whombat/client/managed';
import { versionRefusalCopy } from '@whombat/protocol/session';
import { mobileTranslator } from '../i18n/translate';

export function managedCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  const { t: shared } = clientTranslator(locale);
  const SHARED = managedCopyText(locale);
  const refusal = versionRefusalCopy(locale);
  return {
    ...SHARED,
    appliances: {
      ...SHARED.appliances,
      kicker: shared('managed.appliances.kicker'),
      title: shared('managed.appliances.title'),
      sub: shared('managed.appliances.sub'),
      none: shared('managed.appliances.none'),
      claim: shared('managed.appliances.claim'),
      open: shared('managed.appliances.open'),
      online: shared('managed.appliances.online'),
      neverSeen: shared('managed.appliances.neverSeen'),
      signOut: shared('managed.appliances.signOut'),
      retired: shared('managed.appliances.retired'),
      forget: shared('managed.appliances.forget'),
      rename: shared('managed.appliances.rename'),
      save: shared('managed.appliances.save'),
      saving: shared('managed.appliances.saving'),
      cancel: shared('managed.appliances.cancel'),
      yourWhombat: shared('managed.appliances.yourWhombat'),
      offline: (ago: string) => shared('managed.appliances.offline', { ago }),
    },
    lookAround: {
      ...SHARED.lookAround,
      open: shared('managed.lookAround.open'),
      notice: shared('managed.lookAround.notice'),
      leave: shared('managed.lookAround.leave'),
      loading: shared('managed.lookAround.loading'),
      failed: shared('managed.lookAround.failed'),
      retry: shared('managed.lookAround.retry'),
    },
    signIn: {
      ...SHARED.signIn,
      kicker: shared('managed.signIn.kicker'),
      title: shared('managed.signIn.title'),
      sub: shared('managed.signIn.sub'),
      tip: shared('managed.signIn.tip'),
      email: shared('managed.signIn.email'),
      send: shared('managed.signIn.send'),
      sentTitle: shared('managed.signIn.sentTitle'),
      inviteOnlySub: shared('managed.signIn.inviteOnlySub'),
      waitlistSub: shared('managed.signIn.waitlistSub'),
      joinWaitlist: shared('managed.signIn.joinWaitlist'),
      again: shared('managed.signIn.again'),
      verifying: shared('managed.signIn.verifying'),
      linkSub: shared('managed.signIn.linkSub'),
      useLink: shared('managed.signIn.useLink'),
      newLink: shared('managed.signIn.newLink'),
      badLink: shared('managed.signIn.badLink'),
      unreachable: shared('managed.signIn.unreachable'),
      badEmail: shared('managed.signIn.badEmail'),
      tooMany: shared('managed.signIn.tooMany'),
      failed: shared('managed.signIn.failed'),
      sentGated: (email: string) => shared('managed.signIn.sentGated', { email }),
      sent: (email: string) => t('copy.copy.signIn.sent', { email }),
      openHint: t('copy.copy.signIn.openHint'),
      /** QR first (AP-530): the computer shows the code, the phone scans it. */
      scanTitle: t('copy.copy.signIn.scanTitle'),
      scanSub: t('copy.copy.signIn.scanSub'),
      scan: t('copy.copy.signIn.scan'),
      scanTip: t('copy.copy.signIn.scanTip'),
      withEmail: t('copy.copy.signIn.withEmail'),
      withScan: t('copy.copy.signIn.withScan'),
      emailTitle: t('copy.copy.signIn.emailTitle'),
    },
    /** Signing in by the computer's QR code (CT-190, AP-530…AP-539). */
    phone: {
      kicker: t('managed2.copy.signInKicker'),
      scanTitle: t('copy.copy.phone.scanTitle'),
      scanWrong: t('copy.copy.phone.scanWrong'),
      scanDenied: t('copy.copy.phone.scanDenied'),
      scanDeniedSignedIn: t('copy.copy.phone.scanDeniedSignedIn'),
      scanClose: t('copy.copy.phone.scanClose'),
      workingTitle: t('copy.copy.phone.workingTitle'),
      askingTitle: t('copy.copy.phone.askingTitle'),
      workingSub: t('copy.copy.phone.workingSub'),
      confirmTitle: t('copy.copy.phone.confirmTitle'),
      confirmSub: t('copy.copy.phone.confirmSub'),
      stages: {
        signingIn: t('copy.copy.phone.stages.signingIn'),
        asking: t('copy.copy.phone.stages.asking'),
        confirm: t('copy.copy.phone.stages.confirm'),
      },
      stageState: {
        done: t('copy.copy.phone.stageState.done'),
        active: t('copy.copy.phone.stageState.active'),
        todo: t('copy.copy.phone.stageState.todo'),
        failed: t('copy.copy.phone.stageState.failed'),
      },
      thisPhone: t('copy.copy.phone.thisPhone'),
      fingerprint: t('copy.copy.phone.fingerprint'),
      same: t('copy.copy.phone.same'),
      waiting: t('copy.copy.phone.waiting'),
      cancel: t('copy.copy.phone.cancel'),
      scanAgain: t('copy.copy.phone.scanAgain'),
      tryAgain: t('copy.copy.phone.tryAgain'),
      backToSignIn: t('copy.copy.phone.backToSignIn'),
      backToList: t('copy.copy.phone.backToList'),
      withEmail: t('copy.copy.phone.withEmail'),
      pairScan: t('copy.copy.phone.pairScan'),
      pairScanHint: t('copy.copy.phone.pairScanHint'),
      pairOr: t('copy.copy.phone.pairOr'),
      codeMismatchTitle: t('copy.copy.phone.codeMismatchTitle'),
      codeMismatch: t('copy.copy.phone.codeMismatch'),
      errors: {
        expired: {
          title: t('copy.copy.phone.errors.expired.title'),
          text: t('copy.copy.phone.errors.expired.text'),
        },
        over: {
          title: t('copy.copy.phone.errors.over.title'),
          text: t('copy.copy.phone.errors.over.text'),
        },
        tooMany: {
          title: t('copy.copy.phone.errors.tooMany.title'),
          text: t('copy.copy.phone.errors.tooMany.text'),
        },
        unreachable: {
          title: t('copy.copy.phone.errors.unreachable.title'),
          text: t('copy.copy.phone.errors.unreachable.text'),
        },
        notInOrg: {
          title: t('copy.copy.phone.errors.notInOrg.title'),
          text: t('copy.copy.phone.errors.notInOrg.text'),
        },
        retired: {
          title: t('copy.copy.phone.errors.retired.title'),
          text: t('copy.copy.phone.errors.retired.text'),
        },
        whombatUnreachable: {
          title: t('copy.copy.phone.errors.whombatUnreachable.title'),
          text: t('copy.copy.phone.errors.whombatUnreachable.text'),
        },
        denied: {
          title: t('copy.copy.phone.errors.denied.title'),
          text: t('copy.copy.phone.errors.denied.text'),
        },
        pairExpired: {
          title: t('copy.copy.phone.errors.pairExpired.title'),
          text: t('copy.copy.phone.errors.pairExpired.text'),
        },
        failed: {
          title: t('copy.copy.phone.errors.failed.title'),
          text: t('copy.copy.phone.errors.failed.text'),
        },
      },
    },
    claim: {
      ...SHARED.claim,
      title: shared('managed.claim.title'),
      looking: shared('managed.claim.looking'),
      letters: shared('managed.claim.letters'),
      nameLabel: shared('managed.claim.nameLabel'),
      claim: shared('managed.claim.claim'),
      connecting: shared('managed.claim.connecting'),
      claiming: shared('managed.claim.claiming'),
      kicker: claimStepKicker('claim', locale),
      tip: t('claim.tip'),
      noneTitle: t('claim.noneTitle'),
      noneSub: t('claim.noneSub'),
      lookAgain: t('claim.lookAgain'),
      foundTitle: t('claim.foundTitle'),
      foundSub: t('claim.foundSub'),
      lettersHint: t('claim.lettersHint'),
      severalSub: t('claim.severalSub'),
      pick: t('claim.pick'),
      notThisOne: t('claim.notThisOne'),
      noneOfThese: t('claim.noneOfThese'),
      withCard: t('claim.withCard'),
      withCode: t('claim.withCode'),
      cardTitle: t('claim.cardTitle'),
      cardTip: t('claim.cardTip'),
      device: t('claim.device'),
      secret: t('claim.secret'),
      paste: t('claim.paste'),
      malformed: t('claim.malformed'),
      termsAgree: t('claim.termsAgree'),
      termsLabel: t('claim.termsLabel'),
      severalTitle: (n: number) => t('claim.severalTitle', { n }),
      pickLabel: (model: string, device: string) => t('claim.pickLabel', { model, device }),
      cardSub: t('copy.copy.claim.cardSub'),
      scan: t('copy.copy.claim.scan'),
      scanTitle: t('copy.copy.claim.scanTitle'),
      scanClose: t('copy.copy.claim.scanClose'),
      scanDenied: t('copy.copy.claim.scanDenied'),
      scanWrong: t('copy.copy.claim.scanWrong'),
      typeIt: t('copy.copy.claim.typeIt'),
      scanned: t('copy.copy.claim.scanned'),
    },
    kit: {
      ...SHARED.kit,
      download: t('copy.copy.kit.download'),
      saveHint: t('copy.copy.kit.saveHint'),
    },
    pair: {
      ...SHARED.pair,
      sub: t('copy.copy.pair.sub'),
    },
    connection: {
      ...SHARED.connection,
      reconnecting: shared('managed.connection.reconnecting'),
      offline: shared('managed.connection.offline'),
      applianceOffline: shared('managed.connection.applianceOffline'),
      unlisted: shared('managed.connection.unlisted'),
      busy: shared('managed.connection.busy'),
      maintenance: shared('managed.connection.maintenance'),
      retry: shared('managed.connection.retry'),
      reload: shared('managed.connection.reload'),
      applianceTooOldTitle: shared('managed.connection.applianceTooOldTitle'),
      revokedTitle: shared('managed.connection.revokedTitle'),
      signedOutTitle: shared('managed.connection.signedOutTitle'),
      back: shared('managed.connection.back'),
      signIn: shared('managed.connection.signIn'),
      clientTooOldTitle: t('copy.copy.connection.clientTooOldTitle'),
      /** A box of another protocol major (HE-52): the contracts' words. */
      clientTooOld: refusal.client,
      applianceTooOld: refusal.appliance,
      unsupported: t('copy.copy.connection.unsupported'),
      belowFloor: t('copy.copy.connection.belowFloor'),
    },
    /**
     * Until the app is in the Play Store, Android downloads and installs the published APK itself (AP-813); the iPhone
     * and a phone without one published get the hosted UI's Mobile app page (AP-537).
     */
    update: {
      label: t('copy.copy.update.label'),
      phoneTooOld: t('copy.copy.update.phoneTooOld'),
      /** After “1 item needs a newer version of the app.” while no newer app is out (AP-701). */
      soon: t('copy.copy.update.soon'),
      /** A newer build is out though nothing needs it (SS-71): a calm row, not a warning. */
      available: t('copy.copy.update.available'),
      /** “0.37.0 · 58 MB · Download and install it over this app.” */
      availableMeta: (version: string, size: number) =>
        t('managed2.copy.availableMeta', { version, mb: Math.max(1, Math.round(size / 1_000_000)) }),
      /** The row's button: downloads the APK. */
      install: t('copy.copy.update.install'),
      /** The pop-up when a newer build is out, once per version (update-check.md). */
      newTitle: t('copy.copy.update.newTitle'),
      /** “Version 3.155.0 (37 MB) is ready. It takes a minute, and you stay signed in.” */
      newLead: (version: string, size: number) =>
        t('managed2.copy.newLead', { version, mb: Math.max(1, Math.round(size / 1_000_000)) }),
      later: t('copy.copy.update.later'),
      /** The app updates itself (AP-813): the button while the APK downloads into the app. */
      downloading: (percent: number) => t('copy.copy.update.downloading', { percent }),
      /** “0.44.0 · 34 of 96 MB” */
      downloadingMeta: (version: string, received: number, total: number) =>
        t('managed2.copy.downloadingMeta', {
          version,
          received: Math.round(received / 1_000_000),
          total: Math.max(1, Math.round(total / 1_000_000)),
        }),
      /** Android asks once whether Whombat may install apps (“Install unknown apps”). */
      allow: t('copy.copy.update.allow'),
      /** Where Android sent the person to allow installs: the setting, the app's page instead, or nowhere. */
      allowWhere: {
        setting: t('copy.copy.update.allowWhere.setting'),
        details: t('copy.copy.update.allowWhere.details'),
        none: t('copy.copy.update.allowWhere.none'),
      },
      /** Downloaded; Android's installer opens on it. */
      ready: t('copy.copy.update.ready'),
      readyMeta: (version: string) => t('copy.copy.update.readyMeta', { version }),
      retry: t('copy.copy.update.retry'),
      failed: {
        network: t('copy.copy.update.failed.network'),
        verify: t('copy.copy.update.failed.verify'),
        signature: t('copy.copy.update.failed.signature'),
        failed: t('copy.copy.update.failed.failed'),
      },
    },
    notifications: {
      label: t('copy.copy.notifications.label'),
      /** Under the settings sheet's Notifications group (SS-30): push on this phone. */
      onThisPhone: t('copy.copy.notifications.onThisPhone'),
      on: t('copy.copy.notifications.on'),
      onMeta: t('copy.copy.notifications.onMeta'),
      /** An iPhone allowed quietly (provisional): on, without a sound or a banner. */
      quietOn: t('copy.copy.notifications.quietOn'),
      quietMeta: t('copy.copy.notifications.quietMeta'),
      turnOnAlerts: t('copy.copy.notifications.turnOnAlerts'),
      /** Push on this phone, not turned on yet. */
      off: t('copy.copy.notifications.off'),
      offMeta: t('copy.copy.notifications.offMeta'),
      turnOn: t('copy.copy.notifications.turnOn'),
      denied: t('copy.copy.notifications.denied'),
      deniedMeta: t('copy.copy.notifications.deniedMeta'),
      openSettings: t('copy.copy.notifications.openSettings'),
      unavailable: t('copy.copy.notifications.unavailable'),
      unavailableMeta: t('copy.copy.notifications.unavailableMeta'),
      registering: t('copy.copy.notifications.registering'),
      failed: t('copy.copy.notifications.failed'),
      failedMeta: t('copy.copy.notifications.failedMeta'),
      lastReceived: (ago: string) => t('copy.copy.notifications.lastReceived', { ago }),
      /** Android lets some through and holds others back (pushView.ts). */
      partly: t('copy.copy.notifications.partly'),
      channelsOff: (names: string) => t('copy.copy.notifications.channelsOff', { names }),
      heldBack: t('copy.copy.notifications.heldBack'),
      restrictedMeta: t('copy.copy.notifications.restrictedMeta'),
      runsOff: (name: string) => t('copy.copy.notifications.runsOff', { name }),
      liveUpdatesOff: t('copy.copy.notifications.liveUpdatesOff'),
      batteryMeta: t('copy.copy.notifications.batteryMeta'),
      opening: t('copy.copy.notifications.opening'),
    },
    /** The parts' names are the shared `THIS_WHOMBAT_TEXT.parts` (this-whombat-sections-android.md AP-1252). */
    whombat: {
      title: t('copy.copy.whombat.title'),
      switch: t('copy.copy.whombat.switch'),
      signOut: t('copy.copy.whombat.signOut'),
    },
    /**
     * The BACKUP FILE section on This Whombat → Backups and the phone's own words on its screen (backup-file-android.md
     * AP-1211…; AP-1246); the panels' words are the contracts' (`BACKUP_COPY`) and the client's (`BACKUP_FILE_TEXT`).
     */
    backupFile: {
      title: t('copy.copy.backupFile.title'),
      meta: t('copy.copy.backupFile.meta'),
      open: t('copy.copy.backupFile.open'),
      openHint: t('copy.copy.backupFile.openHint'),
      /** A Backup file screen restored on a Whombat without `backup.file`. */
      /** The picked file's provider didn't say how big it is (it can't be staged). */
      noSize: t('copy.copy.backupFile.noSize'),
      /** “Save as” (or the folder) couldn't make the file. */
      saveFailed: t('copy.copy.backupFile.saveFailed'),
      /** Under a download or an upload while it runs: leaving the screen stops it. */
      stay: t('copy.copy.backupFile.stay'),
      leave: {
        downloadTitle: t('copy.copy.backupFile.leave.downloadTitle'),
        downloadText: t('copy.copy.backupFile.leave.downloadText'),
        uploadTitle: t('copy.copy.backupFile.leave.uploadTitle'),
        uploadText: t('copy.copy.backupFile.leave.uploadText'),
        stay: t('copy.copy.backupFile.leave.stay'),
        stop: t('copy.copy.backupFile.leave.stop'),
      },
    },
    /**
     * The phone's own words in REMOTE HELP on About (app remote-help.md AP-4476, AP-4477); the rest are the contracts'
     * (`REMOTE_HELP_WORDS`) and the client's (`REMOTE_HELP_TEXT`).
     */
    remoteHelp: {
      /** The command line's sheet shows the start of a long record; Share and Download give all of it. */
      cut: t('copy.copy.remoteHelp.cut'),
      share: t('copy.copy.remoteHelp.share'),
    },
  } as const;
}
export const COPY = managedCopy();

export function managedText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    ...sharedStatus(locale),
    thisBrowser: t('copy.managedText.thisBrowser'),
    addHelp: t('copy.managedText.addHelp'),
  } as const;
}
export const MANAGED_TEXT = managedText();
