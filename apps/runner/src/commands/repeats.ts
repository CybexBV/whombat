/**
 * The same command failing the same way, again and again (docs/decisions/health-command-loops.md HC-02…HC-04). The
 * guard of a commands turn keeps, for the turn, the commands that failed: by what the agent wrote (trimmed;
 * Claude Code's wrapper taken off, `agentCommand`) and where it ran, with the exit status and how often in a row it
 * failed with it. The second identical failure gets `REPEAT_NUDGE_LINE` after its output, the third
 * `REPEAT_LAST_LINE`, and the fourth isn't run: exit `REPEAT_REFUSED_EXIT` and `REPEAT_REFUSED_LINE`. A success of
 * the command, or another exit status, starts it over; any change to the command makes it another command. A non-zero
 * exit that is an answer (grep found nothing, diff found a difference, test was false: `answers`) is no failure.
 *
 * Bounded: the last `REPEATS_KEPT` failing commands, by a hash (nothing of a command is kept). Pure: no I/O, no clock.
 */
import { createHash } from 'node:crypto';

/** The failure that gets `REPEAT_NUDGE_LINE` (the second identical one). */
export const REPEAT_NUDGE_AT = 2;
/** After this many identical failures the same command isn't run again. */
export const REPEAT_REFUSE_AT = 3;
/** Failing commands remembered per turn; older ones are forgotten. */
export const REPEATS_KEPT = 64;
/** The exit status of a command that wasn't run because it kept failing (not 126/125: no key or person said no). */
export const REPEAT_REFUSED_EXIT = 1;

export const REPEAT_NUDGE_LINE =
  "[whombat] This command failed the same way twice. Don't run it again unchanged: change something, or say what is in the way.";
export const REPEAT_LAST_LINE =
  "[whombat] This command failed the same way 3 times; unchanged, it won't run again. Change something, or say what is in the way.";
export const REPEAT_REFUSED_LINE =
  '[whombat] Not run: this exact command already failed 3 times. Change it, or tell the person what is in the way.';

/** Claude Code's last step after every command: its working directory into a file named fresh each time. */
const CLAUDE_CWD_TAIL = /\s*&&\s*pwd -P >\| (?:'[^']*'|"[^"]*"|[^\s'"]+)\s*$/;
/** Where Claude Code's own command starts: `eval`, first or after one of its ` && ` steps. */
const CLAUDE_EVAL = /(?:^|\s&&\s)eval /;

/**
 * One shell word from `from` (single and double quotes, backslashes), as bash reads it: its value and where it ends.
 * Null when it isn't one (nothing there, or a quote that never closes).
 */
function shellWord(text: string, from: number): { value: string; end: number } | null {
  let value = '';
  let i = from;
  while (i < text.length) {
    const c = text.charAt(i);
    if (/\s/.test(c) || '|&;<>()'.includes(c)) break;
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return null;
      value += text.slice(i + 1, close);
      i = close + 1;
    } else if (c === '"') {
      i += 1;
      while (i < text.length && text.charAt(i) !== '"') {
        const next = text.charAt(i + 1);
        if (text.charAt(i) === '\\' && i + 1 < text.length && '$`"\\\n'.includes(next)) {
          if (next !== '\n') value += next;
          i += 2;
        } else {
          value += text.charAt(i);
          i += 1;
        }
      }
      if (i >= text.length) return null;
      i += 1;
    } else if (c === '\\') {
      if (i + 1 >= text.length) return null;
      if (text.charAt(i + 1) !== '\n') value += text.charAt(i + 1);
      i += 2;
    } else {
      value += c;
      i += 1;
    }
  }
  return i > from ? { value, end: i } : null;
}

/**
 * The command the agent wrote. Claude Code runs each one as `<its setup> && eval '<command>' < /dev/null && pwd -P >|
 * <tmp>/claude-<random>-cwd` (2.1.283; health-command-loops.md HC-02): the command inside `eval`, unquoted. Anything
 * else (Codex's, a person's): the text, trimmed. A wrapper this can't read loses only its changing last step.
 */
export function agentCommand(text: string): string {
  const trimmed = text.trim();
  const hermes = hermesCommand(trimmed);
  if (hermes !== null) return hermes;
  const tail = CLAUDE_CWD_TAIL.exec(trimmed);
  if (!tail) return trimmed;
  const head = trimmed.slice(0, tail.index);
  const at = CLAUDE_EVAL.exec(head);
  if (at) {
    const word = shellWord(head, at.index + at[0].length);
    const rest = word ? head.slice(word.end).trim() : null;
    if (word && (rest === '' || rest === '< /dev/null')) return word.value.trim();
  }
  return head.trim();
}

