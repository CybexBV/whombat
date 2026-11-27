import { splitPairs } from './pairs.js';

/** The AI gateway's words (`text/gateway.ts`). */
export const GATEWAY = splitPairs({
  'gateway.connections': ['Settings → Connections', 'Instellingen → Koppelingen'],
  'gateway.aiSignIn': ['Settings → AI sign-in', 'Instellingen → AI-aanmelding'],
  'gateway.and': ['{a} and {b}', '{a} en {b}'],
  'gateway.today': ['today {clock}', 'vandaag {clock}'],
  'gateway.tomorrow': ['tomorrow {clock}', 'morgen {clock}'],
  'gateway.dayClock': ['{day} {clock}', '{day} {clock}'],
  'gateway.account': ['{provider} account {n}', '{provider}-account {n}'],
  'gateway.switchLabel': ['Send {tool} through {name}', 'Stuur {tool} via {name}'],
  'gateway.switchHint': [
    'Every {tool} turn on this Whombat goes through {name}, whoever asks. Off: turns use their usual sign-in again.',
    'Elke {tool}-beurt op deze Whombat gaat via {name}, wie het ook vraagt. Uit: beurten gebruiken weer hun gewone aanmelding.',
  ],
  'gateway.confirmTitle': ['Send {tool} through {name}?', '{tool} via {name} sturen?'],
  'gateway.confirmBody': [
    'Fusebox can share Claude and ChatGPT subscriptions between people. Anthropic’s terms say “Each end user must authenticate with their own … credentials”, and OpenAI asks people not to share a ChatGPT sign-in. Either can limit or suspend those accounts.',
    'Fusebox kan Claude- en ChatGPT-abonnementen tussen mensen delen. De voorwaarden van Anthropic zeggen “Each end user must authenticate with their own … credentials”, en OpenAI vraagt mensen een ChatGPT-aanmelding niet te delen. Beide kunnen die accounts beperken of blokkeren.',
  ],
  'gateway.confirm': ['Send through {name}', 'Via {name} sturen'],
  'gateway.cancel': ['Cancel', 'Annuleren'],
  'gateway.runsOnTitle': ['Runs on {name}', 'Draait op {name}'],
  'gateway.runsOnNote': [
    'Every {tool} turn on this Whombat goes through {name}. When it isn’t answering, your own Claude or ChatGPT sign-in is used. You can change this under {connections} → {name}.',
    'Elke {tool}-beurt op deze Whombat gaat via {name}. Als die niet antwoordt, wordt je eigen Claude- of ChatGPT-aanmelding gebruikt. Je kunt dit wijzigen onder {connections} → {name}.',
  ],
  'gateway.yourSubscriptions': ['Your subscriptions', 'Je abonnementen'],
  'gateway.toolOn': ['{tool} turns go through {name}', '{tool}-beurten gaan via {name}'],
  'gateway.toolOff': ['{tool} turns don’t go through {name}', '{tool}-beurten gaan niet via {name}'],
  'gateway.signInExpired': ['Sign-in expired', 'Aanmelding verlopen'],
  'gateway.offIn': ['Off in {name}', 'Uit in {name}'],
  'gateway.answering': ['{name} is answering', '{name} antwoordt'],
  'gateway.notAnswering': ['{name} isn’t answering', '{name} antwoordt niet'],
  'gateway.notReadYet': ['Not read yet', 'Nog niet gelezen'],
  'gateway.exists': [
    'This Whombat already sends its AI through {name}. Remove that connection first.',
    'Deze Whombat stuurt zijn AI al via {name}. Verwijder eerst die koppeling.',
  ],
  'gateway.outOfCredit': ['Out of API credit', 'Geen API-tegoed meer'],
  'gateway.tooOld': [
    'This Fusebox is too old to add a client key for Whombat. Update Fusebox and connect again.',
    'Deze Fusebox is te oud om een clientsleutel voor Whombat toe te voegen. Werk Fusebox bij en koppel opnieuw.',
  ],
  'gateway.removeByHand': [
    '{name} didn’t answer, so remove the client “{client}” there yourself.',
    '{name} antwoordde niet, dus verwijder de client “{client}” daar zelf.',
  ],
  'gateway.usedUp': ['Used up', 'Op'],
  'gateway.usedUpUntil': ['Used up until {until}', 'Op tot {until}'],
  'gateway.busy': ['Busy', 'Bezet'],
  'gateway.busyUntil': ['Busy until {until}', 'Bezet tot {until}'],
  'gateway.updated': ['Updated {ago}', 'Bijgewerkt {ago}'],
  'gateway.refusal.missing': [
    '{name} isn’t set up any more, so I couldn’t start. You can connect it again under {connections}.',
    '{name} is niet meer ingesteld, dus ik kon niet beginnen. Je kunt het opnieuw koppelen onder {connections}.',
  ],
  'gateway.refusal.unreachable': [
    '{name} isn’t answering and I have no Claude or ChatGPT sign-in of yours to use instead, so I couldn’t start. You can add one under {signIn}.',
    '{name} antwoordt niet en ik heb geen Claude- of ChatGPT-aanmelding van jou om in plaats daarvan te gebruiken, dus ik kon niet beginnen. Je kunt er een toevoegen onder {signIn}.',
  ],
  'gateway.refusal.usedUp': [
    '{name} has no {tool} room left, so I couldn’t start.',
    '{name} heeft geen ruimte meer voor {tool}, dus ik kon niet beginnen.',
  ],
  'gateway.refusal.usedUpUntil': [
    '{name} has no {tool} room left until {until}, so I couldn’t start.',
    '{name} heeft tot {until} geen ruimte meer voor {tool}, dus ik kon niet beginnen.',
  ],
  'gateway.alert.usedUp': [
    '{name} has no {tool} room left. {tool} turns won’t start until it has room again.',
    '{name} heeft geen ruimte meer voor {tool}. {tool}-beurten starten pas weer als er ruimte is.',
  ],
  'gateway.alert.usedUpUntil': [
    '{name} has no {tool} room left until {until}. {tool} turns won’t start until then.',
    '{name} heeft tot {until} geen ruimte meer voor {tool}. {tool}-beurten starten tot dan niet.',
  ],
  'gateway.alert.back': ['{name} has room for {tool} again.', '{name} heeft weer ruimte voor {tool}.'],
  'gateway.alert.signinExpired': [
    '{name}’s {provider} sign-in for {account} has expired. Sign in again in {name}.',
    'De {provider}-aanmelding van {name} voor {account} is verlopen. Log opnieuw in bij {name}.',
  ],
  'gateway.alert.fallback': [
    {
      one: '{name} isn’t answering, so I’m using your own {own} sign-in until it does.',
      other: '{name} isn’t answering, so I’m using your own {own} sign-ins until it does.',
    },
    {
      one: '{name} antwoordt niet, dus ik gebruik je eigen {own}-aanmelding tot hij weer antwoordt.',
      other: '{name} antwoordt niet, dus ik gebruik je eigen {own}-aanmeldingen tot hij weer antwoordt.',
    },
  ],
  'gateway.alert.unreachable': [
    '{name} isn’t answering, so {tools} turns won’t start until it does. Sign in to Claude or ChatGPT under {signIn} and I’ll use that while it’s down.',
    '{name} antwoordt niet, dus {tools}-beurten starten niet tot hij weer antwoordt. Log in bij Claude of ChatGPT onder {signIn}, dan gebruik ik dat zolang hij plat ligt.',
  ],
  'gateway.alert.reachable': ['Whombat reaches {name} again.', 'Whombat bereikt {name} weer.'],
});
