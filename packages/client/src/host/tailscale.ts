/**
 * Tailscale on This Whombat (Whombat hermes-engine.md HE-51; contracts CT-1253, CT-1254; hermes-engine-app.md AP-5305),
 * for the web and the phone: Tailscale runs on the box, off until the person turns it on and signs in with Tailscale's
 * own login link; while it is on, the box's Tailscale name is one of its direct ways in (HE-50). The box sends states and kinds, never words (HD-11): these are the words.
 *
 * `tailscaleApi(session)` is the four ops; `tailscaleView` turns `host.tailscale`'s answer into the section's one row,
 * its action and whether to ask again soon (`TAILSCALE_POLL_MS` while it starts, waits for a sign-in or an approval).
 */
import {
  type HostTailscaleChangeOutput,
  type HostTailscaleOutput,
  normalizeTailscaleLoginServer,
  TAILSCALE_POLL_MS,
  type TailscaleLoginServerProblem,
  type TailscaleProblem,
  type TailscaleStatus,
  tailscaleLoginUrlTrusted,
} from '@whombat/protocol/session';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';

export type { HostTailscaleOutput, TailscaleStatus } from '@whombat/protocol/session';

/** The ops. None is resent by itself (CT-1254). */
export interface TailscaleApi {
  state(): Promise<HostTailscaleOutput>;
  /**
   * `loginServer` (CT-1306; AP-5404): absent keeps the box's, null is Tailscale's own, another server signs the box out
   * of its tailnet first and starts a fresh sign-in there.
   */
  on(loginServer?: string | null): Promise<HostTailscaleChangeOutput>;
  /** `signOut`: also leave the tailnet (a new sign-in brings it back). */
  off(signOut?: boolean): Promise<HostTailscaleChangeOutput>;
  /** A fresh login link. */
  signIn(): Promise<HostTailscaleChangeOutput>;
}

export function tailscaleApi(session: ApplianceSession): TailscaleApi {
  return {
    state: () => sessionOps.hostTailscale(session),
    on: (loginServer) =>
      sessionOps.hostTailscaleOn(session, loginServer === undefined ? {} : { loginServer }),
    off: (signOut) => sessionOps.hostTailscaleOff(session, signOut ? { signOut: true } : {}),
    signIn: () => sessionOps.hostTailscaleSignIn(session),
  };
}

/** Every word of TAILSCALE. */
export const TAILSCALE_TEXT = {
  section: 'TAILSCALE',
  intro: 'Reach this Whombat over Tailscale, from anywhere your devices are on your tailnet.',
  title: 'Tailscale',
  off: 'Off',
  /** Off: what Tailscale is, for someone who hasn't met it. */
  offMeta: 'Reach this Whombat from anywhere with Tailscale, a private network for your own devices.',
  starting: 'Starting…',
  startingMeta: 'Tailscale is getting ready.',
  signIn: 'Sign in to Tailscale',
  signInMeta: 'Sign in with the Tailscale account this Whombat should join.',
  makingLink: 'Making a sign-in link…',
  approval: 'Waiting for approval',
  approvalMeta: 'Approve this Whombat in your Tailscale admin console.',
  on: 'On',
  /** Its name in the tailnet, as NETWORK's rows put an address under the state. */
  onMeta: (name: string, tailnet: string | null) => (tailnet ? `${name} · in ${tailnet}` : name),
  noHttps: 'Turn on HTTPS in your tailnet’s DNS settings to open this Whombat in a browser there.',
  error: 'Not working',
  problems: {
    not_running: 'Tailscale stopped on this Whombat. Turn it on again.',
    unreachable: 'This Whombat can’t reach Tailscale right now.',
    failed: 'Tailscale ran into a problem on this Whombat.',
  } satisfies Record<TailscaleProblem, string>,
  notHere: 'Tailscale isn’t on this Whombat.',
  unavailable: 'Couldn’t ask this Whombat about Tailscale.',
  turnOn: 'Turn on',
  openSignIn: 'Sign in',
  newLink: 'New sign-in link',
  turnOff: 'Turn off',
  tryAgain: 'Try again',
  offConfirmTitle: 'Turn off Tailscale?',
  offConfirm:
    'Devices that use Tailscale reach this Whombat through your local network or Whombat’s servers instead.',
  failedChange: 'That didn’t work. Try again.',
  busy: 'Tailscale is busy with another change. Try again in a moment.',
  /** Its own login server (community; AP-5404, AP-5426). */
  loginServer: 'Login server',
  loginServerOwn: 'Tailscale’s own',
  loginServerOwnMeta: 'This Whombat signs in to Tailscale’s own servers.',
  loginServerMeta: (server: string) => `This Whombat signs in to ${server}.`,
  /** The sign-in row's words on a server of the person's own. */
  signInOnMeta: (host: string) => `Sign in on ${host} with the account this Whombat should join.`,
  change: 'Change',
  changeTitle: 'Login server',
  changeLead: 'Use Headscale or your company’s server instead of Tailscale’s own.',
  field: 'Login server',
  fieldHint: 'Leave it empty for Tailscale’s own.',
  plainHttp: 'Plain http:// is fine for a server on your own network: Tailscale encrypts inside it.',
  moves:
    'This Whombat leaves its tailnet and signs in again on the new server. Devices that use Tailscale reach it another way until then.',
  save: 'Save and sign in',
  problems_server: {
    invalid: 'That isn’t a web address.',
    scheme: 'Start it with https:// or http://.',
    credentials: 'Leave the user name and password out of it.',
    query: 'Leave out anything after ? or #.',
    host: 'That server name doesn’t look right.',
    port: 'That port doesn’t look right.',
    path: 'That address has a character Whombat can’t pass on.',
  } satisfies Record<TailscaleLoginServerProblem, string>,
} as const;

