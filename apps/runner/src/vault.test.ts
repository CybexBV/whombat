/**
 * The Vault in the runner (Whombat docs/decisions/vault.md VT-53, hermes-engine.md HE-43): every Vault tool is one
 * neutral activity row without evidence. What the agent holds keys to reaches its commands in the person's turns.
 */
import { describe, expect, it } from 'vitest';
import { classifyTool, VAULT_ACTIVITY_TOOL } from './activity';

describe('the Vault in the runner', () => {
  it.each(['vault_save', 'mcp__whombat__vault_add_server', 'whombat.vault_save'])(
    '%s is one neutral row without evidence',
    (name) => {
      expect(classifyTool({ name, category: 'mcp' })).toEqual({
        kind: 'whombat',
        tool: VAULT_ACTIVITY_TOOL,
        evidence: false,
      });
    },
  );
});
