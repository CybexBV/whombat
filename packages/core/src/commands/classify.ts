/**
 * The guard's reading of a shell command (Whombat agent-computer.md AC-40, contracts 0.36.0, CT-218): which
 * consequential thing it does, if any. Pure and synchronous, so the runner's command wrapper runs it on every command of a
 * turn (OP-07), the server can check what the runner sent, and tests pin it down.
 *
 * It reads the command the way a shell would, without running anything: a small tokenizer (single and double quotes,
 * `$'…'`, backslash escapes, comments, redirections, here-documents) splits it into simple commands at `&&`, `||`, `;`,
 * `|`, `&`, newlines and parentheses, and command substitutions (`$(…)`, backticks) are read as commands of their own.
 * Each simple command is looked through: assignments (`VAR=…`), `sudo`/`doas` and their options, `env`, `nohup`,
 * `time`, `timeout N`, `nice`, `exec`, `command`, `xargs`, `watch`, `stdbuf`, package runners (`npx`, `pnpm dlx|exec`,
 * `yarn dlx|exec`, `npm exec`, `bunx`), shells with `-c '…'` (and `-s` or a here-document), and `ssh [options]
 * [user@]host 'remote command'`, whose remote command is read as running on that host. Nesting is followed up to
 * `CLASSIFY_MAX_DEPTH` levels (one `bash -c` inside an ssh command inside `$(…)` …).
 *
 * The guard is a convenience in front of the real wall: production servers are closed at the network (AC-11) whatever a
 * command looks like. So it errs towards asking, never throws, and a command it can't read (an unterminated quote)
 * is read as far as it goes.
 */
import { type CommandCategory, moreSevereCategory } from './commands.js';

/** A Vault SSH server marked Production (AC-11), as the guard matches it: by name (the ssh_config alias), host or address. */
export interface ClassifyProductionServer {
  name: string;
  host: string;
  /** The addresses the host resolved to when the turn started. */
  addresses?: readonly string[];
}

export interface ClassifyContext {
  productionServers: readonly ClassifyProductionServer[];
  /** The branches `git push` must not reach without a key (default `DEFAULT_BRANCHES`). */
  defaultBranches?: readonly string[];
  /**
   * The turn's `gh` goes through Whombat (Whombat agent-gh.md AGH-11, contracts 0.41.0): Whombat decides each `gh`
   * command by the agent's keys itself (a `gh pr merge` by “Merge into main”), so the guard leaves `gh` alone rather
   * than asking twice. False or absent: `gh pr merge` and `gh api … pulls/N/merge` are merges.
   */
  ghThroughWhombat?: boolean;
  /**
   * The machine the command runs on when it isn't the person's Whombat (0.100.1, CT-535): a Servers
   * `server_command` runs on that server. The command is then read as `ssh <runsOn> '<command>'` would be — reaching a
   * production server when `runsOn` names one, and its destructive commands count. Absent, null or blank: the
   * person's Whombat, where destructive commands are not asked about (AC-40).
   */
  runsOn?: string | null;
}

/** What `classifyCommand` found: the category, what it is aimed at, and one line a person reads on the card. */
export interface CommandClassification {
  category: CommandCategory;
  /**
   * What the command reaches: the production server's name (`deploy_production`), the branch (`push_main`), the
   * repository (`merge`, when named), the other machine (`destructive`), the webhook host or the address
   * (`message_external`); null when the words don't say.
   */
  target: string | null;
  /** “SSH to the production server web-1”, “Push to main”, “Deploy with fly”. */
  summary: string;
}

/** The default branches when the context names none. */
export const DEFAULT_BRANCHES: readonly string[] = ['main', 'master'];

/** How deep `$(…)`, `bash -c` and ssh remote commands are followed. */
export const CLASSIFY_MAX_DEPTH = 4;

/* Tokenizer --------------------------------------------------------------------------------------------------- */

type Token =
  | { kind: 'word'; value: string }
  | { kind: 'op'; value: string }
  /**
   * A redirection; the next word is its target (dropped from the words; a file a truncating one writes over is kept,
   * CT-535). `op`: `>`, `>>`, `>|`, `>&`, `&>`, `&>>`, `<`, `<<`, `<<-`, `<<<`, `<>`, `<&`.
   */
  | { kind: 'redir'; op: string; heredoc: boolean; herestring: boolean };

interface Lexed {
  tokens: Token[];
  /** Bodies of command substitutions, read as commands of their own. */
  nested: string[];
  /** Here-document bodies, in the order of their `<<` redirections. */
  heredocs: string[];
}

const BLANK = new Set([' ', '\t', '\r']);

/** The index just past the `)` closing a `(` at `open`, skipping quoted text; `text.length + 1` when unbalanced. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end === -1 ? text.length : end;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  // Unbalanced: everything after the `(` is its body (`end - 1` is then the text's end).
  return text.length + 1;
}

/** The index of the unescaped backtick closing one at `open`, or -1. */
function closeBacktick(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') return i;
  }
  return -1;
}

const ANSI_C: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
  e: '\x1b',
};

