import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  at,
  dusty,
  mara,
  msg_pr482_mara_1130,
  PRINCIPALS,
  reportCardOf,
  reportLikelyBug,
  SEED_NOW,
} from '@whombat/fixtures';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerProps, UPLOADS_UNAVAILABLE } from './Composer';
import { MessageRow } from './MessageRow';
import { principalLookup } from './model';

const lookup = principalLookup({ principals: PRINCIPALS });

function ControlledComposer(props: Partial<ComposerProps> & { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <Composer
      placeholder="Comment on PR #482"
      value={value}
      onValueChange={setValue}
      mentionables={PRINCIPALS}
      viewerId={mara.id}
      {...props}
    />
  );
}

describe('Composer', () => {
  it('has no @ list and no @ agent button: a message reaches the agent anyway (one-agent.md AP-4949)', async () => {
    const user = userEvent.setup();
    render(<ControlledComposer onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '@ agent' })).toBeNull();
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('ask @Wa');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('the / command chip lists the agent’s skills and fills the pick', async () => {
    const user = userEvent.setup();
    const skills = [
      {
        name: 'docx',
        description: 'Write Word files',
        agentId: dusty.id,
        agentName: 'Dusty',
        insert: '/docx ',
      },
      {
        name: 'xlsx',
        description: 'Read spreadsheets',
        agentId: dusty.id,
        agentName: 'Dusty',
        insert: '/xlsx ',
      },
    ];
    render(<ControlledComposer onSubmit={vi.fn()} skills={skills} />);
    await user.click(screen.getByRole('button', { name: '/ command' }));
    const list = screen.getByRole('listbox', { name: 'Skills' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining('/docx'), expect.stringContaining('/xlsx')]);
    await user.keyboard('{ArrowDown}{Enter}');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('/xlsx ');
  });

  it('corrects `@dusty` to `@Dusty` when the word ends, caret kept (AP-607, MS-C03)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ControlledComposer onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard('@dusty');
    expect(input.value).toBe('@dusty');
    await user.keyboard(' ');
    expect(input.value).toBe('@Dusty ');
    expect(input.selectionStart).toBe(7);
    await user.keyboard('hi');
    expect(input.value).toBe('@Dusty hi');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('@Dusty hi');
  });

  it('corrects in the middle of the text and keeps the caret there', async () => {
    const user = userEvent.setup();
    render(<ControlledComposer onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard('can you look, @pepper');
    await user.keyboard('{Home}');
    await user.keyboard('@MARA,');
    expect(input.value).toBe('@Mara,can you look, @pepper');
    expect(input.selectionStart).toBe(6);
  });

  it('leaves emails, unknown names, code and deletions as typed', async () => {
    const user = userEvent.setup();
    render(<ControlledComposer onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard('mail john@dusty.example or @nobody `@dusty` ');
    expect(input.value).toBe('mail john@dusty.example or @nobody `@dusty` ');
    await user.clear(input);
    await user.keyboard('@dusty{Backspace}y');
    expect(input.value).toBe('@dusty');
    await user.keyboard(' x{Backspace}');
    // The space corrected it; deleting the x doesn't undo or redo anything.
    expect(input.value).toBe('@Dusty ');
  });

  it('+ file is disabled with a tooltip while uploads are unavailable', async () => {
    render(<ControlledComposer onSubmit={vi.fn()} />);
    const file = screen.getByRole('button', { name: '+ file' });
    expect(file.getAttribute('aria-disabled')).toBe('true');
    expect(file.getAttribute('title')).toBe(UPLOADS_UNAVAILABLE);
  });
});

/** Mara's 10:02 in PR #482's room: a mention of the agent and a +1 that isn't hers (the agent's). */
const msg_pr482_mara_1002 = {
  ...msg_pr482_mara_1130,
  id: 'msg_pr482-mara-1002',
  createdAt: at('10:02'),
  text: 'Morning @Dusty, the VAT fix looks right to me.',
  mentions: [dusty.id],
  reactions: [{ value: '+1', count: 1, mine: false, principalIds: [dusty.id] }],
};

describe('MessageRow', () => {
  it('renders name, time, @mentions, reactions that toggle, and no thread link without replies', async () => {
    const user = userEvent.setup();
    const onReact = vi.fn();
    render(
      <MessageRow
        message={msg_pr482_mara_1002}
        author={lookup(msg_pr482_mara_1002.authorId)}
        lookup={lookup}
        timeZone="Europe/Amsterdam"
        now={SEED_NOW}
        onReact={onReact}
      />,
    );
    const row = screen.getByRole('article', { name: 'Mara Okafor, 10:02' });
    expect(within(row).getByText('@Dusty').className).toMatch(/mention/);
    const reaction = within(row).getByRole('button', { name: /^\+1, 1 reaction/ });
    expect(reaction.textContent).toBe('+1 · 1');
    expect(reaction.getAttribute('aria-pressed')).toBe('false');
    await user.click(reaction);
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ value: '+1', mine: false }));
    expect(within(row).queryByRole('link')).toBeNull();
  });

  it('links a thread as Slack does: faces, “2 replies”, “Last reply 1 hour ago” (AP-940, AP-941)', async () => {
    const message = {
      ...msg_pr482_mara_1002,
      replyCount: 2,
      threadParticipantIds: [msg_pr482_mara_1002.authorId],
      lastReplyAt: new Date(SEED_NOW.getTime() - 60 * 60_000).toISOString(),
    };
    const onOpenThread = vi.fn();
    render(
      <MessageRow
        message={message}
        author={lookup(message.authorId)}
        lookup={lookup}
        timeZone="Europe/Amsterdam"
        now={SEED_NOW}
        onOpenThread={onOpenThread}
      />,
    );
    // One row: no “View thread” on hover, the time stays.
    const link = screen.getByRole('link', { name: '2 replies Last reply 1 hour ago' });
    expect(link.getAttribute('href')).toBe(`?thread=${message.id}`);
    expect(within(link).queryByText('View thread')).toBeNull();
    await userEvent.setup().click(link);
    expect(onOpenThread).toHaveBeenCalledWith(message.id);
  });
});

