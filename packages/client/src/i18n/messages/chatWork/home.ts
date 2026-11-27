import { treeCatalogs } from '../../tree';

/**
 * Home's words beyond what the flat catalog has: a thing's history (`home/monitoring.ts`), its changes
 * (`home/changes.ts`), and the failures renaming a thing or changing weather and news say (`react/`).
 */
export const HOME_AREA_WORDS = treeCatalogs(
  'cwHome',
  {
    history: {
      today: 'Today {clock}',
      yesterday: 'Yesterday {clock}',
      dayClock: '{day} {clock}',
    },
    duration: {
      min: '{m} min',
      h: '{h} h',
      hMin: '{h} h {m} min',
      d: '{d} d',
      dH: '{d} d {h} h',
    },
    changes: {
      asked: 'Asked {assistant} to undo this',
      yourAgent: 'your agent',
      undone: 'Undone.',
      needsApproval: 'Undoing this needs an approval first.',
      you: 'You',
    },
    failed: 'That didn’t work. Try again in a moment.',
    notThrough: 'That didn’t go through.',
  },
  {
    history: {
      today: 'Vandaag {clock}',
      yesterday: 'Gisteren {clock}',
      dayClock: '{day} {clock}',
    },
    duration: {
      min: '{m} min',
      h: '{h} u',
      hMin: '{h} u {m} min',
      d: '{d} d',
      dH: '{d} d {h} u',
    },
    changes: {
      asked: '{assistant} gevraagd dit ongedaan te maken',
      yourAgent: 'je agent',
      undone: 'Ongedaan gemaakt.',
      needsApproval: 'Dit ongedaan maken heeft eerst een goedkeuring nodig.',
      you: 'Jij',
    },
    failed: 'Dat lukte niet. Probeer het zo opnieuw.',
    notThrough: 'Dat lukte niet.',
  },
);
