import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  breakpoints,
  codeColors,
  contentWidths,
  FACES,
  facePalettes,
  fixedColors,
  humanTones,
  kebab,
  layout,
  radii,
  shadows,
  spacing,
  statusColors,
  THEMES,
  type ThemeColors,
  themeColors,
  typeScale,
} from '@whombat/tokens';
import type { CSSProperties, ReactNode } from 'react';

const meta = {
  title: 'Foundations/Tokens',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const mono: CSSProperties = { font: 'var(--type-mono-meta-small)', color: 'var(--mut)' };
const h2: CSSProperties = {
  margin: '0 0 14px',
  font: 'var(--type-header-title)',
  letterSpacing: 'var(--type-header-title-tracking)',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={h2}>{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ color, label, note }: { color: string; label: string; note?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span
        style={{
          width: 36,
          height: 36,
          flex: 'none',
          borderRadius: 10,
          background: color,
          border: '1px solid var(--line)',
        }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
        {note && <span style={mono}>{note}</span>}
      </span>
    </div>
  );
}

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 14,
};

/** Theme colors in both themes side by side (each column sets its own `data-theme`). */
export const Colors: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
      {THEMES.map((theme) => (
        <div
          key={theme}
          data-theme={theme}
          style={{ background: 'var(--bg)', color: 'var(--ink)', padding: 24, borderRadius: 16 }}
        >
          <h2 style={h2}>{theme}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(Object.keys(themeColors[theme]) as (keyof ThemeColors)[]).map((name) => (
              <Swatch
                key={name}
                color={`var(--${name})`}
                label={`--${name}`}
                note={themeColors[theme][name]}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};

export const FixedColors: Story = {
  render: () => (
    <>
      <Section title="Status and presence">
        <div style={grid}>
          {Object.entries(statusColors).map(([k, v]) => (
            <Swatch key={k} color={v} label={`--status-${k}`} note={v} />
          ))}
          {Object.entries(fixedColors).map(([k, v]) => (
            <Swatch key={k} color={v} label={`--${kebab(k)}`} note={v} />
          ))}
        </div>
      </Section>
      <Section title="Human avatar tones">
        <div style={grid}>
          {humanTones.map((v, i) => (
            <Swatch key={v} color={v} label={`--tone-${i + 1}`} note={v} />
          ))}
        </div>
      </Section>
      <Section title="Code block">
        <div
          style={{
            borderRadius: 16,
            background: 'var(--code)',
            padding: '18px 0',
            font: '400 13px/1.7 var(--font-mono)',
          }}
        >
          {(
            [
              ['11:22:04', '$ pnpm test invoice', codeColors.command],
              ['11:22:09', '✓ formats Dutch amounts', codeColors.pass],
              ['11:22:10', '✗ rounds VAT before formatting', codeColors.fail],
              ['11:22:11', '  const net = lineTotal(item)', codeColors.text],
            ] as const
          ).map(([at, text, color]) => (
            <div key={at} style={{ display: 'grid', gridTemplateColumns: '52px 1fr', padding: '2px 20px' }}>
              <span style={{ color: codeColors.timestamp }}>{at}</span>
              <span style={{ color, whiteSpace: 'pre-wrap' }}>{text}</span>
            </div>
          ))}
          <div style={{ padding: '2px 20px', background: codeColors.removedBg, color: codeColors.removed }}>
            - const shown = formatEuro(net * vatRate)
          </div>
          <div style={{ padding: '2px 20px', background: codeColors.addedBg, color: codeColors.added }}>
            + const vat = roundVat(net * vatRate)
          </div>
        </div>
      </Section>
    </>
  ),
};

export const Faces: Story = {
  render: () => (
    <Section title="The agent’s faces">
      <div style={grid}>
        {FACES.map((face) => {
          const p = facePalettes[face];
          return (
            <div key={face} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Swatch color={p.accent} label={p.name} note={`--face-${face} ${p.accent}`} />
              <Swatch color={p.deep} label="deep" note={`--face-${face}-deep ${p.deep}`} />
            </div>
          );
        })}
      </div>
    </Section>
  ),
};

export const TypeScale: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {Object.entries(typeScale).map(([name, style]) => {
        const v = `--type-${kebab(name)}`;
        return (
          <div
            key={name}
            style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, alignItems: 'baseline' }}
          >
            <span style={mono}>
              {v}
              <br />
              {style.size}px / {style.weight}
              {'lineHeight' in style ? ` / ${style.lineHeight}` : ''}
              {'tracking' in style ? ` / ${style.tracking}em` : ''}
            </span>
            <span
              style={{
                font: `var(${v})`,
                letterSpacing: `var(${v}-tracking)`,
                textTransform: 'uppercase' in style ? 'uppercase' : undefined,
              }}
            >
              Invoice PDF export
            </span>
          </div>
        );
      })}
    </div>
  ),
};

export const RadiiShadowsSpacing: Story = {
  render: () => (
    <>
      <Section title="Radii">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
          {Object.entries(radii).map(([name, px]) => (
            <div
              key={name}
              style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}
            >
              <span
                style={{
                  width: 72,
                  height: 72,
                  background: 'var(--sf2)',
                  border: '1px solid var(--line2)',
                  borderRadius: `var(--radius-${kebab(name)})`,
                }}
              />
              <span style={mono}>
                {kebab(name)} {px}
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Shadows">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 40, padding: '10px 30px 60px' }}>
          {Object.keys(shadows).map((name) => (
            <div
              key={name}
              style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}
            >
              <span
                style={{
                  width: name === 'liveHalo' ? 12 : 160,
                  height: name === 'liveHalo' ? 12 : 100,
                  borderRadius: name === 'liveHalo' ? '50%' : 14,
                  background: name === 'liveHalo' ? 'var(--status-working)' : 'var(--bg)',
                  boxShadow: `var(--shadow-${kebab(name)})`,
                }}
              />
              <span style={mono}>--shadow-{kebab(name)}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Spacing">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {spacing.map((px) => (
            <div key={px} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ ...mono, width: 90 }}>--space-{px}</span>
              <span style={{ width: `var(--space-${px})`, height: 12, background: 'var(--brand)' }} />
            </div>
          ))}
        </div>
      </Section>
      <Section title="Layout">
        <div style={{ ...mono, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Object.entries(contentWidths).map(([k, v]) => (
            <span key={k}>
              --max-{kebab(k)}: {v}px
            </span>
          ))}
          {Object.entries(layout).map(([k, v]) => (
            <span key={k}>
              --size-{kebab(k)}: {v}px
            </span>
          ))}
          {Object.entries(breakpoints).map(([k, v]) => (
            <span key={k}>
              --bp-{kebab(k)}: {v}px
            </span>
          ))}
        </div>
      </Section>
    </>
  ),
};
