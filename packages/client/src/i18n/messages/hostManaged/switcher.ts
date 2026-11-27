import { treeCatalogs } from '../../tree';

/** The Whombat switcher under the burrow's name (`managed/switcher.ts`) and the kinds of device that ask to be let in. */
export const SWITCHER_WORDS = treeCatalogs(
  'hostManaged.switcher',
  {
    here: 'This Whombat',
    all: 'All Whombats',
    label: '{name}. Your Whombats',
    platforms: {
      web: 'Browser',
      android: 'Android phone',
      ios: 'iPhone or iPad',
      desktop: 'Desktop app',
      cli: 'Command line',
      other: 'Device',
    },
  },
  {
    here: 'Deze Whombat',
    all: 'Alle Whombats',
    label: '{name}. Jouw Whombats',
    platforms: {
      web: 'Browser',
      android: 'Android-telefoon',
      ios: 'iPhone of iPad',
      desktop: 'Desktop-app',
      cli: 'Opdrachtregel',
      other: 'Apparaat',
    },
  },
);
