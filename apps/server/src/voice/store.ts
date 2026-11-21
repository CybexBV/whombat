/**
 * Voice typing and opt-in Dutch voice settings in the database (`voice_typing`, migrations 0000 and 0009): read
 * here, written only through the commit pipeline. Changes and licence agreements are signed without words.
 */
import { VoiceTypingPatch } from '@whombat/core/domain';
import { VoiceDutchInput } from '@whombat/protocol/session';
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
  return {
    on: row.enabled,
    model: row.model,
    language: row.language,
    dutchVoice: row.dutchVoice,
    dutchVoiceAgreedBy: row.dutchVoiceAgreedBy,
    dutchVoiceAgreedAt: row.dutchVoiceAgreedAt,
    dutchVoiceLicenceVersion: row.dutchVoiceLicenceVersion,
  };
}

/** `voice.update`: the person's change of any of the voice typing settings, in one commit. */
export const updateVoiceTyping = defineCommand({
  name: 'update_voice_typing',
  schema: VoiceTypingPatch,
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can change voice typing.');
    const prev = await loadVoiceSettings(tx);
    const next: VoiceTypingSettings = { ...prev, ...input };
    const values = { enabled: next.on, model: next.model, language: next.language, updatedAt: ctx.now };
    await tx
      .insert(voiceTyping)
      .values({
        id: VOICE_TYPING_ID,
        ...values,
        dutchVoice: next.dutchVoice,
        dutchVoiceAgreedBy: next.dutchVoiceAgreedBy,
        dutchVoiceAgreedAt: next.dutchVoiceAgreedAt,
        dutchVoiceLicenceVersion: next.dutchVoiceLicenceVersion,
      })
      .onConflictDoUpdate({ target: voiceTyping.id, set: values });
    await ctx.emit({
      type: 'voice.updated',
      kind: 'System',
      text: null,
      where: null,
      payload: { settings: { on: next.on, model: next.model, language: next.language } },
    });
    return next;
  },
});

/**
 * `voice.setDutchVoice`: turn the opt-in Dutch voice (Supertonic 3) on after recording the person's agreement to its
 * Open RAIL-M licence (who, when, licence version), or turn it off and clear the active agreement.
 */
export const setDutchVoice = defineCommand({
  name: 'set_dutch_voice',
  schema: VoiceDutchInput,
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can agree to or change the Dutch voice.');
    const prev = await loadVoiceSettings(tx);
    const dutch = input.on
      ? {
          dutchVoice: true,
          dutchVoiceAgreedBy: ctx.actor.id,
          dutchVoiceAgreedAt: ctx.now,
          dutchVoiceLicenceVersion: input.licenceVersion,
        }
      : {
          dutchVoice: false,
          dutchVoiceAgreedBy: null,
          dutchVoiceAgreedAt: null,
          dutchVoiceLicenceVersion: null,
        };
    const next: VoiceTypingSettings = { ...prev, ...dutch };
    await tx
      .insert(voiceTyping)
      .values({
        id: VOICE_TYPING_ID,
        enabled: next.on,
        model: next.model,
        language: next.language,
        ...dutch,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: voiceTyping.id,
        set: { ...dutch, updatedAt: ctx.now },
      });
    if (input.on) {
      await ctx.emit({
        type: 'voice.dutch_agreed',
        kind: 'System',
        text: null,
        where: null,
        payload: {
          on: true,
          agreedBy: ctx.actor.id,
          agreedAt: ctx.now.toISOString(),
          licenceVersion: input.licenceVersion,
        },
      });
    } else {
      await ctx.emit({
        type: 'voice.dutch_disabled',
        kind: 'System',
        text: null,
        where: null,
        payload: { on: false },
      });
    }
    return next;
  },
});

export const VOICE_COMMANDS = [updateVoiceTyping, setDutchVoice];
