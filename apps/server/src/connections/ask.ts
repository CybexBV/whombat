/**
 * `connection_add` (connect-in-chat.md): the assistant puts a card in the thread that opens the connect form filled
 * in — the entry, the address (the network scan's, when it found one the person hasn't connected), Look only or Manage
 * by risk — and the person signs in once there. Whombat never signs in for the agent and the agent never sees the
 * password. An entry Whombat looks after best as a server (`asServer`) gets “Add as a server” first.
 *
 * Only in a turn for the person (any of their rooms: the card is a link, nothing is answered on it). A service they
 * have connected already isn't asked again: the agent hears which connection it is.
 *
 * An MCP server or API outside the catalog (a Custom entry) is set up by talking (connect-by-talking.md): the assistant
 * gives its name, address, how it signs in and notes from its documentation. Whombat checks the address may be reached,
 * asks an MCP server itself whether it needs a sign-in, and posts a card that says what it connects and takes the key in
 * a write-only field; Connect on it connects as the person (`answerConnectHere`), runs the entry's check and wakes the
 * assistant with the new connection. An MCP server with its own sign-in (OAuth) gets the connect form's link instead,
 * as the sign-in needs the browser.
 */
import {
  type CatalogEntry,
  CONNECT_HERE_DECLINE,
  CONNECT_HERE_FIELDS,
  CONNECT_HERE_FORM,
  CONNECT_HERE_TEXT,
  CONNECTIONS_MAX,
  type ConnectionAccessLevel,
  type ConnectionAddInput,
  type ConnectionAddOutput,
  CreateConnectionBody,
  catalogEntry,
  catalogSignIn,
  connectAccessWords,
  connectAskHref,
  connectEntryOf,
  connectHereAsk,
  connectHereCard,
  connectHereSecretKind,
  connectSignInCard,
  connectsByTalking,
  type GuideAction,
  type GuideCard,
  GuideConnectAsk,
  newId,
  suggestedAccess,
  UPTIME_HUB_RUNNER,
  UPTIME_ID,
  UPTIME_KINDS,
  UptimeFields,
} from '@whombat/core';
import type { z } from 'zod';
import { cardReturnTo, postAskCard } from '../guides/ask';
import { makeCard, type SavedConnection } from '../guides/flows';
import { guideError, type PersonalPlace } from '../guides/place';
import { addServerHref } from '../hosts/tools';
import { ApiError } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { shortName } from '../read/principals';
import type { Services } from '../services';
import { plural } from '../things/words';
import { ownTurn } from '../vault/self-serve';
import { probeMcp } from './checks';
import { appClient } from './clients';
import { createConnection, requireDestination, viewerFor } from './connect';
import { burrowFound, type Found, newFoundTest } from './discover';
import { foundViewerOf } from './found-scans';
import { knownServers } from './found-servers';
import { orderFound } from './found-view';
import { discoverProtectedResource } from './oauth';
import { connectionCount, visibleConnections } from './store';
import { uptimeRunners } from './uptime';

type Input = z.output<typeof ConnectionAddInput>;

/** The words the tool answers the agent with (to the agent, never the chat). */
export const CONNECTION_ADD_TEXT = {
  notHere: 'Only in a turn for the person: the card goes to them.',
  unknown: (named: string) =>
    `Whombat doesn’t know “${named.slice(0, 60)}”. Name a catalog service by its id or name, like homeassistant, unifi_network or synology, or set it up yourself as custom_mcp (an MCP server) or custom_api (an HTTP API) with its address from its documentation.`,
  already: (label: string) =>
    `It is connected already as “${label}”. Use it with connection_call, or ask the person whether they want a second one.`,
  address:
    'address: a host name or IP address, with :port or http(s):// when it needs one (192.168.1.10, https://ha.lan:8123).',
  server: (id: string) =>
    `It is one of the person’s servers already (${id}): use it through the Servers connection.`,
  byHandAddress: (entry: string) =>
    entry === 'custom_mcp'
      ? 'address: the MCP server’s Streamable HTTP address from its documentation, like https://mcp.example.com/mcp.'
      : 'address: the API’s base address from its documentation, like https://api.example.com/v1.',
  full: `This Whombat has ${CONNECTIONS_MAX} connections, as many as it may. The person removes one first.`,
  unreachable:
    'Whombat couldn’t reach an MCP server at that address. Check the address in its documentation.',
} as const;

const fail = (
  reason: Extract<ConnectionAddOutput, { status: 'failed' }>['reason'],
  message: string,
  connectionId?: string,
): ConnectionAddOutput => ({
  status: 'failed',
  reason,
  message,
  ...(connectionId ? { connectionId } : {}),
});

