/**
 * What the assistant tells the person in Chat on the server's behalf, and what a backup look says when it can't open:
 * a connection that needs a new sign-in, an SSH host key that changed.
 */
import { splitPairs } from './pairs';

export const CHAT = splitPairs({
  'chat.repair.token_invalid': [
    '{name} stopped accepting my sign-in, so I can’t use it for now. You can sign in again in Settings → Connections.',
    '{name} accepteert mijn inlog niet meer, dus ik kan het nu niet gebruiken. Je kunt opnieuw inloggen via Instellingen → Koppelingen.',
  ],
  'chat.repair.revoked': [
    '{name} took my access back, so I can’t use it for now. You can sign in again in Settings → Connections.',
    '{name} heeft mijn toegang ingetrokken, dus ik kan het nu niet gebruiken. Je kunt opnieuw inloggen via Instellingen → Koppelingen.',
  ],
  'chat.repair.app_removed': [
    '{name} lost the app it signed in with on this Whombat, so I can’t use it for now. You can sign in again in Settings → Connections.',
    '{name} is de app kwijt waarmee het op deze Whombat inlogde, dus ik kan het nu niet gebruiken. Je kunt opnieuw inloggen via Instellingen → Koppelingen.',
  ],
  'chat.repair.expired': [
    '{name} let my sign-in run out, so I can’t use it for now. You can sign in again in Settings → Connections.',
    'Mijn inlog bij {name} is verlopen, dus ik kan het nu niet gebruiken. Je kunt opnieuw inloggen via Instellingen → Koppelingen.',
  ],
  'chat.sshHostKeyChanged': [
    'Whombat refused to connect an agent to one of the servers of your SSH keys: its host key changed. In the Vault the server shows “This server’s host key changed.” Check it there before agents use it again.',
    'Whombat liet een agent niet verbinden met een van de servers van je SSH-sleutels: de hostsleutel is veranderd. In de Kluis staat bij die server “De hostsleutel van deze server is veranderd.” Controleer hem daar voordat agents hem weer gebruiken.',
  ],

  // A backup look that can't open or stopped (`backups/look/peek.ts`).
  'look.busy': [
    'Another backup is open, or a backup is running right now. Try again in a few minutes.',
    'Er is al een andere back-up open, of er loopt nu een back-up. Probeer het over een paar minuten opnieuw.',
  ],
  'look.notSupported': [
    'This Whombat can’t open a backup to look inside it yet. It can once its next update is in.',
    'Deze Whombat kan nog geen back-up openen om erin te kijken. Dat kan na de volgende update.',
  ],
  'look.notFound': ['That backup isn’t there any more.', 'Die back-up is er niet meer.'],
  'look.failed': [
    'The backup couldn’t be opened. Try again in a few minutes.',
    'De back-up kon niet worden geopend. Probeer het over een paar minuten opnieuw.',
  ],
  'look.closed': [
    'The backup closed after two hours. Open it again to bring more back.',
    'De back-up is na twee uur gesloten. Open hem opnieuw om meer terug te halen.',
  ],
  'look.noRoomSized': [
    'There isn’t room on this Whombat to open this backup: it needs about {need} and {free} is free.',
    'Er is op deze Whombat geen ruimte om deze back-up te openen: hij heeft ongeveer {need} nodig en er is {free} vrij.',
  ],
  'look.noRoom': [
    'There isn’t room on this Whombat to open this backup.',
    'Er is op deze Whombat geen ruimte om deze back-up te openen.',
  ],
});
