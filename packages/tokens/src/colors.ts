/**
 * Color tokens. Values are copied verbatim from the `THEMES` objects in
 * `docs/design-handoff/design/Whombat Desktop.dc.html` and `Whombat Mobile.dc.html`,
 * and from the README "Colors" section.
 */
import type { ThemeName } from './themes.js';

/** The logo package's colors (packages/brand/assets/README.md). The logo is one flat color: ink or paper. */
export const brandColors = {
  /** Burrow ink: the logo on light grounds, the app icon tile. */
  ink: '#2b221d',
  /** Paper: the logo on dark grounds. */
  paper: '#f5f2ed',
  /** Night: dark UI ground. */
  night: '#1c1815',
  /** Cocoa: alternate app icon tile. */
  cocoa: '#7d6353',
  /** Muzzle cream: secondary light ground. */
  cream: '#dcc6ab',
} as const;

/** Theme-dependent colors. CSS variable name = key (`--bg`, `--sf2`, …), same as the reference. */
export interface ThemeColors {
  /** App background. */
  bg: string;
  /** Sidebar, secondary panes. */
  side: string;
  /** Cards, inputs. */
  sf: string;
  /** Chips, badges, tracks. */
  sf2: string;
  /** Primary text. */
  ink: string;
  /** Body text. */
  ink2: string;
  /** Meta text. */
  mut: string;
  /** Dividers, card borders. */
  line: string;
  /** Input and button borders. */
  line2: string;
  /** Links, @mentions, sha. */
  brand: string;
  /** Primary button, active chips. */
  btn: string;
  /** Text on `btn`. */
  btnfg: string;
  /** Code and log blocks. */
  code: string;
  /** Success, additions. */
  ok: string;
  /** Needs a person, pending. */
  warn: string;
  /** Errors, deletions, declined. */
  bad: string;
  /** Sidebar hover / selected row. */
  sel: string;
  /** Modal overlay. */
  ov: string;
  /** Live-edit highlight on canvas. */
  hi: string;
  /** Canvas highlight, researcher. */
  mark: string;
  /** Canvas highlight, reviewer. */
  mark2: string;
  /** Mobile: incoming chat bubble (mobile THEMES `bubble`). */
  bubble: string;
  /** The Whombat logo: burrow ink on light, paper on dark (never an accent). */
  logo: string;
}

export const themeColors: Record<ThemeName, ThemeColors> = {
  light: {
    bg: '#fbf9f5',
    side: '#f3eee6',
    sf: '#fffdf9',
    sf2: '#f1ece4',
    ink: '#221d18',
    ink2: '#3d352e',
    mut: '#6e655c',
    line: 'rgba(34,29,24,.09)',
    line2: 'rgba(34,29,24,.18)',
    brand: '#7d6353',
    btn: '#221d18',
    btnfg: '#f5f2ed',
    code: '#2b221d',
    ok: '#3e7b58',
    warn: '#8d6d2d',
    bad: '#9f5540',
    sel: 'rgba(34,29,24,.06)',
    ov: 'rgba(34,29,24,.32)',
    hi: 'rgba(84,145,196,.1)',
    mark: 'rgba(143,127,201,.16)',
    mark2: 'rgba(201,118,95,.14)',
    bubble: '#ece5da',
    logo: brandColors.ink,
  },
  dark: {
    bg: '#1c1815',
    side: '#171411',
    sf: '#24201c',
    sf2: '#2e2925',
    ink: '#f1ebe3',
    ink2: '#d8cfc4',
    mut: '#a0958a',
    line: 'rgba(255,255,255,.08)',
    line2: 'rgba(255,255,255,.16)',
    brand: '#d2b49a',
    btn: '#f1ebe3',
    btnfg: '#1c1815',
    code: '#120f0d',
    ok: '#6fcf97',
    warn: '#e0b75e',
    bad: '#e59a85',
    sel: 'rgba(255,255,255,.07)',
    ov: 'rgba(0,0,0,.55)',
    hi: 'rgba(84,145,196,.16)',
    mark: 'rgba(143,127,201,.24)',
    mark2: 'rgba(201,118,95,.22)',
    bubble: '#3a332d',
    logo: brandColors.paper,
  },
};

/**
 * Status words as text on any surface, pills and chips on `sf2` included, where `warn` and `ok` fail 4.5:1 in light (CSS
 * `--warn-text`, `--ok-text`; ui-refresh-status.md). Light takes warn and ok toward ink; dark passes as it is. Apart from
 * `ThemeColors` like the charts', so the feedback widget's bundle doesn't carry them.
 */
export interface StatusTextColors {
  warnText: string;
  okText: string;
}

export const statusTextColors: Record<ThemeName, StatusTextColors> = {
  light: { warnText: '#765b27', okText: '#36694a' },
  dark: { warnText: '#e0b75e', okText: '#6fcf97' },
};

/**
 * Chart series in fixed order (box-status.md): blue, orange, green — download/received/processor, upload/sent, the
 * third disk part — then violet (dashboards.md DS-18; app dashboards-client.md AP-2001: memory, disk writes, a fourth
 * series), and the opacity of an area wash under a line. Validated as a categorical set on `sf` in each theme
 * (lightness band, chroma, colour-blind separation of every pair, 3:1 against the surface). Marks only, never text.
 * Apart from `ThemeColors` so the feedback widget, which bundles those, stays within its size budget.
 */
