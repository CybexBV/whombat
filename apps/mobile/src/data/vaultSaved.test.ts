/** The lines under a message whose secret was blanked (Whombat vault-self-serve.md VS-07, VS-11; AP-4037…AP-4039). */
import { type Message, type MessageVaultSave, parseMessage, VAULT_BLANKED } from '@whombat/core';
import { DM_DUSTY_MESSAGES, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { chatItems } from './messages';
import { vaultSavedRows } from './vaultSaved';

const base = DM_DUSTY_MESSAGES[1] as Message;
const msg = (over: Partial<Message>): Message => ({ ...base, card: null, ...over });
const saved: MessageVaultSave = {
  entryId: 'vlt_plex',
  name: 'Plex',
  kind: 'login',
  how: 'saved',
  server: null,
  at: SEED_NOW.toISOString(),
};
const usedOnce: MessageVaultSave = {
  entryId: 'vlt_servers',
  name: 'Servers',
  kind: 'ssh',
  how: 'used_once',
  server: 'web-1',
  at: SEED_NOW.toISOString(),
};

describe('Saved to your Vault under a message (AP-4037)', () => {
  it('says each save in core’s words and opens its entry', () => {
    const rows = vaultSavedRows([saved, usedOnce]);
    expect(rows.map((r) => [r.entryId, r.name])).toEqual([
      ['vlt_plex', 'Plex'],
      ['vlt_servers', 'Servers'],
    ]);
    expect(rows[0]?.text).toContain('Plex');
    expect(rows[1]?.text).toContain('web-1');
    expect(rows[0]?.hint).toContain('Plex');
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(vaultSavedRows(undefined)).toEqual([]);
  });

  it('puts them on the message’s item, and none on a message without or a deleted one', () => {
    const ctx = worldContext();
    const [blanked, plain, deleted] = chatItems(
      [
        msg({ id: 'msg_v1', text: `The Plex password is ${VAULT_BLANKED}`, vaultSaved: [saved] }),
        msg({ id: 'msg_v2' }),
        msg({ id: 'msg_v3', deletedAt: SEED_NOW.toISOString(), vaultSaved: [saved] }),
      ],
      ctx,
      { authors: true },
    );
    expect(blanked?.vaultSaved.map((r) => r.entryId)).toEqual(['vlt_plex']);
    // The blanked secret stays the message's own text (VS-07): no markdown reads it as anything else.
    expect(blanked?.text).toContain(VAULT_BLANKED);
    expect(parseMessage(blanked?.text ?? '')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: `The Plex password is ${VAULT_BLANKED}` }] },
    ]);
    expect(plain?.vaultSaved).toEqual([]);
    expect(deleted?.vaultSaved).toEqual([]);
  });
});
