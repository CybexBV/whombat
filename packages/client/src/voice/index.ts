/**
 * `@whombat/client/voice` — voice typing (docs/decisions/dictation.md): the session ops and the recording's upload as a
 * `VoiceApi`, the composer's controller (a port of T3 Code's voice input), the WAV a browser's recording becomes, and
 * what Settings → This Whombat → VOICE TYPING and the mic show, in words. React hooks are `@whombat/client/voice/react`;
 * the fixture worlds' speech service is `@whombat/client/voice/fake`.
 */
export * from './api';
export * from './controller';
export * from './model';
export * from './wav';
