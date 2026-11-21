/**
 * The guided sign-in's reading of Claude Code's own output (AP-62, SUB-03): the sign-in link it prints, whether it said
 * the login failed, and whether it asked for the code again. Pure string work — the web keeps the terminal and this
 * side by side, and nothing here is logged or stored.
 *
 * Claude Code 2.1.283 prints, in its PTY:
 *
 *     Opening browser to sign in…
 *     If the browser didn't open, visit: ESC]8;;<url>BEL ESC[94m<url>ESC[39m ESC]8;;BEL
 *     Paste code here if prompted >
 *
 * and after a refused code `Login failed: Request failed with status code 400`, then exits non-zero.
 */

/** Hosts a Claude sign-in link may point to (anything else gets no button; its output stays visible). */
export const CLAUDE_SIGNIN_HOSTS: readonly string[] = [
  'claude.ai',
  'claude.com',
  'platform.claude.com',
  'console.anthropic.com',
];

/** Hosts (and their subdomains) ChatGPT's device-code page (OpenAI's, provider `codex`) may be on. */
export const CODEX_SIGNIN_DOMAINS: readonly string[] = ['openai.com', 'chatgpt.com'];

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** `raw` when it is an `https:` link on one of Claude's sign-in hosts, else null. */
export function claudeSignInUrl(raw: string): string | null {
  const url = httpsUrl(raw.trim());
  return url && CLAUDE_SIGNIN_HOSTS.includes(url.hostname) ? url.href : null;
}

/** `raw` when it is an `https:` link on openai.com or chatgpt.com (or a subdomain), else null. */
export function codexSignInUrl(raw: string): string | null {
  const url = httpsUrl(raw.trim());
  if (!url) return null;
  const host = url.hostname;
  return CODEX_SIGNIN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ? url.href : null;
}

// OSC 8 hyperlink: ESC ] 8 ; params ; URI (BEL | ESC \).
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are control characters.
const OSC8 = /\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
// Any OSC (ended by BEL or ST), CSI, or a two-character escape.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are control characters.
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/** The text without terminal escapes (colors, hyperlinks, cursor moves). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** The first `https:` hyperlink target (OSC 8) in the output, whatever its host. */
function osc8Target(output: string): string | null {
  for (const m of output.matchAll(OSC8)) {
    const target = m[1]?.trim();
    if (target) return target;
  }
  return null;
}

/**
 * The link after “visit:” in the text (escapes stripped). A link the terminal (or the CLI) wrapped over several lines
 * is joined: lines that are nothing but link characters continue it. Only a link whose line has ended counts — output
 * arrives in pieces, and half a link isn't one.
 */
function visitTarget(output: string): string | null {
  const text = stripAnsi(output);
  const at = text.search(/visit:/i);
  if (at < 0) return null;
  const after = text.slice(at + 'visit:'.length).replace(/^\s+/, '');
  const lines = after.split(/\r\n|\r|\n/);
  // The last element is the line still being written.
  const complete = lines.slice(0, -1);
  const first = complete[0]?.trim();
  if (!first || !/^https:\/\/\S+$/.test(first)) return null;
  let url = first;
  for (const line of complete.slice(1)) {
    const part = line.trim();
    if (!part || /\s/.test(part) || !/^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(part)) break;
    url += part;
  }
  return url;
}

export interface SignInOutput {
  /** The sign-in link Claude Code printed, when it's one of Claude's hosts. */
  url: string | null;
  /** Claude Code printed a link, but not to a host Whombat offers as a button. */
  foreignUrl: boolean;
  /** Claude Code said the login failed (a refused or expired code). */
  loginFailed: boolean;
  /** How many times it asked for the code (“Paste code here if prompted”). */
  prompts: number;
}

/** What the guided sign-in needs from Claude Code's output so far. */
export function readSignInOutput(output: string): SignInOutput {
  const raw = osc8Target(output) ?? visitTarget(output);
  const url = raw ? claudeSignInUrl(raw) : null;
  const text = stripAnsi(output);
  return {
    url,
    foreignUrl: raw != null && url == null,
    loginFailed: /Login failed/i.test(text),
    prompts: text.match(/Paste code here/gi)?.length ?? 0,
  };
}

/** How much of the output the watcher keeps to read from (the link is well under this). */
export const SIGNIN_OUTPUT_KEEP = 32 * 1024;

/**
 * Reads Claude Code's output as it arrives (UTF-8 bytes in pieces). Keeps the start of the output (where the link is)
 * and a bounded tail (where “Login failed” and new prompts appear), in memory only.
 */
export function createSignInOutputWatcher() {
  const decoder = new TextDecoder();
  let head = '';
  let tail = '';
  let seen = '';
  return {
    push(bytes: Uint8Array): SignInOutput {
      const text = decoder.decode(bytes, { stream: true });
      if (head.length < SIGNIN_OUTPUT_KEEP) head += text;
      else tail = (tail + text).slice(-SIGNIN_OUTPUT_KEEP);
      seen = tail ? `${head}\n${tail}` : head;
      return readSignInOutput(seen);
    },
  };
}

/**
 * Whether clipboard text looks like a sign-in code (no whitespace inside, 20–512 characters): enough to offer it in the
 * field, never to send it. Claude's codes look like `<base64url>#<base64url>`.
 */
export function isCodeShaped(text: string): boolean {
  return /^\S{20,512}$/.test(text.trim());
}

/** The host of a sign-in link, for its button (“Open auth.openai.com”). */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
