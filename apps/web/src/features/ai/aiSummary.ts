/**
 * Settings → AI in the assistant shell, the pure parts (docs/decisions/less-is-more.md AP-1780…AP-1787): the help line
 * over your sign-ins, and the one line that stands for the folded “On this Whombat” — the AI clients and the agent
 * runner — with whether something there needs the person (then it opens by itself, AP-1753).
 */
import { CLIENT_NAMES, CLIENT_PROVIDERS, type ClientsList } from '@whombat/client/signins';
import type { AgentSetupStatus, ClientStatus, LiveProvider } from '@whombat/core/domain';
import { engineProblemCopy } from '@whombat/core/text';
import { currentLocale } from '../../i18n/provider';

export const YOUR_AI_TEXT = {
  /** The one sentence over the sign-ins (AP-1780), with the assistant's name. */
  help: (name: string) => `${name} works on your own sign-in.`,
  /** The same while the burrow's AI gateway carries a provider's turns (AIG-07): “Claude Code goes through Fusebox”. */
  helpGateway: (name: string, through: string) => `${name} works on your own sign-in (${through}).`,
  /** The folded area's name (AP-1786). */
  fold: 'On this Whombat',
  details: 'Details',
  hideDetails: 'Hide details',
} as const;

/** The line that stands for the folded area: what it says, its dot, and whether it opens by itself. */
export interface FoldSummary {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'mut';
  /** Something in it needs the person: it opens by itself (AP-1753). */
  attention: boolean;
}

/** “Claude Code and ChatGPT”, “Claude Code, ChatGPT and Gemini”. */
function and(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** “Part of this Whombat is missing” from “Part of this Whombat is missing. Updating this Whombat puts it back.” */
function firstSentence(text: string): string {
  const end = text.indexOf('. ');
  return (end < 0 ? text : text.slice(0, end)).replace(/\.$/, '');
}

/** Whether `a` is a later version than `b` (“2.1.300” after “2.1.296”; a build found on the host may be ahead). */
export function newerVersion(a: string, b: string): boolean {
  const parts = (v: string) =>
    v
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** “Claude Code 2.1.296” (its installed version). */
function installedName(provider: LiveProvider, client: ClientStatus): string {
  return client.installed ? `${CLIENT_NAMES[provider]} ${client.installed.version}` : CLIENT_NAMES[provider];
}

/**
 * The folded area in one line (AP-1786), the first that applies: the runner not running; what turns run on not ready
 * (its first sentence in the contracts' words, hermes-engine-app.md AP-5040: “Part of this Whombat is missing”); an
 * install that failed; a client that isn't installed; a provider that didn't start (“ChatGPT isn’t working”); an
 * install in progress; else what is installed — “Claude Code 2.1.302 is
 * installed and up to date” (“…and updates itself” while a newer tested version waits). Only Claude Code is a client
 * (chatgpt-no-client.md AP-5614): a Codex row an older Whombat still lists says nothing here.
 */
export function foldSummary({
  clients,
  setup,
}: {
  clients: ClientsList | undefined;
  setup: AgentSetupStatus | undefined;
}): FoldSummary {
  const ENGINE_PROBLEM_COPY = engineProblemCopy(currentLocale());
  if (setup && !setup.runner.connected)
    return { text: 'Part of Whombat is restarting', tone: 'bad', attention: true };
  const engine =
    setup?.hermes && !setup.hermes.ready ? ENGINE_PROBLEM_COPY[setup.hermes.problem ?? 'broken'] : null;
  if (engine) return { text: firstSentence(engine), tone: 'bad', attention: true };

  const listed = CLIENT_PROVIDERS.map((p): { provider: LiveProvider; client: ClientStatus | null } => ({
    provider: p,
    client: clients?.clients.find((c) => c.provider === p) ?? null,
  }));
  const failed = listed.find(({ client }) => client?.state === 'failed');
  if (failed)
    return { text: `${CLIENT_NAMES[failed.provider]} didn’t install`, tone: 'bad', attention: true };
  if (clients) {
    const missing = listed.filter(({ client }) => !client || client.state === 'not_installed');
    if (missing.length)
      return {
        text: `${and(missing.map((m) => CLIENT_NAMES[m.provider]))} ${missing.length > 1 ? 'aren’t' : 'isn’t'} installed`,
        tone: 'warn',
        attention: true,
      };
  }

  // A client that didn't start (the runner's words are under its row, AP-5324).
  const broken = (setup?.providers ?? []).find((p) => p.state === 'error');
  if (broken) return { text: `${CLIENT_NAMES[broken.provider]} isn’t working`, tone: 'bad', attention: true };

  const moving = listed.find(({ client }) => client?.state === 'installing' || client?.state === 'updating');
  if (moving)
    return {
      text:
        moving.client?.state === 'installing'
          ? `Installing ${CLIENT_NAMES[moving.provider]}…`
          : `${installedName(moving.provider, moving.client as ClientStatus)} is updating`,
      tone: 'warn',
      attention: false,
    };

  const installed = listed.filter(
    (x): x is { provider: LiveProvider; client: ClientStatus } => !!x.client?.installed,
  );
  if (installed.length === 0) return { text: 'Checking the AI clients…', tone: 'mut', attention: false };
  const behind = installed.some(
    ({ client }) =>
      client.latest && client.installed && newerVersion(client.latest.version, client.installed.version),
  );
  const names = installed.map(({ provider, client }) => installedName(provider, client));
  const verb = names.length > 1 ? 'are' : 'is';
  return {
    text: `${and(names)} ${verb} installed and ${behind ? (names.length > 1 ? 'update themselves' : 'updates itself') : 'up to date'}`,
    tone: 'ok',
    attention: false,
  };
}

/** The help over the sign-ins (AP-1780): with the gateway's providers when the burrow's AI gateway carries their turns. */
export function signInsHelp(
  name: string,
  gateway: { name: string; providers: readonly LiveProvider[] } | null,
): string {
  if (!gateway || gateway.providers.length === 0) return YOUR_AI_TEXT.help(name);
  const through = `${and(gateway.providers.map((p) => CLIENT_NAMES[p]))} ${gateway.providers.length > 1 ? 'go' : 'goes'} through ${gateway.name}`;
  return YOUR_AI_TEXT.helpGateway(name, through);
}
