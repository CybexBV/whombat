// Text consoles (shell, tty, serial) in xterm.js on channel 0 of the session.
// Themed with the --term-* tokens and Geist Mono; the font is 1.7% of the
// screen width (SCREENS 5, never below 12 px); every fit sends `resize`.

import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { ScreenHandle, ScreenProps } from './types';

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** ANSI palette from the design tokens (terminal colors first, series colors for magenta/cyan). */
export function terminalTheme(): ITheme {
  const fg = token('--term-fg', '#c9d1d9');
  const dim = token('--term-dim', '#7d8590');
  const bg = token('--terminal-bg', '#06080b');
  const red = token('--term-red', '#ff7b72');
  const green = token('--term-green', '#56d364');
  const yellow = token('--term-yellow', '#e3b341');
  const blue = token('--term-blue', '#79c0ff');
  const magenta = token('--series-memory', '#9085e9');
  const cyan = token('--series-aqua', '#199e70');
  const white = token('--ink', '#eceef1');
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    // --term-blue at 30% (hex with alpha; xterm needs a concrete color).
    selectionBackground: /^#[0-9a-f]{6}$/i.test(blue) ? `${blue}4d` : blue,
    black: dim,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: fg,
    brightBlack: dim,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: white,
  };
}

const MIN_FONT = 12;
const MAX_FONT = 22;

export function fontSizeFor(width: number): number {
  return Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(width * 0.017 * 2) / 2));
}

async function fontsReady(): Promise<void> {
  if (!('fonts' in document)) return;
  try {
    await Promise.race([
      Promise.all([document.fonts.load('400 14px "Geist Mono"'), document.fonts.load('500 14px "Geist Mono"')]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* metrics fall back to the system mono font */
  }
}

export const TerminalScreen = forwardRef<ScreenHandle, ScreenProps>(function TerminalScreen({ transport, label, onSize, onRelease, onReady, readOnly, fontSize }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const cb = useRef({ onSize, onRelease, onReady });
  cb.current = { onSize, onRelease, onReady };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    const offs: (() => void)[] = [];
    const ch = transport.primary;

    void fontsReady().then(() => {
      if (disposed) return;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const t = new Terminal({
        fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: fontSize ?? fontSizeFor(el.clientWidth),
        lineHeight: 1.35,
        cursorBlink: !reduced && !readOnly,
        disableStdin: !!readOnly,
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        scrollback: 5000,
        theme: terminalTheme(),
        allowProposedApi: false,
        macOptionIsMeta: true,
        screenReaderMode: false,
      });
      term = t;
      termRef.current = t;
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      // The frame around the screen is the Tab stop; the terminal captures keys after a click / Enter.
      t.textarea?.setAttribute('tabindex', '-1');
      t.textarea?.setAttribute('aria-label', label);

      let lastSize = '';
      const refit = () => {
        if (!el.clientWidth || !el.clientHeight) return;
        const fs = fontSize ?? fontSizeFor(el.clientWidth);
        if (t.options.fontSize !== fs) t.options.fontSize = fs;
        try {
          fit.fit();
        } catch {
          return;
        }
        const size = `${t.cols}×${t.rows}`;
        if (size !== lastSize) {
          lastSize = size;
          cb.current.onSize(size);
          transport.resize(t.cols, t.rows);
        }
      };
      refit();
      ro = new ResizeObserver(() => refit());
      ro.observe(el);

      const onMessage = (e: Event) => {
        const data = (e as MessageEvent<ArrayBuffer>).data;
        t.write(new Uint8Array(data));
      };
      ch.addEventListener('message', onMessage);
      offs.push(() => ch.removeEventListener('message', onMessage));
      // The PTY learns the size once the session is connected.
      const onOpen = () => {
        lastSize = '';
        refit();
      };
      ch.addEventListener('open', onOpen);
      offs.push(() => ch.removeEventListener('open', onOpen));

      const d1 = t.onData((d) => ch.send(d));
      const d2 = t.onBinary((d) => ch.send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));
      offs.push(
        () => d1.dispose(),
        () => d2.dispose(),
      );
      cb.current.onReady();
    });

    return () => {
      disposed = true;
      ro?.disconnect();
      for (const off of offs) off();
      term?.dispose();
      termRef.current = null;
    };
  }, [transport, label, readOnly, fontSize]);

  useImperativeHandle(
    ref,
    () => ({
      capture: () => termRef.current?.focus(),
      release: () => {
        termRef.current?.blur();
        cb.current.onRelease();
      },
      paste: async (text, { raw }) => {
        const t = termRef.current;
        if (!t) return;
        if (raw) {
          transport.primary.send(text.replace(/\r?\n/g, '\r'));
        } else {
          // xterm maps newlines to Enter and wraps in bracketed paste when the shell asked for it.
          t.paste(text);
        }
      },
      sendRaw: (data) => {
        if (!readOnly) transport.primary.send(data);
      },
      copyText: () => {
        const t = termRef.current;
        if (!t) return { text: '', lines: 0, selection: false };
        if (t.hasSelection()) {
          const text = t.getSelection();
          return { text, lines: text.split('\n').length, selection: true };
        }
        const buf = t.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
        while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
        return { text: lines.join('\n'), lines: lines.length, selection: false };
      },
    }),
    [transport, readOnly],
  );

  return <div ref={host} className="term-host" />;
});
