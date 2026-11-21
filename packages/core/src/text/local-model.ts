/**
 * The model on the owner's network in words (0.124, CT-1175; Whombat hermes-engine.md HE-32): Settings → AI's form,
 * what a test found, and the signed Keys line. Plain words: an address, a model, a key (concise-replies.md).
 */
import type { LocalModelCheckState } from '../domain/local-model.js';

/** Settings → AI: the section, its form and its buttons. */
export const LOCAL_MODEL_COPY = {
  title: 'A model on your network',
  hint: 'Run the agent on a model server on your own network, like Ollama or LM Studio.',
  address: 'Address',
  addressHint: 'Where its OpenAI-compatible API is, usually ending in /v1.',
  model: 'Model',
  modelHint: 'The model’s name on that server, like llama3.3:70b.',
  label: 'Name (optional)',
  labelHint: 'What people see, like “Llama on the NAS”.',
  apiKey: 'API key (optional)',
  /** Under the key field once one is saved: it is never shown again. */
  apiKeySaved: 'A key is saved. Type a new one to replace it.',
  test: 'Test',
  save: 'Save',
  checkAgain: 'Check again',
  remove: 'Remove',
  removeTitle: 'Remove the model on your network?',
  removeBody: 'Anything set to use it can’t reply until you set it up again or pick another model.',
  /** The toast after saving. */
  saved: 'Saved the model on your network.',
  /** The toast after removing. */
  removed: 'Removed the model on your network.',
} as const;

/**
 * What a test found (`LocalModelCheck.state`), one or two sentences: “It answers.”, “Whombat can’t reach it. Check the
 * address and that the model server is running.” `model` is the model it was asked for.
 */
export function localModelCheckText(state: LocalModelCheckState, model: string): string {
  switch (state) {
    case 'ok':
      return 'It answers.';
    case 'unreachable':
      return 'Whombat can’t reach it. Check the address and that the model server is running.';
    case 'refused':
      return 'It turned Whombat away. Check the API key.';
    case 'no_model':
      return `It has no model called “${model}”. Check the name.`;
    case 'not_compatible':
      return 'It answered, but not like an OpenAI-compatible server. Check the address; it usually ends in /v1.';
    case 'blocked':
      return 'That address points at this Whombat itself or somewhere Whombat won’t send a model’s traffic. Use the model server’s address on your network.';
  }
}

/** What changed, for `burrow.local_model_changed`. */
export type LocalModelChange = 'set' | 'changed' | 'removed';

/**
 * The signed Keys line of `burrow.local_model_changed`: “Mara set up Llama on the NAS as the model on your network”,
 * “Mara changed the model on your network to Llama on the NAS”, “Mara removed the model on your network”. `name` is
 * `localModelName`'s.
 */
export function localModelKeysText(input: { actor: string; change: LocalModelChange; name: string }): string {
  const { actor, change, name } = input;
  switch (change) {
    case 'set':
      return `${actor} set up ${name} as the model on your network`;
    case 'changed':
      return `${actor} changed the model on your network to ${name}`;
    case 'removed':
      return `${actor} removed the model on your network`;
  }
}
