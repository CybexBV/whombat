/**
 * The `voice.*` session ops (docs/decisions/dictation.md; `@whombat/protocol/session` `voice.ts`): voice typing's
 * settings and speech models, the person's. A box without a model fetcher can't download or remove (`not_implemented`).
 */
import type { VoiceDownloadModel, VoiceTypingPatch } from '@whombat/core/domain';
import type { VoiceDutchInput } from '@whombat/protocol/session';
import { requirePerson, type SessionPrincipal } from '../managed/trust';
import type { Services } from '../services';
import { voiceTypingFor } from './service';

interface VoiceOpContext {
  principal: SessionPrincipal;
  services: Services;
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type VoiceHandler = (c: VoiceOpContext, input: any) => Promise<unknown>;

export const VOICE_SESSION_HANDLERS: Readonly<Record<string, VoiceHandler>> = {
  'voice.get': async (c) => {
    requirePerson(c.principal);
    return voiceTypingFor(c.services).view();
  },
  'voice.update': (c, i: VoiceTypingPatch) => voiceTypingFor(c.services).update(c.principal, i),
  'voice.fetchModel': (c, i: { model: VoiceDownloadModel }) =>
    voiceTypingFor(c.services).fetchModel(c.principal, i.model),
  'voice.removeModel': (c, i: { model: VoiceDownloadModel }) =>
    voiceTypingFor(c.services).removeModel(c.principal, i.model),
  'voice.setDutchVoice': (c, i: VoiceDutchInput) => voiceTypingFor(c.services).setDutchVoice(c.principal, i),
};
