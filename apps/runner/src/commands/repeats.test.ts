/**
 * The same command failing the same way (docs/decisions/health-command-loops.md HC-02…HC-04): what counts as the same
 * command, which exits are answers rather than failures, and when the exec service nudges and refuses.
 */
import { describe, expect, it } from 'vitest';
import {
  agentCommand,
  answers,
  CommandRepeats,
  REPEAT_LAST_LINE,
  REPEAT_NUDGE_LINE,
  REPEAT_REFUSED_LINE,
  REPEATS_KEPT,
} from './repeats';

/**
 * How the pinned Claude Code (2.1.283, driven offline against the fake Messages API) hands a Bash call to its shell:
 * its setup steps, the command in `eval`, and its working directory into a file named fresh for every call.
 */
const SNAPSHOT = '/home/whombat-task/.claude/shell-snapshots/snapshot-bash-1791385919320-fobjwd.sh';
const claude = (quoted: string, id: string, devNull = true) =>
  `source ${SNAPSHOT} 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval ${quoted}${devNull ? ' < /dev/null' : ''} && pwd -P >| /tmp/whombat-runner-1000/scratch/dsp_1/claude-${id}-cwd`;

describe('the command the agent wrote (HC-02)', () => {
  it('takes Claude Code’s wrapper off: the same Bash call is the same command, whatever its cwd file', () => {
    expect(agentCommand(claude("'pnpm build:widget'", 'f334'))).toBe('pnpm build:widget');
    expect(agentCommand(claude("'pnpm build:widget'", '7249'))).toBe('pnpm build:widget');
    expect(agentCommand(claude(`'grep -rn "it'"'"'s" src | head -5'`, 'bfe8'))).toBe(
      `grep -rn "it's" src | head -5`,
    );
    // A heredoc: no `< /dev/null`.
    expect(agentCommand(claude(`'cat <<'"'"'EOF'"'"'\nline one\nEOF'`, '8c98', false))).toBe(
      "cat <<'EOF'\nline one\nEOF",
    );
    expect(agentCommand(claude(`'echo "$HOME" && ls'`, '099d'))).toBe('echo "$HOME" && ls');
    // Without a snapshot the setup starts with `eval`; a double-quoted or bare command reads the same.
    expect(agentCommand(`eval 'make' < /dev/null && pwd -P >| /t/claude-0a1b-cwd`)).toBe('make');
    expect(agentCommand(`eval "echo \\"\\$X\\"" < /dev/null && pwd -P >| '/t/claude-0a1b-cwd'`)).toBe(
      'echo "$X"',
    );
    expect(agentCommand(`eval make\\ test && pwd -P >| /t/cwd-0a1b`)).toBe('make test');
  });

  it('leaves everything else as written, trimmed', () => {
    // Codex runs `<login shell> -lc <command>`: the command is the agent's.
    expect(agentCommand('  pnpm test --run \n')).toBe('pnpm test --run');
    expect(agentCommand("eval 'x'")).toBe("eval 'x'");
    // A wrapper it can't read still loses the part that changes every time.
    expect(agentCommand(`setup && eval 'unclosed && pwd -P >| /t/claude-1234-cwd`)).toBe(
      "setup && eval 'unclosed",
    );
    expect(agentCommand('')).toBe('');
  });
});

describe('answers, not failures (HC-02)', () => {
  it('exit 1 of a search, a comparison or a test is its answer', () => {
    for (const command of [
      'grep -rn TODO src',
      'rg -n "a|b" src',
      'cat x | grep -q y',
      'LANG=C /usr/bin/grep x f',
      'diff a b',
      'cmp a b',
      'test -f x',
      '[ -f x ]',
      'git diff --quiet',
      'git -C repo diff --exit-code',
      'git grep oldName',
      'cd src && find . -name x',
    ])
      expect(answers(command, 1), command).toBe(true);
  });

  it('anything else, or another exit, is a failure', () => {
    expect(answers('grep x f', 2)).toBe(false);
    expect(answers('pnpm test', 1)).toBe(false);
    expect(answers('grep x f | head -5', 1)).toBe(false);
    expect(answers('git commit -m "grep"', 1)).toBe(false);
    expect(answers('git status', 1)).toBe(false);
    expect(answers('echo "a | grep b"; false', 1)).toBe(false);
  });
});

