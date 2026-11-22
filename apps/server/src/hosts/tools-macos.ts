/**
 * The assistant's hands on a Mac (docs/decisions/macos-servers.md): `mac_screen` sees the screen and clicks,
 * drags, scrolls, types and presses keys by position, or unlocks it; `mac_ui` works with the Mac's apps by name through
 * Whombat Helper, runs an element's own action by its name (“Play”) and quits an app. An action that removes, erases,
 * signs out, stops sharing or marks something lost is never run: the person does that on the Mac's screen. Both are
 * Servers tools (`connection_call`), so keys, tiers, the server's “Asks you first” and the catalog's sensitive rules
 * apply as to `server_command`; each runs one `hosts.screen` step (`screen.ts`).
 *
 * A look, and every step by position, answers with the screen as a picture (MCP image content, at most 1280 px wide,
 * JPEG) beside a short text part with the screen's size and the scale, so the assistant clicks in the screen's own
 * pixels. The Mac's refusals come back in Whombat's words (the Mac's own reason when it gave one) with what to do next,
 * and a step that worked carries the Mac's own note when it has one; the Mac's password never passes here.
 */
import {
  HOST_SCREEN_LIMITS,
  type HostScreenBody,
  HostScreenBody as HostScreenBodySchema,
  type HostScreenResult,
  type HostUiElement,
  hostScreenProblemText,
  screenMessageText,
} from '@whombat/core';
import type { Adapter } from '../connections/adapters/types';
import { type CallOutput, ConnectionArgumentError } from '../connections/request';
import { destructiveActionText, screenChangeText, screenStep, screenStepIsEveryday } from './screen';
import {
  type Args,
  type CallScope,
  opt,
  optInt,
  output,
  type ResolvedServer,
  record,
  req,
  resolveServer,
  run,
  scope,
} from './tools-shared';

/** The arguments each Mac tool takes (`checkArgs`, PX-08). */
export const MAC_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  mac_screen: ['server', 'action', 'x', 'y', 'to_x', 'to_y', 'dx', 'dy', 'text', 'keys'],
  mac_ui: [
    'server',
    'action',
    'app',
    'window',
    'name',
    'role',
    'index',
    'value',
    'path',
    'target',
    'limit',
    'perform',
  ],
};

/** The arguments each action takes besides `server` and `action`; anything else is refused by name. */
const SCREEN_ACTION_ARGS: Readonly<Record<string, readonly string[]>> = {
  look: [],
  click: ['x', 'y'],
  double_click: ['x', 'y'],
  right_click: ['x', 'y'],
  drag: ['x', 'y', 'to_x', 'to_y'],
  scroll: ['x', 'y', 'dx', 'dy'],
  type: ['text'],
  keys: ['keys'],
  unlock: [],
  password: [],
};
const UI_ACTION_ARGS: Readonly<Record<string, readonly string[]>> = {
  apps: [],
  list: ['app', 'window', 'limit'],
  press: ['app', 'name', 'role', 'index'],
  set: ['app', 'name', 'role', 'index', 'value'],
  menu: ['app', 'path'],
  focus: ['app'],
  open: ['target'],
  // `action` is the tool's own word for the step, so the element's action goes by `perform`.
  action: ['app', 'name', 'role', 'index', 'perform'],
  quit: ['app'],
};

/** The picture the assistant gets: at most this wide, as JPEG (small enough for every turn). */
export const MAC_LOOK = { maxW: 1280, format: 'jpeg' } as const;

/**
 * What the assistant does next when the Mac refuses a step (the person-facing sentence is `hostScreenProblemText`).
 * None of them leads back to the step that was just refused: `not_admin` ends with the person.
 */
