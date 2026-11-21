/**
 * What the AI setup screens derive from `signins.list` and `clients.list` (CT-70, CT-72): the person's sign-in for a
 * provider (one per provider, CT-1503), whether a provider can run agents, and which sign-in modes to offer. Only Claude
 * Code is a client Whombat installs; ChatGPT needs nothing installed (chatgpt-no-client.md AP-5610).
 */
import type { api } from '@whombat/core/contracts';
import type { ClientStatus, LiveProvider, ProviderSignIn } from '@whombat/core/domain';
import type { ResponseData } from '../http/types';
import { withBurrow } from '../paths';

export type SignInsList = ResponseData<typeof api.signins.list>;
export type ClientsList = ResponseData<typeof api.clients.list>;

/** The subscription sign-in of each provider (SUB-01): Claude Code's console, ChatGPT's device code. */
export const SUBSCRIPTION_MODE: Record<LiveProvider, string> = {
  claude: 'subscription_cli',
  codex: 'chatgpt',
};
export const API_KEY_MODE = 'api_key';

/** The person's own sign-in for `provider`: a ready one first. */
export function signInOf(list: SignInsList | undefined, provider: LiveProvider): ProviderSignIn | null {
  const mine = (list?.signIns ?? []).filter((s) => s.provider === provider);
  return mine.find((s) => s.state === 'ready') ?? mine[0] ?? null;
}

/** Whether the policy lets this account start `authMode` for `provider`, and why not. */
export function modeOf(
  list: SignInsList | undefined,
  provider: LiveProvider,
  authMode: string,
): { available: boolean; reason: string | null } | null {
  const m = list?.modes.find((x) => x.provider === provider && x.authMode === authMode);
  return m ? { available: m.available, reason: m.reason } : null;
}

/**
 * The providers that run as a client Whombat installs (chatgpt-no-client.md AP-5610): Claude Code only — its sign-in
 * and its turns need the Claude CLI. ChatGPT runs on Hermes's own loop and signs in through Hermes's device-code login,
 * so nothing is installed for it (Whombat hermes-native.md HN-02…HN-04, HN-C08).
 */
export const CLIENT_PROVIDERS = ['claude'] as const satisfies readonly LiveProvider[];
export type ClientProvider = (typeof CLIENT_PROVIDERS)[number];

/** Whether `provider` runs as an installed client (Claude Code), or needs nothing installed (ChatGPT). */
export function needsClient(provider: LiveProvider): provider is ClientProvider {
  return (CLIENT_PROVIDERS as readonly LiveProvider[]).includes(provider);
}

/** The client of `provider` as listed; null for a provider without one (an older list's Codex row is ignored). */
export function clientOf(list: ClientsList | undefined, provider: LiveProvider): ClientStatus | null {
  if (!needsClient(provider)) return null;
  return list?.clients.find((c) => c.provider === provider) ?? null;
}

/** Installed and runnable (an update in progress keeps the installed version running). */
export function clientInstalled(client: ClientStatus | null): boolean {
  return !!client?.installed && client.state !== 'installing';
}

/**
 * Nothing to install before `provider`'s sign-in and turns: its client is installed (Claude Code), or it needs none
 * (ChatGPT, AP-5610).
 */
export function clientReady(provider: LiveProvider, clients: ClientsList | undefined): boolean {
  return !needsClient(provider) || clientInstalled(clientOf(clients, provider));
}

/**
 * A provider the agent can use (onboarding's picker): its client installed, or none needed (ChatGPT, AP-5610), and the
 * person signed in to it, with their subscription or their own API key (SUB-04, CT-1503).
 */
export function clientUsable(
  provider: LiveProvider,
  clients: ClientsList | undefined,
  signIns: SignInsList | undefined,
): boolean {
  return clientReady(provider, clients) && signInOf(signIns, provider)?.state === 'ready';
}

/**
 * Settings → AI of a burrow, where the person signs in (the phone links there, SUB-11): burrow-less, naming the burrow
 * with `?burrow=` (AP-365).
 */
export function aiAccountsPath(burrow: string): string {
  return withBurrow('/settings?tab=agent&part=ai', burrow);
}