describe('one turn’s failing commands (HC-02, HC-03)', () => {
  it('nudges on the second identical failure, warns on the third, refuses the fourth', () => {
    const r = new CommandRepeats();
    expect(r.ran('pnpm build:widget', '/w', 1)).toBeNull();
    expect(r.refusal('pnpm build:widget', '/w')).toBeNull();
    expect(r.ran('pnpm build:widget', '/w', 1)).toEqual({ line: REPEAT_NUDGE_LINE, failures: 2, code: 1 });
    expect(r.refusal('pnpm build:widget', '/w')).toBeNull();
    expect(r.ran(' pnpm build:widget\n', '/w', 1)).toEqual({ line: REPEAT_LAST_LINE, failures: 3, code: 1 });
    expect(r.refusal('pnpm build:widget', '/w')).toEqual({ line: REPEAT_REFUSED_LINE, failures: 3, code: 1 });
    // Asked again: still not.
    expect(r.refusal('pnpm build:widget', '/w')).not.toBeNull();
  });

  it('counts Claude Code’s calls of the same command together', () => {
    const r = new CommandRepeats();
    r.ran(claude("'pnpm test'", '0001'), '/w', 1);
    r.ran(claude("'pnpm test'", '0002'), '/w', 1);
    r.ran(claude("'pnpm test'", '0003'), '/w', 1);
    expect(r.refusal(claude("'pnpm test'", '0004'), '/w')?.line).toBe(REPEAT_REFUSED_LINE);
    expect(r.refusal('pnpm test', '/w')?.line).toBe(REPEAT_REFUSED_LINE);
  });

  it('starts over after a success, or a failure of another kind', () => {
    const r = new CommandRepeats();
    r.ran('pnpm test', '/w', 1);
    r.ran('pnpm test', '/w', 1);
    expect(r.ran('pnpm test', '/w', 0)).toBeNull();
    expect(r.ran('pnpm test', '/w', 1)).toBeNull();
    expect(r.ran('pnpm test', '/w', 1)?.failures).toBe(2);
    // Out of memory now: another way of failing.
    expect(r.ran('pnpm test', '/w', 137)).toBeNull();
    expect(r.ran('pnpm test', '/w', 137)?.line).toBe(REPEAT_NUDGE_LINE);
    // An answer counts as a success.
    r.ran('grep -rn x src', '/w', 2);
    r.ran('grep -rn x src', '/w', 2);
    expect(r.ran('grep -rn x src', '/w', 1)).toBeNull();
    expect(r.ran('grep -rn x src', '/w', 2)).toBeNull();
  });

  it('a changed command, or the same one somewhere else, is another command', () => {
    const r = new CommandRepeats();
    for (let i = 0; i < 3; i++) r.ran('pnpm test', '/w', 1);
    expect(r.refusal('pnpm test', '/w')).not.toBeNull();
    expect(r.refusal('pnpm test -- src/a.test.ts', '/w')).toBeNull();
    expect(r.refusal('NODE_OPTIONS=--max-old-space-size=4096 pnpm test', '/w')).toBeNull();
    expect(r.refusal('pnpm test', '/w/packages/b')).toBeNull();
    expect(r.ran('pnpm test -- src/a.test.ts', '/w', 1)).toBeNull();
  });

  it('keeps the last 64 failing commands; nothing for an empty one', () => {
    const r = new CommandRepeats();
    for (let i = 0; i < 3; i++) r.ran('make', '/w', 2);
    for (let i = 0; i < REPEATS_KEPT; i++) r.ran(`false ${i}`, '/w', 1);
    expect(r.size).toBe(REPEATS_KEPT);
    // Forgotten: it runs again.
    expect(r.refusal('make', '/w')).toBeNull();
    expect(r.ran('', '/w', 1)).toBeNull();
    expect(r.ran('   ', '/w', 1)).toBeNull();
    expect(r.refusal('', '/w')).toBeNull();
  });
});
