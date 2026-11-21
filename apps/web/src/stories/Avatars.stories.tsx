import type { Meta, StoryObj } from '@storybook/react-vite';
import { AVATAR_FACES, avatarVariant, HUMAN_TONES } from '@whombat/avatars';
import { HumanAvatar, WhombatAvatar } from '@whombat/avatars/react';
import { agentCharacter } from '@whombat/core';
import type { CSSProperties, ReactNode } from 'react';

const meta = {
  title: 'Foundations/Avatars',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The reference's ladder (Whombat five-agents.md FA-16): busts at 160, 64 and 40, the head at 32, the small head below. */
const AGENT_SIZES = [160, 64, 40, 32, 24, 16] as const;
const HUMAN_SIZES = [22, 24, 26, 28, 30, 32, 36, 40, 44] as const;

const caption: CSSProperties = { font: 'var(--type-mono-meta-small)', color: 'var(--mut)' };
const cell: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 };

function Grid({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `120px repeat(${columns}, max-content)`,
        alignItems: 'end',
        gap: '20px 28px',
        color: 'var(--ink)',
      }}
    >
      {children}
    </div>
  );
}

/** The reference's layout: the five faces as columns, each size a row (its file in the left column). */
function AgentGrid({ silhouette = false }: { silhouette?: boolean }) {
  return (
    <Grid columns={AVATAR_FACES.length}>
      <span />
      {AVATAR_FACES.map((face) => (
        <span key={face} style={caption}>
          {agentCharacter(face).name}
        </span>
      ))}
      {AGENT_SIZES.map((size) => (
        <SizeRow key={size} size={size} silhouette={silhouette} />
      ))}
    </Grid>
  );
}

function SizeRow({ size, silhouette }: { size: number; silhouette: boolean }) {
  return (
    <>
      <span style={{ ...caption, alignSelf: 'center' }}>
        {avatarVariant(size)} {size}
      </span>
      {AVATAR_FACES.map((face) => (
        <div key={face} style={cell}>
          <WhombatAvatar
            face={face}
            size={size}
            eager
            silhouette={silhouette}
            label={agentCharacter(face).name}
          />
        </div>
      ))}
    </>
  );
}

export const FiveFaces: Story = {
  name: 'Five faces',
  render: () => <AgentGrid />,
};

export const Silhouette: Story = {
  name: 'Silhouette (loading / unknown)',
  render: () => <AgentGrid silhouette />,
};

export const Humans: Story = {
  name: 'Human avatars',
  render: () => (
    <Grid columns={HUMAN_SIZES.length}>
      <span />
      {HUMAN_SIZES.map((s) => (
        <span key={s} style={caption}>
          {s}
        </span>
      ))}
      {HUMAN_TONES.map((tone, i) => {
        const initials = ['MO', 'JV', 'PR', 'TB', 'HK'][i] ?? 'MO';
        return <HumanRow key={tone} tone={tone} initials={initials} />;
      })}
    </Grid>
  ),
};

function HumanRow({ tone, initials }: { tone: string; initials: string }) {
  return (
    <>
      <span style={{ ...caption, alignSelf: 'center' }}>{tone}</span>
      {HUMAN_SIZES.map((s) => (
        <div key={s} style={cell}>
          <HumanAvatar initials={initials} tone={tone} size={s} />
        </div>
      ))}
    </>
  );
}
