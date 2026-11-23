import { isOwnAddressLabel } from './label.js';

/**
 * Names a person may choose for their Whombat's own address (`<name>.whombat.app`; docs/decisions/own-address.md).
 * Control is the only one that enforces these rules; apps use them to say early what control would answer. Pure.
 */

/**
 * A name's shape: starts with a letter, ends with a letter or digit, lower-case letters, digits and single hyphens
 * between them (so never `xn--`), 3–32 characters. The same as `OWN_ADDRESS_LABEL_RE` in `@whombat/protocol` (a
 * conformance test checks), which core can't import.
 */
export const OWN_ADDRESS_NAME_RE = /^[a-z](-?[a-z0-9])+$/;
export const OWN_ADDRESS_NAME_MIN = 3;
export const OWN_ADDRESS_NAME_MAX = 32;

/**
 * Names nobody gets: the service's own hosts and words, names that would pass for Whombat's own or for a sign-in page,
 * and names devices look up by themselves. Control keeps a list of its own besides this one, which its operators add to
 * without a release.
 */
export const OWN_ADDRESS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'box',
  'dev',
  'www',
  'mail',
  'email',
  'api',
  'app',
  'apps',
  'admin',
  'root',
  'account',
  'accounts',
  'login',
  'signin',
  'signup',
  'auth',
  'id',
  'link',
  'links',
  'relay',
  'door',
  'control',
  'cdn',
  'static',
  'assets',
  'download',
  'downloads',
  'release',
  'releases',
  'update',
  'updates',
  'status',
  'health',
  'docs',
  'doc',
  'help',
  'support',
  'security',
  'abuse',
  'postmaster',
  'hostmaster',
  'webmaster',
  'billing',
  'pay',
  'payment',
  'shop',
  'store',
  'blog',
  'news',
  'ns',
  'ns1',
  'ns2',
  'ns3',
  'mx',
  'smtp',
  'imap',
  'pop',
  'ftp',
  'vpn',
  'git',
  'ci',
  'test',
  'demo',
  'staging',
  'beta',
  'prod',
  'production',
  'internal',
  'localhost',
  'whombat',
  'whombats',
  'cybex',
  'wombat',
  'dusty',
  'hazel',
  // Names that pass for a service's sign-in or payment page.
  'portal',
  'dashboard',
  'console',
  'cloud',
  'my',
  'secure',
  'verify',
  'verification',
  'password',
  'passwords',
  'passkey',
  'passkeys',
  'wallet',
  'bank',
  'banking',
  'invoice',
  'invoices',
  'official',
  'team',
  'staff',
  'info',
  'contact',
  'sales',
  'legal',
  'privacy',
  'terms',
  'careers',
  'jobs',
  'press',
  'community',
  'forum',
  'developer',
  'developers',
  'sso',
  'oauth',
  'webmail',
  // Names devices and mail programs look up by themselves under a domain.
  'autodiscover',
  'autoconfig',
  'wpad',
  'isatap',
  'mta-sts',
  'openpgpkey',
  'lyncdiscover',
  'sip',
  'enterpriseenrollment',
  'enterpriseregistration',
]);

/**
 * Names starting with these pass for Whombat's own (`whombat-home`, `cybexhq`) or for a well-known company's
 * (`paypallogin`): only names unusual enough that no ordinary word starts with them.
 */
export const OWN_ADDRESS_RESERVED_PREFIXES: readonly string[] = [
  'whombat',
  'cybex',
  'paypal',
  'google',
  'gmail',
  'microsoft',
  'hotmail',
  'icloud',
  'appleid',
  'facebook',
  'instagram',
  'whatsapp',
  'netflix',
  'linkedin',
  'docusign',
  'dropbox',
  'github',
  'gitlab',
  'coinbase',
  'binance',
  'metamask',
  'openai',
  'chatgpt',
  'anthropic',
  'cloudflare',
  'letsencrypt',
  'rabobank',
  'abnamro',
  'belastingdienst',
  'digid',
  'postnl',
];

/**
 * Names of companies whose pages people are tricked with: a name is refused when it is one or has one as a hyphen-part
 * (`apple-support`, `my-paypal`), like a rude word, so nobody gets a page that passes for theirs with a real certificate
 * under our domain. A drawn label is never refused for one (`apple` is a drawn word).
 */
