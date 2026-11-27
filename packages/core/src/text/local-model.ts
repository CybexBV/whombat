/**
 * The custom OpenAI-compatible AI model in words: Settings → AI's form, what a test found, and the signed Keys line.
 * Covers both internet services over https (such as OpenRouter or Google Gemini) and a server on the person's network.
 */

import type { LocalModelCheckState } from '../domain/local-model.js';
import { coreTranslator, coreWords } from '../i18n/catalog.js';

const LOCAL_MODEL_KEYS = [
  'title',
  'hint',
  'address',
  'addressHint',
  'model',
  'modelHint',
  'label',
  'labelHint',
  'apiKey',
  /** Under the key field once one is saved: it is never shown again. */
  'apiKeySaved',
  'test',
  'save',
  'checkAgain',
  'remove',
  'removeTitle',
  'removeBody',
  /** The toast after saving. */
  'saved',
  /** The toast after removing. */
  'removed',
] as const;

/** Settings → AI: the section, its form and its buttons, in a locale. */
export function localModelCopy(
  locale?: string | null,
): Readonly<Record<(typeof LOCAL_MODEL_KEYS)[number], string>> {
  return coreWords(locale, 'localModel', LOCAL_MODEL_KEYS);
}

/** Settings → AI: the section, its form and its buttons. */
export const LOCAL_MODEL_COPY = localModelCopy('en');

/**
 * What a test found (`LocalModelCheck.state`), one or two sentences: “It answers.”, “Whombat can’t reach it. Check the
 * address and that the service or server is reachable.” `model` is the model it was asked for.
 */
export function localModelCheckText(
  state: LocalModelCheckState,
  model: string,
  locale?: string | null,
): string {
  return coreTranslator(locale).t(`localModel.check.${state}`, { model });
}

/** What changed, for `burrow.local_model_changed`. */
export type LocalModelChange = 'set' | 'changed' | 'removed';

/**
 * The signed Keys line of `burrow.local_model_changed`: “Mara set up OpenRouter as the custom AI model”,
 * “Mara changed the custom AI model to OpenRouter”, “Mara removed the custom AI model”. `name` is `localModelName`'s.
 */
export function localModelKeysText(input: { actor: string; change: LocalModelChange; name: string }): string {
  const { actor, change, name } = input;
  switch (change) {
    case 'set':
      return `${actor} set up ${name} as the custom AI model`;
    case 'changed':
      return `${actor} changed the custom AI model to ${name}`;
    case 'removed':
      return `${actor} removed the custom AI model`;
  }
}
