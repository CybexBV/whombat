/**
 * The guides as state machines (docs/decisions/assistant-guides.md AG-01…AG-13). Pure: a guide's steps are
 * built from `GuideFacts` (what this Whombat and this person have set up), and `transition` says what an action on
 * a card means — the answer label for the locked card, the effects to run and the next steps to post. The service
 * (`service.ts`) loads the facts, runs the effects and posts the steps as the person's personal agent.
 *
 * A card's `node` carries all the state a guide needs (`step_3.external.email`: step 3 of the app setup, a
 * personal Gmail audience, started from the email topic), so nothing else is stored per guide.
 */
import {
  CONNECTOR_SERVICES,
  type ConnectErrorCode,
  type ConnectionCheck,
  type ConnectionStatus,
  type ConnectorProvider,
  type ConnectorService,
  connectHereLocked,
  type GoogleMode,
  type GoogleSetupFacts,
  type GoogleUserType,
  GUIDE_TOPIC_SERVICES,
  GuideCard,
  type GuideErrorCode,
  type GuideVaultOutcome,
  type GuideVaultRefusal,
  serviceLabel,
  vaultAskLockedLabel,
} from '@whombat/core';
import type { ConnectTopic, Origin } from './copy';
import * as copy from './copy';

export interface GuideFacts {
  /** The person's first name (“Mara”). */
  personName: string;
  agentName: string;
  google: {
    mode: GoogleMode;
    /** Connecting works here at all (not `WHOMBAT_GOOGLE=off`). */
    enabled: boolean;
    /** A client is set (Settings or config), or the fake Google needs none. */
    appReady: boolean;
    /** The client is set in config (the chat can't change it). */
    appInConfig: boolean;
  };
  connection: {
    email: string;
    services: readonly ConnectorService[];
    status: ConnectionStatus;
    checks: readonly ConnectionCheck[];
  } | null;
  setup: GoogleSetupFacts;
  /** The person's time zone (their preference, else the burrow's). */
  timeZone: string;
  /** `/{burrow}/chat`: where connect cards return to (with `?thread=…&guide=<message id>`, AG-08). */
  chatPath: string;
  /** The thread the steps are posted in; null: each goes at the top of the Chat, its own thread. */
  threadRootId: string | null;
  /** `Preferences.assistant.dontAsk`. */
  dontAsk: readonly string[];
}

/** One message the guide posts as the agent. `card` null: a plain message. */
export interface GuidePost {
  id: string;
  text: string;
  card: GuideCard | null;
}

/** A step to post, given the facts and the message id it will get. */
export type Step = (facts: GuideFacts, id: string) => GuidePost;

export interface GuideAct {
  actionId: string;
  optionIds?: readonly string[] | undefined;
}

/** A Google client the route saved before the commit (AG-06 step 5); never the secret. */
export interface SavedApp {
  clientIdHint: string;
  /** The dropped JSON listed this Whombat's redirect URI (or no JSON was dropped). */
  redirectListed: boolean;
}

export type GuideEffect =
  | { kind: 'save_google_app' }
  | { kind: 'dont_ask'; topic: SuggestedTopic | 'skills' }
  | { kind: 'wake_agent' };

export interface Transition {
  /** The locked card's answer (“Google”, “Client ID 1234567890ab… saved”). */
  label: string;
  effects: GuideEffect[];
  next: Step[];
  /** How a Vault card ended, kept in the answer for the agent (connect-in-chat.md, vault-simplify.md). */
  vault?: SavedVault;
  /** How a card that connects on the card ended (connect-by-talking.md). */
  connect?: SavedConnection;
}

/** How the route answered a card that connects on the card (connect-by-talking.md): never the key. */
export interface SavedConnection {
  /** The new connection, when it connected. */
  connectionId?: string | undefined;
  /** The connection's name, as the card and the locked label say it. */
  name: string;
  outcome: 'connected' | 'declined';
  /** Whether the agent is woken in the card's thread (once connected, to carry on with it). */
  wake: boolean;
}

