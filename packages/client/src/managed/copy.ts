/**
 * Words of the managed journeys (not in the mocks; AP-22). Plain customer language: no “Noise”, “PeerId”,
 * “relay”, “ticket” or “endpoint key”. Identities are “fingerprints” shown as groups of five; the appliance is
 * “your Whombat”; a browser or phone is a “device”. Curly quotes and the middle dot as in the mocks.
 */
import { interpolate } from '@whombat/core/i18n';
import { versionRefusalCopy } from '@whombat/protocol/session';
import { clientTranslator, clientTree } from '../i18n/catalog';
import { MANAGED_COPY_WORDS } from '../i18n/messages/hostManaged/managedCopy';
import { claimStepKicker } from './claim-steps';

/** The managed journeys' words, in a locale (English when none is given). */
export function managedCopyText(locale?: string | null) {
  const w = clientTree(locale, MANAGED_COPY_WORDS);
  const refusal = versionRefusalCopy(locale);
  return {
    /**
     * “Look around without a Whombat” (docs/app/decisions/look-around.md): the first screen opens the demo world, which
     * says on every screen that it is a demo, with the way back.
     */
    lookAround: w.lookAround,
    signIn: {
      ...w.signIn,
      sent: (email: string) => interpolate(w.signIn.sent, { email }),
      /** Outside `open` signup mode control mails only accounts, invited addresses and code holders (BL-33). */
      inviteOnlySub: w.signIn.inviteOnlySub,
      sentGated: (email: string) => interpolate(w.signIn.sentGated, { email }),
      /** A sign-in link opened in the browser: it's used on a tap, not on opening (mail scanners open links too). */
      linkSub: w.signIn.linkSub,
    },
    /** An emailed invitation's link signs the invited address in. */
    invite: {
      ...w.invite,
      continueAs: (email: string) => interpolate(w.invite.continueAs, { email }),
      other: (invited: string, current: string) => interpolate(w.invite.other, { invited, current }),
      stayAs: (email: string) => interpolate(w.invite.stayAs, { email }),
    },
    org: {
      ...w.org,
      /** `/signup` signed out, with a code from the link (BL-22). */
      codeKept: (code: string) => interpolate(w.org.codeKept, { code }),
      /** Android (AP-130): organizations are set up on the web, where the terms, codes and plans are. */
      onWeb: (host: string) => interpolate(w.org.onWeb, { host }),
    },
    waitlist: { ...w.waitlist, done: (email: string) => interpolate(w.waitlist.done, { email }) },
    billing: {
      ...w.billing,
      chooseSub: (days: number) => interpolate(w.billing.chooseSub, { days }),
      perWhombat: (price: string) => interpolate(w.billing.perWhombat, { price }),
      connectors: (n: number) => interpolate(w.billing.connectors, { n }),
      total: (price: string) => interpolate(w.billing.total, { price }),
      startTrial: (days: number) => interpolate(w.billing.startTrial, { days }),
      whombatsOf: (claimed: number, paid: number) => interpolate(w.billing.whombatsOf, { claimed, paid }),
      trialEnds: (day: string) => interpolate(w.billing.trialEnds, { day }),
      renews: (day: string) => interpolate(w.billing.renews, { day }),
      ends: (day: string) => interpolate(w.billing.ends, { day }),
      addConfirm: (n: number) => interpolate(w.billing.addConfirm, { n }),
    },
    appliances: {
      ...w.appliances,
      offline: (ago: string) => interpolate(w.appliances.offline, { ago }),
      pendingRevocations: (n: number) => w.appliances.pendingRevocations(n),
      org: (name: string) => name,
      /** A retired Whombat this device remembers (AP-695): muted, never opened, forgotten at once. */
      retired: w.appliances.retired,
      forgetLabel: (name: string) => interpolate(w.appliances.forgetLabel, { name }),
      renameLabel: (name: string) => interpolate(w.appliances.renameLabel, { name }),
      nameLabel: (device: string) => interpolate(w.appliances.nameLabel, { device }),
      /** What the list says after leaving a Whombat that can't be opened any more (AP-694); `name` or “Your Whombat”. */
      gone: {
        retired: (name: string) => interpolate(w.appliances.gone.retired, { name }),
        missing: (name: string) => interpolate(w.appliances.gone.missing, { name }),
      },
    },
    claim: {
      kicker: claimStepKicker('claim', locale),
      ...w.claim,
      severalTitle: (n: number) => interpolate(w.claim.severalTitle, { n }),
      pickLabel: (model: string, device: string) => interpolate(w.claim.pickLabel, { model, device }),
      errors: {
        ...w.claim.errors,
        claim_backoff: (minutes: number) => interpolate(w.claim.errors.claim_backoff, { minutes }),
        devices_allowed: (n: number) => w.claim.errors.devices_allowed(n),
      },
      addNote: (n: number) => interpolate(w.claim.addNote, { n }),
    },
    /** Made from Settings · This Whombat, no longer a step of the claim (BX-01). */
    kit: w.kit,
    pair: w.pair,
    diagnostics: {
      ...w.diagnostics,
      scopeNames: w.diagnostics.scopeNames as Record<string, string>,
      downloads: (n: number) => (n === 0 ? w.diagnostics.notDownloaded : w.diagnostics.downloads(n)),
    },
    recover: { ...w.recover, opened: (name: string) => interpolate(w.recover.opened, { name }) },
    account: {
      ...w.account,
      deletedItems: [w.account.deletedItems.one, w.account.deletedItems.two, w.account.deletedItems.three],
      keptItems: [w.account.keptItems.one],
    },
    licence: {
      ...w.licence,
      notConfirmedSince: (date: string) => interpolate(w.licence.notConfirmedSince, { date }),
      plan: (plan: string) =>
        interpolate(w.licence.plan, {
          plan: `${plan.charAt(0).toUpperCase()}${plan.slice(1).replace(/-/g, ' ')}`,
        }),
      validUntil: (date: string) => interpolate(w.licence.validUntil, { date }),
      keepWorking: (date: string) => interpolate(w.licence.keepWorking, { date }),
      usageOf: (label: string, used: number, allowed: number) =>
        interpolate(w.licence.usageOf, { label, used, allowed }),
      graceBanner: (date: string) => interpolate(w.licence.graceBanner, { date }),
      paymentBanner: (date: string) => interpolate(w.licence.paymentBanner, { date }),
      limit: (n: number) => w.licence.limit(n),
    },
    identity: w.identity,
    setup: { ...w.setup, ways: [w.setup.ways.one, w.setup.ways.two] },
    /**
     * Signing in at the box's screen (Whombat signin-at-box.md BX-02…BX-08): on “Let this device in” and “Set up this
     * device”, the box shows six letters on its own screen for this device and the person types them here.
     */
    screen: {
      ...w.screen,
      errors: {
        ...w.screen.errors,
        screen_backoff: (min: number) => interpolate(w.screen.errors.screen_backoff, { min }),
      },
    },
    addLink: { ...w.addLink, shareText: (name: string) => interpolate(w.addLink.shareText, { name }) },
    connection: {
      reconnecting: w.connection.reconnecting,
      offline: w.connection.offline,
      applianceOffline: w.connection.applianceOffline,
      /** Control refuses it and the directory doesn't list it (`appliance_unlisted`, AP-693): never “offline”. */
      unlisted: w.connection.unlisted,
      busy: w.connection.busy,
      maintenance: w.connection.maintenance,
      retry: w.connection.retry,
      /** The box speaks another major (CT-1260): the contracts' words (`versionRefusalCopy`), one check (HE-52). */
      clientTooOldTitle: w.connection.clientTooOldTitle,
      clientTooOld: refusal.client,
      reload: w.connection.reload,
      belowFloorTitle: w.connection.belowFloorTitle,
      belowFloor: w.connection.belowFloor,
      applianceTooOldTitle: w.connection.applianceTooOldTitle,
      applianceTooOld: `${refusal.appliance} ${w.connection.updatesItself}`,
      mismatchTitle: w.connection.mismatchTitle,
      mismatch: w.connection.mismatch,
      revokedTitle: w.connection.revokedTitle,
      revoked: w.connection.revoked,
      revokedOthers: w.connection.revokedOthers,
      setUpAgain: w.connection.setUpAgain,
      settingUp: w.connection.settingUp,
      signedOutTitle: w.connection.signedOutTitle,
      signedOut: w.connection.signedOut,
      back: w.connection.back,
      signIn: w.connection.signIn,
      unsupported: w.connection.unsupported,
      weakKeyTitle: w.connection.weakKeyTitle,
      weakKey: w.connection.weakKey,
      weakKeyForget: w.connection.weakKeyForget,
    },
    push: w.push,
    commands: w.commands,
  } as const;
}

export type ManagedCopyText = ReturnType<typeof managedCopyText>;

/** The managed journeys' words in English. */
export const COPY: ManagedCopyText = managedCopyText('en');

/** “3 hours ago”, “2 days ago” from epoch seconds. */
export function agoText(epochS: number, now: number = Date.now(), locale?: string | null): string {
  const tr = clientTranslator(locale);
  const s = Math.max(0, Math.round(now / 1000 - epochS));
  if (s < 90) return tr.t('managed.ago.justNow');
  const m = Math.round(s / 60);
  if (m < 90) return tr.tp('managed.ago.minutes', m);
  const h = Math.round(m / 60);
  if (h < 36) return tr.tp('managed.ago.hours', h);
  const d = Math.round(h / 24);
  return tr.tp('managed.ago.days', d);
}
