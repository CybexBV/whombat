// Polyfills first: `@whombat/core` ids (and the fixture world) need `crypto.getRandomValues`.
import './src/polyfills';
// Then the error notes, before any of the app's own code is read: an error that ends the app is written down first,
// for its Whombat's log (src/errors/errorNotes.ts).
import './src/errors/start';
import { registerRootComponent } from 'expo';
import { App } from './src/App';
import { startShareCapture } from './src/navigation/ShareIntentBridge';

// Shares from other apps (AP-715) are held from the start, before anyone is signed in.
startShareCapture();
registerRootComponent(App);
