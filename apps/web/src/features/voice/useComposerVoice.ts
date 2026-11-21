/**
 * A web composer's voice typing (docs/decisions/dictation.md DT-01, DT-08): `useVoiceTyping` with this page's
 * microphone, the app's `VoiceApi` and the composer's textarea, whose selection says where the words go. After the
 * words land, or the person cancels, the field has the focus again with the cursor after them.
 */
import { useVoiceTyping, type VoiceTypingView } from '@whombat/client/voice/react';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { useOptionalAppServices } from '../../app/providers';
import { createWebRecorder, webRecorderSupported } from './webRecorder';

let pageRecorder: ReturnType<typeof createWebRecorder> | null = null;

/** The page's one microphone, or null where it can't record. */
function webRecorder() {
  if (!webRecorderSupported()) return null;
  pageRecorder ??= createWebRecorder();
  return pageRecorder;
}

export interface ComposerVoiceOptions {
  burrow: string;
  /** Which draft the composer holds: a new one drops what goes on. */
  ownerKey: string;
  value: string;
  onValueChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export function useComposerVoice({
  burrow,
  ownerKey,
  value,
  onValueChange,
  inputRef,
}: ComposerVoiceOptions): VoiceTypingView {
  const services = useOptionalAppServices();
  const recorder = useMemo(webRecorder, []);
  const caret = useRef<number | null>(null);
  const voice = useVoiceTyping({
    api: services?.voice ?? null,
    burrow,
    recorder,
    ownerKey,
    text: value,
    selection: () => {
      const el = inputRef.current;
      return el
        ? { start: el.selectionStart, end: el.selectionEnd }
        : { start: value.length, end: value.length };
    },
    commit: (text, selection) => {
      caret.current = selection.start;
      onValueChange(text);
    },
  });
  // Back in the field once voice typing lets go of the composer, with the cursor after the new words.
  const wasActive = useRef(false);
  useEffect(() => {
    if (voice.active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (caret.current !== null) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [voice.active, inputRef]);
  return voice;
}
