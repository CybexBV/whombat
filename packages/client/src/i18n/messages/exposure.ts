import { treeCatalogs } from '../tree';

/**
 * Open to the internet (`home/exposure.ts`, Whombat internet-exposure.md): the page's own words. What each opening is,
 * how it is protected and what each place could read come from the box in the person's language.
 */
export const EXPOSURE_PAGE_WORDS = treeCatalogs(
  'internet',
  {
    title: 'Open to the internet',
    row: 'What the internet can reach',
    loading: 'Looking at what’s open…',
    failed: 'Couldn’t read what’s open to the internet.',
    retry: 'Try again',
    older: 'Update this Whombat to see what’s open to the internet.',
    openings: 'Open now',
    places: 'Where Whombat looked',
    isNew: 'New',
    looks: 'Worth a look',
    meant: 'Meant',
    open: 'Open {name}',
    thisIsMeant: 'This is meant',
    pointOut: 'Point it out again',
    meantDone: 'Whombat won’t point out {address} again.',
    pointedOut: 'Whombat will point out {address} again.',
    failedPress: 'That didn’t work. Try again.',
    askFailed: 'Couldn’t start that chat. Try again.',
  },
  {
    title: 'Bereikbaar vanaf internet',
    row: 'Wat internet kan bereiken',
    loading: 'Kijken wat er open staat…',
    failed: 'Kon niet lezen wat er vanaf internet bereikbaar is.',
    retry: 'Opnieuw proberen',
    older: 'Werk deze Whombat bij om te zien wat er vanaf internet bereikbaar is.',
    openings: 'Nu open',
    places: 'Waar Whombat keek',
    isNew: 'Nieuw',
    looks: 'Even naar kijken',
    meant: 'Bedoeld',
    open: '{name} openen',
    thisIsMeant: 'Dit is de bedoeling',
    pointOut: 'Weer melden',
    meantDone: 'Whombat meldt {address} niet meer.',
    pointedOut: 'Whombat meldt {address} weer.',
    failedPress: 'Dat lukte niet. Probeer het opnieuw.',
    askFailed: 'Kon dat gesprek niet starten. Probeer het opnieuw.',
  },
);
