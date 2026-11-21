/**
 * The two console clients (ported from Rackoon's `clients/TerminalScreen` and `clients/VncScreen`; ONE-13's first port
 * lived in `ConsoleDialog`): a text console in xterm.js (the AI sign-in's terminal, on tokens) and a VM's screen in
 * noVNC, both on channel 0 of the session's transport. Each gives the dialog a handle for its tools: take and give back
 * the keyboard, send keys or bytes (AP-1475), paste (AP-1477), copy the shell's text (AP-1478) and save the screen as a
 * PNG (AP-1479). A paste into the terminal (Ctrl+Shift+V, ⌘V, the browser's menu) goes through the dialog's safe paste
 * instead of straight to the shell; the key row's held Ctrl and Alt change the next key (AP-1476).
 */
import type RFB from '@novnc/novnc';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { TerminalView } from '../../ai/terminal';
import styles from './Console.module.css';
import { type ComboKey, comboEvents, type Modifiers, modifierKeys, withShellModifiers } from './keyCombos';
import { typeText } from './paste';
import type { ConsoleTransport } from './transport';

export interface ScreenHandle {
  /** Give the keyboard to the console. */
  capture(): void;
  /** Take it back (focus goes to the screen's frame). */
  release(): void;
  /** A shell pastes the text (bracketed when the shell asked for it); a screen types it. Resolves with characters sent. */
  paste(
    text: string,
    opts?: { onProgress?: (typed: number, total: number) => void; alive?: () => boolean },
  ): Promise<number>;
  /** A screen: press the keys in order, let go in reverse. */
  sendKeys?(keys: readonly ComboKey[]): void;
  /** A shell: these bytes. */
  sendBytes?(data: string): void;
  /** A shell: the selection, or all its text when nothing is selected. */
  copyText?(): { text: string; lines: number; selection: boolean };
  /** A screen: the picture as a PNG. */
  screenshot?(): Promise<Blob | null>;
}

export interface ScreenProps {
  transport: ConsoleTransport;
  /** The console's accessible name. */
  label: string;
  readOnly?: boolean;
  /** The client is up and takes input. */
  onReady: () => void;
  /** “132×36” for a terminal, the screen's size for a VM. */
  onSize: (size: string) => void;
  /** Ctrl+Alt gave the keyboard back. */
  onRelease: () => void;
  onError: (message: string) => void;
  /** Input reached the console (for the idle timer). */
  onInput: () => void;
  /** Ctrl and Alt held from the key row, for the next key. */
  sticky: Modifiers;
  /** The held keys were used: let them go. */
  onStickyUsed: () => void;
  /** A paste into the terminal, for the dialog's safe paste. */
  onPasteText?: (text: string) => void;
  /**
   * What to say when the screen asks the browser for a password of its own, which Whombat never gives (a VM's screen
   * password); default: a Proxmox guest's words.
   */
  credentialsText?: string;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** A text console in xterm.js (the AI sign-in's terminal: token colours, no inline styles). */
export const TerminalScreen = forwardRef<ScreenHandle, ScreenProps>(function TerminalScreen(props, ref) {
  const { transport, label, readOnly } = props;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const cb = useLatest(props);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let dispose = () => {};
    void import('../../ai/terminal').then(({ mountTerminal }) => {
      if (disposed) return;
      const view = mountTerminal(el);
      viewRef.current = view;
      const term = view.terminal;
      // The frame around the screen is the Tab stop; the terminal takes the keys after a click or Enter.
      term?.textarea?.setAttribute('tabindex', '-1');
      term?.textarea?.setAttribute('aria-label', label);
      const ch = transport.primary;
      const onMessage = (e: Event) => view.write(new Uint8Array((e as MessageEvent<ArrayBuffer>).data));
      ch.addEventListener('message', onMessage);
      let lastSize = '';
      const sendSize = () => {
        transport.resize(view.cols, view.rows);
        const size = `${view.cols}×${view.rows}`;
        if (size !== lastSize) {
          lastSize = size;
          cb.current.onSize(size);
        }
      };
      ch.addEventListener('open', sendSize);
      view.onResize(sendSize);
      view.onData((d) => {
        if (readOnly) return;
        const mods = cb.current.sticky;
        if (mods.ctrl || mods.alt) {
          ch.send(withShellModifiers(d, mods));
          cb.current.onStickyUsed();
        } else ch.send(d);
        cb.current.onInput();
      });
      // Ctrl+Shift+C copies the selection (instead of the browser's inspector); Ctrl+Shift+V is left to the browser,
      // whose paste the listener below takes.
      term?.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
          if (e.code === 'KeyC' && term.hasSelection()) {
            e.preventDefault();
            void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
          }
          return false;
        }
        return true;
      });
      const onPaste = (e: ClipboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (readOnly) return;
        const text = e.clipboardData?.getData('text/plain') ?? '';
        cb.current.onPasteText?.(text);
      };
      el.addEventListener('paste', onPaste, true);
      sendSize();
      cb.current.onReady();
      dispose = () => {
        ch.removeEventListener('message', onMessage);
        ch.removeEventListener('open', sendSize);
        el.removeEventListener('paste', onPaste, true);
        view.dispose();
        viewRef.current = null;
      };
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [transport, readOnly, label, cb]);

  useImperativeHandle(
    ref,
    () => ({
      capture: () => viewRef.current?.focus(),
      release: () => {
        viewRef.current?.terminal?.blur();
        cb.current.onRelease();
      },
      paste: async (text) => {
        const term = viewRef.current?.terminal;
        if (!term || readOnly) return 0;
        // xterm turns newlines into Enter and wraps the text in a bracketed paste when the shell asked for one.
        term.paste(text);
        cb.current.onInput();
        return Array.from(text).length;
      },
      sendBytes: (data) => {
        if (readOnly) return;
        transport.primary.send(data);
        cb.current.onInput();
      },
      copyText: () => {
        const term = viewRef.current?.terminal;
        if (!term) return { text: '', lines: 0, selection: false };
        if (term.hasSelection()) {
          const text = term.getSelection();
          return { text, lines: text.split('\n').length, selection: true };
        }
        const buf = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
        while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
        return { text: lines.join('\n'), lines: lines.length, selection: false };
      },
    }),
    [transport, readOnly, cb],
  );

  return <div ref={host} className={styles.term} />;
});

