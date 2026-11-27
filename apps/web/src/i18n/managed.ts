/**
 * The account site's and the box sign-in's words (`COPY` of `@whombat/client/managed`) in the page's language: same
 * shape, read from the web catalog when used (`liveWords`). The English is the package's own, copied verbatim. Lists
 * and words the package builds itself keep their English.
 */
import { COPY as COPY_EN } from '@whombat/client/managed';
import { liveWords } from './live';

/** The argument names of `COPY`'s template words, in order. */
const PARAMS: Readonly<Record<string, readonly string[]>> = {
  'copy.signIn.sent': ['email'],
  'copy.signIn.sentGated': ['email'],
  'copy.invite.continueAs': ['email'],
  'copy.invite.other': ['invited', 'current'],
  'copy.invite.stayAs': ['email'],
  'copy.org.codeKept': ['code'],
  'copy.org.onWeb': ['host'],
  'copy.waitlist.done': ['email'],
  'copy.billing.chooseSub': ['days'],
  'copy.billing.perWhombat': ['price'],
  'copy.billing.connectors': ['n'],
  'copy.billing.total': ['price'],
  'copy.billing.startTrial': ['days'],
  'copy.billing.whombatsOf': ['claimed', 'paid'],
  'copy.billing.trialEnds': ['day'],
  'copy.billing.renews': ['day'],
  'copy.billing.ends': ['day'],
  'copy.billing.addConfirm': ['n'],
  'copy.appliances.offline': ['ago'],
  'copy.appliances.forgetLabel': ['name'],
  'copy.appliances.renameLabel': ['name'],
  'copy.appliances.nameLabel': ['device'],
  'copy.appliances.gone.retired': ['name'],
  'copy.appliances.gone.missing': ['name'],
  'copy.claim.severalTitle': ['n'],
  'copy.claim.pickLabel': ['model', 'device'],
  'copy.claim.errors.claim_backoff': ['minutes'],
  'copy.claim.addNote': ['n'],
  'copy.recover.opened': ['name'],
  'copy.licence.notConfirmedSince': ['date'],
  'copy.licence.validUntil': ['date'],
  'copy.licence.keepWorking': ['date'],
  'copy.licence.usageOf': ['label', 'used', 'allowed'],
  'copy.licence.graceBanner': ['date'],
  'copy.licence.paymentBanner': ['date'],
  'copy.screen.errors.screen_backoff': ['min'],
  'copy.addLink.shareText': ['name'],
};

export const COPY: typeof COPY_EN = liveWords(COPY_EN, 'copy', PARAMS);
