import { splitPairs } from './pairs.js';

/** Permission keys, their groups, tiers and notes (`keys/`). */
export const KEYS = splitPairs({
  'key.label.repos.read_all': ['Read all connected repos', 'Alle gekoppelde repo’s lezen'],
  'key.description.repos.read_all': [
    'Read every repository that is switched on for this Whombat.',
    'Elke repository lezen die voor deze Whombat aan staat.',
  ],
  'key.label.canvas.write': ['Write canvases', 'Canvassen schrijven'],
  'key.description.canvas.write': [
    'Create canvases and edit them like a person would.',
    'Canvassen maken en bewerken zoals een mens dat zou doen.',
  ],
  'key.label.branch.feature.readwrite': [
    'Read and write feat/* branches',
    'feat/*-branches lezen en schrijven',
  ],
  'key.description.branch.feature.readwrite': [
    'Create, commit to and push feature branches that match feat/*.',
    'Featurebranches die passen bij feat/* maken, erop committen en ze pushen.',
  ],
  'key.label.branch.feature.write': ['Write to feat/* branches', 'Naar feat/*-branches schrijven'],
  'key.description.branch.feature.write': [
    'Create, commit to and push feature branches that match feat/*.',
    'Featurebranches die passen bij feat/* maken, erop committen en ze pushen.',
  ],
  'key.label.tests.run': ['Run tests', 'Tests uitvoeren'],
  'key.description.tests.run': [
    'Run test suites in the agent’s workspace and report the results.',
    'Testsuites uitvoeren in de werkruimte van de assistent en de resultaten melden.',
  ],
  'key.label.tests_ci.run': ['Run tests and CI', 'Tests en CI uitvoeren'],
  'key.description.tests_ci.run': [
    'Run test suites and trigger CI pipelines.',
    'Testsuites uitvoeren en CI-pipelines starten.',
  ],
  'key.label.pr.open': ['Open pull requests', 'Pull requests openen'],
  'key.description.pr.open': [
    'Open pull requests from branches the agent can write to.',
    'Pull requests openen vanuit branches waar de assistent naar kan schrijven.',
  ],
  'key.label.branch.shared.push': ['Push to shared branches', 'Naar gedeelde branches pushen'],
  'key.description.branch.shared.push': [
    'Push to branches other people work on (anything outside feat/* and main).',
    'Pushen naar branches waar andere mensen aan werken (alles buiten feat/* en main).',
  ],
  'key.label.workspace.scratch': [
    'Run tools in a scratch workspace',
    'Tools gebruiken in een kladwerkruimte',
  ],
  'key.description.workspace.scratch': [
    'Run scripts and make files in a private, throwaway folder without a repository.',
    'Scripts uitvoeren en bestanden maken in een eigen wegwerpmap zonder repository.',
  ],
  'key.label.messages.search': [
    'Search messages, canvases and runs',
    'Berichten, canvassen en runs doorzoeken',
  ],
  'key.description.messages.search': [
    'Search everything on this Whombat it may read: branch rooms, canvases and runs.',
    'Alles op deze Whombat doorzoeken wat hij mag lezen: branchruimtes, canvassen en runs.',
  ],
  'key.label.repos.read': ['Read connected repos', 'Gekoppelde repo’s lezen'],
  'key.description.repos.read': [
    'Read every repository that is switched on for this Whombat.',
    'Elke repository lezen die voor deze Whombat aan staat.',
  ],
  'key.label.web.browse': ['Browse the web', 'Op internet surfen'],
  'key.description.web.browse': [
    'Fetch and read public web pages.',
    'Openbare webpagina’s ophalen en lezen.',
  ],
  'key.label.browser.use': ['Use a web browser', 'Een webbrowser gebruiken'],
  'key.description.browser.use': [
    'Open pages, click, type and take screenshots in its browser.',
    'Pagina’s openen, klikken, typen en schermafbeeldingen maken in zijn browser.',
  ],
  'key.label.messages.external': [
    'Message people outside your Whombat',
    'Mensen buiten je Whombat berichten sturen',
  ],
  'key.description.messages.external': [
    'Send email or messages to anyone outside this Whombat.',
    'E-mail of berichten sturen naar iedereen buiten deze Whombat.',
  ],
  'key.label.pr.comment': ['Comment on pull requests', 'Reageren op pull requests'],
  'key.description.pr.comment': [
    'Leave comments on pull requests and issues, and open, edit and close issues.',
    'Reacties plaatsen op pull requests en issues, en issues openen, bewerken en sluiten.',
  ],
  'key.label.pr.request_changes': ['Request changes', 'Wijzigingen vragen'],
  'key.description.pr.request_changes': [
    'Submit a review that requests changes on a pull request.',
    'Een review indienen die om wijzigingen in een pull request vraagt.',
  ],
  'key.label.pr.approve': ['Approve pull requests', 'Pull requests goedkeuren'],
  'key.description.pr.approve': [
    'Submit an approving review on a pull request.',
    'Een goedkeurende review indienen op een pull request.',
  ],
  'key.label.ci.run': ['Run CI', 'CI uitvoeren'],
  'key.description.ci.run': ['Trigger CI pipelines on branches.', 'CI-pipelines starten op branches.'],
  'key.label.jobs.scheduled.run': ['Run scheduled jobs', 'Geplande taken uitvoeren'],
  'key.description.jobs.scheduled.run': [
    'Run this Whombat’s scheduled jobs, such as the nightly sync.',
    'De geplande taken van deze Whombat uitvoeren, zoals de nachtelijke synchronisatie.',
  ],
  'key.label.pipelines.retry': ['Retry failed pipelines', 'Mislukte pipelines opnieuw proberen'],
  'key.description.pipelines.retry': [
    'Re-run pipelines that failed.',
    'Pipelines die mislukten opnieuw uitvoeren.',
  ],
  'key.label.deploy.staging': ['Deploy to staging', 'Naar staging uitrollen'],
  'key.description.deploy.staging': [
    'Deploy a commit to the staging environment.',
    'Een commit uitrollen naar de stagingomgeving.',
  ],
  'key.label.deploy.production': ['Deploy to production', 'Naar productie uitrollen'],
  'key.description.deploy.production': [
    'Deploy a commit to production.',
    'Een commit uitrollen naar productie.',
  ],
  'key.label.customers.read': ['Read customer accounts', 'Klantaccounts lezen'],
  'key.description.customers.read': [
    'Look up customer accounts and their history.',
    'Klantaccounts en hun geschiedenis opzoeken.',
  ],
  'key.label.helpwidget.reply': ['Reply in the help widget', 'Antwoorden in de helpwidget'],
  'key.description.helpwidget.reply': [
    'Answer customers in the help widget.',
    'Klanten beantwoorden in de helpwidget.',
  ],
  'key.label.tickets.tag': ['Tag tickets', 'Tickets labelen'],
  'key.description.tickets.tag': [
    'Add and remove tags on support tickets.',
    'Labels toevoegen aan en verwijderen van supporttickets.',
  ],
  'key.label.refunds.issue': ['Issue refunds', 'Terugbetalingen doen'],
  'key.description.refunds.issue': ['Refund a customer payment.', 'Een betaling van een klant terugbetalen.'],
  'key.label.report.update': ['Update reports', 'Meldingen bijwerken'],
  'key.description.report.update': [
    'Write an assessment and a priority on a customer’s report in its tracker. The reporter doesn’t see them.',
    'Een beoordeling en een prioriteit schrijven bij een melding van een klant in de tracker. De melder ziet die niet.',
  ],
  'key.label.report.reply': ['Reply to customers', 'Klanten antwoorden'],
  'key.description.report.reply': [
    'Answer the customer of a report and set its status in its tracker, signed with the agent’s name. The tracker emails it to them.',
    'De klant van een melding antwoorden en de status ervan zetten in de tracker, ondertekend met de naam van de assistent. De tracker mailt het naar ze.',
  ],
  'key.label.packs.tool.read': ['Retired key (reading tools)', 'Vervallen sleutel (tools lezen)'],
  'key.description.packs.tool.read': ['Nothing uses this key any more.', 'Niets gebruikt deze sleutel nog.'],
  'key.label.packs.tool.write': ['Retired key (changing tools)', 'Vervallen sleutel (tools wijzigen)'],
  'key.description.packs.tool.write': ['Nothing uses this key any more.', 'Niets gebruikt deze sleutel nog.'],
  'key.label.merge': ['Merge', 'Samenvoegen'],
  'key.description.merge': ['Merge pull requests.', 'Pull requests samenvoegen.'],
  'key.label.merge.main': ['Merge into main', 'Samenvoegen in main'],
  'key.description.merge.main': [
    'Merge pull requests into the default branch.',
    'Pull requests samenvoegen in de standaardbranch.',
  ],
  'key.label.branch.main.push': ['Push to main', 'Naar main pushen'],
  'key.description.branch.main.push': [
    'Push commits straight to the default branch, without a pull request.',
    'Commits direct naar de standaardbranch pushen, zonder pull request.',
  ],
  'key.label.code.write': ['Write code', 'Code schrijven'],
  'key.description.code.write': [
    'Change code in connected repositories.',
    'Code wijzigen in gekoppelde repository’s.',
  ],
  'key.label.code.change': ['Change code', 'Code wijzigen'],
  'key.description.code.change': [
    'Change code in connected repositories.',
    'Code wijzigen in gekoppelde repository’s.',
  ],
  'key.label.deploy': ['Deploy', 'Uitrollen'],
  'key.description.deploy': ['Deploy to any environment.', 'Uitrollen naar elke omgeving.'],
  'key.label.commands.destructive': [
    'Destructive commands on other machines',
    'Ingrijpende opdrachten op andere machines',
  ],
  'key.description.commands.destructive': [
    'Delete files, drop databases or stop services on other machines, over SSH or Docker. Commands on your Whombat never need this key.',
    'Bestanden verwijderen, databases weggooien of diensten stoppen op andere machines, via SSH of Docker. Opdrachten op je Whombat hebben deze sleutel nooit nodig.',
  ],
  'key.label.billing.write': ['Change billing data', 'Factuurgegevens wijzigen'],
  'key.description.billing.write': [
    'Edit invoices, prices and customer billing records.',
    'Facturen, prijzen en factuurgegevens van klanten bewerken.',
  ],
  'key.label.agents.manage': ['Change the agent and its keys', 'De assistent en zijn sleutels wijzigen'],
  'key.description.agents.manage': [
    'Change the agent’s name, face, model and keys. People only.',
    'De naam, het gezicht, het model en de sleutels van de assistent wijzigen. Alleen voor mensen.',
  ],
  'key.label.approvals.decide': ['Approve requests', 'Verzoeken goedkeuren'],
  'key.description.approvals.decide': [
    'Be the person who says yes or no to the agent’s requests. People only.',
    'De persoon zijn die ja of nee zegt tegen de verzoeken van de assistent. Alleen voor mensen.',
  ],
  'key.label.burrow.manage': ['Change this Whombat’s settings', 'Instellingen van deze Whombat wijzigen'],
  'key.description.burrow.manage': [
    'Rename this Whombat and connect repos. People only.',
    'Deze Whombat een andere naam geven en repo’s koppelen. Alleen voor mensen.',
  ],
  'key.label.settings.change': ['Change settings for you', 'Instellingen voor je wijzigen'],
  'key.description.settings.change': [
    'Change Whombat’s settings when you ask, like Wi-Fi, backups and the screen. Removing something always asks first.',
    'De instellingen van Whombat wijzigen als je erom vraagt, zoals wifi, back-ups en het scherm. Iets verwijderen vraagt altijd eerst.',
  ],
  'key.label.share.link': ['Share a conversation by link', 'Een gesprek delen via een link'],
  'key.description.share.link': [
    'Make a link anyone can open to read a copy of a thread. Always asks you first.',
    'Een link maken die iedereen kan openen om een kopie van een thread te lezen. Vraagt het je altijd eerst.',
  ],
  'key.label.mail.read': ['Read mail', 'Mail lezen'],
  'key.description.mail.read': [
    'Search and read the email of the person the agent works for.',
    'De e-mail doorzoeken en lezen van de persoon voor wie de assistent werkt.',
  ],
  'key.label.mail.organize': ['Label, archive and mark mail', 'Mail labelen, archiveren en markeren'],
  'key.description.mail.organize': [
    'Add and remove labels, archive and mark the person’s email read or unread.',
    'Labels toevoegen en verwijderen, archiveren en de e-mail van de persoon als gelezen of ongelezen markeren.',
  ],
  'key.label.mail.draft': ['Draft emails', 'E-mails opstellen'],
  'key.description.mail.draft': [
    'Write drafts in the person’s mailbox. Drafts are not sent.',
    'Concepten schrijven in de mailbox van de persoon. Concepten worden niet verstuurd.',
  ],
  'key.label.mail.send': ['Send emails', 'E-mails versturen'],
  'key.description.mail.send': [
    'Send email as the person. Always asks the person first.',
    'E-mail versturen als de persoon. Vraagt het de persoon altijd eerst.',
  ],
  'key.label.mail.delete': ['Move mail to the trash', 'Mail naar de prullenbak verplaatsen'],
  'key.description.mail.delete': [
    'Move the person’s email to the trash.',
    'De e-mail van de persoon naar de prullenbak verplaatsen.',
  ],
  'key.label.calendar.read': ['Read the calendar', 'De agenda lezen'],
  'key.description.calendar.read': [
    'Read the person’s calendar events.',
    'De agenda-afspraken van de persoon lezen.',
  ],
  'key.label.calendar.write': [
    'Add and change events without guests',
    'Afspraken zonder gasten toevoegen en wijzigen',
  ],
  'key.description.calendar.write': [
    'Create, move and delete events on the person’s calendar that have no guests.',
    'Afspraken zonder gasten in de agenda van de persoon maken, verplaatsen en verwijderen.',
  ],
  'key.label.calendar.invite': ['Send calendar invites', 'Agenda-uitnodigingen versturen'],
  'key.description.calendar.invite': [
    'Create, change or cancel events with guests, which emails them. Always asks the person first.',
    'Afspraken met gasten maken, wijzigen of afzeggen, wat ze een e-mail stuurt. Vraagt het de persoon altijd eerst.',
  ],
  'key.label.files.read': ['Read files', 'Bestanden lezen'],
  'key.description.files.read': [
    'Search and read the person’s files, documents and spreadsheets.',
    'De bestanden, documenten en spreadsheets van de persoon doorzoeken en lezen.',
  ],
  'key.label.files.write': ['Create and edit files', 'Bestanden maken en bewerken'],
  'key.description.files.write': [
    'Create files and edit the person’s documents and spreadsheets.',
    'Bestanden maken en de documenten en spreadsheets van de persoon bewerken.',
  ],
  'key.label.files.share': ['Share files', 'Bestanden delen'],
  'key.description.files.share': [
    'Share the person’s files with other people. Always asks the person first.',
    'De bestanden van de persoon delen met andere mensen. Vraagt het de persoon altijd eerst.',
  ],
  'key.label.files.delete': ['Move files to the trash', 'Bestanden naar de prullenbak verplaatsen'],
  'key.description.files.delete': [
    'Move the person’s files to the trash.',
    'De bestanden van de persoon naar de prullenbak verplaatsen.',
  ],
  'key.label.contacts.read': ['Read contacts', 'Contacten lezen'],
  'key.description.contacts.read': [
    'Look up people in the person’s contacts.',
    'Mensen opzoeken in de contacten van de persoon.',
  ],
  'key.label.connections.read': ['Read connected services', 'Gekoppelde diensten lezen'],
  'key.description.connections.read': [
    'Read from services connected in Settings → Connections, like Home Assistant, Notion or Todoist. Each tool’s own setting applies too.',
    'Lezen uit diensten die zijn gekoppeld in Instellingen → Koppelingen, zoals Home Assistant, Notion of Todoist. De eigen instelling van elke tool geldt ook.',
  ],
  'key.label.connections.write': [
    'Change things in connected services',
    'Dingen wijzigen in gekoppelde diensten',
  ],
  'key.description.connections.write': [
    'Add, change or switch things in connected services. Some actions, like unlocking a door or deleting, always ask a person.',
    'Dingen toevoegen, wijzigen of schakelen in gekoppelde diensten. Sommige acties, zoals een deur ontgrendelen of iets verwijderen, vragen altijd een persoon.',
  ],
  'key.group.code': ['Code', 'Code'],
  'key.group.research': ['Research', 'Onderzoek'],
  'key.group.operations': ['Operations', 'Beheer'],
  'key.group.support': ['Support', 'Ondersteuning'],
  'key.group.burrow': ['This Whombat', 'Deze Whombat'],
  'key.group.personal': ['Personal accounts', 'Persoonlijke accounts'],
  'key.group.connections': ['Connected services', 'Gekoppelde diensten'],
  'key.locked.never': ['people only', 'alleen voor mensen'],
  'key.locked.ask': ['always asks a person', 'vraagt altijd een persoon'],
  'key.bundle.browser.use': ['the browser', 'de browser'],
  'key.includedWith': ['included with {name}', 'inbegrepen bij {name}'],
  'key.with': ['with {name}', 'met {name}'],
  'key.and': ['{items} and {last}', '{items} en {last}'],
  'key.tier.cannot': ['Just watch', 'Alleen kijken'],
  'key.tier.ask': ['Ask me first', 'Eerst vragen'],
  'key.tier.can': ['Go ahead', 'Ga je gang'],
  'key.risk.deploy.label': ['Deploy', 'Uitrollen'],
  'key.risk.deploy.description': [
    'Deploy to staging and production.',
    'Uitrollen naar staging en productie.',
  ],
  'key.risk.deploy.always': ['Always allow {agent} to deploy', '{agent} altijd laten uitrollen'],
  'key.risk.merge.label': ['Merge into main', 'Samenvoegen in main'],
  'key.risk.merge.description': [
    'Merge pull requests, into the default branch too.',
    'Pull requests samenvoegen, ook in de standaardbranch.',
  ],
  'key.risk.merge.always': [
    'Always allow {agent} to merge into main',
    '{agent} altijd laten samenvoegen in main',
  ],
  'key.risk.branch.main.push.label': ['Push to main', 'Naar main pushen'],
  'key.risk.branch.main.push.description': [
    'Push commits straight to the default branch, without a pull request.',
    'Commits direct naar de standaardbranch pushen, zonder pull request.',
  ],
  'key.risk.branch.main.push.always': [
    'Always allow {agent} to push to main',
    '{agent} altijd laten pushen naar main',
  ],
  'key.risk.commands.destructive.label': [
    'Destructive commands on other machines',
    'Ingrijpende opdrachten op andere machines',
  ],
  'key.risk.commands.destructive.description': [
    'Delete files, drop databases or stop services on other machines. Commands on your Whombat never need this.',
    'Bestanden verwijderen, databases weggooien of diensten stoppen op andere machines. Opdrachten op je Whombat hebben dit nooit nodig.',
  ],
  'key.risk.commands.destructive.always': [
    'Always allow {agent} to run destructive commands on other machines',
    '{agent} altijd ingrijpende opdrachten laten uitvoeren op andere machines',
  ],
  'key.risk.messages.external.label': [
    'Message people outside your Whombat',
    'Mensen buiten je Whombat berichten sturen',
  ],
  'key.risk.messages.external.description': [
    'Send email or messages to anyone outside this Whombat.',
    'E-mail of berichten sturen naar iedereen buiten deze Whombat.',
  ],
  'key.risk.messages.external.always': [
    'Always allow {agent} to message people outside your Whombat',
    '{agent} altijd berichten laten sturen naar mensen buiten je Whombat',
  ],
  'key.risk.refunds.issue.label': ['Money', 'Geld'],
  'key.risk.refunds.issue.description': [
    'Refunds, payments and billing data.',
    'Terugbetalingen, betalingen en factuurgegevens.',
  ],
  'key.risk.refunds.issue.always': [
    'Always allow {agent} to handle money',
    '{agent} altijd met geld laten werken',
  ],
  'key.deployNoWorkflow': [
    'No deploy workflow is set up on this Whombat yet.',
    'Er is nog geen uitrolworkflow ingesteld op deze Whombat.',
  ],
  'key.risk.deploy.mayNow': [
    'From now on {agent} may deploy without asking.',
    'Vanaf nu mag {agent} uitrollen zonder te vragen.',
  ],
  'key.risk.deploy.letTitle': [
    'Let {agent} deploy without asking?',
    '{agent} laten uitrollen zonder te vragen?',
  ],
  'key.risk.merge.mayNow': [
    'From now on {agent} may merge into main without asking.',
    'Vanaf nu mag {agent} samenvoegen in main zonder te vragen.',
  ],
  'key.risk.merge.letTitle': [
    'Let {agent} merge into main without asking?',
    '{agent} laten samenvoegen in main zonder te vragen?',
  ],
  'key.risk.branch.main.push.mayNow': [
    'From now on {agent} may push to main without asking.',
    'Vanaf nu mag {agent} naar main pushen zonder te vragen.',
  ],
  'key.risk.branch.main.push.letTitle': [
    'Let {agent} push to main without asking?',
    '{agent} naar main laten pushen zonder te vragen?',
  ],
  'key.risk.commands.destructive.mayNow': [
    'From now on {agent} may run destructive commands on other machines without asking.',
    'Vanaf nu mag {agent} ingrijpende opdrachten uitvoeren op andere machines zonder te vragen.',
  ],
  'key.risk.commands.destructive.letTitle': [
    'Let {agent} run destructive commands on other machines without asking?',
    '{agent} ingrijpende opdrachten laten uitvoeren op andere machines zonder te vragen?',
  ],
  'key.risk.messages.external.mayNow': [
    'From now on {agent} may message people outside your Whombat without asking.',
    'Vanaf nu mag {agent} mensen buiten je Whombat berichten sturen zonder te vragen.',
  ],
  'key.risk.messages.external.letTitle': [
    'Let {agent} message people outside your Whombat without asking?',
    '{agent} mensen buiten je Whombat berichten laten sturen zonder te vragen?',
  ],
  'key.risk.refunds.issue.mayNow': [
    'From now on {agent} may handle money without asking.',
    'Vanaf nu mag {agent} met geld werken zonder te vragen.',
  ],
  'key.risk.refunds.issue.letTitle': [
    'Let {agent} handle money without asking?',
    '{agent} met geld laten werken zonder te vragen?',
  ],
});
