import { WhombatLogo } from '@whombat/brand/react';
import { brandColors } from '@whombat/tokens';
import type { ReactNode } from 'react';
import { CopyButton } from '../../../components/CopyButton';
import { SectionLabel } from '../../../components/SectionLabel';
import { ThemeToggle } from '../../../components/ThemeToggle';
import styles from './BrandPage.module.css';
import { brandAsset, fileName } from './brandAssets';

/**
 * `/brand` — the logo package at hand: every logo on its light and dark ground, the colors, sizes, app
 * icons, favicons, link preview, type and rules, with a download for each file. Public and unlinked
 * (docs/decisions/brand.md BR-11); copy follows `packages/brand/assets/README.md`.
 */

interface Download {
  label: string;
  /** Package path (`svg/…`), or an absolute URL the web app serves (`/favicon.svg`). */
  path: string;
}

const LOGOS: {
  name: string;
  use: string;
  /** File stem before `-ink` / `-paper`. */
  stem: string;
  /** Width of the PNG exports, when there are any. */
  png?: number;
  /** Preview height in px. */
  height: number;
}[] = [
  {
    name: 'Horizontal logo',
    use: 'The primary logo.',
    stem: 'whombat-logo-horizontal',
    png: 2000,
    height: 56,
  },
  {
    name: 'Stacked logo',
    use: 'Square and centred formats.',
    stem: 'whombat-logo-stacked',
    png: 1200,
    height: 112,
  },
  { name: 'Symbol', use: 'Icon only, 48 px and up.', stem: 'whombat-symbol', png: 1024, height: 88 },
  {
    name: 'Small symbol',
    use: 'Icon only, 32 px and below: larger eyes and nose, no mouth or inner ears.',
    stem: 'whombat-symbol-small',
    height: 32,
  },
  {
    name: 'Wordmark',
    use: 'When the symbol is already on screen.',
    stem: 'whombat-wordmark',
    png: 2000,
    height: 44,
  },
];

const COLORS: { name: string; key: keyof typeof brandColors; use: string }[] = [
  { name: 'Burrow ink', key: 'ink', use: 'Logo on light grounds' },
  { name: 'Paper', key: 'paper', use: 'Logo on dark grounds, light ground' },
  { name: 'Night', key: 'night', use: 'Dark UI ground' },
  { name: 'Cocoa', key: 'cocoa', use: 'Alternate app icon tile' },
  { name: 'Muzzle cream', key: 'cream', use: 'Secondary light ground' },
];

const TILES: { name: string; tone: 'ink' | 'cocoa' | 'paper'; note: string }[] = [
  { name: 'Ink', tone: 'ink', note: 'Whombat’s app icon: iOS, Android and the web.' },
  { name: 'Cocoa', tone: 'cocoa', note: 'Alternate tile.' },
  { name: 'Paper', tone: 'paper', note: 'Alternate tile.' },
];

const SMALL_SIZES = [16, 20, 24, 32];
const LARGE_SIZES = [48, 64, 96];

const RULES = [
  'Clear space: the height of one ear on every side.',
  'Minimum size: symbol 16 px, horizontal logo 20 px tall.',
  'Switch to the small symbol at 32 px and below.',
  'One flat color only. Never recolor with agent accents, stretch, rotate or add effects.',
];

const HTML_SNIPPET = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta property="og:image" content="/whombat-og-1200x630.png">`;

const CODE_SNIPPET = `import { WhombatLogo } from '@whombat/brand/react';

<WhombatLogo height={16} />                                   // symbol; ≤ 32 px draws the small symbol
<WhombatLogo variant="lockup" height={24} label="Whombat" />  // horizontal logo

// Regenerate every web and mobile icon from the package:
// pnpm --filter @whombat/brand export-icons`;

const url = (path: string) => (path.startsWith('/') ? path : brandAsset(path));

