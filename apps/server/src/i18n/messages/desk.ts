/** The desk display: what the box's own screen says (`desk/`). */
import { splitPairs } from './pairs';

export const DESK = splitPairs({
  'desk.approve': ['Approve', 'Goedkeuren'],
  'desk.aDecision': ['A decision', 'Een beslissing'],
  'desk.serversTimeout': ['The servers didn’t answer in time.', 'De servers reageerden niet op tijd.'],

  // A connection's or device's widget when it can't show what it shows (`desk/widgets/things.ts`).
  'desk.widget.figures': ['Figures', 'Cijfers'],
  'desk.widget.widget': ['Widget', 'Widget'],
  'desk.widget.notAnswering': ['{name} isn’t answering', '{name} reageert niet'],
  'desk.widget.runsOnDown': [
    'It runs on {server}, which is down.',
    'Het draait op {server}, en die is uit de lucht.',
  ],
  'desk.widget.gone': ['It isn’t connected any more', 'Het is niet meer verbonden'],
  'desk.widget.couldntReadName': [
    'Whombat couldn’t read {name} just now.',
    'Whombat kon {name} net niet lezen.',
  ],
  'desk.widget.couldntRead': ['Whombat couldn’t read it just now.', 'Whombat kon het net niet lezen.'],
  'desk.widget.noFigures': ['No figures to show right now.', 'Nu geen cijfers om te tonen.'],
  'desk.widget.nothing': ['Nothing to show right now.', 'Nu niets om te tonen.'],
  'desk.widget.noLongerShownName': ['{name} doesn’t show this any more', '{name} toont dit niet meer'],
  'desk.widget.noLongerShown': ['Its page doesn’t show this any more', 'De pagina toont dit niet meer'],
  'desk.widget.noLongerInName': ['This isn’t in {name} any more', 'Dit staat niet meer in {name}'],
  'desk.widget.noLongerIn': ['This isn’t in its page any more', 'Dit staat niet meer op de pagina'],
  'desk.widget.couldntShow': ['Couldn’t show this just now', 'Kon dit net niet tonen'],
  // A widget whose read failed before it ever showed (`desk/widgets/resolve.ts`).
  'desk.widget.cantRead': ['I can’t read this right now.', 'Ik kan dit nu niet lezen.'],

  // The push that asks the person's phone to unlock the desk screen; its title is the desk's own words.
  'desk.unlockPush.body': [
    'Unlock it, or say no if it isn’t you.',
    'Ontgrendel het, of zeg nee als jij het niet bent.',
  ],

  // A server's other widgets: *Add a widget*'s lines and each part's view (`desk/widgets/server-parts.ts`).
  'desk.serverPart.ranges.1h': ['Last hour', 'Afgelopen uur'],
  'desk.serverPart.ranges.24h': ['Last 24 hours', 'Afgelopen 24 uur'],
  'desk.serverPart.ranges.7d': ['Last 7 days', 'Afgelopen 7 dagen'],
  'desk.serverPart.cores': ['of {n} cores', 'van {n} kernen'],
  'desk.serverPart.load': ['load {n}', 'belasting {n}'],
  'desk.serverPart.memoryOf': ['{used} of {total}', '{used} van {total}'],
  'desk.serverPart.memoryAvg': ['Avg {avg} %', 'Gem. {avg} %'],
  'desk.serverPart.used': ['{used} of {total} used', '{used} van {total} gebruikt'],
  'desk.serverPart.running': ['{n} running', '{n} actief'],
  'desk.serverPart.runningOff': ['{n} running · {off} off', '{n} actief · {off} uit'],
  'desk.serverPart.in': ['In', 'In'],
  'desk.serverPart.out': ['Out', 'Uit'],
  'desk.serverPart.hottest': ['Hottest', 'Warmste'],
  'desk.serverPart.hotFrom': ['hot from {n} °C', 'heet vanaf {n} °C'],
  'desk.serverPart.vm': ['VM', 'VM'],
  'desk.serverPart.container': ['Container', 'Container'],
  'desk.serverPart.stopped': ['off', 'uit'],
  'desk.serverPart.paused': ['paused', 'gepauzeerd'],
  'desk.serverPart.off': ['It’s switched off.', 'Hij staat uit.'],
  'desk.serverPart.failed': ['I can’t read {name} right now.', 'Ik kan {name} nu niet lezen.'],
  'desk.serverPart.noNetwork': [
    'It doesn’t say what goes in and out.',
    'Hij laat niet zien wat er in- en uitgaat.',
  ],
  'desk.serverPart.noStorage': [
    'It doesn’t say how full its disks are.',
    'Hij laat niet zien hoe vol zijn schijven zijn.',
  ],
  'desk.serverPart.noGuests': ['Nothing runs on it.', 'Er draait niets op.'],
  'desk.serverPart.noTemp': ['It doesn’t report its temperature.', 'Hij geeft zijn temperatuur niet door.'],
  'desk.serverPart.noAlerts': ['Nothing’s wrong with it right now.', 'Er is nu niets mis mee.'],
});