function lex(text: string): Lexed {
  const tokens: Token[] = [];
  const nested: string[] = [];
  const heredocs: string[] = [];
  /** Delimiters of here-documents opened on the current line: `{word, strip}` (`<<-` strips leading tabs). */
  const pendingHeredocs: { delimiter: string; strip: boolean }[] = [];
  let expectHeredocDelimiter: boolean | null = null; // the strip flag while the next word is a delimiter
  let word = '';
  let inWord = false;
  let i = 0;

  const endWord = () => {
    if (!inWord) return;
    if (expectHeredocDelimiter !== null) {
      pendingHeredocs.push({ delimiter: word, strip: expectHeredocDelimiter });
      expectHeredocDelimiter = null;
    }
    tokens.push({ kind: 'word', value: word });
    word = '';
    inWord = false;
  };

  const readHeredocBodies = () => {
    // `i` is just past a newline: each pending here-document takes the lines up to its delimiter.
    for (const doc of pendingHeredocs) {
      const lines: string[] = [];
      while (i < text.length) {
        const nl = text.indexOf('\n', i);
        const line = text.slice(i, nl === -1 ? text.length : nl);
        i = nl === -1 ? text.length : nl + 1;
        const cmp = doc.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === doc.delimiter) break;
        lines.push(line);
      }
      heredocs.push(lines.join('\n'));
    }
    pendingHeredocs.length = 0;
  };

  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (BLANK.has(c)) {
      endWord();
      i++;
    } else if (c === '\n') {
      endWord();
      tokens.push({ kind: 'op', value: ';' });
      i++;
      if (pendingHeredocs.length > 0) readHeredocBodies();
    } else if (c === '#' && !inWord) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else if (c === '\\') {
      if (next === '\n') {
        i += 2;
      } else {
        word += next ?? '\\';
        inWord = true;
        i += 2;
      }
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end === -1 ? text.length : end);
      inWord = true;
      i = end === -1 ? text.length : end + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < text.length && text[i] !== '"') {
        const d = text[i] as string;
        if (d === '\\' && i + 1 < text.length) {
          const e = text[i + 1] as string;
          if (e === '\n') {
            // A line continuation inside double quotes disappears.
          } else if ('$`"\\'.includes(e)) {
            word += e;
          } else {
            word += `\\${e}`;
          }
          i += 2;
        } else if (d === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
          const end = closeParen(text, i + 1);
          nested.push(text.slice(i + 2, Math.max(i + 2, end - 1)));
          word += text.slice(i, end);
          i = Math.min(end, text.length);
        } else if (d === '`') {
          const end = closeBacktick(text, i);
          const stop = end === -1 ? text.length : end;
          nested.push(text.slice(i + 1, stop));
          word += text.slice(i, Math.min(text.length, stop + 1));
          i = stop + 1;
        } else {
          word += d;
          i++;
        }
      }
      i++;
    } else if (c === '$' && next === "'") {
      inWord = true;
      i += 2;
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\' && i + 1 < text.length) {
          const e = text[i + 1] as string;
          word += ANSI_C[e] ?? `\\${e}`;
          i += 2;
        } else {
          word += text[i];
          i++;
        }
      }
      i++;
    } else if (c === '$' && next === '(') {
      const end = closeParen(text, i + 1);
      // `$((…))` is arithmetic, not a command.
      if (text[i + 2] !== '(') nested.push(text.slice(i + 2, Math.max(i + 2, end - 1)));
      word += text.slice(i, end);
      inWord = true;
      i = Math.min(end, text.length);
    } else if (c === '$' && next === '{') {
      const end = text.indexOf('}', i);
      const stop = end === -1 ? text.length : end + 1;
      word += text.slice(i, stop);
      inWord = true;
      i = stop;
    } else if (c === '`') {
      const end = closeBacktick(text, i);
      const stop = end === -1 ? text.length : end;
      nested.push(text.slice(i + 1, stop));
      word += text.slice(i, Math.min(text.length, stop + 1));
      inWord = true;
      i = stop + 1;
    } else if (c === '>' || c === '<') {
      // A word of digits right before is the file descriptor (`2>`), not an argument.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      let op: string = c;
      if (c === '<') {
        if (next === '<') op = text[i + 2] === '<' ? '<<<' : text[i + 2] === '-' ? '<<-' : '<<';
        else if (next === '>' || next === '&') op = `<${next}`;
      } else if (next === '>' || next === '|' || next === '&') {
        op = `>${next}`;
      }
      i += op.length;
      const heredoc = op === '<<' || op === '<<-';
      tokens.push({ kind: 'redir', op, heredoc, herestring: op === '<<<' });
      if (heredoc) expectHeredocDelimiter = op === '<<-';
    } else if (c === '&') {
      endWord();
      if (next === '&') {
        tokens.push({ kind: 'op', value: '&&' });
        i += 2;
      } else if (next === '>') {
        const op = text[i + 2] === '>' ? '&>>' : '&>';
        tokens.push({ kind: 'redir', op, heredoc: false, herestring: false });
        i += op.length;
      } else {
        tokens.push({ kind: 'op', value: '&' });
        i++;
      }
    } else if (c === '|') {
      endWord();
      tokens.push({ kind: 'op', value: next === '|' ? '||' : '|' });
      i += next === '|' || next === '&' ? 2 : 1;
    } else if (c === ';') {
      endWord();
      tokens.push({ kind: 'op', value: ';' });
      i += next === ';' ? 2 : 1;
    } else if (c === '(' || c === ')') {
      endWord();
      tokens.push({ kind: 'op', value: c });
      i++;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endWord();
  if (pendingHeredocs.length > 0) {
    // A here-document on the last line has no body in this text.
    for (const _ of pendingHeredocs) heredocs.push('');
  }
  return { tokens, nested, heredocs };
}

/** A simple command: its words (redirections dropped) and what it reads on stdin from here-documents and strings. */
interface SimpleCommand {
  words: string[];
  stdin: string[];
  /** Files its truncating redirections write over (`TRUNCATING`, not `HARMLESS_TARGET`). */
  writes: string[];
}

/** Redirections that empty their target first: `>`, `>|`, `>&` with a file, `&>` (not `>>`, `&>>`, `<>`). */
const TRUNCATING = new Set(['>', '>|', '>&', '&>']);
/** Targets a write leaves nothing behind in: the bit bucket and the standard streams. */
const HARMLESS_TARGET = /^\/dev\/(null|zero|stdout|stderr|tty|fd\/\d+)$/;
/** A `>&` target that is a file descriptor (`2>&1`, `>&2`, `>&-`), not a file. */
const FD_TARGET = /^(\d+-?|-)$/;

const LEADING_KEYWORDS = new Set([
  '!',
  '{',
  '}',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  'done',
  'fi',
  'esac',
]);
const SKIPPED_KEYWORDS = new Set(['for', 'case', 'select', 'function', 'in']);

