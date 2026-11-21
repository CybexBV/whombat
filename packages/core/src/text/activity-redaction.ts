/** The credential policy for observed activity, shared by the runner and the server's tool reports. */
const REDACTED = '[redacted]';

/** Secret shapes replaced wherever they appear in activity evidence and objects. */
const SECRET_PATTERNS: [RegExp, string][] = [
  // Private key blocks (to their end, or to the end of the text when cut).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  // Authorization headers lose the whole value, whatever the scheme.
  [/\b(authorization\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n]+)/gi, `$1${REDACTED}`],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // Credentials in URLs: scheme://user:password@host, scheme://token@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+(?::[^\s/@'"]*)?@/gi, `$1${REDACTED}@`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abposre]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:wat|wt|ws|whk|ml)_[A-Za-z0-9_-]{32,}/g, REDACTED],
  // Named assignments include quoted values with spaces and short passwords.
  [
    /\b([A-Za-z0-9_.-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;}]+)/gi,
    `$1$2${REDACTED}`,
  ],
];

/** Replace activity credentials; callers retain their own whitespace and length limits. */
export function redactActivitySecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
