/**
 * `pnpm --filter @whombat/server push:vapid` — generates a VAPID keypair for web push (docs/push-setup.md)
 * and prints the two env lines to paste into `.env`. Run once per environment; the keys don't expire.
 */
import webPush from 'web-push';

const { publicKey, privateKey } = webPush.generateVAPIDKeys();
console.log('# Add to .env (see docs/push-setup.md):');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