function simpleCommands(lexed: Lexed): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], stdin: [], writes: [] };
  let dropNext: 'drop' | 'stdin' | 'write' | null = null;
  let writeOp = '';
  let heredocIndex = 0;
  const flush = () => {
    let words = current.words;
    while (words.length > 0 && LEADING_KEYWORDS.has(words[0] as string)) words = words.slice(1);
    while (words.length > 0 && (words[words.length - 1] === '}' || words[words.length - 1] === 'done'))
      words = words.slice(0, -1);
    const skipped =
      words.length > 0 && (SKIPPED_KEYWORDS.has(words[0] as string) || /\)$/.test(words[0] as string));
    if (words.length > 0 && !skipped) out.push({ words, stdin: current.stdin, writes: current.writes });
    else if (current.writes.length > 0) out.push({ words: [], stdin: current.stdin, writes: current.writes });
    current = { words: [], stdin: [], writes: [] };
  };
  for (const token of lexed.tokens) {
    if (token.kind === 'op') {
      flush();
      dropNext = null;
    } else if (token.kind === 'redir') {
      if (token.heredoc) {
        current.stdin.push(lexed.heredocs[heredocIndex] ?? '');
        heredocIndex++;
      }
      dropNext = token.herestring ? 'stdin' : TRUNCATING.has(token.op) ? 'write' : 'drop';
      writeOp = token.op;
    } else if (dropNext) {
      if (dropNext === 'stdin') current.stdin.push(token.value);
      else if (
        dropNext === 'write' &&
        !HARMLESS_TARGET.test(token.value) &&
        !(writeOp === '>&' && FD_TARGET.test(token.value))
      )
        current.writes.push(token.value);
      dropNext = null;
    } else {
      current.words.push(token.value);
    }
  }
  flush();
  return out;
}

/* Reading words ------------------------------------------------------------------------------------------------ */

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `/usr/bin/ssh` → `ssh`; `wrangler@3` → `wrangler`; `@cloudflare/wrangler@3.1` → `wrangler`. */
function toolName(word: string): string {
  let name = word;
  if (name.startsWith('@') && name.includes('/')) name = name.slice(name.indexOf('/') + 1);
  name = name.slice(name.lastIndexOf('/') + 1);
  const at = name.indexOf('@');
  if (at > 0) name = name.slice(0, at);
  return name;
}

interface OptionSpec {
  /** Short option letters that take a value (`-p 22`, `-p22`). */
  short?: string;
  /** Long options that take a value as the next word when written without `=`. */
  long?: readonly string[];
  /** Stop at the first operand (getopt without permutation). Default true. */
  stopAtOperand?: boolean;
}

interface ParsedOptions {
  /** Every option seen, with its value (null for a flag): `-p` → '22', `--prod` → null. */
  options: { name: string; value: string | null }[];
  operands: string[];
}

/** Options and operands of a command's arguments (after its name). `--` ends the options. */
function parseOptions(args: readonly string[], spec: OptionSpec = {}): ParsedOptions {
  const short = spec.short ?? '';
  const long = new Set(spec.long ?? []);
  const stop = spec.stopAtOperand ?? true;
  const options: ParsedOptions['options'] = [];
  const operands: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) options.push({ name: a.slice(0, eq), value: a.slice(eq + 1) });
      else if (long.has(a)) {
        options.push({ name: a, value: args[i + 1] ?? null });
        i++;
      } else options.push({ name: a, value: null });
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const letter = a[j] as string;
        if (short.includes(letter)) {
          const rest = a.slice(j + 1);
          if (rest) options.push({ name: `-${letter}`, value: rest });
          else {
            options.push({ name: `-${letter}`, value: args[i + 1] ?? null });
            i++;
          }
          break;
        }
        options.push({ name: `-${letter}`, value: null });
      }
    } else {
      operands.push(a);
      if (stop) {
        i++;
        break;
      }
    }
  }
  operands.push(...args.slice(i));
  return { options, operands };
}

function hasOption(parsed: ParsedOptions, ...names: string[]): boolean {
  return parsed.options.some((o) => names.includes(o.name));
}

function optionValue(parsed: ParsedOptions, ...names: string[]): string | null {
  for (let k = parsed.options.length - 1; k >= 0; k--) {
    const o = parsed.options[k] as ParsedOptions['options'][number];
    if (names.includes(o.name) && o.value !== null) return o.value;
  }
  return null;
}

/** The index of the first word that isn't an option of `spec` (for wrappers: `sudo -u x cmd` → 2). */
function firstOperandIndex(args: readonly string[], spec: OptionSpec): number {
  const short = spec.short ?? '';
  const long = new Set(spec.long ?? []);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') return i + 1;
    if (a.startsWith('--')) {
      if (!a.includes('=') && long.has(a)) i++;
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        if (short.includes(a[j] as string)) {
          if (j === a.length - 1) i++;
          break;
        }
      }
    } else {
      return i;
    }
  }
  return args.length;
}

/* Hosts -------------------------------------------------------------------------------------------------------- */

/** `deploy@Web1.example.com.` → `web1.example.com`; `[2001:db8::1]` → `2001:db8::1`. */
function bareHost(host: string): string {
  let h = host.trim();
  const at = h.lastIndexOf('@');
  if (at !== -1) h = h.slice(at + 1);
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']') === -1 ? undefined : h.indexOf(']'));
  return h.replace(/\.$/, '').toLowerCase();
}

function findProduction(host: string, ctx: ClassifyContext): ClassifyProductionServer | null {
  const h = bareHost(host);
  if (!h) return null;
  for (const server of ctx.productionServers) {
    if (server.name.toLowerCase() === h) return server;
    if (bareHost(server.host) === h) return server;
    if ((server.addresses ?? []).some((a) => bareHost(a) === h)) return server;
  }
  return null;
}

/** A production server any word names (split at characters a host can't hold), for deploy tools' arguments. */
function productionNamedIn(words: readonly string[], ctx: ClassifyContext): ClassifyProductionServer | null {
  if (ctx.productionServers.length === 0) return null;
  for (const w of words) {
    for (const part of w.split(/[^A-Za-z0-9._:[\]-]+/)) {
      if (!part) continue;
      const found =
        findProduction(part, ctx) ??
        // `host:port` or `host:path`.
        (part.includes(':') && !part.startsWith('[') && part.split(':').length === 2
          ? findProduction(part.slice(0, part.indexOf(':')), ctx)
          : null);
      if (found) return found;
    }
  }
  return null;
}

