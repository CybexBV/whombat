/**
 * Voice typing's settings in the database (`voice_typing`, migration 0009; docs/decisions/dictation.md): read
 * here, written only through the commit pipeline. A change is signed without words, as the desk's settings are.
 */
import { VoiceTypingPatch } from '@whombat/core/domain';
import { eq } from 'drizzle-orm';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { voiceTyping } from '../db/schema/index';
import { forbidden } from '../lib/errors';
import { DEFAULT_VOICE_TYPING, type VoiceTypingSettings } from './view';

/** The only row's id: the settings are the box's. */
const VOICE_TYPING_ID = 1;

export async function loadVoiceSettings(db: Db | Tx): Promise<VoiceTypingSettings> {
  const [row] = await db.select().from(voiceTyping).where(eq(voiceTyping.id, VOICE_TYPING_ID));
  if (!row) return DEFAULT_VOICE_TYPING;
  return { on: row.enabled, model: row.model, language: row.language };
}

/** `voice.update`: the person's change of any of the settings, in one commit. */
export const updateVoiceTyping = defineCommand({
  name: 'update_voice_typing',
  schema: VoiceTypingPatch,
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can change voice typing.');
    const next: VoiceTypingSettings = { ...(await loadVoiceSettings(tx)), ...input };
    const values = { enabled: next.on, model: next.model, language: next.language, updatedAt: ctx.now };
    await tx
      .insert(voiceTyping)
      .values({ id: VOICE_TYPING_ID, ...values })
      .onConflictDoUpdate({ target: voiceTyping.id, set: values });
    await ctx.emit({
      type: 'voice.updated',
      kind: 'System',
      text: null,
      where: null,
      payload: { settings: { ...next } },
    });
    return next;
  },
});

export const VOICE_COMMANDS = [updateVoiceTyping];
