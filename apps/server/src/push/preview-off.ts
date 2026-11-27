/**
 * A push for someone who turned previews off says nothing about what happened, whatever the caller handed the
 * transport: the title is “Whombat” and the text one of the generic lines the phone shows anyway. Each transport
 * applies this itself, so a caller that forgets to blank the words still can't send them to Apple or Google.
 */
import type { PushKind } from '@whombat/control-contracts/device';
import type { PushPayload } from '@whombat/core';
import { SUPPORTED_LANGUAGES } from '@whombat/core/i18n';
import { GENERIC_PUSH_TEXT, GENERIC_PUSH_TITLE, genericPushText } from '../domain/push-preview';
import { type ServerMessageKey, tServer } from '../i18n/catalog';

let safeBodies: ReadonlySet<string> | null = null;

/** Every generic line in every language Whombat speaks: the only texts a push without a preview may carry. */
function genericBodies(): ReadonlySet<string> {
  if (safeBodies) return safeBodies;
  const kinds = Object.keys(GENERIC_PUSH_TEXT) as PushKind[];
  const bodies = new Set<string>(Object.values(GENERIC_PUSH_TEXT));
  for (const language of SUPPORTED_LANGUAGES)
    for (const kind of kinds)
      bodies.add(tServer(language, `managed.push.generic.${kind}` as ServerMessageKey));
  safeBodies = bodies;
  return bodies;
}

/** Whether `body` is one of Whombat's generic push lines, in any language. */
export function isGenericPushBody(body: string): boolean {
  return genericBodies().has(body);
}

/** The words a push may show when previews are off: the generic title, and the body only when it is a generic line. */
export function previewOffWords(
  kind: PushPayload['kind'] | undefined,
  body: string,
): { title: string; body: string } {
  if (isGenericPushBody(body)) return { title: GENERIC_PUSH_TITLE, body };
  // A kind this server doesn't know has no line of its own: the catch-all one.
  const generic = kind ? genericPushText(kind, 'en') : undefined;
  return { title: GENERIC_PUSH_TITLE, body: generic ?? GENERIC_PUSH_TEXT.generic };
}

/**
 * The payload as it may leave this box: unchanged with previews on; with previews off the generic words, and without
 * the run, approval and live-activity details, which carry titles and labels of their own.
 */
export function guardPreview(payload: PushPayload): PushPayload {
  if (payload.preview !== false) return payload;
  const { run: _run, approval: _approval, liveActivity: _liveActivity, ...rest } = payload;
  return { ...rest, ...previewOffWords(payload.kind, payload.body) };
}