export const MAC_NEXT: Readonly<Partial<Record<NonNullable<HostScreenResult['code']>, string>>> = {
  locked: 'mac_screen unlock first, then try again.',
  no_prompt: 'Nothing asks for the Mac’s password: mac_screen look to see what is on the screen.',
  no_access:
    'mac_ui open accessibility, switch Whombat Helper on there with mac_screen look and click, and when macOS asks for its password, mac_screen password once; meanwhile use mac_screen by position.',
  not_admin:
    'Stop here: don’t try mac_screen password or mac_ui open accessibility again. Tell the person the Mac’s screen user isn’t an administrator, so they switch Whombat Helper on themselves in the Mac’s screen in Whombat (Privacy & Security → Accessibility). Never ask for the password in the chat.',
  no_helper: 'Use mac_screen: look, then click by position.',
  not_found: 'mac_ui list shows the names; when nothing matches, mac_screen look and click by position.',
  no_account:
    'Tell the person to set the Mac’s password on its page in Whombat. Never ask for it in the chat.',
  sign_in_failed:
    'Tell the person to set the Mac’s password again on its page in Whombat. Never ask for it in the chat.',
  no_screen:
    'Tell the person to switch Screen Sharing on in System Settings → General → Sharing. mac_ui still works while Whombat Helper runs.',
  busy: 'Try again in a moment.',
  timeout: 'Look again before you repeat it: it may have happened.',
};

/** Refuses an argument the action doesn't take, naming what it takes. */
function onlyFor(tool: string, action: string, takes: readonly string[], args: Args): void {
  for (const [k, v] of Object.entries(args))
    if (v !== undefined && k !== 'server' && k !== 'action' && !takes.includes(k))
      throw new ConnectionArgumentError(
        takes.length
          ? `${k}: ${tool} ${action} doesn’t take it (it takes ${takes.join(', ')}).`
          : `${k}: ${tool} ${action} takes only server.`,
      );
}

const L = HOST_SCREEN_LIMITS;

/** A position argument: the screen's pixels, as the hosts service takes them. */
const px = (args: Args, name: string) => optInt(args, name, 0, L.position) ?? undefined;

/** The hub's body checked by the contract; a refusal names the field in the assistant's words. */
function checked(tool: string, action: string, body: Record<string, unknown>): HostScreenBody {
  const parsed = HostScreenBodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = String(issue?.path[0] ?? 'arguments')
    .replace('toX', 'to_x')
    .replace('toY', 'to_y')
    .replace(/^action$/, 'perform')
    .replace(/^text$/, action === 'set' ? 'value' : 'text');
  if (issue?.code === 'too_big') {
    const unit = issue.origin === 'string' ? ' characters' : issue.origin === 'array' ? ' items' : '';
    throw new ConnectionArgumentError(`${field}: at most ${String(issue.maximum)}${unit}.`);
  }
  throw new ConnectionArgumentError(`${field}: ${tool} ${action} needs it, as its description says.`);
}

/** `mac_screen`'s arguments as one screen step (a look is always the assistant's size and JPEG). */
export function macScreenBody(args: Args): HostScreenBody {
  const action = req(args, 'action');
  const takes = SCREEN_ACTION_ARGS[action];
  if (!takes) throw new ConnectionArgumentError(`action: ${Object.keys(SCREEN_ACTION_ARGS).join(', ')}.`);
  onlyFor('mac_screen', action, takes, args);
  const at = { x: px(args, 'x'), y: px(args, 'y') };
  const text = typeof args.text === 'string' ? args.text : undefined;
  if (args.text !== undefined && text === undefined) throw new ConnectionArgumentError('text: a string.');
  switch (action) {
    case 'look':
      return checked('mac_screen', action, { op: 'look', ...MAC_LOOK });
    case 'click':
      return checked('mac_screen', action, { op: 'click', ...at });
    case 'double_click':
      return checked('mac_screen', action, { op: 'click', ...at, clicks: 2 });
    case 'right_click':
      return checked('mac_screen', action, { op: 'click', ...at, button: 'right' });
    case 'drag':
      return checked('mac_screen', action, {
        op: 'drag',
        ...at,
        toX: px(args, 'to_x'),
        toY: px(args, 'to_y'),
      });
    case 'scroll':
      return checked('mac_screen', action, {
        op: 'scroll',
        ...at,
        dx: optInt(args, 'dx', -L.scroll, L.scroll) ?? undefined,
        dy: optInt(args, 'dy', -L.scroll, L.scroll) ?? undefined,
      });
    case 'type':
      return checked('mac_screen', action, { op: 'type', text });
    case 'keys':
      return checked('mac_screen', action, { op: 'keys', keys: opt(args, 'keys') ?? undefined });
    case 'password':
      return checked('mac_screen', action, { op: 'password' });
    default:
      return checked('mac_screen', action, { op: 'unlock' });
  }
}

