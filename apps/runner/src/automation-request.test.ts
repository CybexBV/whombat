/**
 * An automation's request (docs/decisions/concise-replies.md CNR-08, CNR-10): its turn names the automation and says its
 * reply is what the automation continues with; the reminder to answer in a few plain sentences is `whombat.md`'s.
 */
import { describe, expect, it } from 'vitest';
import { AUTOMATION_REPLY_LINE, turnPrompt, whombatMd } from './prompt';
import { testContext } from './test-context';

const base = testContext();

describe('an automation’s request', () => {
  it('says the reply is what the automation continues with; other turns don’t', () => {
    const line = 'your reply is what the automation continues with';
    expect(turnPrompt(testContext({ dispatch: { ...base.dispatch, trigger: 'automation' } }))).toContain(
      line,
    );
    expect(turnPrompt(base)).not.toContain(line);
  });

  it('asks for a few plain sentences in every session’s whombat.md', () => {
    expect(whombatMd(base)).toContain(AUTOMATION_REPLY_LINE);
    expect(AUTOMATION_REPLY_LINE).toContain('one to three plain sentences');
  });
});
