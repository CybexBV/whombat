import { splitPairs } from './pairs.js';

/** Stats and shared screen copy (`text/format.ts`, `text/copy.ts`). */
export const TEXT = splitPairs({
  'format.files': [
    { one: '{count} file', other: '{count} files' },
    { one: '{count} bestand', other: '{count} bestanden' },
  ],
  'format.replies': [
    { one: '{count} reply', other: '{count} replies' },
    { one: '{count} reactie', other: '{count} reacties' },
  ],
  'format.of': ['{passed} of {total}', '{passed} van {total}'],
  'format.passing': ['{of} passing', '{of} geslaagd'],

  'copy.planLabel': [
    { one: 'PLAN · {count} STEP', other: 'PLAN · {count} STEPS' },
    { one: 'PLAN · {count} STAP', other: 'PLAN · {count} STAPPEN' },
  ],
  'copy.researchLabel': ['RESEARCH · {topic}', 'ONDERZOEK · {topic}'],
  'copy.researchSources': [
    { one: '{count} source', other: '{count} sources' },
    { one: '{count} bron', other: '{count} bronnen' },
  ],
  'copy.researchMeta': ['{sources} · {tested} tested', '{sources} · {tested} getest'],
  'copy.reviewLabel': [
    { one: 'REVIEW · {count} CHANGE REQUESTED', other: 'REVIEW · {count} CHANGES REQUESTED' },
    { one: 'REVIEW · {count} WIJZIGING GEVRAAGD', other: 'REVIEW · {count} WIJZIGINGEN GEVRAAGD' },
  ],
  'copy.runStatus.live': ['LIVE', 'LIVE'],
  'copy.runStatus.paused': ['PAUSED', 'GEPAUZEERD'],
  'copy.runStatus.done': ['DONE', 'KLAAR'],
  'copy.runStatus.failed': ['FAILED', 'MISLUKT'],
  'copy.runStatus.taken_over': ['TAKEN OVER', 'OVERGENOMEN'],
  'copy.runLabel': ['RUN · {status}', 'RUN · {status}'],
  'copy.runKicker': ['{label} · {agent} · STARTED {time}', '{label} · {agent} · GESTART {time}'],
  'copy.runNow': ['Now: {activity}', 'Nu: {activity}'],
  'copy.runPaused': ['Paused: {activity}', 'Gepauzeerd: {activity}'],
  'copy.runTakenOver': ['Taken over: {activity}', 'Overgenomen: {activity}'],
  'copy.runKeysTitle': ['{agent}’s keys for this run', 'Sleutels van {agent} voor deze run'],
  'copy.runKeysScope': ['scoped to {branch}', 'beperkt tot {branch}'],
  'copy.typing': ['{name} is thinking', '{name} denkt na'],
  'copy.dmEmpty': ['This is the start of your chat with {agent}', 'Dit is het begin van je chat met {agent}'],
  'copy.composerBranch': ['Comment on PR #{number}', 'Reageer op PR #{number}'],
  'copy.composerDm': ['Message {agent}', 'Bericht aan {agent}'],
  'copy.commitsFooter': ['{diff} · signed by {signer}', '{diff} · ondertekend door {signer}'],
  'copy.answerReceipts': [
    { one: 'answered from {count} receipt', other: 'answered from {count} receipts' },
    { one: 'beantwoord uit {count} bewijs', other: 'beantwoord uit {count} bewijzen' },
  ],
  'copy.receiptMarker': ['receipt {n}', 'bewijs {n}'],
  'copy.auditSubtitle': [
    'Every action in {burrow}, signed by whoever took it. People and {agent} write to the same log, and entries can’t be edited afterwards.',
    'Elke actie in {burrow}, ondertekend door wie hem deed. Mensen en {agent} schrijven in hetzelfde logboek, en wat erin staat kan achteraf niet worden aangepast.',
  ],
  'copy.exportToast': [
    { one: 'Exported {count} signed event as CSV.', other: 'Exported {count} signed events as CSV.' },
    {
      one: '{count} ondertekende gebeurtenis als CSV geëxporteerd.',
      other: '{count} ondertekende gebeurtenissen als CSV geëxporteerd.',
    },
  ],
  'copy.welcomeToast': [
    'Welcome to {burrow}. {agent} is already here.',
    'Welkom bij {burrow}. {agent} is er al.',
  ],
  'copy.mergeToast': [
    'Merged PR #{number}. Nice digging, everyone.',
    'PR #{number} samengevoegd. Mooi gegraven, allemaal.',
  ],
  'copy.mergeNote': [
    'Merging is for people. {agent} doesn’t hold a merge key.',
    'Samenvoegen is voor mensen. {agent} heeft geen sleutel om samen te voegen.',
  ],
  'copy.filesNote': [
    'Every patch here is a signed event from {agent}’s key. Open any file to comment on a line.',
    'Elke patch hier is een ondertekende gebeurtenis van de sleutel van {agent}. Open een bestand om op een regel te reageren.',
  ],
  'copy.onboardingSkip': ['Skip for now', 'Nu overslaan'],
  'copy.onboardingBack': ['Back', 'Terug'],
  'copy.onboardingOpen': ['Open {burrow}', 'Open {burrow}'],
  'copy.onboardingTheBurrow': ['the burrow', 'de burcht'],
  'copy.onboardingContinue': ['Continue', 'Doorgaan'],
  'copy.onboardingStep': ['STEP {step} OF {count}', 'STAP {step} VAN {count}'],
  'copy.repoUpdated': ['updated {when}', 'bijgewerkt {when}'],
  'copy.repoNotUpdated': ['not updated yet', 'nog niet bijgewerkt'],
  'copy.presence': ['{n} here', '{n} hier'],
  'copy.draftedBy': ['Drafted by {name}', 'Opgesteld door {name}'],
  'copy.draftedByFrom': [
    'Drafted by {name} from {requester}’s request',
    'Opgesteld door {name} op verzoek van {requester}',
  ],
  'copy.editedBy': ['edited by {names}', 'bewerkt door {names}'],
  'copy.checksPassed': ['{of} passed', '{of} geslaagd'],
  'copy.checksFailing': ['{base} · {count} failing', '{base} · {count} mislukt'],
  'copy.checksFailingIn': ['{base} · {count} failing in {where}', '{base} · {count} mislukt in {where}'],
  'copy.githubConnectedToast': [
    'GitHub connected. Switch on the repos {agent} should see.',
    'GitHub gekoppeld. Zet de repo’s aan die {agent} mag zien.',
  ],
  'copy.githubConnectedAs': ['Connected as @{login}', 'Verbonden als @{login}'],
  'copy.provider.ready': ['Ready', 'Klaar'],
  'copy.provider.readyVersion': ['Ready · {version}', 'Klaar · {version}'],
  'copy.provider.notReady': ['Not ready', 'Niet klaar'],
  'copy.provider.loggedOut': ['Installed, not logged in', 'Geïnstalleerd, niet ingelogd'],
  'copy.provider.missing': ['Not installed', 'Niet geïnstalleerd'],
  'copy.provider.error': ['Can’t start', 'Kan niet starten'],
  'copy.provider.unknown': ['Not checked yet', 'Nog niet gecontroleerd'],
  'copy.provider.chatgptFix': [
    'ChatGPT needs nothing installed. It works once this Whombat is running; restarting this Whombat usually fixes it.',
    'ChatGPT hoeft niet geïnstalleerd te worden. Het werkt zodra deze Whombat draait; deze Whombat herstarten lost het meestal op.',
  ],
  'copy.provider.claudeInstall': [
    'Install it on the host with npm i -g @anthropic-ai/claude-code, then run claude there and sign in with /login.',
    'Installeer het op de host met npm i -g @anthropic-ai/claude-code, start daar claude en log in met /login.',
  ],
  'copy.provider.claudeLogin': [
    'On the host, run claude and sign in with /login.',
    'Start op de host claude en log in met /login.',
  ],
  'copy.provider.didntStart': ['It didn’t start.', 'Het startte niet.'],
  'copy.provider.doctor': [
    '{detail} Run whombat doctor on the host for details.',
    '{detail} Start whombat doctor op de host voor details.',
  ],
  'copy.providerSettings': ['Settings → AI sign-in', 'Instellingen → AI-aanmelding'],
  'copy.engine.missing': [
    'Part of this Whombat is missing. Updating this Whombat puts it back.',
    'Er ontbreekt een deel van deze Whombat. Deze Whombat bijwerken zet het terug.',
  ],
  'copy.engine.outdated': [
    'Part of this Whombat is out of date. Updating this Whombat fixes it.',
    'Een deel van deze Whombat is verouderd. Deze Whombat bijwerken lost het op.',
  ],
  'copy.engine.broken': [
    'Part of this Whombat didn’t start. Restarting this Whombat usually fixes it.',
    'Een deel van deze Whombat startte niet. Deze Whombat herstarten lost het meestal op.',
  ],
  'copy.engine.storage': [
    'This Whombat’s disk is full or can’t be written. Free some space, then restart it.',
    'De schijf van deze Whombat is vol of kan niet worden beschreven. Maak wat ruimte vrij en herstart hem.',
  ],
  'copy.engineReply.missing': [
    'I can’t reply yet: part of this Whombat is missing. Once it’s updated, ask me again.',
    'Ik kan nog niet antwoorden: er ontbreekt een deel van deze Whombat. Vraag het me opnieuw zodra hij is bijgewerkt.',
  ],
  'copy.engineReply.outdated': [
    'I can’t reply yet: part of this Whombat is out of date. Once it’s updated, ask me again.',
    'Ik kan nog niet antwoorden: een deel van deze Whombat is verouderd. Vraag het me opnieuw zodra hij is bijgewerkt.',
  ],
  'copy.engineReply.broken': [
    'I can’t reply yet: part of this Whombat didn’t start. Restarting it usually fixes that; then ask me again.',
    'Ik kan nog niet antwoorden: een deel van deze Whombat startte niet. Herstarten lost dat meestal op; vraag het me daarna opnieuw.',
  ],
  'copy.engineReply.storage': [
    'I can’t reply yet: this Whombat’s disk is full or can’t be written. Once there’s room again, ask me again.',
    'Ik kan nog niet antwoorden: de schijf van deze Whombat is vol of kan niet worden beschreven. Vraag het me opnieuw zodra er weer ruimte is.',
  ],
  'copy.unrunnable.noRunner': [
    'I can’t reply right now: part of Whombat is restarting. Ask me again in a minute.',
    'Ik kan nu niet antwoorden: een deel van Whombat herstart. Vraag het me over een minuutje opnieuw.',
  ],
  'copy.unrunnable.provider': [
    'I can’t reply yet: {provider} isn’t set up on this Whombat. Once it is ({settings}), ask me again.',
    'Ik kan nog niet antwoorden: {provider} is niet ingesteld op deze Whombat. Vraag het me opnieuw zodra dat zo is ({settings}).',
  ],
  'copy.unrunnable.local': [
    'I can’t reply yet: the custom AI model isn’t set up. Once it’s set up ({settings}), ask me again.',
    'Ik kan nog niet antwoorden: het eigen AI-model is niet ingesteld. Vraag het me opnieuw zodra het is ingesteld ({settings}).',
  ],
  'copy.unrunnable.noProvider': [
    'I can’t reply yet: I’m not connected to Claude Code or ChatGPT. Pick one in Settings → AI sign-in, then ask me again.',
    'Ik kan nog niet antwoorden: ik ben niet gekoppeld aan Claude Code of ChatGPT. Kies er een in Instellingen → AI-aanmelding en vraag het me dan opnieuw.',
  ],
  'copy.blocked.restarting': [
    '{agent} can’t reply right now: part of Whombat is restarting.',
    '{agent} kan nu niet antwoorden: een deel van Whombat herstart.',
  ],
  'copy.blocked.starting': [
    '{agent} can’t reply yet: this Whombat is still starting.',
    '{agent} kan nog niet antwoorden: deze Whombat is nog aan het opstarten.',
  ],
  'copy.blocked.engine': ['{agent} can’t reply yet: {reason}', '{agent} kan nog niet antwoorden: {reason}'],
  'copy.blocked.noProvider': [
    '{agent} can’t reply yet: neither Claude Code nor ChatGPT is ready on this Whombat.',
    '{agent} kan nog niet antwoorden: Claude Code en ChatGPT zijn allebei nog niet klaar op deze Whombat.',
  ],
  'copy.working': ['Working: {what}', 'Bezig: {what}'],
});