/** `mac_ui`'s arguments as one screen step through Whombat Helper. */
export function macUiBody(args: Args): HostScreenBody {
  const action = req(args, 'action');
  const takes = UI_ACTION_ARGS[action];
  if (!takes) throw new ConnectionArgumentError(`action: ${Object.keys(UI_ACTION_ARGS).join(', ')}.`);
  onlyFor('mac_ui', action, takes, args);
  if (args.path !== undefined && !(Array.isArray(args.path) && args.path.every((p) => typeof p === 'string')))
    throw new ConnectionArgumentError('path: a list of names, like ["File", "Save…"].');
  if (args.value !== undefined && typeof args.value !== 'string')
    throw new ConnectionArgumentError('value: a string.');
  return checked('mac_ui', action, {
    op: `ui.${action}`,
    app: opt(args, 'app') ?? undefined,
    window: opt(args, 'window') ?? undefined,
    name: opt(args, 'name') ?? undefined,
    role: opt(args, 'role') ?? undefined,
    index: optInt(args, 'index', 0, 1000) ?? undefined,
    text: args.value as string | undefined,
    path: args.path as string[] | undefined,
    target: opt(args, 'target') ?? undefined,
    limit: optInt(args, 'limit', 1, L.list) ?? undefined,
    action: opt(args, 'perform') ?? undefined,
  });
}

/** A Mac named in the call, or the refusal for a server that isn't one. */
async function macOf(s: CallScope, args: Args): Promise<ResolvedServer | CallOutput> {
  const srv = await resolveServer(s, req(args, 'server'));
  if (srv.kind === 'macos') return srv;
  return output(
    { error: `${srv.label} isn’t a Mac, so this tool doesn’t work there.`, code: 'unsupported' },
    true,
  );
}

/** The Mac's refusal in Whombat's words (its own reason when it gave one), with what to do next. */
export function refusal(r: Pick<HostScreenResult, 'code' | 'message'>, label: string): CallOutput {
  const code = r.code ?? 'failed';
  return output(
    {
      error: hostScreenProblemText(code, label, r.message),
      code,
      ...(MAC_NEXT[code] ? { next: MAC_NEXT[code] } : {}),
    },
    true,
  );
}

/** What the Mac added to a step that worked (“The Mac locks again when this screen session ends.”), if anything. */
export function macSays(r: Pick<HostScreenResult, 'message'>): { message?: string } {
  const said = screenMessageText(r.message);
  return said ? { message: said } : {};
}

/**
 * An element's own actions by name (“Play”, “Directions · 0 min”): Whombat Helper lists them as
 * `Name:Play\nTarget:0x0\nSelector:(null)`; the plain accessibility ones (`AXPress`) are what press does already.
 */
