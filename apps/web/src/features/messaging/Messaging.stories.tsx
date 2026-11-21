import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  cnv_pr482,
  MESSAGES_BY_CONVERSATION,
  mara,
  msg_dm_dusty_dusty_0941,
  PRINCIPALS,
  SEED_NOW,
  THREAD_REPLIES,
} from '@whombat/fixtures';
import { type ReactNode, useState } from 'react';
import { Composer } from './Composer';
import { ConversationHeader } from './ConversationHeader';
import { MessageList } from './MessageList';
import { principalLookup } from './model';
import { ThreadView } from './ThreadView';

/**
 * The conversation building blocks on the mock world (`@whombat/fixtures`), in the main column's
 * frame (1184px wide at 1440). Cards render through `features/cards` in the app and are left out here.
 */
const lookup = principalLookup({ principals: PRINCIPALS });
const TZ = 'Europe/Amsterdam';

function Column({ children, width = 1184 }: { children: ReactNode; width?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width,
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--ink)',
      }}
    >
      {children}
    </div>
  );
}

function ComposerDemo({ placeholder }: { placeholder: string }) {
  const [value, setValue] = useState('');
  return (
    <Composer
      placeholder={placeholder}
      value={value}
      onValueChange={setValue}
      onSubmit={() => setValue('')}
      mentionables={PRINCIPALS}
      viewerId={mara.id}
    />
  );
}

function Conversation({ typing = [] as string[] }) {
  return (
    <Column>
      <ConversationHeader
        variant={{
          kind: 'branch',
          title: cnv_pr482.title,
          topic: cnv_pr482.topic,
          status: { label: 'Open · changes requested', tone: 'warn' },
        }}
      />
      <div style={{ flex: 1 }}>
        <MessageList
          messages={MESSAGES_BY_CONVERSATION.cnv_pr482 ?? []}
          lookup={lookup}
          timeZone={TZ}
          now={SEED_NOW}
          onReact={() => {}}
          threadHref={(m) => `?thread=${m.id}`}
          typing={typing}
        />
      </div>
      <ComposerDemo placeholder="Comment on PR #482" />
    </Column>
  );
}

function Thread() {
  const [draft, setDraft] = useState('');
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', height: '100vh', background: 'var(--bg)' }}>
      <aside
        style={{ display: 'flex', width: 400, borderLeft: '1px solid var(--line)', color: 'var(--ink)' }}
      >
        <ThreadView
          messages={[
            { ...msg_dm_dusty_dusty_0941, text: 'Compared three PDF libraries. Short version: Typeset.' },
            ...THREAD_REPLIES,
          ]}
          where="Chat"
          topic="PDF libraries"
          lookup={lookup}
          timeZone={TZ}
          onClose={() => {}}
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => setDraft('')}
        />
      </aside>
    </div>
  );
}

const meta = {
  title: 'Messaging/Conversation',
  component: Conversation,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Conversation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RoomLight: Story = { name: 'Room · light', globals: { theme: 'light' } };
export const RoomDark: Story = { name: 'Room · dark', globals: { theme: 'dark' } };
export const AgentThinking: Story = {
  name: 'Agent thinking',
  args: { typing: ['Banjo is thinking'] },
};
export const ThreadLight: Story = {
  name: 'Thread pane · light',
  render: () => <Thread />,
  globals: { theme: 'light' },
};
export const ThreadDark: Story = {
  name: 'Thread pane · dark',
  render: () => <Thread />,
  globals: { theme: 'dark' },
};
/** Type `/` for commands; Enter sends (clears), Shift+Enter adds a line. */
export const ComposerOnly: Story = {
  name: 'Composer',
  render: () => (
    <Column>
      <div style={{ flex: 1 }} />
      <ComposerDemo placeholder="Comment on PR #482" />
    </Column>
  ),
};
