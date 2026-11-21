/**
 * Stream WD's fixture additions (consoles, AP-1484): `withConsoleFixtures` wraps the hosts fixtures' `handle` so the
 * fake world's consoles know what they are playing. A console session's token says its protocol and the guest's name
 * (`tok_wd<n>.<protocol>.<name>`), which the web's fake console (`apps/web/src/managed/fake/console.ts`) reads to show
 * a VM's screen or the right shell; and a guest that is started or stopped has its console come and go, as the hub's
 * guests do. Not imported by production code.
 */
import type {
  HostConsoleProtocol,
  HostConsoleSession,
  HostGuest,
  HostServerDetail,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest } from './fixtures';

interface Fixtures {
  world: { guests: Map<string, HostGuest[]>; details: Map<string, HostServerDetail> };
  handle: (req: HostsFixtureRequest) => HostsFixtureAnswer | null;
}

/** What a fixture console token says (null for another token). */
export function fixtureConsoleTarget(token: string): { protocol: HostConsoleProtocol; name: string } | null {
  const m = /^tok_wd\d+\.([a-z]+)\.(.+)$/.exec(token);
  if (!m) return null;
  return { protocol: m[1] as HostConsoleProtocol, name: decodeURIComponent(m[2] as string) };
}

export function withConsoleFixtures<F extends Fixtures>(fx: F, now: number = Date.now()): F {
  let seq = 0;
  const handle = (req: HostsFixtureRequest): HostsFixtureAnswer | null => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${req.method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
    const [, serverId, , guestId] = seg;
    const guest =
      serverId && guestId ? fx.world.guests.get(serverId)?.find((g) => g.id === guestId) : undefined;
    if (route === 'POST servers/:/consoles' && serverId && fx.world.details.has(serverId)) {
      const wanted = typeof req.body.guestId === 'string' ? req.body.guestId : null;
      const g = wanted ? fx.world.guests.get(serverId)?.find((x) => x.id === wanted) : undefined;
      if (!wanted || g) {
        const protocol = ((req.body.protocol as HostConsoleProtocol | undefined) ??
          g?.console.defaultProtocol ??
          (g ? 'vnc' : 'shell')) as HostConsoleProtocol;
        const n = ++seq;
        const session: HostConsoleSession = {
          sessionId: `con_wd${n}`,
          path: `/api/v1/burrows/fixture/hosts/consoles/con_wd${n}/ws`,
          token: `tok_wd${n}.${protocol}.${encodeURIComponent(g?.name ?? serverId)}`,
          protocol,
          expiresAt: new Date(now + 30_000).toISOString(),
          idleTimeoutS: 900,
        };
        return { status: 201, body: session };
      }
    }
    // A guest that starts gets its console; one that stops loses it (the main handler copies the guest on).
    if (route === 'POST servers/:/guests/:/actions' && serverId && guest) {
      const action = String(req.body.action ?? '');
      const on = ['start', 'resume', 'reboot', 'restart'].includes(action);
      const off = ['stop', 'shutdown', 'force_stop'].includes(action);
      if (on || off)
        fx.world.guests.set(
          serverId,
          (fx.world.guests.get(serverId) ?? []).map((x) =>
            x.id === guest.id ? { ...x, console: { ...x.console, available: on } } : x,
          ),
        );
    }
    return fx.handle(req);
  };
  return { ...fx, handle };
}
