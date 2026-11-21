/**
 * A Hermes tool call at Ask as a `run_command` card (contracts 0.125, CT-1236; Whombat hermes-engine.md HE-44): the
 * categories `web` and `browser`, their keys, their rank and their words.
 */
import { describe, expect, it } from 'vitest';
import { RunCommandAction } from '../domain/approval.js';
import { runCommandPhrase } from '../keys/actions.js';
import { classifyCommand } from './classify.js';
import {
  COMMAND_CATEGORIES,
  COMMAND_CATEGORY_KEYS,
  COMMAND_CATEGORY_RANK,
  commandCategoryKey,
  moreSevereCategory,
} from './commands.js';
import {
  COMMAND_CATEGORY_LABELS,
  commandAllowedText,
  commandBlockedText,
  commandDeclinedText,
  commandWaitingText,
} from './copy.js';

describe('web and browser categories', () => {
  it('need the web and browser keys and rank least severe', () => {
    expect(COMMAND_CATEGORIES).toEqual(expect.arrayContaining(['web', 'browser']));
    expect(COMMAND_CATEGORY_KEYS.web).toBe('web.browse');
    expect(commandCategoryKey('browser')).toBe('browser.use');
    expect(COMMAND_CATEGORY_RANK.slice(-2)).toEqual(['browser', 'web']);
    expect(moreSevereCategory('web', 'destructive')).toBe('destructive');
    expect(moreSevereCategory('web', 'browser')).toBe('browser');
  });

  it('are never what the classifier finds', () => {
    for (const command of ['curl https://example.com', 'wget example.com', 'chromium https://example.com'])
      expect(['web', 'browser']).not.toContain(classifyCommand(command, { productionServers: [] })?.category);
  });

  it('ride the run_command card unchanged', () => {
    const action = RunCommandAction.parse({
      type: 'run_command',
      params: { command: 'web_search', category: 'web', target: null, reason: 'opening hours' },
    });
    expect(action.params.category).toBe('web');
  });

  it('say what happens in plain words, with the host when there is one', () => {
    expect(runCommandPhrase('web', null)).toBe('look something up on the web');
    expect(runCommandPhrase('web', 'example.com')).toBe('open example.com');
    expect(runCommandPhrase('browser', null)).toBe('use the browser');
    expect(runCommandPhrase('browser', 'example.com')).toBe('open example.com in the browser');
    expect(COMMAND_CATEGORY_LABELS.web).toMatch(/web/);
    expect(COMMAND_CATEGORY_LABELS.browser).toMatch(/browser/);
  });

  it('never call a tool call a command', () => {
    for (const category of ['web', 'browser'] as const) {
      expect(commandWaitingText(category)).not.toContain('command');
      expect(commandBlockedText(category, 'Dusty')).not.toContain('command');
      expect(commandBlockedText(category, 'Dusty')).toContain('Dusty');
      expect(commandDeclinedText('Mara', category)).not.toContain('command');
      expect(commandDeclinedText('Mara', category)).toMatch(/^Mara said no/);
    }
    expect(commandWaitingText('web')).toContain('Browse the web');
    expect(commandWaitingText('destructive')).toContain('This command');
    expect(commandDeclinedText('Mara')).toContain('command');
    expect(commandDeclinedText('Mara', 'deploy')).toContain('command');
    expect(commandAllowedText('task', 'Mara')).toContain('Mara');
  });
});