function Downloads({ items }: { items: Download[] }) {
  return (
    <div className={styles.downloads}>
      {items.map((d) => (
        <a key={d.path} className={styles.download} href={url(d.path)} download={fileName(d.path)}>
          {d.label}
        </a>
      ))}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  const id = `brand-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <SectionLabel as="h2" id={id}>
          {title}
        </SectionLabel>
        {sub && <p className={styles.sectionSub}>{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function CodeBlock({ code, copied }: { code: string; copied: string }) {
  return (
    <div className={styles.codeWrap}>
      <pre className={styles.code}>
        <code>{code}</code>
      </pre>
      <CopyButton text={code} copied={copied} className={styles.copy}>
        Copy
      </CopyButton>
    </div>
  );
}

export function BrandPage() {
  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <WhombatLogo variant="lockup" height={23} label="Whombat" />
        <ThemeToggle />
      </header>

      <main className={styles.main}>
        <div className={styles.intro}>
          <span className={styles.kicker}>BRAND</span>
          <h1 className={styles.title}>The Whombat logo</h1>
          <p className={styles.sub}>
            A full-face symbol and a Bricolage Grotesque wordmark, in one flat color: burrow ink on light
            grounds, paper on dark ones. Every file below is the logo package as delivered.
          </p>
        </div>

        <Section title="Logo" sub="Transparent masters: -ink for light backgrounds, -paper for dark ones.">
          <div className={styles.logos}>
            {LOGOS.map((logo) => (
              <article key={logo.stem} className={styles.card}>
                <div className={styles.grounds}>
                  {(['ink', 'paper'] as const).map((tone) => (
                    <div
                      key={tone}
                      className={styles.ground}
                      style={{ background: tone === 'ink' ? brandColors.paper : brandColors.night }}
                    >
                      <img
                        src={brandAsset(`svg/${logo.stem}-${tone}.svg`)}
                        alt={`${logo.name}, ${tone}`}
                        style={{ height: logo.height }}
                      />
                    </div>
                  ))}
                </div>
                <div className={styles.cardBody}>
                  <div>
                    <h3 className={styles.cardTitle}>{logo.name}</h3>
                    <p className={styles.cardNote}>{logo.use}</p>
                  </div>
                  <Downloads
                    items={(['ink', 'paper'] as const).flatMap((tone) => [
                      { label: `SVG · ${tone}`, path: `svg/${logo.stem}-${tone}.svg` },
                      ...(logo.png
                        ? [
                            {
                              label: `PNG ${logo.png} · ${tone}`,
                              path: `png/${logo.stem}-${tone}-${logo.png}.png`,
                            },
                          ]
                        : []),
                    ])}
                  />
                </div>
              </article>
            ))}
          </div>
        </Section>

        <Section
          title="Colors"
          sub="In code: brandColors and the logo theme color in @whombat/tokens (--logo on the web)."
        >
          <div className={styles.swatches}>
            {COLORS.map((c) => {
              const hex = brandColors[c.key].toUpperCase();
              return (
                <div key={c.key} className={styles.swatch}>
                  <div className={styles.chip} style={{ background: brandColors[c.key] }} />
                  <div className={styles.swatchBody}>
                    <span className={styles.swatchName}>{c.name}</span>
                    <CopyButton text={hex} copied={`${c.name} ${hex} copied.`} className={styles.hex}>
                      {hex}
                    </CopyButton>
                    <span className={styles.swatchUse}>{c.use}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section
          title="Sizes"
          sub="The symbol at 32 px and below is the small symbol; from 48 px the full face."
        >
          <div className={styles.sizes}>
            {[...SMALL_SIZES, ...LARGE_SIZES].map((size) => (
              <figure key={size} className={styles.size}>
                <div className={styles.sizeBox}>
                  <WhombatLogo height={size} />
                </div>
                <figcaption className={styles.sizeLabel}>
                  {size} px{size <= 32 ? ' · small' : ''}
                </figcaption>
              </figure>
            ))}
          </div>
        </Section>

        <Section
          title="App icons"
          sub="Full-bleed square tiles; stores apply their own corner mask. The rounded SVGs are for previews and decks."
        >
          <div className={styles.tiles}>
            {TILES.map((t) => (
              <article key={t.tone} className={styles.tile}>
                <img
                  className={styles.tileImage}
                  src={brandAsset(`app-icon/whombat-app-icon-${t.tone}-rounded.svg`)}
                  alt={`${t.name} app icon`}
                />
                <div>
                  <h3 className={styles.cardTitle}>{t.name}</h3>
                  <p className={styles.cardNote}>{t.note}</p>
                </div>
                <Downloads
                  items={[
                    { label: 'SVG', path: `app-icon/whombat-app-icon-${t.tone}.svg` },
                    { label: 'SVG · rounded', path: `app-icon/whombat-app-icon-${t.tone}-rounded.svg` },
                    { label: 'PNG 1024', path: `app-icon/whombat-app-icon-${t.tone}-1024.png` },
                    { label: 'PNG 512', path: `app-icon/whombat-app-icon-${t.tone}-512.png` },
                  ]}
                />
              </article>
            ))}
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Platform exports (Ink)</span>
            <Downloads
              items={[
                { label: 'apple-touch-icon 180', path: 'app-icon/apple-touch-icon-180.png' },
                { label: 'android-chrome 192', path: 'app-icon/android-chrome-192.png' },
              ]}
            />
          </div>
        </Section>

        <Section
          title="Favicon"
          sub="favicon.ico holds 16, 32 and 48 px. The favicon.svg this site serves switches between ink and paper with the browser’s color scheme."
        >
          <div className={styles.favicons}>
            {[16, 32, 48].map((size) => (
              <figure key={size} className={styles.size}>
                <div className={styles.sizeBox}>
                  <img
                    src={brandAsset(`favicon/favicon-${size}.png`)}
                    alt={`Favicon, ${size} px`}
                    width={size}
                    height={size}
                  />
                </div>
                <figcaption className={styles.sizeLabel}>{size} px</figcaption>
              </figure>
            ))}
            <Downloads
              items={[
                { label: 'favicon.ico', path: 'favicon/favicon.ico' },
                { label: 'favicon.svg', path: '/favicon.svg' },
                { label: 'PNG 16', path: 'favicon/favicon-16.png' },
                { label: 'PNG 32', path: 'favicon/favicon-32.png' },
                { label: 'PNG 48', path: 'favicon/favicon-48.png' },
              ]}
            />
          </div>
        </Section>

        <Section title="Link preview" sub="Open Graph image, 1200 × 630.">
          <div className={styles.social}>
            <img
              className={styles.socialImage}
              src={brandAsset('social/whombat-og-1200x630.png')}
              alt="Whombat link preview"
            />
            <Downloads
              items={[
                { label: 'PNG', path: 'social/whombat-og-1200x630.png' },
                { label: 'SVG', path: 'social/whombat-og-1200x630.svg' },
              ]}
            />
          </div>
        </Section>

        <Section title="Type">
          <div className={styles.type}>
            <div className={styles.typeRow}>
              <img
                className={styles.typeSample}
                src={brandAsset('svg/whombat-wordmark-ink.svg')}
                alt="Whombat wordmark"
                data-tone="ink"
              />
              <img
                className={styles.typeSample}
                src={brandAsset('svg/whombat-wordmark-paper.svg')}
                alt=""
                data-tone="paper"
              />
              <p className={styles.cardNote}>
                Wordmark: Bricolage Grotesque ExtraBold (96 pt optical size), −3.5% tracking, outlined — no
                font install needed.
              </p>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.sansSample}>Bricolage Grotesque</span>
              <p className={styles.cardNote}>Interface: 400, 500, 600 and 700.</p>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.monoSample}>DM Mono</span>
              <p className={styles.cardNote}>Labels, code and meta: 400 and 500.</p>
            </div>
          </div>
        </Section>

        <Section title="Rules">
          <ul className={styles.rules}>
            {RULES.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </Section>

        <Section title="In a page">
          <CodeBlock code={HTML_SNIPPET} copied="HTML copied." />
        </Section>

        <Section title="In Whombat’s code" sub="packages/brand · docs/decisions/brand.md">
          <CodeBlock code={CODE_SNIPPET} copied="Code copied." />
        </Section>
      </main>
    </div>
  );
}