/** How the route answered a Vault card (connect-in-chat.md, vault-simplify.md): never a value. */
export interface SavedVault {
  /** The entry it went to (a server card's: the SSH key the server is on). */
  entryId?: string | undefined;
  /** The card's name (the entry, the server or the site). */
  name: string;
  outcome: GuideVaultOutcome;
  refusal?: GuideVaultRefusal | undefined;
  /** A server card's server, by the name the commands reach it. */
  server?: string | undefined;
  /** Whether the agent is woken in the card's thread (not when the turn that asked takes the answer itself). */
  wake: boolean;
}

/** Why an action can't be taken; `code` is a `GuideErrorCode`, or a plain bad request. */
export class GuideRefusal extends Error {
  constructor(
    readonly code: GuideErrorCode | 'bad_request',
    message: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

/* Cards ------------------------------------------------------------------------------------------ */

type CardInput = Omit<GuideCard, 'kind' | 'state' | 'answer' | 'step' | 'body' | 'blocks'> & {
  step?: GuideCard['step'];
  body?: string;
  blocks?: unknown[];
};

/**
 * A card as stored: validated against the contract (bounds, ids, URLs), `open` when it takes an action, else
 * `done` with no answer (a result or a plain notice: nothing to answer, nothing to expire). A `standing` card (a
 * setting as set, whose buttons are controls for later) stays open so its buttons work, but waits for nobody.
 */
export function makeCard(input: CardInput): GuideCard {
  const { standing, ...rest } = input;
  const card = GuideCard.parse({ kind: 'guide', ...rest, blocks: input.blocks ?? [], state: 'open' });
  if (!actionable(card)) return { ...card, state: 'done' };
  return standing ? { ...card, standing: true } : card;
}

/** Whether a card waits for the person: a choice, a button (not a link), a form or a connect button. */
export function actionable(card: Pick<GuideCard, 'blocks'>): boolean {
  return card.blocks.some(
    (b) =>
      b.type === 'choices' ||
      b.type === 'form' ||
      b.type === 'connect' ||
      (b.type === 'actions' && b.actions.some((a) => a.href === null)),
  );
}

const plain =
  (text: string): Step =>
  (_f, id) => ({ id, text, card: null });

/** The services of a connect card: the topic's first, then every other one (all preticked, CN-04). */
export function servicesFor(origin: Origin | 'repair' | 'google_app' | 'welcome'): ConnectorService[] {
  const first = (GUIDE_TOPIC_SERVICES as Partial<Record<string, readonly ConnectorService[]>>)[origin] ?? [];
  return [...first, ...CONNECTOR_SERVICES.filter((s) => !first.includes(s))];
}

/**
 * Where Google sends the person back: the connect card's thread in their Chat, marked with the card's message id
 * (AG-08), so the result lands beside the card and the thread is open when they arrive.
 */
export function returnToFor(facts: Pick<GuideFacts, 'chatPath' | 'threadRootId'>, messageId: string): string {
  const thread = facts.threadRootId ?? messageId;
  return `${facts.chatPath}?thread=${encodeURIComponent(thread)}&guide=${encodeURIComponent(messageId)}`;
}

function connectStep(
  topic: string,
  node: string,
  services: readonly ConnectorService[],
  options: {
    text?: string;
    title?: string;
    body?: string;
    reconnect?: boolean;
    extra?: unknown[];
    step?: GuideCard['step'];
  } = {},
): Step {
  return (f, id) => ({
    id,
    text: options.text ?? '',
    card: makeCard({
      guide: topic,
      node,
      title: options.title ?? copy.CONNECT_TITLE,
      body: options.body ?? copy.CONNECT_BODY,
      step: options.step ?? null,
      blocks: [
        {
          type: 'connect',
          provider: 'google',
          services: [...services],
          reconnect: options.reconnect ?? f.connection !== null,
          returnTo: returnToFor(f, id),
        },
        ...(options.extra ?? []),
      ],
    }),
  });
}

/* Connect topics (AG-05) -------------------------------------------------------------------------- */

function hasServices(f: GuideFacts, topic: ConnectTopic): boolean {
  const c = f.connection;
  if (c?.status !== 'active') return false;
  return (GUIDE_TOPIC_SERVICES[topic] ?? []).every((s) => c.services.includes(s));
}

function providerStep(topic: ConnectTopic): Step {
  return (_f, id) => ({
    id,
    text: copy.CONNECT_INTRO_TEXT,
    card: makeCard({
      guide: topic,
      node: 'intro',
      title: copy.CONNECT_TITLES[topic],
      body: copy.CONNECT_INTRO_BODY,
      blocks: [
        {
          type: 'choices',
          id: 'provider',
          options: [
            {
              id: 'google',
              title: 'Google',
              description: copy.GOOGLE_OPTION_DESCRIPTION[topic],
              icon: { brand: 'google' },
            },
            {
              id: 'microsoft',
              ...copy.MICROSOFT_OPTION,
              icon: { brand: 'microsoft' },
              badge: { label: copy.COMING_SOON },
              disabled: true,
            },
            ...(topic === 'email'
              ? [
                  {
                    id: 'other',
                    ...copy.OTHER_EMAIL_OPTION,
                    icon: { brand: 'mail' },
                  },
                ]
              : []),
          ],
        },
      ],
    }),
  });
}

/** The first steps of a connect topic: the result when it is connected already, else the provider choice. */
export function connectTopicSteps(topic: ConnectTopic, f: GuideFacts): Step[] {
  if (!f.google.enabled) return [plain(copy.GOOGLE_OFF_TEXT)];
  if (hasServices(f, topic)) return [resultStep(topic, null), ...followUps(f, f.connection?.services ?? [])];
  return [providerStep(topic)];
}

/** After “Google”: connect (the app is set), else the app setup (AG-05 a/b; one-person.md OP-S76). */
export function googleSteps(origin: Origin, f: GuideFacts): Step[] {
  if (!f.google.enabled) return [plain(copy.GOOGLE_OFF_TEXT)];
  if (f.google.appReady)
    return [connectStep(origin === 'none' ? 'google_app' : origin, 'connect', servicesFor(origin))];
  return appIntroSteps(origin, f);
}

/* The Google app setup (AG-06) ------------------------------------------------------------------ */

export function appIntroSteps(origin: Origin, f: GuideFacts): Step[] {
  if (!f.google.enabled) return [plain(copy.GOOGLE_OFF_TEXT)];
  if (f.google.appInConfig || f.google.appReady) {
    const lead = plain(f.google.appInConfig ? copy.APP_IN_CONFIG_TEXT : copy.APP_ALREADY_TEXT);
    return f.connection?.status === 'active'
      ? [lead]
      : [lead, connectStep('google_app', 'connect', servicesFor(origin))];
  }
  return [
    (_f, id) => ({
      id,
      text: copy.APP_INTRO_TEXT,
      card: makeCard({
        guide: 'google_app',
        node: `intro.${origin}`,
        title: copy.APP_AUDIENCE_TITLE,
        blocks: [
          {
            type: 'choices',
            id: 'audience',
            options: [
              { id: 'external', ...copy.AUDIENCE_OPTIONS.external },
              { id: 'internal', ...copy.AUDIENCE_OPTIONS.internal },
            ],
          },
        ],
      }),
    }),
  ];
}

const STEP_TOTAL = 6;
const stuckAction = { id: 'stuck', label: copy.STUCK, style: 'quiet' } as const;
const stepActions = {
  type: 'actions',
  actions: [{ id: 'next', label: copy.DONE_NEXT, style: 'primary' }, stuckAction],
};

/** Step `n` (1…6) of the app setup (CN-03's six steps). */
export function appStep(n: number, audience: GoogleUserType, origin: Origin, text = ''): Step {
  return (f, id) => {
    const s = f.setup;
    const node = `step_${n}.${audience}.${origin}`;
    const base = {
      guide: 'google_app',
      node,
      step: { index: n, total: STEP_TOTAL },
      title: copy.STEP_TITLES[n - 1] ?? '',
    };
    const link = (label: string, url: string) => ({ label, url });
    switch (n) {
      case 1:
        return {
          id,
          text,
          card: makeCard({
            ...base,
            body: copy.STEP_BODIES.project,
            blocks: [
              { type: 'links', links: [link(copy.STEP_LINKS.createProject, s.links.createProject)] },
              stepActions,
            ],
          }),
        };
      case 2:
        return {
          id,
          text,
          card: makeCard({
            ...base,
            body: copy.STEP_BODIES.apis,
            blocks: [
              { type: 'links', links: [link(copy.STEP_LINKS.enableApis, s.enableApisUrl)] },
              stepActions,
            ],
          }),
        };
      case 3: {
        const rows = [
          { label: 'App name', value: s.appName },
          ...(s.supportEmail ? [{ label: 'Support email', value: s.supportEmail }] : []),
          ...(s.authorizedDomain.includes('.')
            ? [{ label: 'Authorized domain', value: s.authorizedDomain }]
            : []),
        ];
        return {
          id,
          text,
          card: makeCard({
            ...base,
            body:
              audience === 'external' ? copy.STEP_BODIES.consentExternal : copy.STEP_BODIES.consentInternal,
            blocks: [
              { type: 'copy', rows },
              {
                type: 'links',
                links: [
                  link(copy.STEP_LINKS.consentScreen, s.links.consentScreen),
                  ...(audience === 'external' ? [link(copy.STEP_LINKS.audience, s.links.audience)] : []),
                ],
              },
              stepActions,
            ],
          }),
        };
      }
      case 4:
        return {
          id,
          text,
          card: makeCard({
            ...base,
            body: copy.STEP_BODIES.client,
            blocks: [
              { type: 'copy', rows: [{ label: 'Redirect URI', value: s.redirectUri }] },
              { type: 'links', links: [link(copy.STEP_LINKS.createClient, s.links.createClient)] },
              stepActions,
            ],
          }),
        };
      case 5:
        return {
          id,
          text,
          card: makeCard({
            ...base,
            body: copy.STEP_BODIES.paste,
            blocks: [
              {
                type: 'form',
                id: 'app',
                fields: [
                  { id: 'clientId', kind: 'text', optional: true, ...copy.FORM_FIELDS.clientId },
                  { id: 'clientSecret', kind: 'secret', optional: true, ...copy.FORM_FIELDS.clientSecret },
                  { id: 'clientJson', kind: 'json_file', optional: true, ...copy.FORM_FIELDS.clientJson },
                ],
                submitLabel: copy.FORM_SUBMIT,
              },
              { type: 'actions', actions: [stuckAction] },
            ],
          }),
        };
      default:
        return connectStep('google_app', node, servicesFor(origin), {
          text,
          title: copy.STEP_TITLES[5],
          body: copy.STEP_BODIES.test,
          step: { index: 6, total: STEP_TOTAL },
          extra: [{ type: 'actions', actions: [stuckAction] }],
        })(f, id);
    }
  };
}

function troubleStep(n: number, audience: GoogleUserType, origin: Origin): Step {
  return (f, id) => ({
    id,
    text: '',
    card: makeCard({
      guide: 'google_app',
      node: `stuck_${n}.${audience}.${origin}`,
      title: copy.TROUBLE_TITLE,
      body: copy.TROUBLE_BODY,
      blocks: [
        { type: 'status', rows: copy.TROUBLE_ROWS.map((r) => ({ ...r, state: 'warn' })) },
        { type: 'copy', rows: [{ label: 'Redirect URI', value: f.setup.redirectUri }] },
        {
          type: 'links',
          links: [
            { label: copy.STEP_LINKS.enableApis, url: f.setup.enableApisUrl },
            { label: copy.STEP_LINKS.audience, url: f.setup.links.audience },
          ],
        },
        {
          type: 'actions',
          actions: [
            { id: 'again', label: copy.SHOW_AGAIN, style: 'secondary' },
            { id: 'ask', label: copy.askAgentLabel(f.agentName), style: 'secondary' },
          ],
        },
      ],
    }),
  });
}

/* Coming back from Google (AG-08) ---------------------------------------------------------------- */

/** “Google connected · you@example.com” with one row per service (CN-06 checks). */
export function resultStep(topic: string | null, text: string | null): Step {
  return (f, id) => {
    const c = f.connection;
    const services = c?.services ?? [];
    return {
      id,
      text: text ?? copy.connectedText(services),
      card: makeCard({
        guide: topic ?? 'google_app',
        node: 'result',
        title: copy.connectedTitle(c?.email ?? 'Google'),
        blocks: services.length
          ? [
              {
                type: 'status',
                rows: services.map((service) => {
                  const check = c?.checks.find((k) => k.service === service);
                  const state =
                    check?.state === 'ok' ? 'ok' : check?.state === 'error' ? 'bad' : check ? 'warn' : 'mut';
                  return {
                    label: serviceLabel(service, 'google'),
                    state,
                    detail: copy.checkDetail(check),
                    href: check?.state === 'api_disabled' && check.enableUrl ? check.enableUrl : null,
                  };
                }),
              },
            ]
          : [],
      }),
    };
  };
}

/** After a failed connect: what went wrong, the fix and a new connect card (none without an app). */
export function retrySteps(
  topic: string | null,
  code: ConnectErrorCode,
  services: readonly ConnectorService[],
): Step[] {
  if (code === 'no_app') return [plain(copy.CONNECT_ERROR_TEXT.no_app)];
  return [
    connectStep(topic ?? 'google_app', 'retry', services.length ? services : servicesFor('none'), {
      text: copy.CONNECT_ERROR_TEXT[code],
      title: copy.RETRY_TITLE,
      body: copy.CONNECT_ERROR_FIX[code],
    }),
  ];
}

/** What follows a working connection: nothing; the connection's own card says it works. */
export function followUps(_f: GuideFacts, _services: readonly ConnectorService[]): Step[] {
  return [];
}

/* Suggestions (AG-11) --------------------------------------------------------------------------- */

export type SuggestedTopic = 'email' | 'calendar' | 'files';

export function suggestionStep(topic: SuggestedTopic): Step {
  return (_f, id) => ({
    id,
    text: copy.SUGGESTION_TEXT[topic],
    card: makeCard({
      guide: topic,
      node: 'suggest',
      title: copy.CONNECT_TITLES[topic],
      blocks: [
        {
          type: 'actions',
          actions: [
            { id: 'setup', label: copy.SET_IT_UP, style: 'primary' },
            { id: 'later', label: copy.NOT_NOW, style: 'secondary' },
            { id: 'never', label: copy.DONT_ASK_AGAIN, style: 'quiet' },
          ],
        },
      ],
    }),
  });
}

/* Skills (AG-35…AG-39) -------------------------------------------------------------------------- */

/*
 * The skills pack offer is gone (skill-store.md SST-09, contracts CT-816): the agent has its skills (Hermes's, HSK-01),
 * so the guide is neither started nor suggested. A card from before answers its Add with that, and nothing changes.
 */

/* Repair (AG-13) --------------------------------------------------------------------------------- */

export function repairStep(
  reason: Parameters<typeof copy.repairText>[0],
  services: readonly ConnectorService[],
  provider: ConnectorProvider = 'google',
): Step {
  // An IMAP mailbox needs a new password, typed in Settings, never in chat (CM-D03): words, no Google card.
  if (provider === 'imap') return plain(copy.IMAP_REPAIR_TEXT);
  return (f, id) =>
    connectStep('repair', 'reconnect', services.length ? services : servicesFor('none'), {
      text: copy.repairText(reason, services),
      title: copy.RECONNECT_TITLE,
      body: '',
      reconnect: true,
      // An app still in Testing signs the person out weekly: the card links the way to stop it.
      extra:
        reason === 'testing_expired'
          ? [{ type: 'links', links: [{ label: copy.PUBLISH_APP_LINK, url: f.setup.links.audience }] }]
          : [],
    })(f, id);
}

/* Starting a guide ------------------------------------------------------------------------------ */

/**
 * The first steps of a topic (`start_guide`, an old welcome card's choice, a suggestion's “Set it up”). The welcome
 * itself needs what the scan found: `start_guide` builds it (`welcome.ts`).
 */
export function startSteps(topic: string, f: GuideFacts): Step[] {
  switch (topic) {
    case 'email':
    case 'calendar':
    case 'files':
      return connectTopicSteps(topic, f);
    case 'google_app':
      return appIntroSteps('none', f);
    default:
      return [];
  }
}

/* Acting on a card ------------------------------------------------------------------------------ */

function isOrigin(value: string | undefined): value is Origin {
  return copy.ORIGINS.includes(value as Origin);
}

/** What an action is called on the card: the option's title, else the button's label. */
function labelOf(card: GuideCard, act: GuideAct): string | null {
  for (const block of card.blocks) {
    if (block.type === 'choices' && block.id === act.actionId) {
      const chosen = (act.optionIds ?? [])
        .map((o) => block.options.find((x) => x.id === o))
        .filter((o) => o !== undefined);
      if (chosen.length === 0 || chosen.length !== (act.optionIds ?? []).length)
        throw new GuideRefusal('bad_request', 'Choose one of the options on this card.');
      if (block.mode === 'single' && chosen.length > 1)
        throw new GuideRefusal('bad_request', 'Choose one of the options on this card.');
      if (chosen.some((o) => o.disabled))
        throw new GuideRefusal('bad_request', 'That option isn’t available yet.');
      return chosen.map((o) => o.title).join(', ');
    }
    if (block.type === 'actions') {
      const action = block.actions.find((a) => a.id === act.actionId && a.href === null);
      if (action) return action.label;
    }
    if (block.type === 'form' && block.id === act.actionId) return block.submitLabel;
  }
  return null;
}

const none = (label: string): Transition => ({ label, effects: [], next: [] });

/**
 * What acting on `card` means. Throws `GuideRefusal` for an action the card doesn't offer. `saved` is the Google
 * client the route saved for the app setup's form (step 5); without it the form can't be answered here.
 */
export function transition(
  card: GuideCard,
  act: GuideAct,
  f: GuideFacts,
  saved?: SavedApp,
  vault?: SavedVault,
  connect?: SavedConnection,
): Transition {
  const label = labelOf(card, act);
  if (label === null) throw new GuideRefusal('bad_request', 'That isn’t an action on this card.');
  const option = act.optionIds?.[0];
  const [node = '', a, b] = card.node.split('.');
  const topic = card.guide;

  // A Vault card (connect-in-chat.md, vault-simplify.md): how it ended comes from the route, which saved it, signed in
  // or gave a code before this commit. The agent that asked is woken to carry on, unless its turn takes the answer itself.
  if (topic === 'secret') {
    if (!vault)
      throw new GuideRefusal('invalid_values', copy.VAULT_ASK_MISSING, {
        'values.secret': [copy.VAULT_ASK_MISSING],
      });
    return {
      label: vaultAskLockedLabel(vault.outcome, { name: vault.name, server: vault.server ?? null }).slice(
        0,
        200,
      ),
      effects: vault.wake ? [{ kind: 'wake_agent' }] : [],
      next: [],
      vault,
    };
  }

  // A card that connects on the card (connect-by-talking.md): connected (or set aside) by the route before this commit.
  if (topic === 'add_connection' && card.connectAsk) {
    if (!connect)
      throw new GuideRefusal('invalid_values', copy.VAULT_ASK_MISSING, {
        'values.secret': [copy.VAULT_ASK_MISSING],
      });
    return {
      label: connectHereLocked(connect.outcome, connect.name),
      effects: connect.wake ? [{ kind: 'wake_agent' }] : [],
      next: [],
      connect,
    };
  }

  if (act.actionId === 'later' || act.actionId === 'no') return none(label);

  switch (topic) {
    case 'welcome':
      // Mail, second (first-day.md): Gmail goes through the Google setup; other email is a link.
      if (node === 'mail' && act.actionId === 'google')
        return { label, effects: [], next: googleSteps('email', f) };
      // A welcome card from before (Email · Calendar · Files) still answers.
      if (act.actionId === 'topic' && option) return { label, effects: [], next: startSteps(option, f) };
      break;
    case 'email':
    case 'calendar':
    case 'files': {
      if (node === 'intro' && act.actionId === 'provider' && option === 'google')
        return { label, effects: [], next: googleSteps(topic, f) };
      if (node === 'intro' && act.actionId === 'provider' && option === 'other' && topic === 'email')
        return { label, effects: [], next: [plain(copy.OTHER_EMAIL_TEXT)] };
      if (node === 'suggest') return suggestionTransition(topic, act.actionId, label, f);
      break;
    }
    case 'skills': {
      if ((node === 'offer' || node === 'suggest') && act.actionId === 'attach')
        return { label, effects: [], next: [plain(copy.SKILLS_ALL_TEXT)] };
      if (node === 'suggest' && act.actionId === 'never')
        return {
          label,
          effects: [{ kind: 'dont_ask', topic: 'skills' }],
          next: [plain(copy.dontAskText('skills'))],
        };
      break;
    }
    case 'google_app': {
      if (
        node === 'intro' &&
        act.actionId === 'audience' &&
        (option === 'external' || option === 'internal')
      ) {
        return { label, effects: [], next: [appStep(1, option, isOrigin(a) ? a : 'none')] };
      }
      const step = /^step_([1-6])$/.exec(node);
      const stuck = /^stuck_([1-6])$/.exec(node);
      const audience = a === 'internal' ? 'internal' : 'external';
      const origin = isOrigin(b) ? b : 'none';
      if (step) {
        const n = Number(step[1]);
        if (act.actionId === 'stuck') return { label, effects: [], next: [troubleStep(n, audience, origin)] };
        if (act.actionId === 'next' && n < 5)
          return { label, effects: [], next: [appStep(n + 1, audience, origin)] };
        if (act.actionId === 'app' && n === 5) {
          if (!saved)
            throw new GuideRefusal('invalid_values', copy.CLIENT_ID_MISSING, {
              clientId: [copy.CLIENT_ID_MISSING],
            });
          const text = saved.redirectListed
            ? copy.SAVED_TEXT
            : `${copy.SAVED_TEXT} ${copy.redirectMismatchText(f.setup.redirectUri)}`;
          return {
            label: copy.savedLabel(saved.clientIdHint),
            effects: [{ kind: 'save_google_app' }],
            next: [appStep(6, audience, origin, text)],
          };
        }
      }
      if (stuck) {
        const n = Number(stuck[1]);
        if (act.actionId === 'again') return { label, effects: [], next: [appStep(n, audience, origin)] };
        if (act.actionId === 'ask') return { label, effects: [{ kind: 'wake_agent' }], next: [] };
      }
      break;
    }
  }
  throw new GuideRefusal('bad_request', 'That isn’t an action on this card.');
}

function suggestionTransition(
  topic: SuggestedTopic,
  actionId: string,
  label: string,
  f: GuideFacts,
): Transition {
  if (actionId === 'setup') return { label, effects: [], next: startSteps(topic, f) };
  if (actionId === 'never')
    return { label, effects: [{ kind: 'dont_ask', topic }], next: [plain(copy.dontAskText(topic))] };
  return none(label);
}

/** Posts for a list of steps, each with its own id. */
export function materialize(steps: readonly Step[], f: GuideFacts, newId: () => string): GuidePost[] {
  return steps.map((step) => step(f, newId()));
}
