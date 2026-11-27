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
  'things.page.summary': ['Summary', 'Overzicht'],
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
  'things.page.cantReach': ['Whombat can’t reach it', 'Whombat kan het niet bereiken'],
  'things.page.answeringWithErrors': ['It’s answering with errors', 'Het reageert met fouten'],
  'things.page.answeredWithError': ['It answered with an error', 'Het reageerde met een fout'],
  'things.page.couldntReadNow': ['Whombat couldn’t read it just now', 'Whombat kon het net niet lezen'],
  'things.page.cantUseUntil': ['Whombat can’t use it until then.', 'Whombat kan het tot dan niet gebruiken.'],
  'things.page.aCheckFailed': ['A check failed', 'Een controle is mislukt'],
  'things.page.decide': ['Decide', 'Beslissen'],
  'things.page.chooseWhetherItMay': ['Choose whether it may.', 'Kies of het mag.'],
  'things.page.read': ['Read', 'Lezen'],
  'things.page.change': ['Change', 'Wijzigen'],
  'things.page.alwaysAsksFirst': ['Always asks first', 'Vraagt altijd eerst'],
  'things.page.failedChecks24h': ['failed checks in 24 h', 'mislukte controles in 24 u'],
  'things.page.checkedAgo': ['checked {duration} ago', '{duration} geleden gecontroleerd'],
  'things.page.atTime': ['at {time}', 'om {time}'],
  'things.page.averageIn': ['average {value} in {range}', 'gemiddeld {value} in {range}'],
  'things.page.untilAnswersProperly': ['Until it answers properly again.', 'Tot het weer goed reageert.'],
  'things.page.untilPassesCheck': [
    'Until it passes this check again.',
    'Tot het deze controle weer doorstaat.',
  ],
  'things.page.untilCanRead': ['Until Whombat can read it again.', 'Tot Whombat het weer kan lezen.'],
  'things.page.whyCantReach': ['Why can’t Whombat reach {name}?', 'Waarom kan Whombat {name} niet bereiken?'],
  'things.page.whyError': ['Why does {name} answer with an error?', 'Waarom reageert {name} met een fout?'],
  'things.page.needsSignIn': ['{name} needs you to sign in again', '{name}: je moet opnieuw inloggen'],
  'things.page.toolsUnread': [
    'Its tools couldn’t be read at the last check',
    'De tools konden niet worden gelezen bij de laatste controle',
  ],
});
