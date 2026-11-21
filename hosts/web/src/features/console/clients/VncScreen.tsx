// Graphical console over VNC: noVNC's RFB attached to channel 0 of the
// session as a "raw channel". The agent has already authenticated to the
// guest's VNC server, so the browser sees security type None; a password
// prompt from the server is treated as an error (the password must never
// reach the browser). Scaled to fit; click to capture keys.

import type RFB from '@novnc/novnc';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { t } from '../../../lib/i18n';
import { keysymFor, needsShift } from '../paste';
import type { ScreenHandle, ScreenProps } from './types';

const XK_SHIFT_L = 0xffe1;

/** Type text as key events, a few characters per frame so the guest keeps up. */
export async function typeKeys(
  sendKey: (keysym: number, code: string | null, down?: boolean) => void,
  text: string,
  perTick = 40,
  tickMs = 25,
  alive: () => boolean = () => true,
): Promise<void> {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += perTick) {
    if (!alive()) return;
    for (const ch of chars.slice(i, i + perTick)) {
      const ks = keysymFor(ch);
      if (ks === null) continue;
      const shift = needsShift(ch);
      if (shift) sendKey(XK_SHIFT_L, 'ShiftLeft', true);
      sendKey(ks, null);
      if (shift) sendKey(XK_SHIFT_L, 'ShiftLeft', false);
    }
    if (i + perTick < chars.length) await new Promise((r) => setTimeout(r, tickMs));
  }
}

export const VncScreen = forwardRef<ScreenHandle, ScreenProps>(function VncScreen({ transport, label, onSize, onRelease, onError, onReady }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const cb = useRef({ onSize, onRelease, onError, onReady });
  cb.current = { onSize, onRelease, onError, onReady };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let rfb: RFB | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

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
        if (!canvas || !canvas.width || !canvas.height) return;
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
        cb.current.onError(t('The guest asked the browser for a VNC password. The agent must complete VNC authentication itself; the console was closed.'));
        rfb?.disconnect();
      });
      rfb.addEventListener('securityfailure', (e) => {
        const detail = (e as CustomEvent<{ reason?: string }>).detail;
        cb.current.onError(detail?.reason ? t('VNC security negotiation failed: {reason}', { reason: detail.reason }) : t('VNC security negotiation failed.'));
      });
    });

    return () => {
      disposed = true;
      if (poll) clearInterval(poll);
      try {
        rfb?.disconnect();
      } catch {
        /* already disconnected */
      }
      rfbRef.current = null;
      el.replaceChildren();
    };
  }, [transport, label]);

  useImperativeHandle(
    ref,
    () => ({
      capture: () => rfbRef.current?.focus({ preventScroll: true }),
      release: () => {
        rfbRef.current?.blur();
        cb.current.onRelease();
      },
      paste: async (text) => {
        const rfb = rfbRef.current;
        if (!rfb) return;
        await typeKeys((ks, code, down) => rfb.sendKey(ks, code, down), text, 40, 25, () => rfbRef.current === rfb && transport.state === 'connected');
      },
      ctrlAltDel: () => rfbRef.current?.sendCtrlAltDel(),
      sendCombo: (keys) => {
        const rfb = rfbRef.current;
        if (!rfb) return;
        for (const k of keys) rfb.sendKey(k.keysym, k.code, true);
        for (const k of [...keys].reverse()) rfb.sendKey(k.keysym, k.code, false);
      },
    }),
    [transport],
  );

  return <div ref={host} className="vnc-host" />;
});
