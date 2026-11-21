/** Types of the fake Claude Code CLI (fake-claude.mjs). */
export interface FakeClaudeScenario {
  /** JSON-lines file the fake appends what it saw to. */
  record: string;
  initializeError?: string;
  /** The answer to `get_usage` (the usage probe); without it the fake answers an error, as an older CLI would. */
  usage?: object;
  usageError?: string;
  /** `initialize`'s `models` (Whombat model-effort.md ME-04); none by default. */
  models?: object[];
}
export function fakeClaude(scenario: FakeClaudeScenario): string;
export function runFakeClaude(scenario: FakeClaudeScenario): Promise<void>;
