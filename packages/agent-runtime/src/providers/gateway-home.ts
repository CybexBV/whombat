/**
 * The homes of turns through the burrow's AI gateway (Whombat docs/decisions/ai-gateway.md AIG-10):
 * `<base>/gateway/<connectionId>/<provider>`, where `base` is the credentials root (`WHOMBAT_CREDENTIALS_ROOT`) — a self-
 * hosted runner without one uses `WHOMBAT_HOME` (`~/.whombat/gateway/<connectionId>/<provider>`). Each level is a private
 * directory (0700, the runner's own, never a link). Never a person's home and never a sign-in: the gateway holds the
 * subscriptions, and the key is the dispatch's agent token. Claude Code keeps its settings in `config/`
 * (`CLAUDE_CONFIG_DIR`); ChatGPT's turns are Hermes's own loop calling the relay (HE-S48), so its home stays empty.
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { privateDir } from '../host';
import { CLAUDE_CONFIG_SUBDIR, CredentialHomeError } from './credential-home';
import { GATEWAY_CONNECTION_SEGMENT, GATEWAY_OWNER_SEGMENT } from './types';

/** `<base>/gateway/<connectionId>/<provider>`. Pure; refuses a connection id that isn't a plain id. */
export function gatewayHomePath(base: string, connectionId: string, provider: 'claude' | 'codex'): string {
  if (!isAbsolute(base))
    throw new CredentialHomeError('The gateway’s homes need an absolute base directory.');
  if (!GATEWAY_CONNECTION_SEGMENT.test(connectionId))
    throw new CredentialHomeError(`Not a connection id: ${JSON.stringify(connectionId)}.`);
  if (provider !== 'claude' && provider !== 'codex')
    throw new CredentialHomeError(`Not a provider: ${provider}.`);
  return join(base, GATEWAY_OWNER_SEGMENT, connectionId, provider);
}

/**
 * Creates (or checks) a gateway home, each level private (0700) below `base`: Claude's with its `config/`. Returns the
 * home. Throws `PrivateDirError` for a level that is a link, another user's or open to others.
 */
export async function prepareGatewayHome(
  base: string,
  connectionId: string,
  provider: 'claude' | 'codex',
): Promise<string> {
  const home = gatewayHomePath(base, connectionId, provider);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await privateDir(join(base, GATEWAY_OWNER_SEGMENT));
  await privateDir(join(base, GATEWAY_OWNER_SEGMENT, connectionId));
  await privateDir(home);
  if (provider === 'claude') await privateDir(join(home, CLAUDE_CONFIG_SUBDIR));
  return home;
}
