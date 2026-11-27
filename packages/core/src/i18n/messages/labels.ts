import { splitPairs } from './pairs.js';

/** Small word tables and labels across domain/, backup/, text/ and commands/. */
export const LABELS_MESSAGES = splitPairs({
  // backup/restore.ts
  'restore.onDifferent.keep': ['Keep what’s here', 'Houd wat hier staat'],
  'restore.onDifferent.replace': ['Use the backup', 'Gebruik de back-up'],
  'restore.chip.new': ['{count} new', '{count} nieuw'],
  'restore.chip.here': ['{count} already here', '{count} al hier'],
  'restore.chip.different': ['{count} different', '{count} anders'],
  'restore.chip.nothing': ['Nothing to bring back', 'Niets om terug te zetten'],
  'restore.hint.automations': [
    'They start switched off, so they don’t run twice.',
    'Ze staan eerst uit, zodat ze niet twee keer lopen.',
  ],
  'restore.hint.connections': [
    'Checked after restoring. Any that need you show in Connections.',
    'Ze worden na het terugzetten gecontroleerd. Die jou nodig hebben, staan bij Koppelingen.',
  ],
  'restore.servers.state.new': ['New', 'Nieuw'],
  'restore.servers.state.here': ['Already here', 'Al hier'],
  'restore.servers.state.blocked': ['Can’t come back', 'Kan niet terug'],
  'restore.servers.state.unavailable': ['Can’t come back', 'Kan niet terug'],
  'restore.servers.stay': [
    {
      one: 'the server in the file stays with the Whombat it reports to',
      other: 'the {count} in the file stay with the Whombat they report to',
    },
    {
      one: 'blijft de server in het bestand bij de Whombat waaraan hij rapporteert',
      other: 'blijven de {count} in het bestand bij de Whombat waaraan ze rapporteren',
    },
  ],
  'restore.servers.here': [
    { one: 'It already reports to this Whombat.', other: 'They already report to this Whombat.' },
    { one: 'Hij rapporteert al aan deze Whombat.', other: 'Ze rapporteren al aan deze Whombat.' },
  ],
  'restore.servers.blocked': [
    {
      one: 'This Whombat already watches {count} server, so {stay}.',
      other: 'This Whombat already watches {count} servers, so {stay}.',
    },
    {
      one: 'Deze Whombat houdt al {count} server in de gaten, dus {stay}.',
      other: 'Deze Whombat houdt al {count} servers in de gaten, dus {stay}.',
    },
  ],
  'restore.servers.unavailable': [
    'This Whombat doesn’t watch servers, so {stay}.',
    'Deze Whombat houdt geen servers in de gaten, dus {stay}.',
  ],
  'restore.servers.address': [
    'Your servers look for your Whombat at {from}. This Whombat is at {to}.',
    'Je servers zoeken je Whombat op {from}. Deze Whombat staat op {to}.',
  ],
  'restore.servers.pointed': [
    { one: 'Pointed {count} server here.', other: 'Pointed {count} servers here.' },
    { one: '{count} server wijst nu hierheen.', other: '{count} servers wijzen nu hierheen.' },
  ],
  'restore.servers.leftOne': [
    '{name} still looks for your old Whombat. Point it here from the Inbox.',
    '{name} zoekt nog naar je oude Whombat. Wijs hem hierheen vanuit de Inbox.',
  ],
  'restore.servers.leftFew': [
    '{names} still look for your old Whombat. Point them here from the Inbox.',
    '{names} zoeken nog naar je oude Whombat. Wijs ze hierheen vanuit de Inbox.',
  ],
  'restore.servers.leftMany': [
    '{count} servers still look for your old Whombat. Point them here from the Inbox.',
    '{count} servers zoeken nog naar je oude Whombat. Wijs ze hierheen vanuit de Inbox.',
  ],
  'restore.count.agents': [
    { one: '{count} agent', other: '{count} agents' },
    { one: '{count} agent', other: '{count} agents' },
  ],
  'restore.count.memories': [
    { one: '{count} memory', other: '{count} memories' },
    { one: '{count} herinnering', other: '{count} herinneringen' },
  ],
  'restore.count.automations': [
    { one: '{count} automation', other: '{count} automations' },
    { one: '{count} automatisering', other: '{count} automatiseringen' },
  ],
  'restore.count.connections': [
    { one: '{count} connection', other: '{count} connections' },
    { one: '{count} koppeling', other: '{count} koppelingen' },
  ],
  'restore.count.skills': [
    { one: '{count} skill', other: '{count} skills' },
    { one: '{count} vaardigheid', other: '{count} vaardigheden' },
  ],
  'restore.count.settings': [
    { one: '{count} setting', other: '{count} settings' },
    { one: '{count} instelling', other: '{count} instellingen' },
  ],
  'restore.count.vault': [
    { one: '{count} Vault entry', other: '{count} Vault entries' },
    { one: '{count} item in de kluis', other: '{count} items in de kluis' },
  ],
  'restore.count.messages': [
    { one: '{count} message', other: '{count} messages' },
    { one: '{count} bericht', other: '{count} berichten' },
  ],
  'restore.count.servers': [
    { one: '{count} server', other: '{count} servers' },
    { one: '{count} server', other: '{count} servers' },
  ],
  'restore.count.files': [
    { one: '{count} file', other: '{count} files' },
    { one: '{count} bestand', other: '{count} bestanden' },
  ],
  'restore.count.repositories': [
    { one: '{count} repository', other: '{count} repositories' },
    { one: '{count} repository', other: '{count} repository’s' },
  ],
  'restore.summary.allHere': [
    'Everything in the file was already here.',
    'Alles uit het bestand was hier al.',
  ],
  'restore.summary.back': ['Brought back {items}.', 'Teruggezet: {items}.'],
  'restore.summary.signInOne': [
    '{name} needs you to sign in again. It’s in the Inbox.',
    '{name} vraagt je opnieuw in te loggen. Je vindt het in de Inbox.',
  ],
  'restore.summary.signInMany': [
    '{count} connections need you to sign in again. They’re in the Inbox.',
    '{count} koppelingen vragen je opnieuw in te loggen. Je vindt ze in de Inbox.',
  ],
  'restore.summary.automationsOff': [
    {
      one: '{count} automation is switched off. Switch it on when you’re ready.',
      other: '{count} automations are switched off. Switch them on when you’re ready.',
    },
    {
      one: '{count} automatisering staat uit. Zet hem aan als je zover bent.',
      other: '{count} automatiseringen staan uit. Zet ze aan als je zover bent.',
    },
  ],
  'restore.summary.schedulesPaused': [
    { one: '{count} schedule is paused.', other: '{count} schedules are paused.' },
    { one: '{count} schema is gepauzeerd.', other: '{count} schema’s zijn gepauzeerd.' },
  ],

  // domain/deployment.ts
  'deployment.status.succeeded': ['DEPLOYED', 'UITGEROLD'],
  'deployment.status.failed': ['FAILED', 'MISLUKT'],
  'deployment.how.github_actions': ['GitHub Actions', 'GitHub Actions'],
  'deployment.how.ssh': ['SSH', 'SSH'],
  'deployment.how.cli': ['Command line', 'Opdrachtregel'],
  'deployment.how.other': ['Other', 'Anders'],
  'deployment.line.succeeded': [
    'Deployed {service} to {environment}',
    '{service} uitgerold naar {environment}',
  ],
  'deployment.line.failed': [
    'Deploy of {service} to {environment} failed',
    'Uitrollen van {service} naar {environment} mislukt',
  ],

  // domain/notify.ts
  'dnd.preset.30m': ['30 minutes', '30 minuten'],
  'dnd.preset.1h': ['1 hour', '1 uur'],
  'dnd.preset.tomorrow': ['Until tomorrow', 'Tot morgen'],

  // text/emoji.ts
  'emoji.group.smileys': ['Smileys', 'Smileys'],
  'emoji.group.people': ['People', 'Mensen'],
  'emoji.group.nature': ['Nature', 'Natuur'],
  'emoji.group.food': ['Food & drink', 'Eten en drinken'],
  'emoji.group.activities': ['Activities', 'Activiteiten'],
  'emoji.group.travel': ['Travel & places', 'Reizen en plaatsen'],
  'emoji.group.objects': ['Objects', 'Voorwerpen'],
  'emoji.group.symbols': ['Symbols', 'Symbolen'],

  // domain/feedback-card.ts
  'feedbackType.bug': ['Bug report', 'Bugmelding'],
  'feedbackType.feature': ['Feature request', 'Functieverzoek'],
  'feedbackOutcome.confirmed_bug': ['Confirmed bug', 'Bevestigde bug'],
  'feedbackOutcome.likely_bug': ['Likely bug', 'Waarschijnlijk een bug'],
  'feedbackOutcome.needs_information': ['Needs information', 'Meer informatie nodig'],
  'feedbackOutcome.duplicate': ['Duplicate', 'Duplicaat'],
  'feedbackOutcome.configuration_or_support': ['Configuration or support', 'Instelling of ondersteuning'],
  'feedbackOutcome.feature_request': ['Feature request', 'Functieverzoek'],
  'feedbackOutcome.insufficient_evidence': ['Insufficient evidence', 'Onvoldoende bewijs'],
  'feedbackState.not_configured': ['Not assessed', 'Niet beoordeeld'],
  'feedbackState.queued': ['Assessment queued', 'Beoordeling in de wachtrij'],
  'feedbackState.running': ['Assessing', 'Wordt beoordeeld'],
  'feedbackState.done': ['Assessed', 'Beoordeeld'],
  'feedbackState.failed': ['Assessment failed', 'Beoordeling mislukt'],
  'feedbackState.blocked': ['Assessment blocked', 'Beoordeling geblokkeerd'],
  'feedbackState.paused': ['Assessment paused', 'Beoordeling gepauzeerd'],
  'feedbackStatus.new': ['New', 'Nieuw'],
  'feedbackStatus.triaged': ['Triaged', 'Bekeken'],
  'feedbackStatus.in_progress': ['In progress', 'Bezig'],
  'feedbackStatus.resolved': ['Resolved', 'Opgelost'],
  'feedbackStatus.closed': ['Closed', 'Gesloten'],

  // domain/feedback-assessment.ts
  'assessment.verdict.bug': ['Bug', 'Bug'],
  'assessment.verdict.not_a_bug': ['Not a bug', 'Geen bug'],
  'assessment.verdict.unsure': ['Unsure', 'Niet zeker'],
  'assessment.decision.hand_off': ['Build the fix', 'Bouw de oplossing'],
  'assessment.decision.resolve': ['Mark resolved', 'Markeer als opgelost'],
  'assessment.decision.close': ['Close', 'Sluiten'],
  'assessment.decision.keep_open': ['Keep open', 'Open laten'],
  'assessment.reproduction.not_attempted': ['Not attempted', 'Niet geprobeerd'],
  'assessment.reproduction.attempted_not_reproduced': [
    'Tried, not reproduced',
    'Geprobeerd, niet gereproduceerd',
  ],
  'assessment.reproduction.reproduced': ['Reproduced', 'Gereproduceerd'],
  'assessment.reproduction.unknown': ['Unknown', 'Onbekend'],
  'assessment.cardLabel': ['ASSESSMENT · {reference}', 'BEOORDELING · {reference}'],
  'assessment.duplicateOf': ['{outcome} of {reference}', '{outcome} van {reference}'],
  'assessment.confidence.low': ['low confidence', 'lage zekerheid'],
  'assessment.confidence.medium': ['medium confidence', 'gemiddelde zekerheid'],
  'assessment.confidence.high': ['high confidence', 'hoge zekerheid'],
  'assessment.severityLine': ['severity {level}', 'ernst {level}'],
  'assessment.severity.critical': ['critical', 'kritiek'],
  'assessment.severity.high': ['high', 'hoog'],
  'assessment.severity.medium': ['medium', 'gemiddeld'],
  'assessment.severity.low': ['low', 'laag'],
  'assessment.severity.none': ['none', 'geen'],
  'assessment.severity.unknown': ['unknown', 'onbekend'],
  'assessment.row.summary': ['Summary', 'Samenvatting'],
  'assessment.row.goal': ['Goal', 'Doel'],
  'assessment.row.today': ['Today', 'Nu'],
  'assessment.row.workarounds': ['Workarounds', 'Omwegen'],
  'assessment.row.scope': ['Scope', 'Omvang'],
  'assessment.row.tradeoffs': ['Trade-offs', 'Afwegingen'],
  'assessment.row.next': ['Next', 'Volgende stap'],
  'assessment.row.reproduction': ['Reproduction', 'Reproductie'],
  'assessment.row.severity': ['Severity', 'Ernst'],
  'assessment.row.uncertain': ['Uncertain', 'Onzeker'],
  'assessment.row.missing': ['Missing', 'Ontbreekt'],
  'assessment.row.code': ['Code', 'Code'],
  'assessment.code.read': ['read {revision}', 'gelezen: {revision}'],
  'assessment.code.notRead': ['not read', 'niet gelezen'],
  'assessment.code.reported': ['reported version {version}', 'gemelde versie {version}'],
  'assessment.evidence.observed': ['Observed', 'Waargenomen'],
  'assessment.evidence.hypothesis': ['Hypothesis', 'Hypothese'],

  // domain/message.ts
  'message.deleted': ['This message was deleted.', 'Dit bericht is verwijderd.'],
  'message.edited': ['(edited)', '(bewerkt)'],
  'message.tooLong': ['That message is too long.', 'Dat bericht is te lang.'],

  // domain/file-view.ts
  'prFile.binary': [
    'This is a binary file, so there are no lines to show.',
    'Dit is een binair bestand, dus er zijn geen regels om te tonen.',
  ],
  'prFile.too_large': ['This file is too large to show here.', 'Dit bestand is te groot om hier te tonen.'],

  // domain/repo.ts
  'pr.status.merged': ['Merged', 'Samengevoegd'],
  'pr.status.closed': ['Closed', 'Gesloten'],
  'pr.status.changes_requested': ['Open · changes requested', 'Open · wijzigingen gevraagd'],
  'pr.status.checks_failing': ['Open · checks failing', 'Open · checks mislukken'],
  'pr.status.ready': ['Open · ready', 'Open · klaar'],
  'pr.status.in_review': ['Open · in review', 'Open · in review'],
  'review.state.pending': ['Pending', 'In afwachting'],
  'review.state.approved': ['Approved', 'Goedgekeurd'],
  'review.state.changes_requested': ['Changes requested', 'Wijzigingen gevraagd'],
  'review.state.commented': ['Commented', 'Gereageerd'],

  // domain/prompts.ts: a starter's words, with `{council}` where the council lines go
  'starter.council': [
    'Don’t hand what you aren’t sure about back to me. Put those points together to a council first: three independent reviewers on different AI models (use your council skill if you have one), each given the points, the code they concern and your own view. Do what the council agrees on, with the tests still passing. Leave for me only what the council can’t settle or says is mine to choose, such as a product decision or something that can’t be undone, each with the council’s advice. Finish with what you changed, what the council decided and what is left for me.',
    'Leg wat je niet zeker weet niet bij mij terug. Leg die punten eerst samen voor aan een raad: drie onafhankelijke reviewers op verschillende AI-modellen (gebruik je council-skill als je die hebt), die elk de punten, de code waar ze over gaan en jouw eigen kijk krijgen. Doe waar de raad het over eens is, terwijl de tests blijven slagen. Laat voor mij alleen over wat de raad niet kan beslissen of wat volgens de raad aan mij is, zoals een productbeslissing of iets wat niet terug te draaien is, elk met het advies van de raad. Sluit af met wat je hebt veranderd, wat de raad besloot en wat er voor mij overblijft.',
  ],
  'starter.audit.title': ['Find what’s broken', 'Zoek wat stuk is'],
  'starter.audit.text': [
    'Read this entire project and find everything that’s broken, inconsistent, inefficient, or no longer needed. Fix what you’re sure about.\n\n{council}',
    'Lees dit hele project en zoek alles wat stuk, inconsistent of inefficiënt is, of niet meer nodig is. Repareer wat je zeker weet.\n\n{council}',
  ],
  'starter.prune-tests.title': ['Prune the tests', 'Snoei de tests'],
  'starter.prune-tests.text': [
    'Remove 20% of the least useful tests while maintaining code coverage within 2%.\n\nMeasure coverage before you start and again at the end, with the same command. Coverage shows that a line ran, not that anything checked it, so keep every test that guards security, permissions, a contract between parts, a migration, stored data or a named regression, however slow it is. Delete tests; don’t skip or weaken them, and don’t change production code.\n\nFinish with the number of tests and the coverage before and after, and the list of what you removed.',
    'Verwijder 20% van de minst nuttige tests en houd de codedekking binnen 2%.\n\nMeet de dekking voordat je begint en aan het eind opnieuw, met hetzelfde commando. Dekking laat zien dat een regel is uitgevoerd, niet dat iets hem heeft gecontroleerd, dus houd elke test die beveiliging, rechten, een contract tussen onderdelen, een migratie, opgeslagen gegevens of een benoemde regressie bewaakt, hoe traag hij ook is. Verwijder tests; sla ze niet over en maak ze niet zwakker, en verander geen productiecode.\n\nSluit af met het aantal tests en de dekking ervoor en erna, en de lijst van wat je hebt verwijderd.',
  ],
  'starter.simplify.title': ['Remove needless complexity', 'Haal onnodige complexiteit weg'],
  'starter.simplify.text': [
    'Find and remove unnecessary complexity in this repository: wrappers that do nothing, the same logic written twice, abstractions with a single use, dead code and unused dependencies. Behaviour stays the same and the tests still pass. Leave alone what is fine as it is: fewer lines is not the goal.\n\n{council}',
    'Zoek en verwijder onnodige complexiteit in deze repository: wrappers die niets doen, dezelfde logica twee keer geschreven, abstracties die maar één keer gebruikt worden, dode code en ongebruikte dependencies. Het gedrag blijft hetzelfde en de tests blijven slagen. Laat met rust wat goed is zoals het is: minder regels is niet het doel.\n\n{council}',
  ],
  'starter.refactor.title': ['Refactor until you’re happy', 'Refactor tot je tevreden bent'],
  'starter.refactor.text': [
    'Refactor until you are happy with the architecture. Test live after each significant step, review your own change and commit it. Track progress in /tmp/refactor-<project name>.md.\n\nWhat the software does for the people who use it stays the same. Finish with what you changed and why, and what you would still change.',
    'Refactor tot je tevreden bent met de architectuur. Test live na elke belangrijke stap, review je eigen wijziging en commit hem. Houd de voortgang bij in /tmp/refactor-<projectnaam>.md.\n\nWat de software doet voor de mensen die hem gebruiken, blijft hetzelfde. Sluit af met wat je hebt veranderd en waarom, en wat je nog zou veranderen.',
  ],
  'starter.bugs.title': ['Hunt for bugs', 'Jaag op bugs'],
  'starter.bugs.text': [
    'Find and fix correctness bugs in this repository, starting with what people use most. Fix the cause, not the symptom, and add a test that fails without the fix.\n\nWhat you suspect but couldn’t confirm counts as something you aren’t sure about. {council}',
    'Zoek en repareer bugs in de werking van deze repository, te beginnen met wat mensen het meest gebruiken. Pak de oorzaak aan, niet het symptoom, en voeg een test toe die zonder de oplossing faalt.\n\nWat je vermoedt maar niet kon bevestigen, telt als iets wat je niet zeker weet. {council}',
  ],
  'starter.security.title': ['Review the security', 'Controleer de beveiliging'],
  'starter.security.text': [
    'Review the security of this repository: keys and passwords in the code or its history, missing sign-in and permission checks, input that is trusted without checking, data of one person that another can reach, and packages with known vulnerabilities. Confirm each finding in the code before you report it.\n\nRank what you find by how bad it is, explain each in plain English, and fix the top three, each with a test that fails without the fix. Work only in this repository and a local environment: don’t rotate keys, don’t touch production and don’t write exploit code. List the rest for me to review.',
    'Controleer de beveiliging van deze repository: sleutels en wachtwoorden in de code of de geschiedenis, ontbrekende controles op inloggen en rechten, invoer die zonder controle wordt vertrouwd, gegevens van de ene persoon die een ander kan bereiken, en pakketten met bekende kwetsbaarheden. Bevestig elke bevinding in de code voordat je hem meldt.\n\nZet wat je vindt op volgorde van hoe erg het is, leg elk punt in gewone taal uit en repareer de bovenste drie, elk met een test die zonder de oplossing faalt. Werk alleen in deze repository en een lokale omgeving: vervang geen sleutels, kom niet aan productie en schrijf geen exploitcode. Zet de rest in een lijst, zodat ik die kan bekijken.',
  ],
  'starter.dependencies.title': ['Check the dependencies', 'Controleer de dependencies'],
  'starter.dependencies.text': [
    'Check this repository’s dependencies against known vulnerabilities. For each advisory, check whether the installed version is affected and whether the code can reach the vulnerable part, and quote the line that decides it. Rank by the real risk here, not by the advisory’s score.\n\nUpgrade what matters on a branch, one dependency per commit, with the tests passing. Leave an upgrade that needs code changes as an entry in a list, with what it would take. Don’t write exploit code.',
    'Controleer de dependencies van deze repository op bekende kwetsbaarheden. Kijk bij elke advisory of de geïnstalleerde versie getroffen is en of de code het kwetsbare deel kan bereiken, en citeer de regel die dat bepaalt. Zet ze op volgorde van het echte risico hier, niet van de score van de advisory.\n\nUpgrade wat ertoe doet op een branch, één dependency per commit, terwijl de tests blijven slagen. Zet een upgrade die codewijzigingen nodig heeft in een lijst, met wat ervoor nodig is. Schrijf geen exploitcode.',
  ],
  'starter.faster.title': ['Make it faster', 'Maak het sneller'],
  'starter.faster.text': [
    'Find and implement performance improvements in this repository. Measure first: find the slow parts with a profile, a trace, a query plan or a benchmark instead of guessing, and write down the baseline.\n\nKeep a change only when the same measurement shows it is faster and the tests still pass; behaviour stays the same. Finish with the numbers before and after each change, and what you tried that didn’t help.',
    'Zoek en bouw prestatieverbeteringen in deze repository. Meet eerst: zoek de trage delen met een profiel, een trace, een queryplan of een benchmark in plaats van te gokken, en schrijf het beginpunt op.\n\nHoud een wijziging alleen als dezelfde meting laat zien dat het sneller is en de tests blijven slagen; het gedrag blijft hetzelfde. Sluit af met de cijfers voor en na elke wijziging, en wat je hebt geprobeerd dat niet hielp.',
  ],
  'starter.faster-build.title': ['Speed up the build and tests', 'Versnel de build en de tests'],
  'starter.faster-build.text': [
    'Reduce the time this repository’s build and tests take by 30%.\n\nTime them three times before you start and take the average. You are done when three runs in the same environment average 30% less, with every test still passing. Don’t remove, skip or weaken tests, and don’t drop a step that checks something. If 30% is out of reach, stop and say what is in the way.\n\nFinish with the times before and after, and what you changed.',
    'Maak de build en de tests van deze repository 30% sneller.\n\nMeet ze drie keer voordat je begint en neem het gemiddelde. Je bent klaar als drie runs in dezelfde omgeving gemiddeld 30% minder tijd kosten en elke test nog slaagt. Verwijder geen tests, sla ze niet over, maak ze niet zwakker en laat geen stap weg die iets controleert. Is 30% niet haalbaar, stop dan en zeg wat in de weg zit.\n\nSluit af met de tijden ervoor en erna, en wat je hebt veranderd.',
  ],
  'starter.docs.title': ['Make the docs match the code', 'Laat de docs kloppen met de code'],
  'starter.docs.text': [
    'Read the documentation in this repository (the README, the docs folder, comments that explain how something works) and compare it with what the code does today. Fix what is out of date and remove what describes things that are gone.\n\nWhat you couldn’t settle from the code counts as something you aren’t sure about. {council}',
    'Lees de documentatie in deze repository (de README, de docs-map, commentaar dat uitlegt hoe iets werkt) en vergelijk die met wat de code vandaag doet. Werk bij wat verouderd is en haal weg wat dingen beschrijft die er niet meer zijn.\n\nWat je niet uit de code kon opmaken, telt als iets wat je niet zeker weet. {council}',
  ],
  'starter.agent-instructions.title': [
    'Check the agent instructions',
    'Controleer de instructies voor agents',
  ],
  'starter.agent-instructions.text': [
    'Read the instructions this repository gives coding agents (AGENTS.md, CLAUDE.md, skills and rules files). Find the ones that contradict each other, name files or commands that no longer exist, repeat what the code makes obvious, or work around problems older models had. Give me the changes as a list and change nothing until I say so.',
    'Lees de instructies die deze repository aan coding agents geeft (AGENTS.md, CLAUDE.md, skills en rules-bestanden). Zoek de instructies die elkaar tegenspreken, bestanden of commando’s noemen die niet meer bestaan, herhalen wat de code al duidelijk maakt, of problemen omzeilen die oudere modellen hadden. Geef me de wijzigingen als lijst en verander niets tot ik het zeg.',
  ],

  // domain/providers.ts: brand names stay as they are
  'provider.label.claude': ['Claude Code', 'Claude Code'],
  'provider.label.codex': ['ChatGPT', 'ChatGPT'],
  'provider.label.local': ['Custom AI model', 'Eigen AI-model'],

  // domain/agent.ts
  'agentName.form': [
    'Use one word with a capital first letter, like Dusty.',
    'Gebruik één woord met een hoofdletter vooraan, zoals Dusty.',
  ],
  'agentName.reserved': [
    'Whombat is the name of this box, so pick another one.',
    'Whombat is de naam van deze box, dus kies een andere.',
  ],

  // commands/copy.ts
  'commandCategory.deploy': ['Deploy', 'Uitrollen'],
  'commandCategory.deploy_production': ['Deploy to production', 'Naar productie uitrollen'],
  'commandCategory.merge': ['Merge into main', 'Samenvoegen in main'],
  'commandCategory.push_main': ['Push to main', 'Naar main pushen'],
  'commandCategory.destructive': [
    'Destructive command on another machine',
    'Ingrijpende opdracht op een andere machine',
  ],
  'commandCategory.message_external': ['Message outside your Whombat', 'Bericht buiten je Whombat'],
  'commandCategory.web': ['Look something up on the web', 'Iets opzoeken op internet'],
  'commandCategory.browser': ['Use the browser', 'De browser gebruiken'],
  'commandAllowances.title': ['ALWAYS ALLOWED COMMANDS', 'OPDRACHTEN DIE ALTIJD MOGEN'],
  'commandAllowances.empty': [
    'No commands are always allowed. “Always allow” on a command card adds one here.',
    'Er zijn geen opdrachten die altijd mogen. “Altijd toestaan” op een opdrachtkaart zet er hier een bij.',
  ],
  'commandAllowances.remove': ['Remove', 'Verwijderen'],
  'commandAllowances.removed': [
    'Removed. The command asks again next time.',
    'Verwijderd. De opdracht vraagt het de volgende keer opnieuw.',
  ],

  // domain/feature-request.ts
  'featureRequest.score.none': ['Not scored', 'Geen score'],
  'featureRequest.score.value': ['{value} of 10', '{value} van 10'],
  'featureRequest.from': ['From {organization} · {where}', 'Van {organization} · {where}'],
  'featureRequest.outcome.you': ['you', 'jou'],
  'featureRequest.outcome.replaced': [
    'Replaced by a newer assessment',
    'Vervangen door een nieuwere beoordeling',
  ],
  'featureRequest.outcome.stopped': ['No longer waiting', 'Wacht niet meer'],
  'featureRequest.outcome.approved': ['Approved by {who}', 'Goedgekeurd door {who}'],
  'featureRequest.outcome.planned': ['Planned', 'Gepland'],
  'featureRequest.outcome.building': ['Being built', 'Wordt gebouwd'],
  'featureRequest.outcome.declined': ['Declined by {who}', 'Afgewezen door {who}'],
  'featureRequest.outcome.asked': ['{who} asked the customer', '{who} heeft het de klant gevraagd'],
  'featureRequest.outcome.youAsked': ['You asked the customer', 'Je hebt het de klant gevraagd'],
  'featureRequest.outcome.decided': ['Decided', 'Besloten'],
});
