/**
 * The AI gateway's homes (Whombat docs/decisions/ai-gateway.md AIG-10) and the model logins a gateway turn never gets.
 * A turn through the gateway runs on Hermes's own loop (hermes-engine.md HE-S50: `hermes/own-loop.ts`).
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatewayHomePath, prepareGatewayHome } from './providers/gateway-home';
import { GATEWAY_OWNER_SEGMENT } from './providers/types';
import { withoutModelLogins } from './support/env';

/** Logins and endpoints a runner's environment might hold: a gateway turn's CLI gets none of them. */
const LOGINS = {
  ANTHROPIC_API_KEY: 'sk-ant-LEAK',
  ANTHROPIC_AUTH_TOKEN: 'LEAK',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  ANTHROPIC_MODEL: 'claude-x',
  CLAUDE_CODE_OAUTH_TOKEN: 'LEAK',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CONFIG_DIR: '/home/runner/.claude',
  OPENAI_API_KEY: 'sk-LEAK',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  AZURE_OPENAI_API_KEY: 'LEAK',
  CODEX_API_KEY: 'LEAK',
  CODEX_HOME: '/home/runner/.codex',
};

describe('the gateway’s homes', () => {
  it('are <base>/gateway/<connection>/<provider>, private at every level; Claude’s with config/, ChatGPT’s empty', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-gw-home-'));
    const claude = await prepareGatewayHome(base, 'con_1', 'claude');
    const codex = await prepareGatewayHome(base, 'con_1', 'codex');
    expect(claude).toBe(join(base, GATEWAY_OWNER_SEGMENT, 'con_1', 'claude'));
    expect(codex).toBe(gatewayHomePath(base, 'con_1', 'codex'));
    for (const dir of [
      join(base, 'gateway'),
      join(base, 'gateway', 'con_1'),
      claude,
      join(claude, 'config'),
      codex,
    ])
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
    // Hermes's own loop calls the relay for ChatGPT: no Codex config, no login (HN-04).
    expect(readdirSync(codex)).toEqual([]);
  });

  it('refuses a connection id that isn’t a plain id, a relative base, and a level that is a link', async () => {
    expect(() => gatewayHomePath('/b', '../acc_1', 'claude')).toThrow(/connection id/);
    expect(() => gatewayHomePath('/b', 'a/b', 'claude')).toThrow(/connection id/);
    expect(() => gatewayHomePath('relative', 'con_1', 'claude')).toThrow(/absolute/);
    const base = mkdtempSync(join(tmpdir(), 'wb-gw-link-'));
    mkdirSync(join(base, 'elsewhere'), { mode: 0o700 });
    symlinkSync(join(base, 'elsewhere'), join(base, 'gateway'));
    await expect(prepareGatewayHome(base, 'con_1', 'claude')).rejects.toThrow(/link/);
  });

  it('withoutModelLogins drops every model login and endpoint, nothing else', () => {
    expect(withoutModelLogins({ ...LOGINS, PATH: '/usr/bin', GH_TOKEN: 'x', AWS_REGION: 'eu' })).toEqual({
      PATH: '/usr/bin',
      GH_TOKEN: 'x',
      AWS_REGION: 'eu',
    });
  });
});