describe('formatted messages', () => {
  it('renders the light Markdown agents write: bold lead-ins, lists, code, links, curly quotes', () => {
    const message = {
      ...msg_pr482_mara_1002,
      text: [
        "Here's today's inbox, 7 unread:",
        '',
        '**Worth a look**',
        '- **CI failed** on main: `CI / check` with 4 annotations',
        '- See [the run](https://github.com/acme/Whombat/actions)',
        '',
        '@Dusty can you look?',
      ].join('\n'),
      reactions: [],
    };
    render(
      <MessageRow
        message={message}
        author={lookup(message.authorId)}
        lookup={lookup}
        timeZone="Europe/Amsterdam"
        now={SEED_NOW}
      />,
    );
    const row = screen.getByRole('article', { name: 'Mara Okafor, 10:02' });
    expect(within(row).getByText('Here’s today’s inbox, 7 unread:').tagName).toBe('P');
    expect(within(row).getByText('Worth a look').tagName).toBe('STRONG');
    const items = within(row).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'CI failed on main: CI / check with 4 annotations',
      'See the run',
    ]);
    expect(within(row).getByText('CI / check').tagName).toBe('CODE');
    const link = within(row).getByRole('link', { name: 'the run' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/Whombat/actions');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(row).getByText('@Dusty').className).toMatch(/mention/);
    expect(row.textContent).not.toContain('**');
  });
});

describe('a report’s message (docs/decisions/report-rows.md RR-04, RR-05)', () => {
  const card = reportCardOf(reportLikelyBug);
  const report = (text: string) => ({
    ...msg_pr482_mara_1002,
    text,
    card,
    reactions: [],
    attachments: [
      {
        id: 'att_fb-vat-pdf',
        name: 'invoice-pdf.png',
        contentType: 'image/png',
        size: 184_220,
        url: '/api/v1/burrows/burrow-hq/attachments/att_fb-vat-pdf',
        kind: 'image' as const,
        width: 1280,
        height: 800,
      },
    ],
  });
  const row = (text: string, slot: boolean) =>
    render(
      <MessageRow
        message={report(text)}
        author={lookup(msg_pr482_mara_1002.authorId)}
        lookup={lookup}
        timeZone="Europe/Amsterdam"
        now={SEED_NOW}
        card={slot ? <p>The report row</p> : undefined}
      />,
    );

  it('leaves out the standard header and the screenshots beside the row', () => {
    row('Bug report FB-7K3Q-9M2X · Burrow Billing', true);
    expect(screen.queryByText('Bug report FB-7K3Q-9M2X · Burrow Billing')).toBeNull();
    expect(screen.getByText('The report row')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open invoice-pdf.png' })).toBeNull();
  });

  it('keeps other words, and everything when no card shows', () => {
    const { unmount } = row('Look at this one first', true);
    expect(screen.getByText('Look at this one first')).toBeTruthy();
    unmount();
    row('Bug report FB-7K3Q-9M2X · Burrow Billing', false);
    expect(screen.getByText('Bug report FB-7K3Q-9M2X · Burrow Billing')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open invoice-pdf.png' })).toBeTruthy();
  });
});
