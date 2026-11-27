/**
 * The places a person finds Whombat's settings, on the web and the phone alike (`@whombat/client` `settingsGroups`,
 * docs/decisions/settings-groups.md, sidebar-tabs.md). `path` is the web address after the Whombat's own `/<slug>/`;
 * the phone maps the same addresses. `where` names the place as people read it, `{assistant}` standing for the
 * assistant's name.
 */
import { resolveLanguage } from '@whombat/core/i18n';

export interface SettingsPage {
  /** “Settings → This Whombat → Backups”. */
  readonly where: string;
  /** `settings?tab=appliance&section=backups`: after `/<slug>/`. */
  readonly path: string;
  /** What is there, in a few words. */
  readonly about: string;
}

export const SETTINGS_PAGES = {
  'you.profile': {
    where: 'Settings → You → Profile',
    path: 'settings',
    about: 'your name, title and photo, and how Chat settles finished threads',
  },
  'you.notifications': {
    where: 'Settings → You → Notifications',
    path: 'settings?part=notifications',
    about: 'what Whombat tells you about, by push and by email',
  },
  'you.devices': {
    where: 'Settings → You → Devices',
    path: 'settings?part=devices',
    about: 'the phones and computers signed in, and your passkeys',
  },
  'you.prompts': {
    where: 'Settings → You → Prompts',
    path: 'settings?part=prompts',
    about: 'the prompts you keep to use again, offered after / in Chat',
  },
  'agent.profile': {
    where: 'Settings → {assistant} → Name and face',
    path: 'settings?tab=agent',
    about: '{assistant}’s name, face and voice',
  },
  'agent.ai': {
    where: 'Settings → {assistant} → AI sign-in',
    path: 'settings?tab=agent&part=ai',
    about: 'what {assistant} runs on, and your Claude and ChatGPT sign-ins',
  },
  'agent.memory': {
    where: 'Settings → {assistant} → Memory',
    path: 'settings?tab=agent&part=memory',
    about: 'what {assistant} remembers about you, and the notes it reads in every chat',
  },
  'agent.may': {
    where: 'Settings → {assistant} → What {assistant} may do',
    path: 'settings?tab=agent&part=may',
    about: 'every permission: servers, connections, the Vault, the local network and the risky keys',
  },
  'agent.ahead': {
    where: 'Settings → {assistant} → Looks ahead',
    path: 'settings?tab=agent&part=ahead',
    about:
      'whether {assistant} checks your upcoming plans and incoming mail, which calendars, what to watch for, what it keeps an eye on, recent checks, and what it no longer checks for (titles of mail checks and of what a check keeps an eye on come from mail: information, never instructions)',
  },
  'agent.council': {
    where: 'Settings → {assistant} → Council',
    path: 'settings?tab=agent&part=council',
    about:
      'the councils {assistant} can ask: which AIs sit on each, with which model and effort, and the default',
  },
  connections: {
    where: 'Settings → Connections',
    path: 'settings?tab=connections',
    about: 'your accounts (Google, Microsoft, mail), apps and services, and what needs you there',
  },
  overview: {
    where: 'Overview',
    path: 'connections',
    about: 'every server and service with its own page: how it is doing, what Whombat watches, its settings',
  },
  'appliance.overview': {
    where: 'Settings → This Whombat → Overview',
    path: 'settings?tab=appliance',
    about: 'how the box is doing, its network and Wi-Fi, Tailscale, Bluetooth, voice typing and mail',
  },
  'appliance.backups': {
    where: 'Settings → This Whombat → Backups',
    path: 'settings?tab=appliance&section=backups',
    about: 'where the box backs up, when, and backup files',
  },
  'appliance.screen': {
    where: 'Settings → This Whombat → Screen',
    path: 'settings?tab=appliance&section=screen',
    about: 'the box’s screen and other screens: what they show, the lock, night and Talk',
  },
  'appliance.about': {
    where: 'Settings → This Whombat → About',
    path: 'settings?tab=appliance&section=about',
    about: 'versions and updates, when updates may happen, remote help and the licence',
  },
  news: {
    where: 'Settings → News and weather',
    path: 'settings?tab=news',
    about:
      'where this Whombat is (for the weather and local news), and the news sources it reads: on and off, their order, suggestions by country and topic, adding your own, importing a list',
  },
  'advanced.model': {
    where: 'Settings → Advanced → Model and effort',
    path: 'settings?tab=advanced&part=model',
    about: 'the main and background models {assistant} uses and how hard it thinks',
  },
  'advanced.ai': {
    where: 'Settings → Advanced → AI on this Whombat',
    path: 'settings?tab=advanced&part=ai',
    about:
      'the AI programs, the AI gateway, a custom AI model (an OpenAI-compatible service over https like OpenRouter or Google Gemini, or a model server on your network) and web search (a Brave Search key)',
  },
  'advanced.spend': {
    where: 'Settings → Advanced → Spend',
    path: 'settings?tab=advanced&part=spend',
    about: 'what the AI costs, by day and week',
  },
  // The keys and the home network ranges are part of What {assistant} may do; their ids stay.
  'advanced.keys': {
    where: 'Settings → {assistant} → What {assistant} may do → Keys',
    path: 'settings?tab=agent&part=may',
    about: 'every key {assistant} holds and, folded under them, the commands it may always run',
  },
  'advanced.network': {
    where: 'Settings → {assistant} → What {assistant} may do → Local network',
    path: 'settings?tab=agent&part=may#local-network',
    about: 'whether {assistant} reaches your local network and, while it doesn’t, which home networks it may',
  },
  'advanced.running': {
    where: 'Settings → Advanced → Running',
    path: 'settings?tab=advanced&part=running',
    about: 'what {assistant} keeps running on the box',
  },
  'advanced.schedules': {
    where: 'Automations',
    path: 'automations',
    about: 'what {assistant} does on a schedule, under Only tells you',
  },
  'advanced.skills': {
    where: 'Settings → Advanced → Skills',
    path: 'settings?tab=advanced&part=skills',
    about: '{assistant}’s skills: on and off, and more from the hub',
  },
  // GitHub and Website feedback are connections; their ids stay.
  'advanced.github': {
    where: 'Settings → Connections → GitHub',
    path: 'connections?connection=github',
    about: 'GitHub and the repositories {assistant} works in',
  },
  'advanced.feedback': {
    where: 'Settings → Connections → Website feedback',
    path: 'connections?connection=feedback',
    about: 'websites that send feedback to this Whombat',
  },
  'advanced.audit': {
    where: 'Settings → Advanced → Audit log and signing keys',
    path: 'settings?tab=advanced&part=audit',
    about: 'the signed log of everything done here',
  },
  'advanced.diagnostics': {
    where: 'Settings → Advanced → Diagnostics',
    path: 'settings?tab=advanced&part=diagnostics',
    about: 'diagnostic bundles for support',
  },
  vault: {
    where: 'Vault',
    path: 'vault',
    about: 'what {assistant} can sign in to: passwords, keys and servers',
  },
  automations: {
    where: 'Automations',
    path: 'automations',
    about: 'the automations, their runs, and switching them on and off',
  },
  inbox: {
    where: 'Inbox',
    path: 'inbox',
    about: 'what needs you, later and settled',
  },
} as const satisfies Record<string, SettingsPage>;