/** `ssh://user@host:2222/x` → `host`. */
function urlHost(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(url);
  return m ? bareHost(m[1] as string) : null;
}

/**
 * The host of an scp/rsync operand, or null for a local path: `user@host:path`, `host:path`, `[v6]:path`, `host::module`
 * (rsync daemon), `rsync://host/…`, `scp://host/…`.
 */
function remoteSpecHost(word: string): string | null {
  if (/^(rsync|scp|sftp|ssh):\/\//i.test(word)) return urlHost(word);
  const m = /^(?:[^@/\s:]+@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):/.exec(word);
  if (!m) return null;
  return bareHost(m[1] as string);
}

/* Matching ----------------------------------------------------------------------------------------------------- */

interface Scope {
  ctx: ClassifyContext;
  branches: readonly string[];
  depth: number;
  /** The machine the commands run on: null is the person's Whombat; else the host an ssh command reached. */
  remote: string | null;
  /** Variables set earlier in this script (`export DOCKER_HOST=…`). */
  env: Map<string, string>;
}

type Found = CommandClassification;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'busybox']);

/** Letters of ssh options that take a value (OpenSSH 9). */
const SSH_VALUE_OPTIONS = 'BbcDEeFIiJLlmOoPpQRSWw';

const KUBECTL_VERBS = new Set(['apply', 'create', 'replace', 'patch', 'delete', 'rollout', 'scale']);
const HELM_VERBS = new Set(['install', 'upgrade', 'rollback', 'uninstall', 'delete', 'del', 'un']);

const WEBHOOKS: readonly { test: (host: string, path: string) => boolean }[] = [
  { test: (h) => h === 'hooks.slack.com' },
  {
    test: (h, p) =>
      (h === 'discord.com' || h === 'discordapp.com' || h.endsWith('.discord.com')) &&
      p.startsWith('/api/webhooks'),
  },
  { test: (h, p) => h === 'api.telegram.org' && /^\/bot[^/]+\/send/i.test(p) },
  { test: (h, p) => h === 'outlook.office.com' && p.startsWith('/webhook') },
  { test: (h) => h.endsWith('.webhook.office.com') },
];

/** A webhook host a word sends to (`https://hooks.slack.com/services/…`), or null. */
function webhookHost(word: string): string | null {
  const m = /(?:^|[^A-Za-z0-9.-])(?:https?:\/\/)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})(\/[^\s"'?#]*)?/.exec(word);
  if (!m) return null;
  const host = (m[1] as string).toLowerCase();
  const path = m[2] ?? '/';
  return WEBHOOKS.some((w) => w.test(host, path)) ? host : null;
}

function isLocalHost(host: string): boolean {
  const h = bareHost(host);
  return (
    h === '' ||
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h.startsWith('/') ||
    h.startsWith('127.')
  );
}

/** A remote Docker endpoint (`-H ssh://…`, `DOCKER_HOST=tcp://…`): anything but a local socket. */
function dockerRemote(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^(unix|npipe|fd):\/\//i.test(value)) return null;
  const host = urlHost(value) ?? bareHost(value.replace(/:\d+$/, ''));
  return host && !isLocalHost(host) ? host : null;
}

const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema)|truncate)\b/i;

/** Whether a simple command, run on another machine, is destructive (AC-40). */
function isDestructive(words: readonly string[]): boolean {
  const name = toolName(words[0] ?? '');
  const args = words.slice(1);
  if (name === 'rm') {
    const flags = args.filter((a) => a.startsWith('-') && a !== '-' && a !== '--');
    const short = flags.filter((a) => !a.startsWith('--')).join('');
    const recursive = /[rR]/.test(short) || flags.includes('--recursive');
    const force = short.includes('f') || flags.includes('--force');
    return recursive && force;
  }
  if (name.startsWith('mkfs')) return true;
  if (name === 'dd') return args.some((a) => a.startsWith('of=/dev/'));
  if (name === 'systemctl') {
    const verb = parseOptions(args, {
      short: 'HMnopst',
      long: [
        '--host',
        '--machine',
        '--signal',
        '--state',
        '--type',
        '--property',
        '--kill-whom',
        '--root',
        '--lines',
        '--output',
      ],
    }).operands[0];
    return verb === 'stop' || verb === 'disable' || verb === 'mask';
  }
  if (name === 'docker-compose')
    return (
      parseOptions(args, {
        short: 'fp',
        long: [
          '--file',
          '--project-name',
          '--project-directory',
          '--env-file',
          '--profile',
          '--context',
          '--host',
        ],
      }).operands[0] === 'down'
    );
  if (name === 'docker' || name === 'podman') {
    const ops = parseOptions(args, {
      short: 'cHl',
      long: ['--config', '--context', '--host', '--log-level'],
    }).operands;
    if (ops[0] !== 'compose') return false;
    return (
      parseOptions(ops.slice(1), {
        short: 'fp',
        long: ['--file', '--project-name', '--project-directory', '--env-file', '--profile'],
      }).operands[0] === 'down'
    );
  }
  return false;
}

