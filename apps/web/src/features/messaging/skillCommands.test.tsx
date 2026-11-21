import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';
import { activeCommand, skillAddressNotice, skillCommandOf } from './model';

describe('skill commands in the model (SL-09, AP-212, AP-5235)', () => {
  it('reads skill names with digits and dashes as the `/` query', () => {
    expect(activeCommand('/3-state')).toEqual({ query: '3-state' });
    expect(activeCommand('/invoice check')).toBeNull();
  });

  it('reads a skill command at the start of a draft, with Hermes’s names', () => {
    expect(skillCommandOf('/invoice-check this one')).toEqual({ name: 'invoice-check' });
    expect(skillCommandOf('/home.assistant_v2')).toEqual({ name: 'home.assistant_v2' });
    expect(skillCommandOf('//invoice-check')).toBeNull();
    expect(skillCommandOf('check /invoice-check')).toBeNull();
  });

  it('says to mention the agent for one of its skills in a room where it wasn’t mentioned (AP-248)', () => {
    const own = [{ name: 'docx', agentId: 'prn_agent', agentName: ASSISTANT_NAME }];
    expect(skillAddressNotice('/docx the minutes', own, [])).toBe(`Mention @${ASSISTANT_NAME} to use /docx.`);
    expect(skillAddressNotice(`/docx the minutes @${ASSISTANT_NAME}`, own, ['prn_agent'])).toBeNull();
    // Not one of its skills: the command rules answer.
    expect(skillAddressNotice('/pptx', own, [])).toBeNull();
  });
});

describe('the composer’s skills (SL-09, AP-212)', () => {
  it('offers the agent’s skills after `/` in Chat, without naming who has them, and sends the draft as typed', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld();
    renderApp('/chat?new=1', mockedServices(fetch));
    const box = await screen.findByRole('textbox', { name: `Ask ${ASSISTANT_NAME} anything` });
    await user.type(box, '/arx');
    const list = await screen.findByRole('listbox', { name: 'Skills' });
    const option = await within(list).findByRole('option', { name: /\/arxiv/ });
    // One agent: no row says whose skill it is (one-agent.md AP-4949).
    expect(within(list).queryByText(/^@/)).toBeNull();
    await user.click(option);
    expect((box as HTMLTextAreaElement).value).toBe('/arxiv ');
    await user.type(box, 'papers on heat pumps{Enter}');
    await waitFor(() =>
      expect(
        calls.map((c) => c.body as { text?: string }).find((b) => b?.text?.startsWith('/arxiv')),
      ).toBeTruthy(),
    );
    const sent = calls
      .map((c) => c.body as Record<string, unknown>)
      .find((b) => String(b?.text).startsWith('/'));
    expect(sent?.text).toBe('/arxiv papers on heat pumps');
    expect(sent).not.toHaveProperty('skillHint');
  });
});
