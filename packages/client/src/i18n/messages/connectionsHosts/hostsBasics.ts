import { treeCatalogs } from '../../tree';

/** The row that brings temporary machines back (`hosts/temporary.ts`). */
export const HOSTS_TEMPORARY_WORDS = treeCatalogs(
  'hostsTemporary',
  {
    hidden: { one: '1 temporary machine hidden', other: '{count} temporary machines hidden' },
    shown: { one: '1 temporary machine shown', other: '{count} temporary machines shown' },
    show: 'Show',
    hide: 'Hide',
    about: 'Build and test machines that come and go by themselves.',
  },
  {
    hidden: { one: '1 tijdelijke machine verborgen', other: '{count} tijdelijke machines verborgen' },
    shown: { one: '1 tijdelijke machine getoond', other: '{count} tijdelijke machines getoond' },
    show: 'Tonen',
    hide: 'Verbergen',
    about: 'Bouw- en testmachines die vanzelf komen en gaan.',
  },
);

/** The words Point them here leaves to the app (`hosts/repoint.ts`). */
export const HOSTS_REPOINT_WORDS = treeCatalogs(
  'hostsRepoint',
  {
    nothing: 'Your servers have found this Whombat.',
    hide: 'Hide',
    done: 'Done',
  },
  {
    nothing: 'Je servers hebben deze Whombat gevonden.',
    hide: 'Verbergen',
    done: 'Klaar',
  },
);

/** A server's operating-system updates (`hosts/updates.ts`). */
export const HOSTS_UPDATES_WORDS = treeCatalogs(
  'hostsUpdates',
  {
    title: 'Updates',
    restartTitle: 'Restart',
    install: 'Install updates',
    check: 'Check now',
    showLog: 'Show log',
    restartNow: 'Restart now',
    running: { install: 'Installing updates…', check: 'Checking for updates…' },
    upToDate: 'Up to date',
    noReport: 'This server doesn’t report updates.',
    restartNeeded: 'Needed',
    restartNotNeeded: 'Not needed',
    nothingWaiting: 'Nothing to update.',
    confirmTitle: { one: 'Install 1 update on {server}?', other: 'Install {count} updates on {server}?' },
    confirmBody:
      '{server} keeps running while they install, and so do its guests. Services restart when they need to. A new kernel needs a restart afterwards; Whombat doesn’t restart {server} on its own.',
    needsFullControl: 'Installing updates needs Full control on {server}.',
    busy: 'Another program is installing packages on {server} right now. Try again in a few minutes.',
    wayOut: { web: 'See updates', phone: 'See updates' },
    started: { install: 'Installing updates on {server}.', check: 'Checking {server} for updates.' },
    what: { install: 'Updates on {server}', check: 'Update check on {server}' },
    finished: { install: 'Installed the updates on {server}.', check: 'Checked {server} for updates.' },
    failed: {
      install: 'Installing updates on {server} didn’t work.',
      check: 'Checking {server} for updates didn’t work.',
    },
    line: {
      couldntCheck: 'Couldn’t check: {error}',
      waiting: { one: '1 update waiting', other: '{count} updates waiting' },
      waitingSecurity: {
        one: '1 update waiting, {security} for security',
        other: '{count} updates waiting, {security} for security',
      },
      restartWhy: 'Needed: {reason}',
      checked: 'checked {ago}',
    },
    result: {
      verb: { install: 'Installing updates', check: 'Checking for updates' },
      timeout: '{verb} stopped: it took longer than {limit}.',
      limit: { install: '2 hours', check: '10 minutes' },
      stoppedWhy: '{verb} stopped: {why}.',
      stopped: '{verb} stopped.',
      installedAll: 'Installed the updates.',
      nothing: 'Nothing to install.',
      installed: { one: 'Installed 1 update.', other: 'Installed {count} updates.' },
      keptBack: 'Kept back: {list}.',
      keptBackMore: 'Kept back: {list} and {more} more.',
    },
    packageLabel: '{name}: {versions}',
    packageLabelSecurity: '{name}, security: {versions}',
    versionsTo: '{current} to {new}',
  },
  {
    title: 'Updates',
    restartTitle: 'Herstarten',
    install: 'Updates installeren',
    check: 'Nu controleren',
    showLog: 'Log tonen',
    restartNow: 'Nu herstarten',
    running: { install: 'Updates installeren…', check: 'Zoeken naar updates…' },
    upToDate: 'Bijgewerkt',
    noReport: 'Deze server meldt geen updates.',
    restartNeeded: 'Nodig',
    restartNotNeeded: 'Niet nodig',
    nothingWaiting: 'Niets bij te werken.',
    confirmTitle: {
      one: '1 update installeren op {server}?',
      other: '{count} updates installeren op {server}?',
    },
    confirmBody:
      '{server} blijft draaien terwijl ze installeren, en de gasten ook. Diensten herstarten als dat nodig is. Een nieuwe kernel heeft daarna een herstart nodig; Whombat herstart {server} niet uit zichzelf.',
    needsFullControl: 'Voor het installeren van updates is Volledige controle op {server} nodig.',
    busy: 'Een ander programma installeert nu pakketten op {server}. Probeer het over een paar minuten opnieuw.',
    wayOut: { web: 'Updates bekijken', phone: 'Updates bekijken' },
    started: { install: 'Updates installeren op {server}.', check: '{server} controleren op updates.' },
    what: { install: 'Updates op {server}', check: 'Updatecontrole op {server}' },
    finished: {
      install: 'De updates op {server} zijn geïnstalleerd.',
      check: '{server} is gecontroleerd op updates.',
    },
    failed: {
      install: 'Updates installeren op {server} is niet gelukt.',
      check: '{server} controleren op updates is niet gelukt.',
    },
    line: {
      couldntCheck: 'Kon niet controleren: {error}',
      waiting: { one: '1 update wacht', other: '{count} updates wachten' },
      waitingSecurity: {
        one: '1 update wacht, {security} voor beveiliging',
        other: '{count} updates wachten, {security} voor beveiliging',
      },
      restartWhy: 'Nodig: {reason}',
      checked: '{ago} gecontroleerd',
    },
    result: {
      verb: { install: 'Updates installeren', check: 'Zoeken naar updates' },
      timeout: '{verb} is gestopt: het duurde langer dan {limit}.',
      limit: { install: '2 uur', check: '10 minuten' },
      stoppedWhy: '{verb} is gestopt: {why}.',
      stopped: '{verb} is gestopt.',
      installedAll: 'De updates zijn geïnstalleerd.',
      nothing: 'Niets te installeren.',
      installed: { one: '1 update geïnstalleerd.', other: '{count} updates geïnstalleerd.' },
      keptBack: 'Tegengehouden: {list}.',
      keptBackMore: 'Tegengehouden: {list} en {more} meer.',
    },
    packageLabel: '{name}: {versions}',
    packageLabelSecurity: '{name}, beveiliging: {versions}',
    versionsTo: '{current} naar {new}',
  },
);

/** The range picker's words and the live line before it (`hosts/dashboard.ts`). */
export const HOSTS_DASHBOARD_RANGE_WORDS = treeCatalogs(
  'hostsDashboardRange',
  {
    ranges: { '1h': '1h', '6h': '6h', '24h': '24h', '7d': '7d', '30d': '30d', '90d': '90d' },
    live: 'Live · every 10 s',
  },
  {
    ranges: { '1h': '1u', '6h': '6u', '24h': '24u', '7d': '7d', '30d': '30d', '90d': '90d' },
    live: 'Live · elke 10 s',
  },
);