/** The host of an address as typed or found (`https://10.0.0.5:8006` → `10.0.0.5`), lower case; null when none. */
export function hostOfAddress(address: string): string | null {
  const text = address.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** An address the form can identify: no spaces, a host in it. */
function addressOk(address: string): boolean {
  return !/\s/.test(address) && hostOfAddress(address) !== null;
}

/**
 * Where the card points (pure): the address given (a find on that host stands in for a bare host, so the port and
 * scheme are right), else the first find the person hasn't connected, else none.
 */
export function connectAddress(
  given: string | null,
  finds: readonly Pick<Found, 'host' | 'url'>[],
): { url: string | null; found: boolean } {
  if (given) {
    const host = hostOfAddress(given);
    const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(given) && !/:\d+$/.test(given);
    const find = bare ? finds.find((f) => f.host === host) : undefined;
    return find ? { url: find.url, found: true } : { url: given, found: false };
  }
  const first = finds[0];
  return first ? { url: first.url, found: true } : { url: null, found: false };
}

/** The card (topic `add_connection`): what, where, how it signs in, the level in plain words, one button. */
export function connectCard(
  entry: CatalogEntry,
  ask: {
    url: string | null;
    found: boolean;
    access: ConnectionAccessLevel;
    agent: string;
    returnTo?: string | null;
    oauthMethod?: 'mcp_oauth' | 'app_oauth' | null;
  },
): GuideCard {
  const host = ask.url ? hostOfAddress(ask.url) : null;
  const returnTo = ask.returnTo ?? null;
  const oauthMethod = !entry.asServer && returnTo ? (ask.oauthMethod ?? null) : null;
  const where = ask.url
    ? ask.found
      ? `Whombat found it on your network at ${host ?? ask.url}.`
      : `At ${ask.url}.`
    : oauthMethod
      ? null
      : 'The form asks where it is.';
  const signIn = oauthMethod
    ? CONNECT_HERE_TEXT.oauth(entry.name)
    : catalogSignIn(entry, 'password')
      ? 'Sign in to it once: Whombat makes its own key and forgets the password.'
      : 'The form shows how to give Whombat a sign-in key for it.';
  const level = connectAccessWords(entry, ask.access, ask.agent);
  const connect: GuideAction = {
    id: 'connect',
    label: oauthMethod || catalogSignIn(entry, 'password') ? 'Sign in…' : 'Connect…',
    style: 'primary',
    href: connectAskHref({
      catalogId: entry.id,
      url: ask.url,
      access: ask.access,
      ...(returnTo ? { returnTo } : {}),
    }),
  };
  if (entry.asServer) {
    const server = `Whombat looks after ${entry.name} best as a server: its helper there sees everything, with no sign-in key to keep. Sign in to it once and Whombat installs it.`;
    return makeCard({
      guide: 'add_connection',
      node: 'server',
      title: `Add ${entry.name}${host ? ` at ${host}` : ''} as a server`.slice(0, 120),
      body: [where, server].filter(Boolean).join('\n\n'),
      blocks: [
        {
          type: 'actions',
          actions: [
            {
              id: 'server',
              label: 'Add as a server',
              style: 'primary',
              href: addServerHref({ address: host ?? '', username: null, control: null, name: null }),
            },
            { ...connect, id: 'connect', label: 'Connect it instead', style: 'quiet' },
          ],
        },
      ],
    });
  }
  const notNow: GuideAction = {
    id: CONNECT_HERE_DECLINE,
    label: CONNECT_HERE_TEXT.notNow,
    style: 'quiet',
    href: null,
  };
  return makeCard({
    guide: 'add_connection',
    node: 'connect',
    title: `${oauthMethod ? 'Sign in to' : 'Connect'} ${entry.name}${host ? ` at ${host}` : ''}`.slice(
      0,
      120,
    ),
    body: [where, signIn, level].filter(Boolean).join('\n\n'),
    blocks: [{ type: 'actions', actions: returnTo ? [connect, notNow] : [connect] }],
    ...(oauthMethod && returnTo
      ? {
          connectOAuth: {
            catalogId: entry.id,
            method: oauthMethod,
            ...(ask.url ? { url: ask.url } : {}),
            access: ask.access,
            returnTo,
          },
        }
      : {}),
  });
}

/** `connection_add`. */
export async function connectionAddTool(ctx: ToolContext, input: Input): Promise<ConnectionAddOutput> {
  const { services } = ctx;
  const turn = await ownTurn(services.db, ctx);
  if (!turn) return fail('not_here', CONNECTION_ADD_TEXT.notHere);
  const known = connectEntryOf(input.service);
  // An API the catalog doesn't know, named by itself with how it signs in or notes: it is one set up by talking.
  const byHand = input.signIn !== undefined || input.keyName !== undefined || input.notes !== undefined;
  const entry = known ?? (byHand ? catalogEntry('custom_api') : null);
  if (!entry) return fail('unknown_service', CONNECTION_ADD_TEXT.unknown(input.service));
  if (entry.id === UPTIME_ID) return askToWatch(ctx, entry, input);
  if (connectsByTalking(entry))
    return connectByTalking(
      ctx,
      turn,
      entry,
      known ? input : { ...input, name: input.name ?? input.service },
    );
  const given = input.address?.trim() || null;
  if (given && !addressOk(given)) return fail('invalid_address', CONNECTION_ADD_TEXT.address);

  const viewer = await foundViewerOf(services.db, turn.person.id);
  if (!viewer) return fail('not_here', CONNECTION_ADD_TEXT.notHere);
  const mine = (await visibleConnections(services.db, viewer)).filter((c) => c.catalogId === entry.id);
  // What the scans found of this entry that the person hasn't connected or hidden (CS-52, CS-53).
  const scans = burrowFound(services, ctx.burrowId);
  const isNew = await newFoundTest(services, viewer);
  const found = (scans.last?.found ?? scans.running?.found ?? []).filter((f) => f.catalogId === entry.id);
  const finds = orderFound(found.filter(isNew));
  const at = connectAddress(given, finds);
  const host = at.url ? hostOfAddress(at.url) : null;
  const same = mine.find((c) => (host ? hostOfAddress(c.baseUrl) === host : !at.found));
  if (same) return fail('already_connected', CONNECTION_ADD_TEXT.already(same.label), same.id);
  // Best added as a server, and one already: the address given, or what the scan found when nothing new was.
  if (entry.asServer) {
    const look = host ? [host] : finds.length ? [] : found.map((f) => f.host);
    const added = (await knownServers(services)).find((server) => look.includes(server.host));
    if (added) return fail('already_connected', CONNECTION_ADD_TEXT.server(added.id));
  }

  const access = input.access ?? suggestedAccess(entry);
  const messageId = newId('message');
  const returnTo = await cardReturnTo(
    services.db,
    ctx.burrowId,
    ctx.dispatch.conversationId,
    ctx.dispatch.threadRootId ?? null,
    messageId,
  );
  const firstSignIn = entry.signIn[0];
  let oauthMethod: 'mcp_oauth' | 'app_oauth' | null = null;
  if (!entry.asServer && returnTo) {
    const requiredMissing = entry.fields.some((f) => f.required && (f.id !== 'url' || !at.url));
    if (!requiredMissing) {
      if (firstSignIn?.kind === 'mcp_oauth') oauthMethod = 'mcp_oauth';
      else if (firstSignIn?.kind === 'app_oauth' && (await appClient(services, entry.id)))
        oauthMethod = 'app_oauth';
    }
  }
  const card = connectCard(entry, {
    ...at,
    access,
    agent: shortName(turn.agent),
    returnTo,
    oauthMethod,
  });
  await postAskCard(ctx, card, { messageId });
  return {
    status: 'ok',
    messageId,
    service: entry.id,
    address: at.url,
    found: at.found,
    access,
    server: entry.asServer,
  };
}

/** Build the person's confirmation card with the exact check that Connect will save. */
async function askToWatch(ctx: ToolContext, entry: CatalogEntry, input: Input): Promise<ConnectionAddOutput> {
  const settings = UptimeFields.safeParse(input.uptime ?? { kind: 'http', address: input.address });
  if (!settings.success)
    return fail('invalid_address', settings.error.issues[0]?.message ?? 'Give the check an address.');
  const { services, burrowId } = ctx;
  if ((await connectionCount(services.db, burrowId)) >= CONNECTIONS_MAX)
    return fail('full', CONNECTION_ADD_TEXT.full);
  const heartbeat = settings.data.kind === 'heartbeat';
  const uptime = heartbeat
    ? { ...settings.data, address: undefined, keyword: undefined, runner: UPTIME_HUB_RUNNER }
    : settings.data;
  let runners: Awaited<ReturnType<typeof uptimeRunners>>;
  try {
    runners = await uptimeRunners(services, burrowId);
  } catch (err) {
    if (err instanceof ApiError) return fail('unavailable', err.message);
    throw err;
  }
  const from = runners.find((choice) => choice.id === uptime.runner);
  if (!from) return fail('not_allowed', 'Pick this Whombat or a server it watches.');
  const label = input.name ?? (uptime.address ?? 'Check-in').slice(0, 80);
  const ask = GuideConnectAsk.parse({
    catalogId: entry.id,
    label,
    signIn: 'none',
    url: uptime.address ?? entry.baseUrl,
    uptime,
    access: 'read',
  });
  const type = UPTIME_KINDS.find((kind) => kind.value === uptime.kind)?.label;
  const cadence = `every ${plural(Number(uptime.every), 'minute')}`;
  const where = heartbeat
    ? `Your script should check in ${cadence}. ${uptime.late === '0' ? 'There’s no extra time.' : `It has ${plural(Number(uptime.late), 'extra minute')} to check in.`}`
    : `${type} at ${uptime.address}. Whombat checks from ${from.name} ${cadence}.`;
  const card = makeCard({
    guide: 'add_connection',
    node: 'here',
    title: `Watch ${label}`.slice(0, 120),
    body: [
      where,
      ...(uptime.kind === 'http' && uptime.keyword ? [`The page must contain “${uptime.keyword}”.`] : []),
    ].join(' '),
    blocks: [
      {
        type: 'actions',
        actions: [
          { id: CONNECT_HERE_FORM, label: 'Start watching', style: 'primary', href: null },
          { id: CONNECT_HERE_DECLINE, label: 'Not now', style: 'quiet', href: null },
        ],
      },
    ],
    connectAsk: ask,
  });
  const messageId = await postAskCard(ctx, card);
  return byHandOk(messageId, entry, uptime.address ?? null, 'read', 'none', true);
}

/* An MCP server or API set up by talking (connect-by-talking.md) ---------------------------------------------------- */

/** An address given for a Custom entry, as a URL: https when no scheme is given, the fragment dropped; null when none. */
export function byHandUrl(address: string | undefined): string | null {
  const text = address?.trim() ?? '';
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** The same address, whatever the case of its host and a trailing slash. */
function sameAddress(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const url = new URL(u);
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch {
      return u.replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}

/** `connection_add` for a Custom entry: checked, then the card that connects on the card (or opens the sign-in). */
async function connectByTalking(
  ctx: ToolContext,
  turn: NonNullable<Awaited<ReturnType<typeof ownTurn>>>,
  entry: CatalogEntry,
  input: Input,
): Promise<ConnectionAddOutput> {
  const { services } = ctx;
  const url = byHandUrl(input.address);
  if (!url) return fail('invalid_address', CONNECTION_ADD_TEXT.byHandAddress(entry.id));
  const viewer = await foundViewerOf(services.db, turn.person.id);
  if (!viewer) return fail('not_here', CONNECTION_ADD_TEXT.notHere);
  const same = (await visibleConnections(services.db, viewer)).find(
    (c) => c.catalogId === entry.id && sameAddress(c.baseUrl, url),
  );
  if (same) return fail('already_connected', CONNECTION_ADD_TEXT.already(same.label), same.id);
  if ((await connectionCount(services.db, ctx.burrowId)) >= CONNECTIONS_MAX)
    return fail('full', CONNECTION_ADD_TEXT.full);
  try {
    await requireDestination(services, [url]);
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return fail('not_allowed', err.message);
    throw err;
  }
  const access = input.access ?? suggestedAccess(entry);
  const assistant = shortName(turn.agent);
  const host = new URL(url).hostname;
  let label = input.name?.trim() || null;
  let signIn = input.signIn ?? 'bearer';
  if (entry.transport === 'mcp') {
    // The server says itself whether it needs a sign-in, and which kind (CX-61): Whombat asks before the card does.
    const probe = await probeMcp(services, url, async (mcpUrl, header) => {
      const found = await discoverProtectedResource(services, mcpUrl, header);
      return found ? { issuer: found.issuer } : null;
    });
    if (probe.needs === 'unreachable')
      return fail(
        'unreachable',
        probe.message
          ? `${CONNECTION_ADD_TEXT.unreachable} (${probe.message})`
          : CONNECTION_ADD_TEXT.unreachable,
      );
    label ??= probe.serverName?.trim() || host;
    if (probe.needs === 'oauth') {
      const messageId = newId('message');
      const returnTo = await cardReturnTo(
        services.db,
        ctx.burrowId,
        ctx.dispatch.conversationId,
        ctx.dispatch.threadRootId ?? null,
        messageId,
      );
      const card = connectSignInCard(entry, { label, url, access, returnTo }, assistant);
      await postAskCard(ctx, card, { messageId });
      return byHandOk(messageId, entry, url, access, 'oauth', false);
    }
    signIn = probe.needs === 'open' ? 'none' : input.signIn === 'header' ? 'header' : 'bearer';
  }
  const made = connectHereAsk(entry, {
    label: label ?? host,
    url,
    signIn,
    keyName: input.keyName,
    keyPrefix: input.keyPrefix,
    username: input.username,
    notes: input.notes,
    access,
  });
  if ('problem' in made) return fail('invalid_sign_in', made.problem);
  const messageId = await postAskCard(ctx, connectHereCard(entry, made.ask, assistant));
  return byHandOk(messageId, entry, url, access, signIn, true);
}

function byHandOk(
  messageId: string,
  entry: CatalogEntry,
  url: string | null,
  access: ConnectionAccessLevel,
  signIn: NonNullable<Extract<ConnectionAddOutput, { status: 'ok' }>['signIn']>,
  connectsHere: boolean,
): ConnectionAddOutput {
  return {
    status: 'ok',
    messageId,
    service: entry.id,
    address: url,
    found: false,
    access,
    server: false,
    connectsHere,
    signIn,
  };
}

/** A refusal on the card: on the field it is about when the card has one, else above it, never with the value. */
function refusedOnCard(field: string | null, message: string): ApiError {
  return field
    ? guideError('invalid_values', message, { [`values.${field}`]: [message] })
    : guideError('invalid_values', message);
}

/**
 * Connect on the card (connect-by-talking.md), as the person who answered: the stored card's destination, the key they
 * typed, the entry's check (the connection is saved only when it passes), then its tools read, as on the connect form.
 * A refusal comes back on the card's field in the connections' own words, and the card stays open.
 */
export async function answerConnectHere(
  services: Services,
  place: PersonalPlace,
  ask: GuideConnectAsk,
  values: Readonly<Record<string, string>>,
): Promise<SavedConnection> {
  const entry = catalogEntry(ask.catalogId);
  if (!entry) throw refusedOnCard(null, 'Whombat doesn’t know that kind of connection any more.');
  const kind = ask.signIn === 'token' ? connectHereSecretKind(entry, ask) : null;
  const secretField = kind ? CONNECT_HERE_FIELDS.secret : null;
  const secret = values[CONNECT_HERE_FIELDS.secret] ?? '';
  const basic = kind === 'password';
  const username = ask.username ?? (values[CONNECT_HERE_FIELDS.username]?.trim() || null);
  if (basic && !username) throw refusedOnCard(CONNECT_HERE_FIELDS.username, CONNECT_HERE_TEXT.empty.username);
  if (kind && !secret.trim()) throw refusedOnCard(CONNECT_HERE_FIELDS.secret, CONNECT_HERE_TEXT.empty[kind]);
  const fields: Record<string, string> =
    entry.id === UPTIME_ID && ask.uptime
      ? Object.fromEntries(
          Object.entries(ask.uptime).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
        )
      : { url: ask.url };
  if (basic && username) fields.username = username;
  if (ask.notes && entry.fields.some((f) => f.id === 'description')) fields.description = ask.notes;
  const body = CreateConnectionBody.safeParse({
    catalogId: ask.catalogId,
    label: ask.label,
    fields,
    signIn: ask.signIn,
    ...(ask.signIn === 'token' ? { method: ask.method, secret: secret.trim() } : {}),
    ...(ask.auth ? { auth: ask.auth } : {}),
    access: ask.access,
  });
  if (!body.success) throw refusedOnCard(secretField, body.error.issues[0]?.message ?? 'That can’t be used.');
  const viewer = await viewerFor(services, place.accountId, place.burrow.id);
  if (!viewer) throw guideError('not_yours', 'Only the person this is for connects it.');
  try {
    const { row } = await createConnection(services, viewer, body.data, { closeConnectCards: false });
    return { connectionId: row.id, name: row.label, outcome: 'connected', wake: true };
  } catch (err) {
    // The connections' own refusal (the check failed, the address isn't allowed, the key was turned down): its words.
    if (err instanceof ApiError && err.status < 500) {
      const fieldErrors = Object.values(err.extra.fields ?? {}).flat();
      const onUser = !!err.extra.fields?.['fields.username'] && !ask.username;
      throw refusedOnCard(onUser ? CONNECT_HERE_FIELDS.username : secretField, fieldErrors[0] ?? err.message);
    }
    throw err;
  }
}

/** Not now: the card is set aside and nobody is woken (the person replies when they want something else). */
export function declineConnectHere(ask: GuideConnectAsk): SavedConnection {
  return { name: ask.label, outcome: 'declined', wake: false };
}
