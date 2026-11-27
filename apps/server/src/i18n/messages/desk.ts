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
});
