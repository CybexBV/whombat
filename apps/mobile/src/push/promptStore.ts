/** The app's one push prompt (MN-05), “Not now” kept in the secure store. */
import { secureStore } from '../lib/storage';
import { createPushPrompt } from './prompt';

export const pushPrompt = createPushPrompt(secureStore);
