/**
 * Loaded for what it does, before anything of the app (`index.ts`): from here on an error that ends the app is noted,
 * also one while the rest of the app's code is still being read.
 */
import { startErrorNotes } from './nativeErrorNotes';

startErrorNotes();
