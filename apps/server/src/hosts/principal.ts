/**
 * The burrow's Servers signer (agent-updates-server.md AU-S04): an agent-shaped system principal named “Whombat”
 * (`principals.system = 'servers'`) that signs what the hosts service did on its own, so it is in Done recently as
 * Whombat's — today an agent the hosts service updated by itself (agent-updates.md AU-03, AU-08). Made on first use like
 * GitHub's, Feedback's and the trackers': one per burrow, not on the roster, no keys, no channels, never dispatched.
 * Clients see it as `system: 'automation'` (`Principal.system` is a closed enum older clients parse strictly; it runs
 * by itself, like an automation).
 */
import { burrowSystemPrincipal } from '../domain/system-principals';

/** `principals.system` of the Servers signer. */
export const SYSTEM_SERVERS = 'servers';
/** Its name, as Done recently shows who did it. */
export const SERVERS_SIGNER_NAME = 'Whombat';

/** The burrow's Servers signer: the existing one, else a new one with a signed creation event. */
export const serversPrincipal = burrowSystemPrincipal({
  system: SYSTEM_SERVERS,
  name: SERVERS_SIGNER_NAME,
  handle: 'whombat',
  doing: 'Signs what Whombat’s server monitoring does by itself.',
  job: 'Signs what Whombat’s server monitoring does by itself, like keeping the servers’ agents up to date.',
  line: { type: 'hosts.system_principal', where: 'Servers' },
}).ensure;
