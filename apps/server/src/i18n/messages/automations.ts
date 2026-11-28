/**
 * Automations that act without AI (direct-automations.md): why a step can't run now and how it went, on the run page
 * and in `{{steps.<id>.text}}`. `{name}` and `{label}` are names, never translated.
 */
import { splitPairs } from './pairs';

export const AUTOMATIONS = splitPairs({
  'automations.direct.cantDirect': ['This can’t be done directly.', 'Dit kan niet direct worden gedaan.'],
  'automations.direct.noServers': [
    'Whombat can’t reach {name}: no servers are connected.',
    'Whombat kan {name} niet bereiken: er zijn geen servers gekoppeld.',
  ],
  'automations.direct.gone': ['{name} isn’t connected any more.', '{name} is niet meer gekoppeld.'],
  'automations.direct.onlyHome': [
    'Only Home Assistant can be acted on directly this way.',
    'Alleen Home Assistant kan op deze manier direct worden aangestuurd.',
  ],
  'automations.direct.serversAway': [
    'Whombat can’t reach your servers just now.',
    'Whombat kan je servers nu niet bereiken.',
  ],
  'automations.direct.cantDo': ['{name} can’t do that.', '{name} kan dat niet.'],
  'automations.direct.setNot': ['{name} is set not to do this.', '{name} is ingesteld om dit niet te doen.'],
  'automations.direct.signIn': [
    '{name} needs you to sign in again; you can do that in Settings → Connections.',
    '{name} wil dat je opnieuw inlogt; dat kan in Instellingen → Koppelingen.',
  ],
  'automations.direct.lookOnly': [
    '{name} is set up to look only: the agent can read through it but not change anything. A person can switch it to Manage in Settings → Connections.',
    '{name} staat op alleen kijken: de assistent kan erdoor lezen maar niets wijzigen. Je kunt het in Instellingen → Koppelingen op Beheren zetten.',
  ],
  'automations.direct.noAssistant': ['The assistant isn’t available.', 'De assistent is niet beschikbaar.'],
  'automations.direct.httpError': [
    '{name} answered with an error (HTTP {status}).',
    '{name} antwoordde met een fout (HTTP {status}).',
  ],
  'automations.direct.saidNo': ['{name} said it couldn’t do it.', '{name} zei dat het niet lukte.'],
  'automations.direct.failed': ['Couldn’t {what}: {reason}', '{what} lukte niet: {reason}'],
  'automations.direct.maybeRestarted': [
    '{reason} It may or may not have restarted. Check, then say what happened.',
    '{reason} Misschien is hij herstart, misschien niet. Kijk het na en zeg wat er gebeurde.',
  ],
  'automations.direct.maybeRan': [
    '{reason} It may or may not have happened. Check, then say what happened.',
    '{reason} Misschien is het gebeurd, misschien niet. Kijk het na en zeg wat er gebeurde.',
  ],
  'automations.direct.askedFirst': ['Asked you first: {what}', 'Eerst aan jou gevraagd: {what}'],
  'automations.direct.unreachable': [
    'Couldn’t reach {name} at {time}, so nothing was sent to it.',
    'Whombat kon {name} om {time} niet bereiken, dus er is niets naar gestuurd.',
  ],
  'automations.direct.noEntity': ['{name} has no {target}.', '{name} heeft geen {target}.'],
  'automations.direct.noMachine': ['{name} has no machine {target}.', '{name} heeft geen machine {target}.'],
  'automations.direct.offThere': [
    '{name} is set not to allow this from Whombat.',
    '{name} staat dit niet toe vanuit Whombat.',
  ],
  'automations.direct.noAnswer': [
    '{name} didn’t say in time whether it worked.',
    '{name} zei niet op tijd of het lukte.',
  ],
  'automations.direct.notConfirmed': [
    'Sent “{what}” at {time}, but {name} didn’t say in time whether it worked, so it may not have happened.',
    'Om {time} “{what}” gestuurd, maar {name} zei niet op tijd of het lukte, dus misschien is het niet gebeurd.',
  ],
  'automations.direct.changedSinceYes': [
    '{name} changed since you said yes (its address, account or sign-in), so nothing was sent.',
    '{name} is veranderd sinds je ja zei (het adres, account of de inlog), dus er is niets gestuurd.',
  ],
  'automations.direct.maybeDone': [
    'Whombat stopped partway through this, so it may not have happened; check, then say what happened.',
    'Whombat stopte halverwege, dus misschien is het niet gebeurd; kijk het na en zeg wat er gebeurde.',
  ],
});