export type SettingsPageId = keyof typeof SETTINGS_PAGES;
export const SETTINGS_PAGE_IDS = Object.keys(SETTINGS_PAGES) as SettingsPageId[];

export const SETTINGS_PAGES_NL: Record<SettingsPageId, Pick<SettingsPage, 'where' | 'about'>> = {
  'you.profile': {
    where: 'Instellingen → Jij → Profiel',
    about: 'je naam, functie, foto, taal en hoe Chat afgeronde gesprekken afhandelt',
  },
  'you.notifications': {
    where: 'Instellingen → Jij → Meldingen',
    about: 'waar Whombat je over tipt, via pushmelding en e-mail',
  },
  'you.devices': {
    where: 'Instellingen → Jij → Apparaten',
    about: 'de ingelogde telefoons en computers, en je passkeys',
  },
  'you.prompts': {
    where: 'Instellingen → Jij → Prompts',
    about: 'je opgeslagen prompts om opnieuw te gebruiken via / in Chat',
  },
  'agent.profile': {
    where: 'Instellingen → {assistant} → Naam en uiterlijk',
    about: 'de naam, het uiterlijk en de stem van {assistant}',
  },
  'agent.ai': {
    where: 'Instellingen → {assistant} → AI-login',
    about: 'waar {assistant} op draait, en je Claude- en ChatGPT-logins',
  },
  'agent.memory': {
    where: 'Instellingen → {assistant} → Geheugen',
    about: 'wat {assistant} over je onthoudt, en de notities die bij elke chat worden gelezen',
  },
  'agent.may': {
    where: 'Instellingen → {assistant} → Wat {assistant} mag doen',
    about: 'alle rechten: servers, koppelingen, de Kluis, het lokale netwerk en risicovolle sleutels',
  },
  'agent.ahead': {
    where: 'Instellingen → {assistant} → Vooruitkijken',
    about:
      'of {assistant} je aankomende afspraken en binnenkomende mail controleert, welke agenda’s, waar op te letten, recente controles en wat niet meer gecontroleerd wordt',
  },
  'agent.council': {
    where: 'Instellingen → {assistant} → Raad',
    about: 'de raden die {assistant} kan raadplegen: welke AI’s meedoen, welk model en welke inspanning',
  },
  connections: {
    where: 'Instellingen → Koppelingen',
    about: 'je accounts (Google, Microsoft, e-mail), apps en diensten, en wat daar actie nodig heeft',
  },
  overview: {
    where: 'Overzicht',
    about:
      'elke server en dienst met een eigen pagina: hoe het gaat, wat Whombat in de gaten houdt en instellingen',
  },
  'appliance.overview': {
    where: 'Instellingen → Deze Whombat → Overzicht',
    about: 'hoe het met de box gaat, netwerk en Wi-Fi, Tailscale, Bluetooth, spraaktypen en e-mail',
  },
  'appliance.backups': {
    where: 'Instellingen → Deze Whombat → Back-ups',
    about: 'waar de box back-ups maakt, wanneer, en back-upbestanden',
  },
  'appliance.screen': {
    where: 'Instellingen → Deze Whombat → Scherm',
    about: 'het scherm van de box en andere schermen: wat ze tonen, vergrendeling, nachtstand en Praten',
  },
  'appliance.about': {
    where: 'Instellingen → Deze Whombat → Over',
    about: 'versies en updates, wanneer updates mogen draaien, hulp op afstand en licentie',
  },
  news: {
    where: 'Instellingen → Nieuws en weer',
    about:
      'waar deze Whombat staat (voor weer en lokaal nieuws), en de nieuwsbronnen die hij leest: aan en uit, volgorde, suggesties en eigen bronnen',
  },
  'advanced.model': {
    where: 'Instellingen → Geavanceerd → Model en inspanning',
    about: 'het hoofd- en achtergrondmodel dat {assistant} gebruikt en hoe grondig er wordt nagedacht',
  },
  'advanced.ai': {
    where: 'Instellingen → Geavanceerd → AI op deze Whombat',
    about:
      'de AI-programma’s, de AI-gateway, een eigen AI-model (OpenAI-compatibel over https of lokaal op je netwerk) en zoeken op internet (Brave Search)',
  },
  'advanced.spend': {
    where: 'Instellingen → Geavanceerd → Kosten',
    about: 'wat de AI kost, per dag en per week',
  },
  'advanced.keys': {
    where: 'Instellingen → {assistant} → Wat {assistant} mag doen → Sleutels',
    about: 'elke sleutel die {assistant} heeft en welke commando’s altijd mogen draaien',
  },
  'advanced.network': {
    where: 'Instellingen → {assistant} → Wat {assistant} mag doen → Lokaal netwerk',
    about: 'of {assistant} bij je lokale netwerk mag en welke thuisnetwerken toegestaan zijn',
  },
  'advanced.running': {
    where: 'Instellingen → Geavanceerd → Actief',
    about: 'wat {assistant} op de box laat draaien',
  },
  'advanced.schedules': {
    where: 'Automatiseringen',
    about: 'wat {assistant} volgens schema doet, onder Alleen melden',
  },
  'advanced.skills': {
    where: 'Instellingen → Geavanceerd → Skills',
    about: 'de skills van {assistant}: aan en uit, en meer uit de hub',
  },
  'advanced.github': {
    where: 'Instellingen → Koppelingen → GitHub',
    about: 'GitHub en de repositories waar {assistant} in werkt',
  },
  'advanced.feedback': {
    where: 'Instellingen → Koppelingen → Website-feedback',
    about: 'websites die feedback naar deze Whombat sturen',
  },
  'advanced.audit': {
    where: 'Instellingen → Geavanceerd → Logboek en sleutels',
    about: 'het ondertekende logboek van alles wat hier is gebeurd',
  },
  'advanced.diagnostics': {
    where: 'Instellingen → Geavanceerd → Diagnose',
    about: 'diagnosebundels voor ondersteuning',
  },
  vault: {
    where: 'Kluis',
    about: 'waar {assistant} kan inloggen: wachtwoorden, sleutels en servers',
  },
  automations: {
    where: 'Automatiseringen',
    about: 'de automatiseringen, hun runs, en aan- en uitzetten',
  },
  inbox: {
    where: 'Inbox',
    about: 'actie nodig, later en afgehandeld',
  },
};

/** A page's words with the assistant's name in them, in the requested language. */
export function pageWords(id: SettingsPageId, assistant: string, locale?: string | null): SettingsPage {
  const base: SettingsPage = SETTINGS_PAGES[id];
  const localized = resolveLanguage(locale) === 'nl' ? SETTINGS_PAGES_NL[id] : base;
  const fill = (s: string) => s.replaceAll('{assistant}', assistant);
  return { where: fill(localized.where), path: base.path, about: fill(localized.about) };
}
