/**
 * Literal secrets (docs/decisions/bp-packs.md; since 0.113 `skills/`, CT-804): values that look like credentials — known
 * token prefixes, private keys, JWTs, or long high-entropy strings — found (`literalSecretKind`) and redacted where
 * someone's text is shown (`redactSecrets`): a turn's failure detail (`turnFailureDetail`) and the text a finding of
 * Hermes's scan quotes (`ScanFinding.match`, CT-1407). `${secret:NAME}` placeholders hold no secret and are left alone.
 * Kept when Whombat's skill imports went (2.0, CT-1403): the redaction serves both.
 */

/** Well-known credential shapes (prefix-anchored so ordinary words do not match). */
const TOKEN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'a GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: 'an Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'an OpenAI-style key', re: /\bsk-(proj-|live-|test-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'a Stripe key', re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'a Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'an AWS access key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'a Google OAuth token', re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { name: 'a GitLab token', re: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  { name: 'an npm token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { name: 'a PyPI token', re: /\bpypi-[A-Za-z0-9_-]{30,}/ },
  { name: 'a Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: 'a SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: 'a webhook secret', re: /\bwhsec_[A-Za-z0-9]{16,}/ },
  { name: 'a private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // A scheme starts at a word boundary and is short (0.92, CT-421): unanchored and unbounded, a 130 KB run without spaces
  // took seconds.
  { name: 'a password in a URL', re: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^/\s:@]+:[^/\s@]+@/i },
];

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A long token-like run (≥ 24 characters of letters, digits and `+=_-`; slashes split paths) with high entropy and mixed character
 * classes: random keys, not words, paths or version strings.
 */
function highEntropyRun(value: string): string | null {
  for (const m of value.matchAll(/[A-Za-z0-9+=_-]{24,}/g)) {
    const run = m[0];
    const classes = Number(/[a-z]/.test(run)) + Number(/[A-Z]/.test(run)) + Number(/[0-9]/.test(run));
    if (classes >= 3 && entropy(run) >= 4.0) return run;
  }
  return null;
}

/** What a value looks like when it looks like a credential (“a GitHub token”), else null. */
export function literalSecretKind(value: string, options: { entropy?: boolean } = {}): string | null {
  // Placeholders are how secrets are meant to appear.
  const text = value.replace(/\$\{secret:[A-Za-z0-9_]+\}/g, '');
  for (const { name, re } of TOKEN_PATTERNS) if (re.test(text)) return name;
  if (options.entropy !== false && highEntropyRun(text)) return 'a random-looking key';
  return null;
}

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/** A value after `KEY=`, `token:`, `"password": …` (names that say they hold a secret). */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS|CREDENTIALS?|COOKIE)[A-Za-z0-9_]*)(['"]?\s*[:=]\s*)(['"]?)([^\s'"$`{}<>]{4,})/gi;
/** `Authorization: Bearer …`, `-u user:password`. */
const AUTH_VALUE = /\b(Bearer|Basic|Token)(\s+)(?!\$|\[redacted\])([A-Za-z0-9._~+/=-]{8,})/g;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi;
/** `curl -u user:password`, `--user user:password`. */
const USER_PASSWORD = /((?:^|\s)(?:-u|--user)\s+['"]?[^\s:'"]+:)(?!\$)([^\s'"]+)/g;
/** Long hex runs (keys, digests): not secret-shaped by entropy, but may be one. */
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g;

/**
 * Text with anything that looks like a credential replaced by `[redacted]`: the shapes `literalSecretKind` knows,
 * random-looking runs, long hex runs, values assigned to names like `API_KEY` or `password`, `Bearer …` values and
 * passwords in URLs. `${secret:NAME}` placeholders and `$VARIABLE` references stay (they hold no secret). For showing
 * a line of someone's text (a scan finding's excerpt) without echoing a secret it holds.
 */
export function redactSecrets(text: string): string {
  // Placeholders hold no secret: set them aside so no rule below touches them.
  const placeholders: string[] = [];
  let out = text.replace(/\$\{secret:[A-Za-z0-9_]+\}/g, (p) => `\uE000${placeholders.push(p) - 1}\uE001`);
  for (const { re } of TOKEN_PATTERNS) {
    if (re.source.includes(':\\/\\/')) continue;
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), REDACTED);
  }
  out = out.replace(URL_PASSWORD, (_, a: string, _p: string, b: string) => `${a}${REDACTED}${b}`);
  out = out.replace(USER_PASSWORD, (_, a: string) => `${a}${REDACTED}`);
  out = out.replace(AUTH_VALUE, (_, kind: string, space: string) => `${kind}${space}${REDACTED}`);
  out = out.replace(
    SECRET_ASSIGNMENT,
    (_, name: string, sep: string, quote: string) => `${name}${sep}${quote}${REDACTED}`,
  );
  out = out.replace(/[A-Za-z0-9+=_-]{24,}/g, (run) => {
    if (run.includes(REDACTED)) return run;
    const classes = Number(/[a-z]/.test(run)) + Number(/[A-Z]/.test(run)) + Number(/[0-9]/.test(run));
    return classes >= 3 && entropy(run) >= 4.0 ? REDACTED : run;
  });
  return out
    .replace(HEX_RUN, REDACTED)
    .replace(/\uE000(\d+)\uE001/g, (_, i: string) => placeholders[Number(i)] ?? '');
}
