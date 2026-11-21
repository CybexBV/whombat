/**
 * “Asks you first” per server in the fixture world (Whombat `server-asks.md` SA-01, SA-04, SA-05; app
 * `server-asks-web.md` AP-1719): Whombat keeps it, not the hosts service, so this layer sits outside the others. It
 * answers `asksFirst` on the fleet's rows, a server's page (`detail.server`) and its settings (`never` unless set), and
 * `hosts.updateServer` with `asksFirst` stores it — a body with only `asksFirst` doesn't reach the hosts routes, as on
 * the server. `world.asks` is also set by “Don’t ask again on {server}” on an approval (the web's fixture layer).
 * The name a person gave a server is Whombat's too: `hosts.updateServer` with `name` keeps it in `world.names` (null
 * puts the id back), and the fleet's rows, the page and the settings say it.
 */
import {
  HOST_ASKS_FIRST_DEFAULT,
  HostAsksFirst,
  type HostFleet,
  type HostServerDetail,
  HostServerGivenName,
  type HostServerSettings,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

export function withSa(base: Handle, world: HostsFixtureWorld): Handle {
  const asks = withAsks(base, world);
  return (req) => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${req.method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
    const id = seg[1] ?? '';
    const nameOf = (serverId: string) => world.names.get(serverId);
    if (route === 'PATCH servers/:' && 'name' in req.body) {
      if (!world.settings.has(id)) return null;
      const raw = req.body.name;
      const parsed = raw === null ? null : HostServerGivenName.safeParse(raw);
      if (parsed && !parsed.success) {
        const message = parsed.error.issues[0]?.message ?? 'Give it a name.';
        return {
          status: 400,
          body: { error: { code: 'validation_failed', message, fields: { name: [message] } } },
        };
      }
      const name = parsed?.data ?? null;
      const taken =
        name &&
        world.servers.some(
          (s) =>
            s.id !== id &&
            (s.id.toLowerCase() === name.toLowerCase() || nameOf(s.id)?.toLowerCase() === name.toLowerCase()),
        );
      if (taken) {
        const message = 'Another server already goes by that name.';
        return { status: 409, body: { error: { code: 'conflict', message, fields: { name: [message] } } } };
      }
      if (name && name !== id) world.names.set(id, name);
      else world.names.delete(id);
      const { name: _name, ...rest } = req.body;
      if (Object.keys(rest).length) {
        const answer = asks({ ...req, body: rest });
        if (answer && answer.status < 300)
          return { ...answer, body: { ...(answer.body as HostServerSettings), name: nameOf(id) ?? null } };
        return answer;
      }
      const s = world.settings.get(id) as HostServerSettings;
      return {
        status: 200,
        body: { ...s, asksFirst: world.asks.get(id) ?? HOST_ASKS_FIRST_DEFAULT, name: nameOf(id) ?? null },
      };
    }
    const answer = asks(req);
    if (!answer || answer.status >= 300) return answer;
    switch (route) {
      case 'GET fleet': {
        const fleet = answer.body as HostFleet;
        return {
          ...answer,
          body: { ...fleet, servers: fleet.servers.map((s) => ({ ...s, name: nameOf(s.id) ?? s.name })) },
        };
      }
      case 'GET servers/:': {
        const d = answer.body as HostServerDetail;
        const name = d?.server ? nameOf(d.server.id) : undefined;
        if (!name) return answer;
        return { ...answer, body: { ...d, server: { ...d.server, name } } };
      }
      case 'GET servers/:/settings':
      case 'PATCH servers/:': {
        const s = answer.body as HostServerSettings;
        return { ...answer, body: { ...s, name: nameOf(s.id) ?? null } };
      }
    }
    return answer;
  };
}

function withAsks(base: Handle, world: HostsFixtureWorld): Handle {
  const asksOf = (id: string): HostAsksFirst => world.asks.get(id) ?? HOST_ASKS_FIRST_DEFAULT;

  return (req) => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${req.method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
    const id = seg[1] ?? '';

    if (route === 'PATCH servers/:' && 'asksFirst' in req.body) {
      const parsed = HostAsksFirst.safeParse(req.body.asksFirst);
      if (!parsed.success)
        return {
          status: 400,
          body: { error: { code: 'invalid_request', message: 'Choose “Before risky actions” or “Never”.' } },
        };
      if (!world.settings.has(id)) return null;
      world.asks.set(id, parsed.data);
      const { asksFirst: _asks, ...rest } = req.body;
      if (Object.keys(rest).length) {
        const answer = base({ ...req, body: rest });
        if (answer && answer.status < 300)
          return { ...answer, body: { ...(answer.body as HostServerSettings), asksFirst: parsed.data } };
        return answer;
      }
      const s = world.settings.get(id) as HostServerSettings;
      return { status: 200, body: { ...s, asksFirst: parsed.data } };
    }

    const answer = base(req);
    if (!answer || answer.status >= 300) return answer;
    switch (route) {
      case 'GET fleet': {
        const fleet = answer.body as HostFleet;
        return {
          ...answer,
          body: { ...fleet, servers: fleet.servers.map((s) => ({ ...s, asksFirst: asksOf(s.id) })) },
        };
      }
      case 'GET servers/:': {
        const d = answer.body as HostServerDetail;
        if (!d?.server) return answer;
        return { ...answer, body: { ...d, server: { ...d.server, asksFirst: asksOf(d.server.id) } } };
      }
      case 'GET servers/:/settings':
      case 'PATCH servers/:': {
        const s = answer.body as HostServerSettings;
        return { ...answer, body: { ...s, asksFirst: asksOf(s.id) } };
      }
    }
    return answer;
  };
}
