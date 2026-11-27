import { splitPairs } from './pairs.js';

/** Models, effort, the Chat runtime, the custom AI model and web search (`text/models.ts` and neighbours). */
export const AI = splitPairs({
  'effort.low': ['Low', 'Laag'],
  'effort.medium': ['Medium', 'Gemiddeld'],
  'effort.high': ['High', 'Hoog'],
  'effort.xhigh': ['Extra high', 'Extra hoog'],
  'effort.max': ['Max', 'Max'],
  'effort.ultra': ['Ultra', 'Ultra'],
  'model.modelSection': ['MODEL', 'MODEL'],
  'model.backgroundModelSection': ['BACKGROUND MODEL', 'ACHTERGRONDMODEL'],
  'model.effortSection': ['EFFORT', 'INSPANNING'],
  'model.defaultModel': ['Default', 'Standaard'],
  'model.backgroundModelSame': ['Same as the main model', 'Hetzelfde als het hoofdmodel'],
  'model.backgroundModelHint': [
    'Used for automatic checks, care plans and scheduled automations. Chats and plans you start keep the main model.',
    'Gebruikt voor automatische controles, zorgplannen en geplande automatiseringen. Chats en plannen die jij start houden het hoofdmodel.',
  ],
  'model.automatic': ['Automatic', 'Automatisch'],
  'model.automaticHint': [
    'Medium for conversations, high for code work.',
    'Gemiddeld voor gesprekken, hoog voor codewerk.',
  ],
  'model.effortHint': [
    'Every reply and task uses this. Higher thinks longer: slower replies and more usage.',
    'Elk antwoord en elke taak gebruikt dit. Hoger denkt langer na: tragere antwoorden en meer verbruik.',
  ],
  'model.saved': ['model and effort', 'model en inspanning'],
  'model.notSaved': [
    'This Whombat didn’t save that change. Update this Whombat to use every setting.',
    'Deze Whombat heeft die wijziging niet opgeslagen. Werk deze Whombat bij om elke instelling te gebruiken.',
  ],
  'model.defaultNamed': ['{default} ({model})', '{default} ({model})'],
  'model.defaultModelWords': ['Default model', 'Standaardmodel'],
  'model.effortWords': ['{effort} effort', '{effort} inspanning'],
  'model.fast': ['Fast', 'Snel'],
  'model.fallbackGateway': ['through {name}', 'via {name}'],
  'model.fallbackGatewayUnnamed': ['through the AI gateway', 'via de AI-gateway'],
  'model.fallbackOrg': ['on the organization’s key', 'op de sleutel van de organisatie'],
  'model.fallbackLocal': ['on the custom AI model', 'op het eigen AI-model'],
  'model.fallbackPerson': ['on {name}’s sign-in', 'op de aanmelding van {name}'],
  'model.fallbackSomeone': ['on that person’s sign-in', 'op de aanmelding van die persoon'],
  'model.fallback': [
    '{model} wasn’t available {on}, so {agent} used the default model for that reply.',
    '{model} was niet beschikbaar {on}, dus {agent} gebruikte het standaardmodel voor dat antwoord.',
  ],

  'chat.provider.claude': ['Claude', 'Claude'],
  'chat.provider.codex': ['ChatGPT', 'ChatGPT'],
  'chat.provider.local': ['Custom', 'Eigen'],
  'chat.answersWith': ['{name} answers with', '{name} antwoordt met'],
  'chat.model': ['Model', 'Model'],
  'chat.effort': ['Effort', 'Inspanning'],
  'chat.effortHint': [
    'Higher thinks longer: slower replies and more usage.',
    'Hoger denkt langer na: tragere antwoorden en meer verbruik.',
  ],
  'chat.fast': ['Fast replies', 'Snelle antwoorden'],
  'chat.fastHint.claude': [
    'Up to 2½× faster. Paid from usage credits on your Claude account, not from your plan.',
    'Tot 2½× sneller. Betaald uit verbruikstegoed op je Claude-account, niet uit je abonnement.',
  ],
  'chat.fastHint.codex': [
    'About twice as fast. Uses up your ChatGPT plan quicker.',
    'Ongeveer twee keer zo snel. Gebruikt je ChatGPT-abonnement sneller op.',
  ],
  'chat.fastMidThread': [
    'Turning it on now reads this whole thread once at the fast price.',
    'Als je het nu aanzet, wordt deze hele thread één keer tegen de snelle prijs gelezen.',
  ],
  'chat.fastGateway': [
    'Fast replies don’t go through the AI gateway.',
    'Snelle antwoorden gaan niet via de AI-gateway.',
  ],
  'chat.scopeThread': ['For this thread', 'Voor deze thread'],
  'chat.scopeNext': ['For your next question', 'Voor je volgende vraag'],
  'chat.makeDefault': ['Make this {name}’s default', 'Maak dit de standaard van {name}'],
  'chat.defaultTag': ['DEFAULT', 'STANDAARD'],
  'chat.more': ['{n} more…', 'nog {n}…'],
  'chat.notSetUp': ['{label} isn’t set up on this Whombat.', '{label} is niet ingesteld op deze Whombat.'],
  'chat.setUp': ['Set it up', 'Instellen'],
  'chat.madeDefault': [
    '{name} now answers with {choice} by default.',
    '{name} antwoordt nu standaard met {choice}.',
  ],
  'chat.buttonLabel': ['Choose how {name} answers', 'Kies hoe {name} antwoordt'],
  'chat.noAi': ['No AI yet', 'Nog geen AI'],
  'chat.noAiLabel': [
    'No AI yet. Set one up so {name} can answer.',
    'Nog geen AI. Stel er een in zodat {name} kan antwoorden.',
  ],
  'chat.list': ['{items} and {last}', '{items} en {last}'],
  'chat.noFast': ['This model has no fast replies.', 'Dit model heeft geen snelle antwoorden.'],
  'chat.onlyFast': [
    {
      one: 'Only {models} has fast replies. {picked} is picked.',
      other: 'Only {models} have fast replies. {picked} is picked.',
    },
    {
      one: 'Alleen {models} heeft snelle antwoorden. {picked} is gekozen.',
      other: 'Alleen {models} hebben snelle antwoorden. {picked} is gekozen.',
    },
  ],
  'chat.usagePart': ['{provider} {pct}% used', '{provider} {pct}% gebruikt'],
  'chat.usageLine': ['This 5 hours: {parts}', 'Deze 5 uur: {parts}'],
  'chat.fastOn': ['Fast replies on', 'Snelle antwoorden aan'],
  'chat.fastOff': ['Fast replies off', 'Snelle antwoorden uit'],
  'chat.fastOnLower': ['fast replies on', 'snelle antwoorden aan'],
  'chat.fastOffLower': ['fast replies off', 'snelle antwoorden uit'],
  'chat.switchedTo': ['Switched to {what}', 'Overgestapt op {what}'],
  'chat.skipped.busy': [
    'Fast replies were busy, so this one came at the normal speed.',
    'Snelle antwoorden waren druk, dus dit antwoord kwam op normale snelheid.',
  ],
  'chat.skipped.creditsCodex': [
    'Fast replies need more usage on your ChatGPT plan, so this one came at the normal speed.',
    'Snelle antwoorden hebben meer verbruik op je ChatGPT-abonnement nodig, dus dit antwoord kwam op normale snelheid.',
  ],
  'chat.skipped.creditsClaude': [
    'Fast replies need usage credits on your Claude account, so this one came at the normal speed.',
    'Snelle antwoorden hebben verbruikstegoed op je Claude-account nodig, dus dit antwoord kwam op normale snelheid.',
  ],
  'chat.skipped.orgCodex': [
    'Fast replies are turned off for your ChatGPT workspace, so this one came at the normal speed.',
    'Snelle antwoorden staan uit voor je ChatGPT-werkruimte, dus dit antwoord kwam op normale snelheid.',
  ],
  'chat.skipped.orgClaude': [
    'Fast replies are turned off for your Claude organization, so this one came at the normal speed.',
    'Snelle antwoorden staan uit voor je Claude-organisatie, dus dit antwoord kwam op normale snelheid.',
  ],
  'chat.skipped.unavailable': [
    'Fast replies weren’t available, so this one came at the normal speed.',
    'Snelle antwoorden waren niet beschikbaar, dus dit antwoord kwam op normale snelheid.',
  ],
  'chat.modelSkipped': [
    '{asked} wasn’t available, so this one came from {used}.',
    '{asked} was niet beschikbaar, dus dit antwoord kwam van {used}.',
  ],

  'localModel.title': ['Custom AI model', 'Eigen AI-model'],
  'localModel.hint': [
    'Use an OpenAI-compatible service over https (like OpenRouter or Google Gemini) with an API key, or a model server on your own network (like Ollama or LM Studio).',
    'Gebruik een OpenAI-compatibele dienst via https (zoals OpenRouter of Google Gemini) met een API-sleutel, of een modelserver op je eigen netwerk (zoals Ollama of LM Studio).',
  ],
  'localModel.address': ['Address', 'Adres'],
  'localModel.addressHint': [
    'Where its OpenAI-compatible API is, usually ending in /v1. Use https:// for internet services.',
    'Waar de OpenAI-compatibele API staat, meestal eindigend op /v1. Gebruik https:// voor internetdiensten.',
  ],
  'localModel.model': ['Model', 'Model'],
  'localModel.modelHint': [
    'The model’s name on that service or server, like gemini-2.5-flash or llama3.3:70b.',
    'De naam van het model op die dienst of server, zoals gemini-2.5-flash of llama3.3:70b.',
  ],
  'localModel.label': ['Name (optional)', 'Naam (optioneel)'],
  'localModel.labelHint': [
    'What you see in Whombat, like “OpenRouter” or “Llama on the NAS”.',
    'Wat je in Whombat ziet, zoals “OpenRouter” of “Llama op de NAS”.',
  ],
  'localModel.apiKey': ['API key (optional)', 'API-sleutel (optioneel)'],
  'localModel.apiKeySaved': [
    'A key is saved. Type a new one to replace it.',
    'Er is een sleutel opgeslagen. Typ een nieuwe om hem te vervangen.',
  ],
  'localModel.test': ['Test', 'Testen'],
  'localModel.save': ['Save', 'Opslaan'],
  'localModel.checkAgain': ['Check again', 'Opnieuw controleren'],
  'localModel.remove': ['Remove', 'Verwijderen'],
  'localModel.removeTitle': ['Remove the custom AI model?', 'Het eigen AI-model verwijderen?'],
  'localModel.removeBody': [
    'Anything set to use it can’t reply until you set it up again or pick another model.',
    'Alles wat het gebruikt kan niet antwoorden tot je het opnieuw instelt of een ander model kiest.',
  ],
  'localModel.saved': ['Saved the custom AI model.', 'Eigen AI-model opgeslagen.'],
  'localModel.removed': ['Removed the custom AI model.', 'Eigen AI-model verwijderd.'],
  'localModel.check.ok': ['It answers.', 'Het antwoordt.'],
  'localModel.check.unreachable': [
    'Whombat can’t reach it. Check the address and that the service or server is reachable.',
    'Whombat kan het niet bereiken. Controleer het adres en of de dienst of server bereikbaar is.',
  ],
  'localModel.check.refused': [
    'It turned Whombat away. Check the API key.',
    'Het weigerde Whombat. Controleer de API-sleutel.',
  ],
  'localModel.check.no_model': [
    'It has no model called “{model}”. Check the name.',
    'Het heeft geen model met de naam “{model}”. Controleer de naam.',
  ],
  'localModel.check.not_compatible': [
    'It answered, but not like an OpenAI-compatible API. Check the address; it usually ends in /v1.',
    'Het antwoordde, maar niet als een OpenAI-compatibele API. Controleer het adres; dat eindigt meestal op /v1.',
  ],
  'localModel.check.blocked': [
    'That address points at this Whombat itself or somewhere Whombat won’t send a model’s traffic. Use an internet https:// address or a server on your network.',
    'Dat adres wijst naar deze Whombat zelf of naar een plek waar Whombat geen modelverkeer heen stuurt. Gebruik een https://-adres op internet of een server op je netwerk.',
  ],

  'webSearch.title': ['Web search', 'Zoeken op internet'],
  'webSearch.hint': [
    'Let {assistant} search the web with Brave Search. Brave gives about 1,000 searches a month free; signing up asks for a card.',
    'Laat {assistant} op internet zoeken met Brave Search. Brave geeft ongeveer 1.000 zoekopdrachten per maand gratis; bij aanmelden wordt om een betaalkaart gevraagd.',
  ],
  'webSearch.steps': [
    'Make a key at Brave, then paste it here.',
    'Maak een sleutel aan bij Brave en plak hem hier.',
  ],
  'webSearch.getKey': ['Get a Brave Search key', 'Vraag een Brave Search-sleutel aan'],
  'webSearch.signUp': ['No account yet? Sign up', 'Nog geen account? Meld je aan'],
  'webSearch.apiKey': ['Brave Search API key', 'Brave Search API-sleutel'],
  'webSearch.save': ['Save', 'Opslaan'],
  'webSearch.checkAgain': ['Check again', 'Opnieuw controleren'],
  'webSearch.replace': ['Use another key', 'Een andere sleutel gebruiken'],
  'webSearch.remove': ['Remove', 'Verwijderen'],
  'webSearch.removeTitle': ['Remove web search?', 'Zoeken op internet verwijderen?'],
  'webSearch.removeBody': [
    '{assistant} can’t search the web until you add a key again.',
    '{assistant} kan niet op internet zoeken tot je weer een sleutel toevoegt.',
  ],
  'webSearch.on': ['On, with your Brave Search key.', 'Aan, met je Brave Search-sleutel.'],
  'webSearch.saved': ['Web search is on.', 'Zoeken op internet staat aan.'],
  'webSearch.removed': ['Removed web search.', 'Zoeken op internet verwijderd.'],
  'webSearch.invalidKey': [
    'Brave doesn’t accept this key. Copy it again from Brave’s API keys page.',
    'Brave accepteert deze sleutel niet. Kopieer hem opnieuw van de pagina met API-sleutels van Brave.',
  ],
  'webSearch.browseOff': [
    'It works while “Browse the web” is on for {assistant}.',
    'Het werkt zolang “Op internet surfen” aan staat voor {assistant}.',
  ],
  'webSearch.check.ok': ['It works.', 'Het werkt.'],
  'webSearch.check.invalid_key': [
    'Brave doesn’t accept the key. Copy it again from Brave’s API keys page.',
    'Brave accepteert de sleutel niet. Kopieer hem opnieuw van de pagina met API-sleutels van Brave.',
  ],
  'webSearch.check.out_of_credit': [
    'Brave knows the key, but it has no searches left right now. Check your plan at Brave.',
    'Brave kent de sleutel, maar er zijn nu geen zoekopdrachten meer over. Controleer je abonnement bij Brave.',
  ],
  'webSearch.check.unreachable': [
    'Whombat couldn’t reach Brave Search just now. Try again in a moment.',
    'Whombat kon Brave Search net niet bereiken. Probeer het zo opnieuw.',
  ],
});
