import type { Meta, StoryObj } from '@storybook/react-vite';
import { PRINCIPALS, SEED_NOW } from '@whombat/fixtures';
import type { ReactNode } from 'react';
import { richMessages } from '../../app/richFixtures';
import { MessageList } from './MessageList';
import { principalLookup } from './model';

/**
 * Rich messages (assignment item 8, AP-320…AP-329): the agent's logo page as a fenced `html` block and as an `.html`
 * attachment, a heading with a table and a task list, a Mermaid diagram, highlighted code with a nested quote, and a
 * gallery, a PDF and audio. The same messages as `VITE_FIXTURE_RICH=1` in fixture mode.
 */
const lookup = principalLookup({ principals: PRINCIPALS });
const TZ = 'Europe/Amsterdam';

function Column({ children, width }: { children: ReactNode; width: number }) {
  return (
    <div style={{ width, minHeight: '100vh', background: 'var(--bg)', color: 'var(--ink)' }}>{children}</div>
  );
}

function Rich({ width = 1184 }: { width?: number }) {
  return (
    <Column width={width}>
      <MessageList
        messages={richMessages()}
        lookup={lookup}
        timeZone={TZ}
        now={SEED_NOW}
        onReact={() => {}}
        threadHref={(m) => `?thread=${m.id}`}
      />
    </Column>
  );
}

const meta = {
  title: 'Messaging/Rich messages',
  component: Rich,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Rich>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = { name: 'Channel · light', globals: { theme: 'light' } };
export const Dark: Story = { name: 'Channel · dark', globals: { theme: 'dark' } };
export const Phone: Story = { name: 'Phone width', args: { width: 390 }, globals: { theme: 'light' } };