/** The words of a wrapper's command (`sudo -u x cmd` → `cmd …`), or null when `words` isn't a wrapper. */
function unwrap(words: string[], assigned: Map<string, string>): string[] | null {
  const name = toolName(words[0] ?? '');
  const args = words.slice(1);
  switch (name) {
    case 'sudo':
    case 'doas':
      return args.slice(
        firstOperandIndex(args, {
          short: 'CDghpRrTtUu',
          long: [
            '--user',
            '--group',
            '--host',
            '--prompt',
            '--close-from',
            '--chdir',
            '--role',
            '--type',
            '--other-user',
            '--command-timeout',
            '--chroot',
          ],
        }),
      );
    case 'env': {
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i] as string;
        if (a === '--') {
          i++;
          break;
        }
        if (a === '-S' || a === '--split-string') {
          const split = simpleCommands(lex(args[i + 1] ?? ''))[0]?.words ?? [];
          return [...split, ...args.slice(i + 2)];
        }
        if (a.startsWith('--split-string=')) {
          const split = simpleCommands(lex(a.slice('--split-string='.length)))[0]?.words ?? [];
          return [...split, ...args.slice(i + 1)];
        }
        if (a === '-u' || a === '-C' || a === '--unset' || a === '--chdir') i++;
        else if (a.startsWith('-')) continue;
        else if (ASSIGNMENT.test(a)) {
          const eq = a.indexOf('=');
          assigned.set(a.slice(0, eq), a.slice(eq + 1));
        } else break;
      }
      return args.slice(i);
    }
    case 'nohup':
    case 'exec':
    case 'builtin':
    case 'chronic':
    case 'unbuffer':
    case 'caffeinate':
      return args.slice(firstOperandIndex(args, { short: 'a' }));
    case 'command':
      // `command -v ssh` only looks a name up.
      if (args.some((a) => a === '-v' || a === '-V')) return [];
      return args.slice(firstOperandIndex(args, {}));
    case 'time':
      return args.slice(firstOperandIndex(args, { short: 'fo', long: ['--format', '--output'] }));
    case 'nice':
      return args.slice(firstOperandIndex(args, { short: 'n', long: ['--adjustment'] }));
    case 'ionice':
      return args.slice(firstOperandIndex(args, { short: 'cnp', long: ['--class', '--classdata', '--pid'] }));
    case 'stdbuf':
      return args.slice(firstOperandIndex(args, { short: 'ioe', long: ['--input', '--output', '--error'] }));
    case 'timeout': {
      const i = firstOperandIndex(args, { short: 'ks', long: ['--kill-after', '--signal'] });
      return args.slice(i + 1); // the duration, then the command
    }
    case 'xargs':
      return args.slice(
        firstOperandIndex(args, {
          short: 'aEeIiLlnPds',
          long: [
            '--arg-file',
            '--eof',
            '--replace',
            '--max-lines',
            '--max-args',
            '--max-procs',
            '--delimiter',
            '--max-chars',
            '--process-slot-var',
          ],
        }),
      );
    case 'watch':
      return args.slice(firstOperandIndex(args, { short: 'nq', long: ['--interval', '--equexit'] }));
    case 'npx':
    case 'pnpx':
    case 'bunx': {
      const parsed = parseOptions(args, {
        short: 'pc',
        long: ['--package', '--call', '--node-options', '--cache', '--registry'],
      });
      const call = optionValue(parsed, '-c', '--call');
      if (call !== null) return ['sh', '-c', call];
      return parsed.operands;
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const parsed = parseOptions(args, {
        short: 'Cw',
        long: ['--dir', '--filter', '--workspace', '--prefix', '--cwd'],
      });
      const [sub, ...rest] = parsed.operands;
      if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
        const inner = parseOptions(rest, { short: 'pc', long: ['--package', '--call'] });
        const call = optionValue(inner, '-c', '--call');
        if (call !== null) return ['sh', '-c', call];
        return inner.operands;
      }
      return null;
    }
    default:
      return null;
  }
}

function found(category: CommandCategory, target: string | null, summary: string): Found {
  return { category, target, summary };
}

/** Everything a script's commands match, depth-first, in order. */
function classifyScript(text: string, scope: Scope): Found[] {
  if (scope.depth > CLASSIFY_MAX_DEPTH) return [];
  const lexed = lex(text);
  const out: Found[] = [];
  if (scope.remote !== null && SQL_DESTRUCTIVE.test(text))
    out.push(found('destructive', scope.remote, `Run a destructive command on ${scope.remote}`));
  for (const cmd of simpleCommands(lexed)) out.push(...classifySimple(cmd, scope));
  for (const inner of lexed.nested) out.push(...classifyScript(inner, { ...scope, depth: scope.depth + 1 }));
  return out;
}

/** A simple command's words with leading assignments and wrappers looked through (`unwrap`), and the assignments. */
function lookThrough(start: string[]): { words: string[]; assigned: Map<string, string> } {
  let words = start;
  const assigned = new Map<string, string>();
  for (let guard = 0; guard < 16; guard++) {
    while (words.length > 0 && ASSIGNMENT.test(words[0] as string)) {
      const a = words[0] as string;
      const eq = a.indexOf('=');
      assigned.set(a.slice(0, eq), a.slice(eq + 1));
      words = words.slice(1);
    }
    if (words.length === 0) break;
    const inner = unwrap(words, assigned);
    if (inner === null) break;
    words = inner;
  }
  return { words, assigned };
}

