/**
 * The words of a service's test (`works/`, docs/decisions/service-works.md): the page's “Does it really work?” card, its
 * line in Worth a look, the toasts of Run now and Watch it. The server writes them in English; these `things.page.*`
 * messages are the phrasebook that says them in the reader's language. A step's words fill `{what}` in the sentences
 * (“it can’t {what}”), so in Dutch they are written to follow “om”: “je bestanden te tonen”.
 */
import { splitPairs } from './pairs';

export const WORKS = splitPairs({
  // The card.
  'things.page.works.title': ['Does it really work?', 'Werkt het echt?'],
  'things.page.works.onAsk': ['Runs only when you ask', 'Draait alleen als je erom vraagt'],
  'things.page.works.every': ['Every {minutes} minutes', 'Elke {minutes} minuten'],
  'things.page.works.passed': ['passed {n} of the last {count}', '{n} van de laatste {count} geslaagd'],
  'things.page.works.runNow': ['Run now', 'Nu uitvoeren'],
  'things.page.works.watch': ['Watch it', 'In de gaten houden'],
  'things.page.works.stopWatching': ['Stop watching', 'Niet meer in de gaten houden'],
  'things.page.works.notRun': [
    'Not run yet. Whombat only reads: it opens something as you would, and keeps only the result.',
    'Nog niet uitgevoerd. Whombat kijkt alleen: het opent iets zoals jij dat zou doen, en bewaart alleen de uitkomst.',
  ],
  'things.page.works.check': ['Whether it really works', 'Of het echt werkt'],

  // The tests.
  'things.page.works.files': ['Open one of your files', 'Een van je bestanden openen'],
  'things.page.works.photo': ['Open your newest photo', 'Je nieuwste foto openen'],
  'things.page.works.document': ['Open your newest document', 'Je nieuwste document openen'],
  'things.page.works.library': [
    'Open the newest item of a library',
    'Het nieuwste item van een bibliotheek openen',
  ],
  'things.page.works.sensor': ['See a sensor change', 'Een sensor zien veranderen'],

  // What a run did.
  'things.page.works.done.files': ['opened one of your files', 'een van je bestanden geopend'],
  'things.page.works.done.photo': ['opened your newest photo', 'je nieuwste foto geopend'],
  'things.page.works.done.document': ['opened your newest document', 'je nieuwste document geopend'],
  'things.page.works.done.library': [
    'opened the newest item of a library',
    'het nieuwste item van een bibliotheek geopend',
  ],
  'things.page.works.done.libraryNamed': [
    'opened the newest item in ‘{name}’',
    'het nieuwste item in ‘{name}’ geopend',
  ],
  'things.page.works.done.sensor': ['saw a sensor change', 'een sensor zien veranderen'],

  // What a step tried, as “it can’t {what}”.
  'things.page.works.step.listFiles': ['list your files', 'je bestanden te tonen'],
  'things.page.works.step.openFiles': ['open your files', 'je bestanden te openen'],
  'things.page.works.step.findPhoto': ['find your newest photo', 'je nieuwste foto te vinden'],
  'things.page.works.step.showPhoto': ['show your newest photo', 'je nieuwste foto te tonen'],
  'things.page.works.step.findDocument': ['find your newest document', 'je nieuwste document te vinden'],
  'things.page.works.step.openDocument': ['open your newest document', 'je nieuwste document te openen'],
  'things.page.works.step.libraries': ['list its libraries', 'de bibliotheken te tonen'],
  'things.page.works.step.findItem': ['find anything in your libraries', 'iets in je bibliotheken te vinden'],
  'things.page.works.step.details': ['open an item’s details', 'de details van een item te openen'],
  'things.page.works.step.openItem': [
    'open the newest item of a library',
    'het nieuwste item van een bibliotheek te openen',
  ],
  'things.page.works.step.readSensors': ['read its sensors', 'de sensoren te lezen'],
  'things.page.works.step.freshSensors': [
    'get new readings from its sensors',
    'nieuwe metingen van de sensoren te krijgen',
  ],
  'things.page.works.step.other': ['do what it should', 'te doen wat het moet doen'],

  // A run in one sentence.
  'things.page.works.ok': ['It works — {what} in {seconds} s.', 'Het werkt — {what} in {seconds} s.'],
  'things.page.works.okSensor': [
    'It works — a sensor changed {duration} ago.',
    'Het werkt — een sensor veranderde {duration} geleden.',
  ],
  'things.page.works.empty': [
    '{name} opens, but there’s nothing to open yet.',
    '{name} gaat open, maar er is nog niets om te openen.',
  ],
  'things.page.works.accessStatus': [
    'The sign-in Whombat uses can’t {what} any more (it answered {status}).',
    'Met de inlog die Whombat gebruikt lukt het niet meer om {what} (het antwoord was {status}).',
  ],
  'things.page.works.access': [
    'The sign-in Whombat uses can’t {what} any more.',
    'Met de inlog die Whombat gebruikt lukt het niet meer om {what}.',
  ],
  'things.page.works.down': [
    '{name} stopped answering when Whombat tried to {what}.',
    '{name} reageerde niet meer toen Whombat probeerde {what}.',
  ],
  'things.page.works.stale': [
    '{name} opens, but none of its sensors changed in the last hour.',
    '{name} gaat open, maar geen van de sensoren is het afgelopen uur veranderd.',
  ],
  'things.page.works.page': [
    '{name} answered with a web page instead of its data when Whombat tried to {what}.',
    '{name} gaf een webpagina in plaats van zijn gegevens toen Whombat probeerde {what}.',
  ],
  'things.page.works.timeout': [
    '{name} opens, but it can’t {what} (it didn’t answer in time).',
    '{name} gaat open, maar het lukt niet om {what} (er kwam niet op tijd antwoord).',
  ],
  'things.page.works.brokenStatus': [
    '{name} opens, but it can’t {what} (it answered {status}).',
    '{name} gaat open, maar het lukt niet om {what} (het antwoord was {status}).',
  ],
  'things.page.works.broken': [
    '{name} opens, but it can’t {what}.',
    '{name} gaat open, maar het lukt niet om {what}.',
  ],

  // Its line in Worth a look.
  'things.page.works.failedTwice': [
    'Whombat’s test of it failed twice in a row, last at {time}.',
    'De test van Whombat is twee keer achter elkaar mislukt, het laatst om {time}.',
  ],
  'things.page.works.badge.files': ['Files don’t open', 'Bestanden gaan niet open'],
  'things.page.works.badge.photo': ['Photos don’t open', 'Foto’s gaan niet open'],
  'things.page.works.badge.document': ['Documents don’t open', 'Documenten gaan niet open'],
  'things.page.works.badge.library': ['Library doesn’t open', 'Bibliotheek gaat niet open'],
  'things.page.works.badge.sensor': ['Sensors don’t change', 'Sensoren veranderen niet'],
  'things.page.works.badge.access': ['Test sign-in lost access', 'Test-inlog heeft geen toegang'],
  'things.page.works.checkSignIn': ['Check the sign-in', 'Inlog controleren'],
  'things.page.works.untilPasses': ['Until the test passes again.', 'Tot de test weer slaagt.'],
  'things.page.works.ask.files': [
    'Why can’t {name} open my files?',
    'Waarom kan {name} mijn bestanden niet openen?',
  ],
  'things.page.works.ask.photo': [
    'Why don’t my photos open in {name}?',
    'Waarom gaan mijn foto’s niet open in {name}?',
  ],
  'things.page.works.ask.document': [
    'Why don’t my documents open in {name}?',
    'Waarom gaan mijn documenten niet open in {name}?',
  ],
  'things.page.works.ask.library': [
    'Why can’t {name} open what’s in my libraries?',
    'Waarom kan {name} niet openen wat er in mijn bibliotheken staat?',
  ],
  'things.page.works.ask.sensor': [
    'Why don’t my sensors change in {name}?',
    'Waarom veranderen mijn sensoren niet in {name}?',
  ],

  // The toasts.
  'things.page.works.watching': [
    'Whombat runs this test every {minutes} minutes now.',
    'Whombat voert deze test nu elke {minutes} minuten uit.',
  ],
  'things.page.works.stopped': [
    'Whombat stopped running this test.',
    'Whombat voert deze test niet meer uit.',
  ],
});
