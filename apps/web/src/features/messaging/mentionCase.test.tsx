/**
 * Mentions in any letter case on the fixture world (docs/decisions/app-managed.md AP-607; Whombat messaging.md
 * MS-C01…MS-C03): the composer, the thread's reply box and the edit box correct `@neo ` to `@Neo ` as it is typed, and
 * what is sent is canonical, so the optimistic message shows `@Neo` as a mention. There is no `@` list (one-agent.md
 * AP-4949); the branch room is one of the person's conversations with the agent.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { __holdFixtureRepliesForTests, __setFixtureReplyDelayForTests } from './useRoom';

afterEach(() => {
  __setFixtureReplyDelayForTests(null);
});

pinMockDate();

/** The `@Name` segment of a message: its own element, brand/600 (`segmentMentions`). */
const mentionIn = (scope: HTMLElement, name: string) =>
  within(scope)
    .queryAllByText(`@${name}`)
    .find((el) => el.tagName !== 'TEXTAREA');

describe('mentions in any letter case', () => {
  it('the composer corrects as you type, and sends the canonical text', async () => {
    const release = __holdFixtureRepliesForTests();
    const user = userEvent.setup();
    renderApp('/pr/482');
    const input = (await screen.findByRole('textbox', {
      name: 'Comment on PR #482',
    })) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard(`@${ASSISTANT_NAME.toLowerCase()} `);
    expect(input.value).toBe(`@${ASSISTANT_NAME} `);
    await user.keyboard('any receipts on rounding?{Enter}');
    expect(await screen.findByText('any receipts on rounding?', { exact: false })).toBeTruthy();
    expect(input.value).toBe('');
    release();
  });

  it('a pasted lowercase mention is sent canonical (the optimistic message too)', async () => {
    const release = __holdFixtureRepliesForTests();
    const user = userEvent.setup();
    renderApp('/pr/482');
    const input = await screen.findByRole('textbox', { name: 'Comment on PR #482' });
    await user.click(input);
    const lower = `@${ASSISTANT_NAME.toLowerCase()}`;
    await user.paste(`${lower} did the rounding receipts land?`);
    expect((input as HTMLTextAreaElement).value).toBe(`${lower} did the rounding receipts land?`);
    await user.keyboard('{Enter}');
    const text = await screen.findByText('did the rounding receipts land?', { exact: false });
    const body = text.parentElement as HTMLElement;
    expect(mentionIn(body, ASSISTANT_NAME)).toBeTruthy();
    expect(body.textContent).toContain(`@${ASSISTANT_NAME} did the rounding receipts land?`);
    release();
  });

  it('the thread’s reply box corrects too', async () => {
    const release = __holdFixtureRepliesForTests();
    const user = userEvent.setup();
    renderApp('/pr/482?thread=msg_billing-mara-1127', fixtureServices({ essentials: true }));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const box = (await within(pane).findByRole('textbox', {
      name: 'Reply in thread',
    })) as HTMLTextAreaElement;
    await user.type(box, `thanks @${ASSISTANT_NAME.toUpperCase()}, `);
    expect(box.value).toBe(`thanks @${ASSISTANT_NAME}, `);
    await user.type(box, 'nice.{Enter}');
    const reply = await within(pane).findByText('nice.', { exact: false });
    expect(mentionIn(reply.parentElement as HTMLElement, ASSISTANT_NAME)).toBeTruthy();
    release();
  });

  it('the edit box corrects as you type', async () => {
    const release = __holdFixtureRepliesForTests();
    const user = userEvent.setup();
    renderApp('/pr/482', fixtureServices({ essentials: true }));
    const row = await screen.findByRole('article', { name: 'Mara Okafor, 11:26' });
    await user.click(within(row).getByRole('button', { name: 'More actions for Mara Okafor’s message' }));
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit message' }));
    const editor = within(row).getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement;
    await user.clear(editor);
    await user.type(editor, `@${ASSISTANT_NAME.toLowerCase()} `);
    expect(editor.value).toBe(`@${ASSISTANT_NAME} `);
    await user.type(editor, 'the review is on Friday.{Enter}');
    const text = await within(row).findByText('the review is on Friday.', { exact: false });
    expect(mentionIn(text.parentElement as HTMLElement, ASSISTANT_NAME)).toBeTruthy();
    release();
  });
});