function classifySimple(cmd: SimpleCommand, scope: Scope): Found[] {
  const { words, assigned } = lookThrough(cmd.words);
  if (words.length === 0) {
    // `DOCKER_HOST=ssh://… ` alone, or `export DOCKER_HOST=…`: later commands of this script see it.
    for (const [k, v] of assigned) scope.env.set(k, v);
    return [];
  }
  const name = toolName(words[0] as string);
  const args = words.slice(1);
  if (name === 'export' || name === 'declare' || name === 'typeset') {
    for (const a of args)
      if (ASSIGNMENT.test(a)) scope.env.set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
    return [];
  }
  const out: Found[] = [];
  const env = (key: string) => assigned.get(key) ?? scope.env.get(key);

  if (scope.remote !== null && isDestructive(words))
    out.push(found('destructive', scope.remote, `Run a destructive command on ${scope.remote}`));

  if (SHELLS.has(name)) {
    out.push(...classifyShell(args, cmd.stdin, scope));
    return out;
  }

  switch (name) {
    case 'ssh':
      out.push(...classifySsh(args, cmd.stdin, scope));
      break;
    case 'scp':
    case 'rsync': {
      for (const a of args) {
        if (a.startsWith('-')) continue;
        const host = remoteSpecHost(a);
        if (!host) continue;
        const prod = findProduction(host, scope.ctx);
        if (prod)
          out.push(
            found('deploy_production', prod.name, `Copy files to or from the production server ${prod.name}`),
          );
      }
      break;
    }
    case 'sftp': {
      const ops = parseOptions(args, { short: 'BbcDFiJloPRSsX' });
      const dest = ops.operands[0];
      const host = dest ? (remoteSpecHost(dest) ?? bareHost(dest)) : null;
      const prod = host ? findProduction(host, scope.ctx) : null;
      if (prod)
        out.push(
          found('deploy_production', prod.name, `Copy files to or from the production server ${prod.name}`),
        );
      break;
    }
    case 'docker':
    case 'podman': {
      const parsed = parseOptions(args, {
        short: 'cHl',
        long: ['--config', '--context', '--host', '--log-level', '--tlscacert', '--tlscert', '--tlskey'],
      });
      const remote = dockerRemote(optionValue(parsed, '-H', '--host') ?? env('DOCKER_HOST'));
      if (remote) {
        const prod = findProduction(remote, scope.ctx);
        out.push(
          prod
            ? found('deploy_production', prod.name, `Run Docker on the production server ${prod.name}`)
            : found('destructive', remote, `Run Docker on ${remote}`),
        );
      }
      const [sub, sub2] = parsed.operands;
      if (sub === 'push' || (sub === 'image' && sub2 === 'push'))
        out.push(deployFound(name, 'push', parsed.operands, scope));
      break;
    }
    case 'fly':
    case 'flyctl':
      if (
        parseOptions(args, { short: 'act', long: ['--app', '--config', '--access-token'] }).operands[0] ===
        'deploy'
      )
        out.push(deployFound(name, 'deploy', args, scope));
      break;
    case 'wrangler': {
      const ops = parseOptions(args, { short: 'ce', long: ['--config', '--env', '--cwd'] }).operands;
      const deploys = (s: string | undefined) => s === 'deploy' || s === 'publish';
      if (deploys(ops[0]) || ((ops[0] === 'pages' || ops[0] === 'versions') && deploys(ops[1])))
        out.push(deployFound(name, 'deploy', args, scope));
      break;
    }
    case 'vercel': {
      const parsed = parseOptions(args, {
        short: 'AQSt',
        long: [
          '--scope',
          '--token',
          '--target',
          '--local-config',
          '--global-config',
          '--cwd',
          '--env',
          '--build-env',
          '--meta',
        ],
        stopAtOperand: false,
      });
      if (hasOption(parsed, '--prod', '--production') || optionValue(parsed, '--target') === 'production')
        out.push(deployFound(name, 'deploy', args, scope));
      break;
    }
    case 'netlify': {
      const parsed = parseOptions(args, {
        short: 'adfms',
        long: ['--alias', '--dir', '--functions', '--message', '--site', '--auth', '--filter', '--context'],
        stopAtOperand: false,
      });
      if (
        parsed.operands[0] === 'deploy' &&
        hasOption(parsed, '--prod', '-p', '--prod-if-unlocked', '--prodIfUnlocked')
      )
        out.push(deployFound(name, 'deploy', args, scope));
      break;
    }
    case 'kubectl': {
      const ops = parseOptions(args, {
        short: 'nsl',
        long: [
          '--namespace',
          '--context',
          '--kubeconfig',
          '--server',
          '--cluster',
          '--user',
          '--token',
          '--as',
          '--as-group',
          '--request-timeout',
          '--certificate-authority',
          '--client-certificate',
          '--client-key',
          '--tls-server-name',
          '--cache-dir',
        ],
      }).operands;
      if (
        KUBECTL_VERBS.has(ops[0] ?? '') &&
        !(ops[0] === 'rollout' && (ops[1] === 'status' || ops[1] === 'history'))
      )
        out.push(deployFound(name, 'deploy', args, scope));
      break;
    }
    case 'helm': {
      const ops = parseOptions(args, {
        short: 'n',
        long: [
          '--namespace',
          '--kube-context',
          '--kubeconfig',
          '--kube-apiserver',
          '--kube-token',
          '--registry-config',
          '--repository-config',
          '--repository-cache',
        ],
      }).operands;
      if (HELM_VERBS.has(ops[0] ?? '')) out.push(deployFound(name, 'deploy', args, scope));
      break;
    }
    case 'terraform':
    case 'tofu':
    case 'terragrunt': {
      const ops = parseOptions(args).operands;
      if (ops[0] === 'apply' || ops[0] === 'destroy') out.push(deployFound(name, 'deploy', args, scope));
      break;
    }
    case 'pulumi': {
      const ops = parseOptions(args, { short: 'Cs', long: ['--cwd', '--stack'] }).operands;
      if (ops[0] === 'up' || ops[0] === 'update' || ops[0] === 'destroy')
        out.push(deployFound(name, 'deploy', args, scope));
      break;
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const ops = parseOptions(args, {
        short: 'Cw',
        long: [
          '--dir',
          '--filter',
          '--workspace',
          '--prefix',
          '--cwd',
          '--tag',
          '--access',
          '--otp',
          '--registry',
        ],
        stopAtOperand: false,
      }).operands;
      if (ops[0] === 'publish' || (name === 'yarn' && ops[0] === 'npm' && ops[1] === 'publish'))
        out.push(deployFound(name, 'publish', args, scope));
      break;
    }
    case 'gh':
      if (!scope.ctx.ghThroughWhombat) out.push(...classifyGh(args));
      break;
    case 'git':
      out.push(...classifyGit(args, scope));
      break;
    case 'curl':
    case 'wget':
    case 'http':
    case 'https':
    case 'xh':
    case 'xhs':
    case 'httpie': {
      for (const a of args) {
        const host = webhookHost(a);
        if (host) {
          out.push(found('message_external', host, `Send a message through ${host}`));
          break;
        }
      }
      break;
    }
    case 'sendmail':
    case 'swaks':
    case 'msmtp':
    case 'ssmtp': {
      const to = args.find((a) => !a.startsWith('-') && a.includes('@')) ?? null;
      out.push(found('message_external', to, `Send an email with ${name}`));
      break;
    }
    case 'mail':
    case 'mailx':
    case 's-nail':
    case 'mutt': {
      const to = args.find((a) => !a.startsWith('-') && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) ?? null;
      if (to) out.push(found('message_external', to, `Send an email with ${name}`));
      break;
    }
    case 'psql':
    case 'mysql':
    case 'mariadb': {
      const text = words.join(' ');
      if (!SQL_DESTRUCTIVE.test(text)) break;
      const parsed = parseOptions(args, {
        short: 'hcdUpPuDeSf',
        long: [
          '--host',
          '--command',
          '--dbname',
          '--username',
          '--port',
          '--user',
          '--database',
          '--execute',
          '--socket',
          '--file',
        ],
        stopAtOperand: false,
      });
      const host =
        optionValue(parsed, '-h', '--host') ?? parsed.operands.map((o) => urlHost(o)).find((h) => h) ?? null;
      if (host && !isLocalHost(host) && scope.remote === null) {
        const prod = findProduction(host, scope.ctx);
        out.push(
          prod
            ? found('deploy_production', prod.name, `Change a database on the production server ${prod.name}`)
            : found('destructive', bareHost(host), `Run a destructive command on ${bareHost(host)}`),
        );
      }
      break;
    }
    default:
      break;
  }
  return out;
}