export const OWN_ADDRESS_LOOKALIKE_WORDS: ReadonlySet<string> = new Set([
  'apple',
  'itunes',
  'google',
  'gmail',
  'youtube',
  'android',
  'microsoft',
  'outlook',
  'hotmail',
  'office365',
  'xbox',
  'azure',
  'amazon',
  'aws',
  'paypal',
  'stripe',
  'visa',
  'mastercard',
  'amex',
  'facebook',
  'instagram',
  'whatsapp',
  'netflix',
  'spotify',
  'github',
  'gitlab',
  'dropbox',
  'adobe',
  'docusign',
  'linkedin',
  'twitter',
  'tiktok',
  'snapchat',
  'telegram',
  'coinbase',
  'binance',
  'metamask',
  'trezor',
  'discord',
  'openai',
  'chatgpt',
  'anthropic',
  'claude',
  'cloudflare',
  'letsencrypt',
  'hetzner',
  'ebay',
  'airbnb',
  'uber',
  'yahoo',
  'protonmail',
  'mollie',
  'adyen',
  'klarna',
  'revolut',
  'bitcoin',
  'ethereum',
  'playstation',
  'nintendo',
  'roblox',
  // Dutch banks, government and post.
  'ing',
  'rabobank',
  'abnamro',
  'bunq',
  'knab',
  'triodos',
  'digid',
  'belastingdienst',
  'postnl',
  'dhl',
]);

/**
 * A short list of rude words, English and Dutch, kept plain on purpose: a name is refused when it is one, when one of
 * its hyphen-parts is one, or when it is one with hyphens in it. Never a part of a word (“class”, “scrap”), so no
 * ordinary name is caught.
 */
export const OWN_ADDRESS_RUDE_WORDS: ReadonlySet<string> = new Set([
  'arsehole',
  'asshole',
  'bastard',
  'bitch',
  'bullshit',
  'cum',
  'cunt',
  'dildo',
  'fag',
  'faggot',
  'fuck',
  'fucker',
  'fucking',
  'fuckyou',
  'hitler',
  'jizz',
  'kkk',
  'motherfucker',
  'nazi',
  'nigga',
  'nigger',
  'penis',
  'porn',
  'porno',
  'pussy',
  'rape',
  'rapist',
  'retard',
  'shit',
  'slut',
  'twat',
  'vagina',
  'wanker',
  'whore',
  // Dutch.
  'hoer',
  'kanker',
  'klootzak',
  'kut',
  'lul',
  'mongool',
  'neuken',
  'tering',
]);

/** What is wrong with a name: `invalid` (not the shape), `reserved` (nobody gets it), or null (it may be given). */
export type OwnAddressNameProblem = 'invalid' | 'reserved';

/** Whether `name` has a name's shape and length (lower case only: lower-case and trim what a person typed first). */
export function isOwnAddressNameShape(name: string): boolean {
  return (
    name.length >= OWN_ADDRESS_NAME_MIN &&
    name.length <= OWN_ADDRESS_NAME_MAX &&
    OWN_ADDRESS_NAME_RE.test(name)
  );
}

/**
 * Why `name` can't be a Whombat's address, or null when it can (whether another box has it is control's to say). Every
 * three-word label `drawOwnAddressLabel` gives answers null.
 */
export function ownAddressNameProblem(name: string): OwnAddressNameProblem | null {
  if (!isOwnAddressNameShape(name)) return 'invalid';
  if (OWN_ADDRESS_RESERVED_NAMES.has(name)) return 'reserved';
  if (OWN_ADDRESS_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'reserved';
  if (OWN_ADDRESS_RUDE_WORDS.has(name.replaceAll('-', ''))) return 'reserved';
  const parts = name.split('-');
  if (parts.some((part) => OWN_ADDRESS_RUDE_WORDS.has(part))) return 'reserved';
  if (parts.some((part) => OWN_ADDRESS_LOOKALIKE_WORDS.has(part)) && !isOwnAddressLabel(name))
    return 'reserved';
  return null;
}