/**
 * Hermes's script around a command (its `_wrap_command_script`, 0.22.5; one-person.md OP-S107): the snapshot sourced,
 * `builtin cd -- <folder> || exit 126`, then the agent's command as `eval '<command>'` from the start of a line to the
 * end of one (single quotes escaped `'\''`; a command of several lines spans them), then its bookkeeping. The command,
 * or null when the text isn't such a script.
 */
export function hermesCommand(text: string): string | null {
  const cd = /^builtin cd -- .* \|\| exit 126$/m.exec(text);
  if (!cd) return null;
  const at = text.indexOf("\neval '", cd.index);
  if (at < 0) return null;
  const word = shellWord(text, at + '\neval '.length);
  return word && (word.end === text.length || text.charAt(word.end) === '\n') ? word.value.trim() : null;
}

/** The words of the last command of a list or pipeline (`a && b | c` → c's), quotes left as written. */
function lastCommandWords(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') {
        current += c;
        i += 1;
        current += command.charAt(i);
        continue;
      }
      current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === '\\') {
      current += c + command.charAt(i + 1);
      i += 1;
    } else if ('|&;\n'.includes(c)) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  parts.push(current);
  const last =
    parts
      .map((p) => p.trim())
      .filter(Boolean)
      .pop() ?? '';
  const words = last.split(/\s+/).filter(Boolean);
  // `LANG=C grep …`: the assignments aren't the command.
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift();
  return words;
}

/** Commands whose exit 1 is an answer (Claude Code 2.1.292's own table, and cmp): nothing found, a difference, false. */
const ANSWERING = new Set(['grep', 'egrep', 'fgrep', 'rg', 'find', 'diff', 'cmp', 'test', '[']);

/** Whether a non-zero exit is the command's answer, not a failure: exit 1 of grep, rg, diff, test, git diff, …. */
export function answers(command: string, code: number): boolean {
  if (code !== 1) return false;
  const words = lastCommandWords(command);
  const name = (words[0] ?? '').split('/').pop() ?? '';
  if (ANSWERING.has(name)) return true;
  if (name !== 'git') return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i] ?? '';
    if (w === '-C' || w === '-c') i += 1;
    else if (!w.startsWith('-')) return w === 'diff' || w === 'grep';
  }
  return false;
}

/** What the exec service adds to a command's output, or answers instead of running it. */
export interface RepeatVerdict {
  line: string;
  /** How often in a row it failed the same way. */
  failures: number;
  /** With which exit status. */
  code: number;
}

interface Failing {
  code: number;
  failures: number;
}

/** One turn's failing commands (HC-02, HC-03). */
export class CommandRepeats {
  /** By key, least recently failed first. */
  readonly #failing = new Map<string, Failing>();

  #key(command: string, cwd: string): string {
    return createHash('sha256').update(cwd).update('\0').update(command).digest('hex');
  }

  /** Before a command runs: the refusal when it already failed the same way `REPEAT_REFUSE_AT` times. */
  refusal(text: string, cwd: string): RepeatVerdict | null {
    const command = agentCommand(text);
    if (!command) return null;
    const failing = this.#failing.get(this.#key(command, cwd));
    if (!failing || failing.failures < REPEAT_REFUSE_AT) return null;
    return { line: REPEAT_REFUSED_LINE, failures: failing.failures, code: failing.code };
  }

  /** After it ran, with its exit status: the line to add to its output, if any. */
  ran(text: string, cwd: string, code: number): RepeatVerdict | null {
    const command = agentCommand(text);
    if (!command) return null;
    const key = this.#key(command, cwd);
    const had = this.#failing.get(key);
    this.#failing.delete(key);
    if (code === 0 || answers(command, code)) return null;
    const failures = had && had.code === code ? had.failures + 1 : 1;
    this.#failing.set(key, { code, failures });
    for (const oldest of this.#failing.keys()) {
      if (this.#failing.size <= REPEATS_KEPT) break;
      this.#failing.delete(oldest);
    }
    if (failures >= REPEAT_REFUSE_AT) return { line: REPEAT_LAST_LINE, failures, code };
    if (failures >= REPEAT_NUDGE_AT) return { line: REPEAT_NUDGE_LINE, failures, code };
    return null;
  }

  /** How many failing commands it keeps (tests). */
  get size(): number {
    return this.#failing.size;
  }
}