const DEPLOY_SUMMARIES = {
  deploy: (tool: string) => `Deploy with ${tool}`,
  publish: (tool: string) => `Publish a package with ${tool}`,
  push: (tool: string) => `Push an image with ${tool}`,
} as const;

/** A deploy tool's match: `deploy_production` when its arguments name a production server, else `deploy`. */
function deployFound(
  tool: string,
  kind: keyof typeof DEPLOY_SUMMARIES,
  args: readonly string[],
  scope: Scope,
): Found {
  const prod = productionNamedIn(args, scope.ctx);
  if (prod)
    return found('deploy_production', prod.name, `Deploy with ${tool} to the production server ${prod.name}`);
  return found('deploy', null, DEPLOY_SUMMARIES[kind](tool));
}

function classifyShell(args: readonly string[], stdin: readonly string[], scope: Scope): Found[] {
  const next = { ...scope, depth: scope.depth + 1 };
  return shellScripts(args, stdin).flatMap((s) => classifyScript(s, next));
}

/** The scripts a shell runs: its `-c` operand, else what it reads on stdin (`-s`, or no script file). */
function shellScripts(args: readonly string[], stdin: readonly string[]): string[] {
  // Options until the first operand; `-c` anywhere in a cluster (`-lc`, `-ec`) makes that operand the script.
  let hasC = false;
  let readsStdin = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (a === '-o' || a === '+o' || a === '--rcfile' || a === '--init-file') {
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    if ((a.startsWith('-') || a.startsWith('+')) && a.length > 1) {
      if (a.startsWith('-') && a.includes('c')) hasC = true;
      if (a.startsWith('-') && a.includes('s')) readsStdin = true;
      continue;
    }
    break;
  }
  if (hasC) return i < args.length ? [args[i] as string] : [];
  if (readsStdin || i >= args.length) return [...stdin];
  return [];
}

function classifySsh(args: readonly string[], stdin: readonly string[], scope: Scope): Found[] {
  const call = sshCall(args, stdin);
  if (call === null) return [];
  const out: Found[] = [];
  for (const host of call.hosts) {
    const prod = findProduction(host, scope.ctx);
    if (prod) {
      out.push(found('deploy_production', prod.name, `SSH to the production server ${prod.name}`));
      break;
    }
  }
  const remote = { ...scope, depth: scope.depth + 1, remote: call.shown, env: new Map<string, string>() };
  for (const s of call.scripts) out.push(...classifyScript(s, remote));
  return out;
}

/**
 * What an ssh command reaches and runs there: the hosts it connects through (the destination first, then `-J` and
 * `-o HostName|ProxyJump`), and the remote scripts — its command, and the here-document a remote shell reads (or of an
 * ssh without a command). Null when it connects nowhere (no destination, `-G`, `-V`).
 */
function sshCall(
  args: readonly string[],
  stdin: readonly string[],
): { hosts: string[]; shown: string; scripts: string[] } | null {
  const options: { name: string; value: string | null }[] = [];
  let destination: string | null = null;
  const rest: string[] = [];
  // OpenSSH reads options before and right after the destination, then the command.
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') {
      i++;
      if (destination === null && i < args.length) {
        destination = args[i] as string;
        i++;
      }
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const letter = a[j] as string;
        if (SSH_VALUE_OPTIONS.includes(letter)) {
          const value = a.slice(j + 1) || (args[++i] ?? null);
          options.push({ name: letter, value });
          break;
        }
        options.push({ name: letter, value: null });
      }
      continue;
    }
    if (destination === null) {
      destination = a;
      continue;
    }
    break;
  }
  rest.push(...args.slice(i));
  if (destination === null) return null;
  // `ssh -G` prints the configuration and `ssh -V` the version: nothing connects.
  if (options.some((o) => o.name === 'G' || o.name === 'V')) return null;

  const hosts = [urlHost(destination) ?? bareHost(destination)];
  for (const o of options) {
    if (!o.value) continue;
    if (o.name === 'J')
      hosts.push(...o.value.split(',').map((h) => urlHost(h) ?? bareHost(h.replace(/:\d+$/, ''))));
    if (o.name === 'o') {
      const m = /^\s*(HostName|ProxyJump)\s*[= ]\s*(.+)$/i.exec(o.value);
      if (m)
        hosts.push(...(m[2] as string).split(',').map((h) => urlHost(h) ?? bareHost(h.replace(/:\d+$/, ''))));
    }
  }
  const scripts: string[] = [];
  if (rest.length > 0) scripts.push(rest.join(' '));
  // No remote command, or a remote shell reading its script (`ssh host bash -s <<EOF`): the here-document runs there.
  if (rest.length === 0 || SHELLS.has(toolName(rest[0] as string))) scripts.push(...stdin);
  return { hosts, shown: hosts[0] as string, scripts };
}

