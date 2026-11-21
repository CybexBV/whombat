/**
 * The burrow's system signer for mail-triggered automations: signs cursor updates and `mail.received` events
 * through the commit pipeline. Not on the roster, no keys, never dispatched.
 */
import { burrowSystemPrincipal } from '../domain/system-principals';

export const SYSTEM_MAIL = 'mail';

export const mailPrincipal = burrowSystemPrincipal({
  system: SYSTEM_MAIL,
  name: 'Mail',
  handle: 'mail-system',
  doing: 'Watching mailboxes for automations',
  job: 'Mail',
  line: { type: 'mail.system_principal', where: 'Mail' },
});