/** A VM's screen in noVNC (the agent did VNC's own sign-in; a password prompt is an error). */
export const VncScreen = forwardRef<ScreenHandle, ScreenProps>(function VncScreen(props, ref) {
  const { transport, label } = props;
  const host = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const cb = useLatest(props);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let rfb: RFB | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    // Ctrl and Alt held from the key row go down before the next key and up after it.
    let held: ComboKey[] = [];
    const onKeyDown = (e: KeyboardEvent) => {
      cb.current.onInput();
      const mods = cb.current.sticky;
      if (!rfb || held.length || (!mods.ctrl && !mods.alt)) return;
      if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return;
      held = modifierKeys(mods);
      for (const k of held) rfb.sendKey(k.keysym, k.code, true);
    };
    const onKeyUp = () => {
      if (!held.length) return;
      const keys = held;
      held = [];
      // After noVNC has let the key itself go.
      queueMicrotask(() => {
        for (const k of [...keys].reverse()) rfbRef.current?.sendKey(k.keysym, k.code, false);
        cb.current.onStickyUsed();
      });
    };
    const onPointer = () => cb.current.onInput();
    el.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('keyup', onKeyUp, true);
    el.addEventListener('pointerdown', onPointer);
    el.addEventListener('pointermove', onPointer);
    el.addEventListener('wheel', onPointer, { passive: true });
    void import('@novnc/novnc').then(({ default: RFBClass }) => {
      if (disposed) return;
      rfb = new RFBClass(el, transport.primary, { shared: true });
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.clipViewport = false;
      rfb.focusOnClick = true;
      rfb.background = 'transparent';
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 2;
      let lastSize = '';
      const reportSize = () => {
        const canvas = el.querySelector('canvas');
        if (!canvas?.width || !canvas.height) return;
        const size = `${canvas.width}×${canvas.height}`;
        if (size !== lastSize) {
          lastSize = size;
          cb.current.onSize(size);
        }
        canvas.setAttribute('aria-label', label);
      };
      rfb.addEventListener('connect', () => {
        reportSize();
        poll = setInterval(reportSize, 1000);
        cb.current.onReady();
      });
      rfb.addEventListener('credentialsrequired', () => {
        cb.current.onError(
          cb.current.credentialsText ??
            'This machine wants a screen password of its own, which Whombat can’t give it, so its screen was closed. Open its screen from Proxmox instead.',
        );
        rfb?.disconnect();
      });
      rfb.addEventListener('securityfailure', () => {
        cb.current.onError('The guest’s screen refused the connection.');
      });
    });
    return () => {
      disposed = true;
      if (poll) clearInterval(poll);
      el.removeEventListener('keydown', onKeyDown, true);
      el.removeEventListener('keyup', onKeyUp, true);
      el.removeEventListener('pointerdown', onPointer);
      el.removeEventListener('pointermove', onPointer);
      el.removeEventListener('wheel', onPointer);
      try {
        rfb?.disconnect();
      } catch {
        // Already disconnected.
      }
      rfbRef.current = null;
      el.replaceChildren();
    };
  }, [transport, label, cb]);

  useImperativeHandle(
    ref,
    () => ({
      capture: () => rfbRef.current?.focus({ preventScroll: true }),
      release: () => {
        rfbRef.current?.blur();
        cb.current.onRelease();
      },
      paste: async (text, opts = {}) => {
        const rfb = rfbRef.current;
        if (!rfb) return 0;
        cb.current.onInput();
        return typeText((ks, code, down) => rfb.sendKey(ks, code, down), text, {
          alive: () => rfbRef.current === rfb && transport.state === 'connected' && (opts.alive?.() ?? true),
          onProgress: (typed, total) => {
            cb.current.onInput();
            opts.onProgress?.(typed, total);
          },
        });
      },
      sendKeys: (keys) => {
        const rfb = rfbRef.current;
        if (!rfb) return;
        for (const step of comboEvents(keys)) rfb.sendKey(step.keysym, step.code, step.down);
        cb.current.onInput();
      },
      screenshot: () =>
        new Promise<Blob | null>((resolve) => {
          const canvas = host.current?.querySelector('canvas');
          if (!canvas?.width) return resolve(null);
          canvas.toBlob(resolve, 'image/png');
        }),
    }),
    [transport, cb],
  );

  return <div ref={host} className={styles.vnc} />;
});
