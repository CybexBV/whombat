/**
 * The `voice.*` session ops (docs/decisions/dictation.md; `@whombat/protocol/session` `voice.ts`): voice typing's
 * settings and speech models, the person's. A box without a model fetcher can't download or remove (`not_implemented`).
 */
import type { VoiceDownloadModel, VoiceTypingPatch } from '@whombat/core/domain';
import type { VoiceDutchInput } from '@whombat/protocol/session';
import { requirePerson, type SessionPrincipal } from '../managed/trust';
import type { Services } from '../services';
import { voiceTypingFor } from './service';
import { voiceTypingForMinor } from './view';

interface VoiceOpContext {
  principal: SessionPrincipal;
  services: Services;
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type VoiceHandler = (c: VoiceOpContext, input: any) => Promise<unknown>;

export const VOICE_SESSION_HANDLERS: Readonly<Record<string, VoiceHandler>> = {
  'voice.get': async (c) => {
    requirePerson(c.principal);
    return voiceTypingForMinor(await voiceTypingFor(c.services).view(), c.principal.protocolMinor);
  },
  'voice.update': async (c, i: VoiceTypingPatch) =>
    voiceTypingForMinor(await voiceTypingFor(c.services).update(c.principal, i), c.principal.protocolMinor),
  'voice.fetchModel': async (c, i: { model: VoiceDownloadModel }) =>
    voiceTypingForMinor(
      await voiceTypingFor(c.services).fetchModel(c.principal, i.model),
      c.principal.protocolMinor,
    ),
  'voice.removeModel': async (c, i: { model: VoiceDownloadModel }) =>
    voiceTypingForMinor(
      await voiceTypingFor(c.services).removeModel(c.principal, i.model),
      c.principal.protocolMinor,
    ),
  'voice.setDutchVoice': async (c, i: VoiceDutchInput) =>
    voiceTypingForMinor(
      await voiceTypingFor(c.services).setDutchVoice(c.principal, i),
      c.principal.protocolMinor,
    ),
};