export interface ChartColors {
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  /** A number as a string (`0.1`). */
  chartWash: string;
}

export const chartColors: Record<ThemeName, ChartColors> = {
  light: { chart1: '#3a78bd', chart2: '#d9762f', chart3: '#1e9a72', chart4: '#6e3bb4', chartWash: '0.1' },
  dark: { chart1: '#4a8ad0', chart2: '#d06a28', chart3: '#1f9a70', chart4: '#8450d4', chartWash: '0.16' },
};

/**
 * The council's room (app council-web.md, council-phone.md): the burrow behind the elders, the lamp light in it, the
 * table they sit at and the plaques on it. The plaques are paper in both themes, so their words are dark in both; each
 * word colour is at least 4.5:1 on `plaque` and `plaqueQuiet` (contrast.test.ts). Apart from `ThemeColors` like the
 * charts', so the feedback widget's bundle doesn't carry them.
 */
export interface CouncilRoomColors {
  roomTop: string;
  roomBottom: string;
  /** The burrow's inner shadow under its arch. */
  roomShade: string;
  /** The lamp's glow over the elders' heads. */
  roomLamp: string;
  woodTop: string;
  wood: string;
  woodEdge: string;
  plaque: string;
  /** A member that didn't answer, failed or was stopped. */
  plaqueQuiet: string;
  plaqueInk: string;
  plaqueMut: string;
  plaqueOk: string;
  plaqueWarn: string;
}

export const councilRoomColors: Record<ThemeName, CouncilRoomColors> = {
  light: {
    roomTop: '#eadfcf',
    roomBottom: '#d9c6ad',
    roomShade: 'rgba(90,62,38,.16)',
    roomLamp: 'rgba(255,226,160,.75)',
    woodTop: '#c49565',
    wood: '#a77748',
    woodEdge: '#7e5530',
    plaque: '#fffaf1',
    plaqueQuiet: '#ece3d6',
    plaqueInk: '#2b221d',
    plaqueMut: '#655547',
    plaqueOk: '#33633f',
    plaqueWarn: '#6f5524',
  },
  dark: {
    roomTop: '#2d251f',
    roomBottom: '#3a2e24',
    roomShade: 'rgba(0,0,0,.35)',
    roomLamp: 'rgba(243,201,94,.22)',
    woodTop: '#8a6040',
    wood: '#6c4a30',
    woodEdge: '#4a311f',
    plaque: '#f3ead9',
    plaqueQuiet: '#d6cab6',
    plaqueInk: '#2b221d',
    plaqueMut: '#55473b',
    plaqueOk: '#2c5a3a',
    plaqueWarn: '#5f4920',
  },
};

/** Text colors inside code/log blocks (always on the dark `code` surface, same in both themes). */
export const codeColors = {
  text: '#ece4d9',
  added: '#9fd7b4',
  addedBg: 'rgba(90,163,122,.18)',
  removed: '#f0a893',
  removedBg: 'rgba(201,118,95,.2)',
  /** `$ command` lines. */
  command: '#b8ada1',
  /** `✓` lines. */
  pass: '#8fd1a8',
  /** `✗` lines. */
  fail: '#f0a893',
  timestamp: '#7e746a',
  /*
   * Syntax highlighting in message code blocks (web; highlight.js scopes, AP-322). Warm, low-saturation hues on the
   * dark `code` surface, each at least 4.5:1 on both themes' `code` (contrast.test.ts).
   */
  /** Keywords, built-ins. */
  syntaxKeyword: '#e8a47c',
  /** Strings, regular expressions. */
  syntaxString: '#b3d59a',
  /** Numbers, literals (`true`, `null`), symbols. */
  syntaxNumber: '#e0c078',
  /** Comments. */
  syntaxComment: '#9d9185',
  /** Function and class names, section titles. */
  syntaxTitle: '#9cc7e6',
  /** Types, classes, selectors. */
  syntaxType: '#d9aad2',
  /** Attributes, properties, variables. */
  syntaxAttr: '#e6cc98',
  /** Tags, names in markup. */
  syntaxTag: '#f0a893',
  /** Meta: preprocessor lines, doctype, annotations. */
  syntaxMeta: '#b8ada1',
} as const;

export type AgentStatus = 'working' | 'waiting' | 'idle';

/** Agent status dots (fixed, same in both themes). */
export const statusColors: Record<AgentStatus, string> = {
  working: '#6fcf97',
  waiting: '#d9a84a',
  idle: '#a0958a',
};

/** Fixed colors that do not change with the theme. */
export const fixedColors = {
  /** Online presence dot. */
  presence: '#6fcf97',
  /** Halo around the live run dot. */
  liveHalo: 'rgba(111,207,151,.22)',
  /** Run progress bar fill and the "active" plan/run step marker (developer accent). */
  progress: '#5aa37a',
  /** Toggle knob. */
  knob: '#fffdf9',
  /** Glyphs (✓ ? ×) on filled circles. */
  onSolid: '#fffdf9',
  /** Initials on human avatars. */
  avatarInk: '#221d18',
  /** Input placeholder (reference `input::placeholder`). */
  placeholder: '#9d9186',
} as const;

/** Human avatar background tones, in README order. Initials use `fixedColors.avatarInk`. */
export const humanTones = ['#d9c3a9', '#bfd0bf', '#dcc0cc', '#c3cad9', '#cfd2b8'] as const;
export type HumanTone = (typeof humanTones)[number];