/**
 * A typed login server (AP-5404): `null` for Tailscale's own (empty), its normal form, or why not in words. Plain
 * `http://` is allowed (a server on the person's network); `plainHttp` says so beside the field.
 */
export function readLoginServer(
  raw: string,
): { ok: true; value: string | null; plainHttp: boolean } | { ok: false; problem: string } {
  if (!raw.trim()) return { ok: true, value: null, plainHttp: false };
  const n = normalizeTailscaleLoginServer(raw);
  if (!n.ok) return { ok: false, problem: TAILSCALE_TEXT.problems_server[n.problem] };
  return { ok: true, value: n.value, plainHttp: n.value.startsWith('http://') };
}

/** The host of a login server for the words (`hs.lumio.example.org`), or the address as it is. */
export function loginServerHost(server: string): string {
  return /^https?:\/\/([^/:]+|\[[^\]]+\])/.exec(server)?.[1] ?? server;
}

export type TailscaleAction = 'turn_on' | 'sign_in' | 'new_link' | 'turn_off' | 'try_again';

/** The section's row: its dot, words, what can be done and Tailscale's link while it waits for a sign-in. */
export interface TailscaleView {
  dot: 'ok' | 'warn' | 'bad' | 'mut';
  title: string;
  meta: string;
  /**
   * Tailscale's login page (`https://login.tailscale.com/…`, or on the box's own login server), while it waits for a
   * sign-in; only a link `tailscaleLoginUrlTrusted` allows (CT-1306).
   */
  loginUrl: string | null;
  /** The box's own login server (absent: Tailscale's own; CT-1306). */
  loginServer: string | null;
  /** What can be done here, the first one the main action. */
  actions: TailscaleAction[];
  /** Ask again in this many ms (it is moving), or null. */
  pollMs: number | null;
  /** Nothing to show: this Whombat has no Tailscale (development). */
  hidden: boolean;
}

/** The row for `host.tailscale`'s answer (null: not asked yet). */
export function tailscaleView(answer: HostTailscaleOutput | null): TailscaleView {
  const T = TAILSCALE_TEXT;
  const base = { loginUrl: null, loginServer: null, pollMs: null, hidden: false };
  const can = (actions: TailscaleAction[], meta: string) => ({ actions, meta });
  if (!answer) return { ...base, dot: 'mut', title: T.title, meta: '', actions: [] };
  const s = answer.tailscale;
  if (!s) {
    if (answer.reason === 'not_managed')
      return { ...base, dot: 'mut', title: T.title, meta: T.notHere, actions: [], hidden: true };
    return { ...base, dot: 'mut', title: T.title, meta: T.unavailable, actions: ['try_again'] };
  }
  const server = s.loginServer ?? null;
  const at = { ...base, loginServer: server };
  // A login link only on the box's login server's origin, or Tailscale's without one (CT-1306).
  const trusted = s.loginUrl && tailscaleLoginUrlTrusted(s.loginUrl, server) ? s.loginUrl : null;
  switch (s.state) {
    case 'off':
      return { ...at, dot: 'mut', title: T.off, ...can(['turn_on'], T.offMeta) };
    case 'starting':
      return {
        ...at,
        dot: 'warn',
        title: T.starting,
        meta: T.startingMeta,
        actions: [],
        pollMs: TAILSCALE_POLL_MS,
      };
    case 'needs_sign_in':
      return {
        ...at,
        dot: 'warn',
        title: T.signIn,
        ...can(
          trusted ? ['sign_in', 'turn_off'] : ['turn_off'],
          trusted ? (server ? T.signInOnMeta(loginServerHost(server)) : T.signInMeta) : T.makingLink,
        ),
        loginUrl: trusted,
        pollMs: TAILSCALE_POLL_MS,
      };
    case 'needs_approval':
      return {
        ...at,
        dot: 'warn',
        title: T.approval,
        ...can(['turn_off'], T.approvalMeta),
        pollMs: TAILSCALE_POLL_MS,
      };
    case 'on':
      return {
        ...at,
        dot: 'ok',
        title: T.on,
        ...can(
          ['turn_off'],
          s.https ? T.onMeta(s.name ?? '', s.tailnet) : `${T.onMeta(s.name ?? '', s.tailnet)}. ${T.noHttps}`,
        ),
      };
    case 'error':
      return {
        ...at,
        dot: 'bad',
        title: T.error,
        ...can(['turn_on', 'turn_off'], T.problems[s.problem ?? 'failed']),
      };
  }
}

/** What a failed change says (`tailscale.busy` by name, anything else the general line). */
export function tailscaleErrorText(error: unknown): string {
  const code =
    error instanceof OperationError ? (error.details as { code?: unknown } | undefined)?.code : null;
  return code === 'tailscale.busy' ? TAILSCALE_TEXT.busy : TAILSCALE_TEXT.failedChange;
}

/** The status a change answered, as `host.tailscale` would (so the row follows at once). */
export function tailscaleAnswer(change: { tailscale: TailscaleStatus }): HostTailscaleOutput {
  return { tailscale: change.tailscale };
}
