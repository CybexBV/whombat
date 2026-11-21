// Graphical console over SPICE with the vendored spice-html5 client
// (src/vendor/spice-html5, LGPL-3.0). spice-html5 opens one socket per SPICE
// channel; the registered socket factory maps the first (main) to channel 0
// of the session and every further one to a new session channel (`open` ->
// wait for `opened`). The guest display is drawn at its own size and scaled
// to fit with a CSS transform, which keeps spice-html5's mouse coordinates
// (offsetX/offsetY, local to the transformed canvas) in guest pixels.

import { forwardRef, useEffect, useId, useImperativeHandle, useRef } from 'react';
import { toast } from '../../../components/Toast';
import { t, tn } from '../../../lib/i18n';
import { registerSocketFactory } from '../../../vendor/spice-html5/rackoon-socket.js';
import type { ConsoleTransport } from '../transport';
import type { ScreenHandle, ScreenProps } from './types';

type SpiceModule = typeof import('../../../vendor/spice-html5/main.js');
type SpiceConnection = InstanceType<SpiceModule['SpiceMainConn']>;

/** Socket factory for one session: the first socket is channel 0, the rest are new channels. */
export function spiceSocketFactory(transport: ConsoleTransport): (uri: string) => WebSocket {
  let first = true;
  return () => {
    if (first) {
      first = false;
      const p = transport.primary;
      // Channel 0 may already be open when the lazily loaded client attaches.
      if (p.readyState === p.OPEN) setTimeout(() => p.dispatchEvent(new Event('open')), 0);
      return p as unknown as WebSocket;
    }
    return transport.openChannel() as unknown as WebSocket;
  };
}

export const SpiceScreen = forwardRef<ScreenHandle, ScreenProps>(function SpiceScreen({ transport, label, onSize, onRelease, onError, onReady }, ref) {
  const frame = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const screenId = `spice-screen-${uid}`;
  const conn = useRef<{ sc: SpiceConnection; mod: SpiceModule } | null>(null);
  const cb = useRef({ onSize, onRelease, onError, onReady });
  cb.current = { onSize, onRelease, onError, onReady };

  useEffect(() => {
    const fr = frame.current;
    const sc = screen.current;
    if (!fr || !sc) return;
    let disposed = false;
    const unregister = registerSocketFactory(transport.url, spiceSocketFactory(transport));

    let lastSize = '';
    const fit = () => {
      const canvas = sc.querySelector('canvas');
      if (!canvas || !canvas.width || !canvas.height) return;
      canvas.setAttribute('aria-label', label);
      // The screen frame is the Tab stop; the canvas takes keys after a click.
      if (canvas.getAttribute('tabindex') !== '-1') canvas.setAttribute('tabindex', '-1');
      const w = canvas.width;
      const h = canvas.height;
      const k = Math.min(fr.clientWidth / w, fr.clientHeight / h) || 1;
      const x = (fr.clientWidth - w * k) / 2;
      const y = (fr.clientHeight - h * k) / 2;
      sc.style.width = `${w}px`;
      sc.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      const size = `${w}×${h}`;
      if (size !== lastSize) {
        // The first display surface means the session is up.
        if (!lastSize) cb.current.onReady();
        lastSize = size;
        cb.current.onSize(size);
      }
    };
    const ro = new ResizeObserver(fit);
    ro.observe(fr);
    const mo = new MutationObserver(fit);
    mo.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });

    void import('../../../vendor/spice-html5/main.js')
      .then((mod) => {
        if (disposed) return;
        try {
          const spice = new mod.SpiceMainConn({
            uri: transport.url,
            // The agent completes SPICE ticket authentication; the browser never holds the password.
            password: '',
            screen_id: screenId,
            onerror: (e) => {
              if (disposed || transport.state !== 'connected') return;
              const msg = e instanceof Error ? e.message : t('SPICE connection error');
              cb.current.onError(`SPICE: ${msg}`);
            },
          });
          spice.clipboard_sharing = false;
          conn.current = { sc: spice, mod };
        } catch (e) {
          cb.current.onError(t('SPICE client failed to start: {error}', { error: e instanceof Error ? e.message : String(e) }));
        }
      })
      .catch(() => cb.current.onError(t('The SPICE client could not be loaded.')));

    return () => {
      disposed = true;
      ro.disconnect();
      mo.disconnect();
      try {
        conn.current?.sc.stop();
      } catch {
        /* already stopped */
      }
      conn.current = null;
      unregister();
      sc.replaceChildren();
    };
  }, [transport, label, screenId]);

  useImperativeHandle(
    ref,
    () => ({
      capture: () => screen.current?.querySelector('canvas')?.focus({ preventScroll: true }),
      release: () => {
        screen.current?.querySelector('canvas')?.blur();
        cb.current.onRelease();
      },
      paste: async (text) => {
        const c = conn.current;
        if (!c) return;
        const res = await c.mod.typeText(c.sc, text);
        if (res.skipped.length) {
          toast(tn(res.skipped.length, '{n} character could not be typed (no key on a US keyboard layout).', '{n} characters could not be typed (no key on a US keyboard layout).'), 'info');
        }
      },
      ctrlAltDel: () => {
        const c = conn.current;
        if (c) c.mod.sendCtrlAltDel(c.sc);
      },
      sendCombo: (keys) => {
        const c = conn.current;
        if (c) c.mod.sendScancodes(c.sc, keys.map((k) => k.scancode));
      },
    }),
    [],
  );

  return (
    <div ref={frame} className="spice-host">
      <div ref={screen} id={screenId} className="spice-screen" />
    </div>
  );
});