export function ownActionNames(actions: readonly string[]): string[] {
  const names: string[] = [];
  for (const a of actions) {
    const m = /^Name:([^\n]*)/.exec(a);
    const name = m?.[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** What the assistant is told when it asks for an action that undoes something. */
export const DESTRUCTIVE_NEXT =
  'Don’t try it another way (press, menu or the screen): tell the person to do it on the Mac themselves.';

/** An element as the assistant reads it: what names it and where it is, nothing empty. */
function element(e: HostUiElement) {
  const own = ownActionNames(e.actions);
  return {
    id: e.id,
    role: e.role.replace(/^AX/, ''),
    ...(e.subrole ? { subrole: e.subrole.replace(/^AX/, '') } : {}),
    ...(e.title ? { title: e.title } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.value ? { value: e.value } : {}),
    ...(e.identifier ? { identifier: e.identifier } : {}),
    ...(e.enabled ? {} : { enabled: false }),
    ...(e.focused ? { focused: true } : {}),
    at: [e.x, e.y, e.w, e.h],
    ...(own.length ? { actions: own } : {}),
    ...(e.window ? { window: e.window } : {}),
  };
}

/** What the text part says about a picture: the screen's size and how much smaller the picture is. */
export function lookFacts(r: HostScreenResult): Record<string, number> {
  const screenW = r.screenW ?? r.w ?? 0;
  const screenH = r.screenH ?? r.h ?? 0;
  const imageW = r.w ?? screenW;
  const scale = imageW > 0 && screenW > 0 ? Math.round((screenW / imageW) * 1000) / 1000 : 1;
  return { screen_w: screenW, screen_h: screenH, image_w: imageW, image_h: r.h ?? screenH, scale };
}

/** Said once with every picture: positions are the screen's pixels. */
export const LOOK_NOTE = 'x and y are the screen’s pixels: multiply a point in the picture by scale.';

/** An answer with the screen's picture attached (MCP image content) and its facts as text. */
function withLook(value: Record<string, unknown>, look: HostScreenResult): CallOutput {
  const out = output({ ...value, ...lookFacts(look), note: LOOK_NOTE });
  if (look.imageB64)
    out.image = { data: look.imageB64, mimeType: look.format === 'png' ? 'image/png' : 'image/jpeg' };
  return out;
}

/** Records a step that changed something, signed as the Whombat for its person (the typed text never). */
async function recordStep(
  s: CallScope,
  tool: 'mac_screen' | 'mac_ui',
  mac: ResolvedServer,
  body: HostScreenBody,
  r: HostScreenResult,
) {
  const text = screenChangeText(body, mac.label);
  if (!text) return;
  await record(s, {
    text,
    op: tool,
    serverId: mac.id,
    ...(r.auditId ? { ids: { auditId: r.auditId } } : {}),
    change: { title: text, everyday: screenStepIsEveryday(body.op) },
  });
}

export const MAC_TOOLS: Adapter = {
  async mac_screen(ctx, args) {
    const s = await scope(ctx);
    const body = macScreenBody(args);
    const out = await run({ server: String(args.server ?? ''), op: 'screen' }, async () => {
      const mac = await macOf(s, args);
      if (!('id' in mac)) return mac;
      const action = String(args.action);
      const r = await screenStep(s.hosts, mac.id, body, s.actor('admin'));
      if (!r.ok) return refusal(r, mac.label);
      if (body.op === 'look') return withLook({ server: mac.id, ...macSays(r) }, r);
      await recordStep(s, 'mac_screen', mac, body, r);
      const done = {
        server: mac.id,
        action,
        done: true,
        ...macSays(r),
        ...(r.status ? { locked: r.status.locked } : {}),
      };
      // What the step did, seen: a fresh look (a step that worked still says so when the look doesn't).
      const look = await screenStep(s.hosts, mac.id, { op: 'look', ...MAC_LOOK }, s.actor('admin')).catch(
        () => null,
      );
      if (!look?.ok)
        return output({
          ...done,
          look: look
            ? hostScreenProblemText(look.code ?? 'failed', mac.label, look.message)
            : 'No picture this time.',
        });
      return withLook(done, look);
    });
    return out as CallOutput;
  },

  async mac_ui(ctx, args) {
    const s = await scope(ctx);
    const body = macUiBody(args);
    const out = await run({ server: String(args.server ?? ''), op: 'screen' }, async () => {
      const mac = await macOf(s, args);
      if (!('id' in mac)) return mac;
      const destructive =
        body.op === 'ui.action' ? destructiveActionText(body.action ?? '', mac.label) : null;
      if (destructive)
        return output({ error: destructive, code: 'destructive_action', next: DESTRUCTIVE_NEXT }, true);
      const r = await screenStep(s.hosts, mac.id, body, s.actor('admin'));
      if (!r.ok) return refusal(r, mac.label);
      if (body.op === 'ui.apps')
        return output({
          server: mac.id,
          ...macSays(r),
          apps: (r.apps ?? []).map((a) => ({
            name: a.name,
            ...(a.bundleId ? { bundleId: a.bundleId } : {}),
            ...(a.active ? { active: true } : {}),
            windows: a.windows,
          })),
        });
      if (body.op === 'ui.list')
        return output({
          server: mac.id,
          ...macSays(r),
          elements: (r.elements ?? []).map(element),
          ...(r.truncated ? { truncated: true } : {}),
        });
      await recordStep(s, 'mac_ui', mac, body, r);
      return output({
        server: mac.id,
        action: String(args.action),
        ...(body.action ? { performed: body.action } : {}),
        done: true,
        ...macSays(r),
        ...(r.element ? { element: element(r.element) } : {}),
      });
    });
    return out as CallOutput;
  },
};