function classifyGh(args: readonly string[]): Found[] {
  const parsed = parseOptions(args, {
    short: 'RXfFHq',
    long: [
      '--repo',
      '--method',
      '--field',
      '--raw-field',
      '--header',
      '--jq',
      '--template',
      '--input',
      '--hostname',
    ],
    stopAtOperand: false,
  });
  const ops = parsed.operands;
  const repo = optionValue(parsed, '-R', '--repo');
  if (ops[0] === 'pr' && ops[1] === 'merge') {
    const number = ops[2] && /^#?\d+$/.test(ops[2]) ? ops[2].replace('#', '') : null;
    const what = number ? `Merge pull request #${number}` : 'Merge a pull request';
    return [found('merge', repo, repo ? `${what} in ${repo}` : what)];
  }
  if (ops[0] === 'api' && ops[1] && /pulls\/\d+\/merge\/?$/.test(ops[1])) {
    const method = (optionValue(parsed, '-X', '--method') ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      const m = /repos\/([^/]+\/[^/]+)\/pulls\/(\d+)/.exec(ops[1]);
      return [
        found(
          'merge',
          m ? (m[1] as string) : null,
          m ? `Merge pull request #${m[2]} in ${m[1]}` : 'Merge a pull request',
        ),
      ];
    }
  }
  return [];
}

function classifyGit(args: readonly string[], scope: Scope): Found[] {
  const ops = parseOptions(args, {
    short: 'Cc',
    long: [
      '--git-dir',
      '--work-tree',
      '--namespace',
      '--exec-path',
      '--config-env',
      '--super-prefix',
      '--list-cmds',
    ],
  }).operands;
  if (ops[0] !== 'push') return [];
  const parsed = parseOptions(ops.slice(1), {
    short: 'o',
    long: ['--push-option', '--repo', '--receive-pack', '--exec', '--signed'],
    stopAtOperand: false,
  });
  const branches = scope.branches;
  if (hasOption(parsed, '--all', '--mirror', '--branches')) {
    const main = branches[0] ?? 'main';
    return [found('push_main', main, `Push every branch, ${main} included`)];
  }
  const refspecs = parsed.operands.slice(1);
  for (const refspec of refspecs) {
    let spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
    const colon = spec.indexOf(':');
    if (colon !== -1) spec = spec.slice(colon + 1);
    spec = spec.replace(/^refs\/heads\//, '');
    if (branches.includes(spec)) return [found('push_main', spec, `Push to ${spec}`)];
  }
  return [];
}

/**
 * What a shell command does that needs a key (AC-40), or null for everything else — including destructive commands on
 * the person's Whombat (inside the commands' wrapper). When several parts match, the most severe category wins (`COMMAND_CATEGORY_RANK`:
 * deploy to production > push to main > merge > deploy > destructive > outside message), with the first match of it.
 * With `ctx.runsOn` the command runs on that machine, as an ssh remote command does (CT-535).
 */
export function classifyCommand(command: string, ctx: ClassifyContext): CommandClassification | null {
  const runsOn = ctx.runsOn?.trim() || null;
  const scope: Scope = {
    ctx,
    branches: ctx.defaultBranches && ctx.defaultBranches.length > 0 ? ctx.defaultBranches : DEFAULT_BRANCHES,
    depth: 0,
    remote: runsOn,
    env: new Map(),
  };
  const prod = runsOn ? findProduction(runsOn, ctx) : null;
  const all: Found[] = prod
    ? [found('deploy_production', prod.name, `Run a command on the production server ${prod.name}`)]
    : [];
  try {
    all.push(...classifyScript(command, scope));
  } catch {
    // Never throws: a command it can't read is read as nothing more than its first word.
  }
  let best: Found | null = null;
  for (const f of all) {
    if (
      !best ||
      (f.category !== best.category && moreSevereCategory(f.category, best.category) === f.category)
    )
      best = f;
  }
  return best;
}

/* Every simple command, for stricter readers (0.100.1, CT-535) ------------------------------------------------- */

/** One simple command as `shellSimpleCommands` reads it. */
export interface ShellSimpleCommand {
  /** The tool it runs: `/usr/bin/rm` → `rm`; empty when only a redirection is left (`> file`). */
  name: string;
  /** Its arguments, wrappers (`sudo`, `env`, `nohup`, `timeout N`, `xargs`, …) and leading assignments looked through. */
  args: readonly string[];
  /** What it reads from here-documents and here-strings. */
  stdin: readonly string[];
  /**
   * The files its `>`, `>|`, `>&` and `&>` redirections write over: not `>>`, not a file descriptor (`2>&1`), not
   * `/dev/null`, `/dev/zero` or a standard stream.
   */
  truncates: readonly string[];
}

/**
 * Every simple command a script runs, read the way `classifyCommand` reads them: split at `&&`, `||`, `;`, `|`, `&`,
 * newlines and parentheses, wrappers looked through, and the scripts of a shell's `-c` or here-document, of an ssh
 * remote command and of command substitutions followed up to `CLASSIFY_MAX_DEPTH`, in order. It says nothing about
 * where each runs or what it means: that is for a reader stricter than the guard (the desk's `deskMayDecide`). Never
 * throws; a script it can't read is read as far as it goes.
 */
export function shellSimpleCommands(command: string): ShellSimpleCommand[] {
  const out: ShellSimpleCommand[] = [];
  try {
    walkScript(command, 0, out);
  } catch {
    // What it read until then.
  }
  return out;
}

function walkScript(text: string, depth: number, out: ShellSimpleCommand[]): void {
  if (depth > CLASSIFY_MAX_DEPTH) return;
  const lexed = lex(text);
  for (const cmd of simpleCommands(lexed)) {
    const { words } = lookThrough(cmd.words);
    const name = toolName(words[0] ?? '');
    const args = words.slice(1);
    if (name !== '' || cmd.writes.length > 0)
      out.push({ name, args, stdin: cmd.stdin, truncates: cmd.writes });
    const scripts = SHELLS.has(name)
      ? shellScripts(args, cmd.stdin)
      : name === 'ssh'
        ? (sshCall(args, cmd.stdin)?.scripts ?? [])
        : [];
    for (const s of scripts) walkScript(s, depth + 1, out);
  }
  for (const inner of lexed.nested) walkScript(inner, depth + 1, out);
}
