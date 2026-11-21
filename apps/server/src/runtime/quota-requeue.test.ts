/** What the agent says when its turn carries on after a usage limit's reset (docs/decisions/resourceful-agents.md RA-32). */
import { describe, expect, it } from 'vitest';
import { carriesOnText } from './failure';

describe('a usage limit’s message', () => {
  it('says the agent carries on after the reset instead of asking for Try again', () => {
    expect(
      carriesOnText(
        'I stopped because the Claude usage limit was reached. It resets at 14:00; press Try again after that.',
      ),
    ).toBe('I stopped because the Claude usage limit was reached. It resets at 14:00; I’ll carry on then.');
    expect(carriesOnText('Something else.')).toBe('Something else. I’ll carry on once it resets.');
  });
});
