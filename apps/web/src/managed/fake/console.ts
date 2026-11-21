/**
 * The fake world's consoles (contracts 0.80.1, CT-350): what the appliance's `console` stream relays from the hosts
 * service, played by a tiny shell, so the console dialog on the session transport opens, shows a prompt and answers
 * typing in development and the managed e2e suite. It speaks the hosts service's frames (`kind | channel | payload`):
 * `status` first, data echoed as a terminal does, `pong` for `ping`, `closed` with a reason on `exit`. Each
 * `hosts.createConsole` token works once, as on the box.
 */
import type { FakeConsoleIo, FakeConsolePeer } from '@whombat/client/fake';
import { fixtureConsoleTarget } from '@whombat/client/hosts/fixtures';
import { openFakeScreen } from './console-vnc';

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(kind: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === 'string' ? enc.encode(payload) : payload;
  const out = new Uint8Array(3 + body.length);
  out.set([kind, 0, 0]);
  out.set(body, 3);
  return out;
}
const control = (c: object) => frame(1, JSON.stringify(c));

/** What the fake shell answers (a few commands people try first). */
function answer(line: string, host: string): string | null {
  const cmd = line.trim();
  if (!cmd) return '';
  if (cmd === 'exit') return null;
  if (cmd === 'hostname') return host;
  if (cmd === 'whoami') return 'root';
  if (cmd === 'uptime') return ' 09:41:07 up 12 days,  3:02,  1 user,  load average: 0.42, 0.37, 0.31';
  if (cmd === 'ls') return 'backups  docker-compose.yml  notes.txt';
  return `${cmd.split(/\s+/)[0]}: command not found`;
}

/** The consoles of one fake appliance. */
export function createFakeConsoles() {
  const used = new Set<string>();
  let opened = 0;
  return {
    /** How many consoles were opened over the session (for the e2e suite). */
    opened: () => opened,
    open(
      target: { burrow: string; sessionId: string; token: string },
      io: FakeConsoleIo,
    ): { peer: FakeConsolePeer; protocol: string } | { refused: string; message: string } {
      if (used.has(target.token))
        return {
          refused: 'console_refused',
          message: 'This console link was used already or is too old. Open the console again.',
        };
      used.add(target.token);
      opened += 1;
      // The fixture's token says which console it is (a VM's screen, or whose shell; stream WD).
      const what = fixtureConsoleTarget(target.token);
      const host = what?.name ?? 'pve-02';
      if (what?.protocol === 'vnc') return { protocol: 'vnc', peer: openFakeScreen(io, host) };
      const prompt = `root@${host}:~# `;
      let line = '';
      let inEscape = false;
      io.send(
        control({
          type: 'status',
          state: 'connected',
          protocol: what?.protocol ?? 'shell',
          resolution: null,
        }),
      );
      io.send(frame(0, `Welcome to ${host} (Debian GNU/Linux 13)\r\n\r\n${prompt}`));
      return {
        protocol: what?.protocol ?? 'shell',
        peer: {
          receive(message) {
            if (message[0] === 1) {
              try {
                const c = JSON.parse(dec.decode(message.subarray(3))) as { type?: string; id?: number };
                if (c.type === 'ping') io.send(control({ type: 'pong', id: c.id }));
              } catch {
                // not a control this shell knows
              }
              return;
            }
            for (const ch of dec.decode(message.subarray(3))) {
              // Escape sequences (arrows, Alt+…) move nothing here.
              if (inEscape) {
                if (/[A-Za-z~]/.test(ch)) inEscape = false;
                continue;
              }
              if (ch === '\u001b') {
                inEscape = true;
                continue;
              }
              if (ch === '\u0003') {
                line = '';
                io.send(frame(0, `^C\r\n${prompt}`));
                continue;
              }
              if (ch === '\u0004' && !line) {
                io.send(frame(0, '\r\nlogout\r\n'));
                io.send(control({ type: 'closed', reason: 'ended' }));
                io.end();
                return;
              }
              if (ch === '\r' || ch === '\n') {
                const out = answer(line, host);
                line = '';
                if (out === null) {
                  io.send(frame(0, '\r\nlogout\r\n'));
                  io.send(control({ type: 'closed', reason: 'ended' }));
                  io.end();
                  return;
                }
                io.send(frame(0, `\r\n${out ? `${out}\r\n` : ''}${prompt}`));
              } else if (ch === '\u007f') {
                if (line) {
                  line = line.slice(0, -1);
                  io.send(frame(0, '\b \b'));
                }
              } else if (ch >= ' ') {
                line += ch;
                io.send(frame(0, ch));
              }
            }
          },
          close() {},
        },
      };
    },
  };
}
