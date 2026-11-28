import { treeCatalogs } from '../../tree';

/** Docker Compose app updates on a server's apps list and a service's page (`hosts/app-updates.ts`). */
export const HOSTS_APP_UPDATES_WORDS = treeCatalogs(
  'hostsAppUpdates',
  {
    available: 'Update available',
    availableTo: 'Update available: {version}',
    updating: 'Updating…',
    update: 'Update',
    updateName: 'Update {name}',
    pinned: 'Pinned to one exact version',
    asks: {
      database: 'A database: Whombat asks you first',
      major: 'A new major version: Whombat asks you first',
    },
    last: {
      updated: 'Updated to {version} · {ago}',
      updatedPlain: 'Updated {ago}',
      rolledBack: '{to} didn’t start, so {from} is back',
      rolledBackPlain: 'Its update didn’t start, so the previous version is back',
      failed: 'Its last update didn’t work',
      held: '{version} waits for you: a new major version',
    },
    outdated: 'This server needs Whombat’s newer helper to update apps. It gets it by itself.',
    composeOnly: 'Whombat can update apps started with Docker Compose.',
    needsFullControl: 'Updating apps needs Full control on {server}.',
    title: 'App update',
  },
  {
    available: 'Update beschikbaar',
    availableTo: 'Update beschikbaar: {version}',
    updating: 'Bijwerken…',
    update: 'Bijwerken',
    updateName: '{name} bijwerken',
    pinned: 'Vastgezet op één versie',
    asks: {
      database: 'Een database: Whombat vraagt het je eerst',
      major: 'Een nieuwe hoofdversie: Whombat vraagt het je eerst',
    },
    last: {
      updated: 'Bijgewerkt naar {version} · {ago}',
      updatedPlain: 'Bijgewerkt {ago}',
      rolledBack: '{to} startte niet, dus {from} draait weer',
      rolledBackPlain: 'De update startte niet, dus de vorige versie draait weer',
      failed: 'De laatste update lukte niet',
      held: '{version} wacht op jou: een nieuwe hoofdversie',
    },
    outdated:
      'Deze server heeft de nieuwere helper van Whombat nodig om apps bij te werken. Die krijgt hij vanzelf.',
    composeOnly: 'Whombat kan apps bijwerken die met Docker Compose zijn gestart.',
    needsFullControl: 'Voor het bijwerken van apps is Volledige controle op {server} nodig.',
    title: 'App-update',
  },
);
