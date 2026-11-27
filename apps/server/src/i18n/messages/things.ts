/**
 * The words around a thing: when an Ignore or snooze ends, and the parts every thing's page shares. `things.page.*`
 * are also phrasebook entries (`../phrases.ts`): kinds write them in English and the page is said in the reader's
 * language on its way out.
 */
import { splitPairs } from './pairs';

export const THINGS = splitPairs({
  'things.quiet.untilTime': ['until {time}', 'tot {time}'],
  'things.quiet.untilTomorrow': ['until tomorrow {time}', 'tot morgen {time}'],
  'things.quiet.untilDay': ['until {day} {time}', 'tot {day} {time}'],

  // The parts every page has (its status, the summary, how it answers).
  'things.page.summary': ['Summary', 'Samenvatting'],
  'things.page.notCheckedYet': ['Not checked yet', 'Nog niet gecontroleerd'],
  'things.page.notChecked': ['Not checked', 'Niet gecontroleerd'],
  'things.page.learning': ['Learning', 'Aan het leren'],
  'things.page.problems': ['Problems', 'Problemen'],
  'things.page.signedOut': ['Signed out', 'Uitgelogd'],
  'things.page.signInLine': ['Needs you to sign in again', 'Je moet opnieuw inloggen'],
  'things.page.notAnsweringNow': ['Not answering now', 'Reageert nu niet'],
  'things.page.answersWithErrors': ['Answers with errors', 'Reageert met fouten'],
  'things.page.answers': ['Answers', 'Reacties'],
  'things.page.over7Days': ['Over 7 days', 'Over 7 dagen'],
  'things.page.allAnswered': ['All answered', 'Alles beantwoord'],
  'things.page.answersIn': ['Answers in', 'Reageert in'],
  'things.page.typicalToday': ['Typical today', 'Normaal vandaag'],
  'things.page.typicalPerDay': ['Typical per day', 'Normaal per dag'],
  'things.page.byWhombat': ['By Whombat', 'Door Whombat'],
  'things.page.withWhombat': ['With Whombat', 'Met Whombat'],
  'things.page.checksAndUse': ['Its checks and use', 'Controles en gebruik'],
  'things.page.signIn': ['Sign-in', 'Inloggen'],
  'things.page.itsTools': ['Its tools', 'De tools'],
  'things.page.tools': ['Tools', 'Tools'],
  'things.page.yesterday': ['Yesterday', 'Gisteren'],
  'things.page.tomorrow': ['Tomorrow', 'Morgen'],
  'things.page.todayAt': ['Today {time}', 'Vandaag {time}'],
  'things.page.yesterdayAt': ['Yesterday {time}', 'Gisteren {time}'],
  'things.page.didntAnswerFor': ['Didn’t answer for {duration}', 'Reageerde {duration} niet'],
  'things.page.signInFailed': [
    'Its sign-in didn’t work at the last check',
    'Inloggen lukte niet bij de laatste controle',
  ],
  'things.page.toolsFailed': [
    'Whombat couldn’t use its tools at the last check',
    'Whombat kon de tools niet gebruiken bij de laatste controle',
  ],
  'things.page.addressRefused': ['Its address isn’t allowed any more', 'Het adres is niet meer toegestaan'],
  'things.page.toolsUnread': [
    'Its tools couldn’t be read at the last check',
    'De tools konden niet worden gelezen bij de laatste controle',
  ],
});
