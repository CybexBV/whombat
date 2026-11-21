/**
 * A VM's screen in the fake world (stream WD, AP-1484): a tiny VNC server (RFB 3.8, no password, Raw rectangles)
 * behind a fixture console whose token says `vnc`, so the console dialog's noVNC shows a guest's text screen in
 * development and the managed e2e suite. It draws a Debian login on a canvas, types what the keys say (letters, Enter,
 * Backspace, Shift), and names the key combinations it is sent (“Ctrl+Alt+Del”), so Send keys and Paste can be seen
 * working. Not production code.
 */
import type { FakeConsoleIo, FakeConsolePeer } from '@whombat/client/fake';

const WIDTH = 1024;
const HEIGHT = 640;
const LINE = 20;
const PAD = 16;
/** Raw pixels go out in pieces of this size (the console stream's messages stay small). */
const CHUNK = 192 * 1024;

const XK = {
  shiftL: 0xffe1,
  shiftR: 0xffe2,
  ctrlL: 0xffe3,
  ctrlR: 0xffe4,
  altL: 0xffe9,
  altR: 0xffea,
  superL: 0xffeb,
  enter: 0xff0d,
  backspace: 0xff08,
  tab: 0xff09,
  escape: 0xff1b,
  delete: 0xffff,
  print: 0xff61,
} as const;

const MODS: Record<number, string> = {
  [XK.ctrlL]: 'Ctrl',
  [XK.ctrlR]: 'Ctrl',
  [XK.altL]: 'Alt',
  [XK.altR]: 'Alt',
};

function keyName(ks: number): string | null {
  if (ks === XK.delete) return 'Del';
  if (ks === XK.backspace) return 'Backspace';
  if (ks === XK.tab) return 'Tab';
  if (ks === XK.escape) return 'Esc';
  if (ks === XK.print) return 'PrtSc';
  if (ks === XK.superL) return 'Windows key';
  if (ks >= 0xffbe && ks <= 0xffc9) return `F${ks - 0xffbe + 1}`;
  if (ks >= 0xff51 && ks <= 0xff54) return ['←', '↑', '→', '↓'][ks - 0xff51] ?? null;
  if (ks >= 0x20 && ks <= 0x7e) return String.fromCharCode(ks).toUpperCase();
  return null;
}

function charOf(ks: number): string | null {
  if (ks >= 0x20 && ks <= 0xff && ks !== 0x7f) return String.fromCharCode(ks);
  if (ks >= 0x01000100 && ks <= 0x0110ffff) return String.fromCodePoint(ks & 0x00ffffff);
  return null;
}

/** RFB's shifts and maxes for the client's pixel format (noVNC: 32 bpp, R G B X in memory). */
interface PixelFormat {
  bpp: number;
  bigEndian: boolean;
  shifts: [number, number, number];
}

