/**
 * The custom OpenAI-compatible AI model in words: Settings → AI's form, what a test found, and the signed Keys line.
 * Covers both internet services over https (such as OpenRouter or Google Gemini) and a server on the person's network.
 */
import type { LocalModelCheckState } from '../domain/local-model.js';

/** Settings → AI: the section, its form and its buttons. */
export const LOCAL_MODEL_COPY = {
  title: 'Custom AI model',
  hint: 'Use an OpenAI-compatible service over https (like OpenRouter or Google Gemini) with an API key, or a model server on your own network (like Ollama or LM Studio).',
  address: 'Address',
  addressHint: 'Where its OpenAI-compatible API is, usually ending in /v1. Use https:// for internet services.',
  model: 'Model',
  modelHint: 'The model’s name on that service or server, like gemini-2.5-flash or llama3.3:70b.',
  label: 'Name (optional)',
  labelHint: 'What you see in Whombat, like “OpenRouter” or “Llama on the NAS”.',
  apiKey: 'API key (optional)',
  /** Under the key field once one is saved: it is never shown again. */
  apiKeySaved: 'A key is saved. Type a new one to replace it.',
  test: 'Test',
  save: 'Save',
  checkAgain: 'Check again',
  remove: 'Remove',
  removeTitle: 'Remove the custom AI model?',
  removeBody: 'Anything set to use it can’t reply until you set it up again or pick another model.',
  /** The toast after saving. */
  saved: 'Saved the custom AI model.',
  /** The toast after removing. */
  removed: 'Removed the custom AI model.',
} as const;

/**
 * What a test found (`LocalModelCheck.state`), one or two sentences: “It answers.”, “Whombat can’t reach it. Check the
 * address and that the service or server is reachable.” `model` is the model it was asked for.
 */
export function localModelCheckText(state: LocalModelCheckState, model: string): string {
  switch (state) {
    case 'ok':
      return 'It answers.';
    case 'unreachable':
      return 'Whombat can’t reach it. Check the address and that the service or server is reachable.';
    case 'refused':
      return 'It turned Whombat away. Check the API key.';
    case 'no_model':
      return `It has no model called “${model}”. Check the name.`;
    case 'not_compatible':
      return 'It answered, but not like an OpenAI-compatible API. Check the address; it usually ends in /v1.';
    case 'blocked':
      return 'That address points at this Whombat itself or somewhere Whombat won’t send a model’s traffic. Use an internet https:// address or a server on your network.';
  }
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
