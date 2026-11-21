/**
 * The sign-in console's terminal (CT-71): `@xterm/xterm`, loaded only when a console opens (`import('./terminal')`).
 * Colors come from `@whombat/tokens` CSS variables (the code-block surface and its text colors, the README's fixed
 * code colors), read when it mounts and again when the theme changes, so there are no color literals here.
 *
 * The hosted build's CSP allows styles only from files (`style-src 'self'`, AP-23), but xterm writes a few `<style>`
 * elements (sizes, theme, scrollbar) and `style` attributes (truecolor cells), which the policy would block (and
 * report). So xterm gets a document whose `<style>` is an inert, hidden element, whose text goes into a constructable
 * stylesheet (`adoptedStyleSheets`), and whose elements take a `style` attribute through the CSSOM; the CSP restricts
 * neither, so the terminal looks the same and nothing is refused.
 */
import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { styleSafeDocument } from './terminalStyles';

export interface TerminalView {
  readonly cols: number;
  readonly rows: number;
  write(bytes: Uint8Array): void;
  onData(listener: (data: string) => void): void;
  onResize(listener: (size: { cols: number; rows: number }) => void): void;
  focus(): void;
  dispose(): void;
  /** The xterm itself, for a server console's tools (paste, selection, blur; AP-1478). */
  readonly terminal?: Terminal;
}

export type MountTerminal = (host: HTMLElement) => TerminalView;

function themeOf(el: HTMLElement): ITheme {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v('--code'),
    foreground: v('--code-text'),
    cursor: v('--code-text'),
    cursorAccent: v('--code'),
    selectionBackground: v('--code-added-bg'),
    black: v('--code'),
    red: v('--code-removed'),
    green: v('--code-added'),
    yellow: v('--status-waiting'),
    blue: v('--face-banjo'),
    magenta: v('--face-dusty'),
    cyan: v('--face-dusty'),
    white: v('--code-text'),
    brightBlack: v('--code-timestamp'),
    brightRed: v('--code-fail'),
    brightGreen: v('--code-pass'),
    brightYellow: v('--status-waiting'),
    brightBlue: v('--face-banjo'),
    brightMagenta: v('--face-dusty'),
    brightCyan: v('--face-dusty'),
    brightWhite: v('--code-text'),
  };
}

export const mountTerminal: MountTerminal = (host) => {
  const css = getComputedStyle(host);
  const safe = styleSafeDocument(host.ownerDocument);
  const term = new Terminal({
    ...(safe && { documentOverride: safe.document }),
    theme: themeOf(host),
    fontFamily: css.getPropertyValue('--font-mono').trim() || 'monospace',
    fontSize: 13,
    lineHeight: 1.3,
    cursorBlink: true,
    convertEol: false,
    scrollback: 1000,
    // Long sign-in links wrap; a click opens them (xterm's own link detection).
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const unmirror = safe?.watch(host) ?? (() => {});
  term.open(host);
  try {
    fit.fit();
  } catch {
    // Not laid out yet: the observer below fits it once it is.
  }
  const resize = new ResizeObserver(() => {
    try {
      fit.fit();
    } catch {
      // Hidden: nothing to fit.
    }
  });
  resize.observe(host);
  // The theme toggles `data-theme` on the root: take the new colors.
  const themeWatch = new MutationObserver(() => {
    term.options.theme = themeOf(host);
  });
  themeWatch.observe(host.ownerDocument.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (bytes) => term.write(bytes),
    onData: (listener) => {
      term.onData(listener);
    },
    onResize: (listener) => {
      term.onResize(listener);
    },
    focus: () => term.focus(),
    terminal: term,
    dispose: () => {
      themeWatch.disconnect();
      resize.disconnect();
      term.dispose();
      unmirror();
    },
  };
};