export function openFakeScreen(io: FakeConsoleIo, name: string): FakeConsolePeer {
  const enc = new TextEncoder();
  const frame = (kind: number, body: Uint8Array) => {
    const out = new Uint8Array(3 + body.length);
    out.set([kind, 0, 0]);
    out.set(body, 3);
    return out;
  };
  const control = (c: object) => frame(1, enc.encode(JSON.stringify(c)));
  const send = (bytes: Uint8Array) => {
    for (let off = 0; off < bytes.length; off += CHUNK) io.send(frame(0, bytes.subarray(off, off + CHUNK)));
  };

  const lines: string[] = [
    `Debian GNU/Linux 13 ${name} tty1`,
    '',
    `${name} login: root`,
    'Password:',
    `Linux ${name} 6.12.48+deb13-amd64 #1 SMP PREEMPT_DYNAMIC x86_64`,
    '',
    `root@${name}:~# `,
  ];
  const prompt = `root@${name}:~# `;
  const maxLines = Math.floor((HEIGHT - PAD * 2) / LINE);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const draw = () => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#c8c8c8';
    ctx.font = '15px "DejaVu Sans Mono", "Geist Mono", monospace';
    ctx.textBaseline = 'top';
    lines.slice(-maxLines).forEach((l, i) => {
      ctx.fillText(l, PAD, PAD + i * LINE);
    });
    // The cursor.
    const last = lines.slice(-maxLines);
    const row = last.length - 1;
    const x = PAD + ctx.measureText(last[row] ?? '').width;
    ctx.fillRect(x + 1, PAD + row * LINE + 15, 9, 2);
  };

  let fmt: PixelFormat = { bpp: 32, bigEndian: false, shifts: [0, 8, 16] };
  let state: 'version' | 'security' | 'init' | 'normal' = 'version';
  let buf = new Uint8Array(0);
  let wantsUpdate = false;
  let dirty = true;
  const held = new Set<number>();

  const pixels = (): Uint8Array => {
    const img = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const out = new Uint8Array(WIDTH * HEIGHT * 4);
    const [rs, gs, bs] = fmt.shifts;
    const view = new DataView(out.buffer);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      const v =
        (((img[i * 4] ?? 0) << rs) | ((img[i * 4 + 1] ?? 0) << gs) | ((img[i * 4 + 2] ?? 0) << bs)) >>> 0;
      view.setUint32(i * 4, v, !fmt.bigEndian);
    }
    return out;
  };

  const update = () => {
    if (!wantsUpdate || !dirty) return;
    wantsUpdate = false;
    dirty = false;
    draw();
    const head = new Uint8Array(4 + 12);
    const v = new DataView(head.buffer);
    v.setUint8(0, 0); // FramebufferUpdate
    v.setUint16(2, 1); // one rectangle
    v.setUint16(4, 0);
    v.setUint16(6, 0);
    v.setUint16(8, WIDTH);
    v.setUint16(10, HEIGHT);
    v.setInt32(12, 0); // Raw
    send(head);
    send(pixels());
  };
  let scheduled = false;
  const changed = () => {
    dirty = true;
    if (scheduled) return;
    scheduled = true;
    // Typing at speed is drawn a few times a second, not once per key.
    setTimeout(() => {
      scheduled = false;
      update();
    }, 60);
  };

  const type = (ks: number) => {
    const mods = [...held].map((k) => MODS[k]).filter(Boolean);
    const named = keyName(ks);
    if (mods.length && named) {
      lines.push(`[${[...new Set(mods)].join('+')}+${named}]`, prompt);
      changed();
      return;
    }
    if (ks === XK.enter) {
      const cmd = (lines[lines.length - 1] ?? '').slice(prompt.length).trim();
      if (cmd) lines.push(`-bash: ${cmd.split(/\s+/)[0]}: command not found`);
      lines.push(prompt);
    } else if (ks === XK.backspace) {
      const l = lines[lines.length - 1] ?? '';
      if (l.length > prompt.length) lines[lines.length - 1] = l.slice(0, -1);
    } else if (named && !charOf(ks)) {
      lines.push(`[${named}]`, prompt);
    } else {
      const ch = charOf(ks);
      if (!ch) return;
      lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''}${ch}`;
    }
    changed();
  };

  const take = (n: number): Uint8Array | null => {
    if (buf.length < n) return null;
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  };

  const pump = () => {
    for (;;) {
      if (state === 'version') {
        if (!take(12)) return;
        send(new Uint8Array([1, 1])); // one security type: None
        state = 'security';
      } else if (state === 'security') {
        if (!take(1)) return;
        send(new Uint8Array([0, 0, 0, 0])); // SecurityResult: OK
        state = 'init';
      } else if (state === 'init') {
        if (!take(1)) return;
        const title = enc.encode(name);
        const init = new Uint8Array(24 + title.length);
        const v = new DataView(init.buffer);
        v.setUint16(0, WIDTH);
        v.setUint16(2, HEIGHT);
        init.set([32, 24, 0, 1], 4); // bpp, depth, little endian, true colour
        v.setUint16(8, 255);
        v.setUint16(10, 255);
        v.setUint16(12, 255);
        init.set([16, 8, 0], 14);
        v.setUint32(20, title.length);
        init.set(title, 24);
        send(init);
        state = 'normal';
      } else {
        const type0 = buf[0];
        if (type0 === undefined) return;
        if (type0 === 0) {
          const m = take(20);
          if (!m) return;
          fmt = { bpp: m[4] ?? 32, bigEndian: m[6] === 1, shifts: [m[14] ?? 0, m[15] ?? 8, m[16] ?? 16] };
          dirty = true;
        } else if (type0 === 2) {
          if (buf.length < 4) return;
          const count = new DataView(buf.buffer, buf.byteOffset).getUint16(2);
          if (!take(4 + count * 4)) return;
        } else if (type0 === 3) {
          const m = take(10);
          if (!m) return;
          if (m[1] === 0) dirty = true;
          wantsUpdate = true;
          update();
        } else if (type0 === 4) {
          const m = take(8);
          if (!m) return;
          const down = m[1] === 1;
          const ks = new DataView(m.buffer).getUint32(4);
          if (ks === XK.shiftL || ks === XK.shiftR || MODS[ks]) {
            if (down) held.add(ks);
            else held.delete(ks);
          } else if (down) type(ks);
        } else if (type0 === 5) {
          if (!take(6)) return;
        } else if (type0 === 6) {
          if (buf.length < 8) return;
          const len = new DataView(buf.buffer, buf.byteOffset).getUint32(4);
          if (!take(8 + len)) return;
        } else {
          // A message this screen doesn't know: drop what's buffered.
          buf = new Uint8Array(0);
          return;
        }
      }
    }
  };

  io.send(control({ type: 'status', state: 'connected', protocol: 'vnc', resolution: `${WIDTH}x${HEIGHT}` }));
  send(enc.encode('RFB 003.008\n'));

  return {
    receive(message) {
      if (message[0] === 1) {
        try {
          const c = JSON.parse(new TextDecoder().decode(message.subarray(3))) as {
            type?: string;
            id?: number;
          };
          if (c.type === 'ping') io.send(control({ type: 'pong', id: c.id }));
        } catch {
          // not a control this screen knows
        }
        return;
      }
      const data = message.subarray(3);
      const next = new Uint8Array(buf.length + data.length);
      next.set(buf);
      next.set(data, buf.length);
      buf = next;
      pump();
    },
    close() {},
  };
}
