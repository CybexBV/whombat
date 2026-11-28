/**
 * App updates (app-updates.md): the line when an update ended, one sentence per app, and why a page's Update can't ask.
 * `{app}` and `{server}` are names, `{from}` and `{to}` versions: never translated.
 */
import { splitPairs } from './pairs';

export const APPS = splitPairs({
  'hosts.apps.list.none': ['the apps', 'de apps'],
  'hosts.apps.list.two': ['{first} and {second}', '{first} en {second}'],
  'hosts.apps.list.many': [
    { one: '{n} app', other: '{n} apps' },
    { one: '{n} app', other: '{n} apps' },
  ],
  'hosts.apps.updatedTo': ['{app} is updated to {to}.', '{app} is bijgewerkt naar {to}.'],
  'hosts.apps.updated': ['{app} is updated.', '{app} is bijgewerkt.'],
  'hosts.apps.current': ['{app} was already up to date.', '{app} was al bijgewerkt.'],
  'hosts.apps.held': [
    '{app} {to} is a new major version, so I left {from} running for you to decide.',
    '{app} {to} is een nieuwe hoofdversie, dus ik heb {from} laten draaien zodat jij kunt beslissen.',
  ],
  'hosts.apps.heldUnknown': [
    '{app}’s update may be a new major version, so I left it as it was for you to decide.',
    'De update van {app} kan een nieuwe hoofdversie zijn, dus ik heb het gelaten zoals het was zodat jij kunt beslissen.',
  ],
  'hosts.apps.rolledBack': [
    '{app} {to} didn’t start, so I put {from} back.',
    '{app} {to} startte niet, dus ik heb {from} teruggezet.',
  ],
  'hosts.apps.rolledBackUnknown': [
    '{app}’s update didn’t start, so I put the previous version back.',
    'De update van {app} startte niet, dus ik heb de vorige versie teruggezet.',
  ],
  'hosts.apps.pull': ['I couldn’t download {app}’s update.', 'Ik kon de update van {app} niet downloaden.'],
  'hosts.apps.noFiles': [
    'I couldn’t update {app}: its Compose files aren’t where it was started from any more.',
    'Ik kon {app} niet bijwerken: de Compose-bestanden staan niet meer waar het vandaan is gestart.',
  ],
  'hosts.apps.noCli': [
    'I couldn’t update {app}: Docker Compose isn’t installed on {server}.',
    'Ik kon {app} niet bijwerken: Docker Compose is niet geïnstalleerd op {server}.',
  ],
  'hosts.apps.gone': ['{app} isn’t on {server} any more.', '{app} staat niet meer op {server}.'],
  'hosts.apps.backFailed': [
    '{app} {to} didn’t start, and putting the previous version back didn’t work either: it needs a look.',
    '{app} {to} startte niet, en de vorige versie terugzetten lukte ook niet: dit moet even bekeken worden.',
  ],
  'hosts.apps.backFailedUnknown': [
    '{app} didn’t start, and putting the previous version back didn’t work either: it needs a look.',
    '{app} startte niet, en de vorige versie terugzetten lukte ook niet: dit moet even bekeken worden.',
  ],
  'hosts.apps.timeout': [
    'There wasn’t time left to update {app}.',
    'Er was geen tijd meer om {app} bij te werken.',
  ],
  'hosts.apps.changed': [
    '{app} changed after you said yes, so I left it alone. Ask me again to update it.',
    '{app} is veranderd nadat je ja zei, dus ik heb het zo gelaten. Vraag het me opnieuw om het bij te werken.',
  ],
  'hosts.apps.interrupted': [
    'I didn’t get to {app}: the update was cut short, most likely because {server} restarted.',
    'Ik ben niet aan {app} toegekomen: de update werd onderbroken, waarschijnlijk doordat {server} opnieuw opstartte.',
  ],
  'hosts.apps.failed': ['I couldn’t update {app}.', 'Ik kon {app} niet bijwerken.'],
  'hosts.apps.more': [
    { one: 'And {n} more.', other: 'And {n} more.' },
    { one: 'En nog {n}.', other: 'En nog {n}.' },
  ],
  // Why a page's Update can't ask.
  'hosts.apps.refuse.gone': [
    'That app isn’t on this server any more.',
    'Die app staat niet meer op deze server.',
  ],
  'hosts.apps.refuse.outdated': [
    'This server needs Whombat’s newer helper first. It gets it by itself.',
    'Deze server heeft eerst een nieuwere versie van Whombats helper nodig. Die krijgt hij vanzelf.',
  ],
  'hosts.apps.refuse.none': [
    'Whombat can update apps started with Docker Compose.',
    'Whombat kan apps bijwerken die met Docker Compose zijn gestart.',
  ],
  'hosts.apps.refuse.blocked': [
    '{app}’s image is pinned to one exact version.',
    'De image van {app} staat vast op één precieze versie.',
  ],
  'hosts.apps.refuse.updating': ['{app} is being updated right now.', '{app} wordt nu bijgewerkt.'],
  'hosts.apps.refuse.noAssistant': [
    'Your assistant isn’t set up yet.',
    'Je assistent is nog niet ingesteld.',
  ],
  'hosts.apps.refuse.off': [
    'Updating apps isn’t switched on for your assistant.',
    'Apps bijwerken staat niet aan voor je assistent.',
  ],
});
