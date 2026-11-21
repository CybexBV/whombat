/**
 * Every card state as data, built from the fixture world (`@whombat/fixtures`) and the mock's own
 * states in `Whombat Desktop.dc.html`: stories, the visual harness and tests share it. Not exported
 * from the feature's index (dev and test only).
 */

import {
  type AnswerCard,
  type Approval,
  type ApprovalCondition,
  type DigestCard,
  type FeatureRequestView,
  GuideCard,
  type MessageCard,
  type Plan,
  type Run,
} from '@whombat/core/domain';
import {
  at,
  deployApproval,
  plan as fixturePlan,
  run as fixtureRun,
  msg_dm_dusty_dusty_0941,
  msg_dm_dusty_dusty_0944,
  msg_dm_dusty_dusty_1041,
  msg_dm_dusty_dusty_1402,
  msg_pr482_dusty_1048,
  msg_pr482_dusty_1055,
  msg_pr482_mara_1120,
  reportCardOf,
  reportFailed,
  reportFeature,
  reportLikelyBug,
  reportQueued,
  reportRemoved,
  runFinished,
  SEED_NOW,
} from '@whombat/fixtures';
import { featureRequestViews } from '../../app/trackerFixtures';

type CardOf<K extends MessageCard['kind']> = Extract<MessageCard, { kind: K }>;

function cardOf<K extends MessageCard['kind']>(card: MessageCard | null, kind: K): CardOf<K> {
  if (!card || card.kind !== kind) throw new Error(`fixture message has no ${kind} card`);
  return card as CardOf<K>;
}

/* Plan -------------------------------------------------------------------------------------------- */

/** The plan at 11:22: done · active · active · gate ("Needs you"). */
export const planNow: Plan = fixturePlan;

/** One step in each state: done, active, queued and gate. */
export const planAllMarkers: Plan = {
  ...fixturePlan,
  steps: fixturePlan.steps.map((s, i) => (i === 2 ? { ...s, state: 'queued', stateLabel: 'Queued' } : s)),
};

/** The storyline finished: everything done, the deploy went out (mock `plan` once `done && approved`). */
export const planDeployed: Plan = {
  ...fixturePlan,
  steps: fixturePlan.steps.map((s, i) => ({
    ...s,
    state: 'done',
    stateLabel: ['Done', 'Done', 'Approved', 'Deployed'][i] ?? 'Done',
  })),
};

/** A step the agent stopped at for the person's word, with nothing linked to decide it (WS-55): “Go ahead”. */
export const planGoAhead: Plan = {
  ...fixturePlan,
  steps: fixturePlan.steps.map((s, i) =>
    i < 2
      ? { ...s, state: 'done', stateLabel: 'Done' }
      : i === 2
        ? {
            ...s,
            state: 'gate',
            stateLabel: 'Needs a person',
            note: 'Waiting for your go',
            approvalId: null,
            runId: null,
            automationRunId: null,
            refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
          }
        : { ...s, state: 'queued', stateLabel: 'Queued' },
  ),
};

/* Run --------------------------------------------------------------------------------------------- */

/**
 * The run card as the mock renders it at tick 0: `Now: Editing billing/pdf/format.ts` (the mock shows
 * the first LIVE line), 55%, 38 of 41, +214 −12.
 */
export const runLive: Run = { ...fixtureRun, activity: 'Editing billing/pdf/format.ts' };

/** The mock's run card once every LIVE line has played (`done`): RUN · DONE, 41 of 41, +250 −20. */
export const runDone: Run = {
  ...runFinished,
  progress: 100,
  summary: 'Pushed 7be20f and asked Mara to re-review.',
  diff: { add: 214 + 6 * 6, del: 12 + 4 * 2, files: 6 },
};

export const runPaused: Run = { ...runLive, status: 'paused', progress: 67 };

export const runFailed: Run = {
  ...runLive,
  status: 'failed',
  progress: 84,
  summary: 'Stopped: 3 tests still failing in invoice_format_test.',
};

export const runTakenOver: Run = {
  ...runLive,
  status: 'taken_over',
  progress: 72,
  summary: 'Mara took over the branch.',
};

/** A run that changed nothing yet (AP-668): a check of a branch, shown as the run line. */
export const runLineLive: Run = {
  ...runLive,
  number: 6,
  title: 'Confirm updated repository contains House Rules color fix',
  branch: 'feat/house-rules-step-02-color',
  prNumber: null,
  progress: 25,
  activity: 'Inspect repository update',
  tests: null,
  files: [],
  diff: { add: 0, del: 0, files: 0 },
};

export const runLineDone: Run = {
  ...runLineLive,
  status: 'done',
  progress: 100,
  finishedAt: new Date(new Date(runLineLive.startedAt).getTime() + 72_000).toISOString(),
  summary: 'Confirmed 1e5baa7 fixes 02/PLAN color on main; source and Astro checks pass.',
};

/** A check that failed (AP-699): `Run #6 · Failed in 1m 12s · …`, Try again where the Whombat can, and Open run. */
export const runLineFailed: Run = {
  ...runLineDone,
  status: 'failed',
  progress: 40,
  summary: 'Couldn’t fetch the repository from GitHub.',
};

/* Approval ---------------------------------------------------------------------------------------- */

function conditions(
  approval: Approval,
  patch: Partial<Record<ApprovalCondition['kind'], Partial<ApprovalCondition>>>,
): ApprovalCondition[] {
  return approval.conditions.map((c) => ({ ...c, ...patch[c.kind] }) as ApprovalCondition);
}

const checksGreen = {
  met: true,
  state: 'passed',
  passed: 41,
  total: 41,
  fixing: false,
  headSha: '7be20f7',
} as const;
const reviewApproved = { met: true, reviewState: 'approved', reviewedAt: at('11:38') } as const;

/** NEEDS A PERSON — the 11:22 state (checks 38 of 41 fixing, changes requested). */
export const approvalPending: Approval = deployApproval();

/** APPROVED · WAITING FOR CHECKS — Mara approved in advance. */
export const approvalWaiting: Approval = deployApproval({
  state: 'approved',
  decidedById: 'prn_mara',
  decidedAt: SEED_NOW.toISOString(),
  conditions: conditions(deployApproval(), { person_approves: { met: true } }),
});

/** APPROVED · WAITING FOR REVIEW — approved in advance, checks green, only Mara’s review is left. */
export const approvalWaitingReview: Approval = deployApproval({
  state: 'approved',
  decidedById: 'prn_mara',
  decidedAt: SEED_NOW.toISOString(),
  conditions: conditions(deployApproval(), { checks_pass: checksGreen, person_approves: { met: true } }),
});

/** Pending with checks green and Mara's review: the CTA reads "Approve and deploy". */
export const approvalReady: Approval = deployApproval({
  conditions: conditions(deployApproval(), { checks_pass: checksGreen, review_approved: reviewApproved }),
});

/** APPROVED · DEPLOYING — every condition met, the executor is running. */
export const approvalDeploying: Approval = deployApproval({
  state: 'approved',
  decidedById: 'prn_mara',
  decidedAt: SEED_NOW.toISOString(),
  conditions: conditions(deployApproval(), {
    checks_pass: checksGreen,
    review_approved: reviewApproved,
    person_approves: { met: true },
  }),
  execution: {
    state: 'running',
    startedAt: SEED_NOW.toISOString(),
    finishedAt: null,
    durationMs: null,
    resultUrl: null,
    error: null,
  },
});

/** DEPLOYED — the mock's final state ("Deployed to staging in 2m 14s. Try it: …"). */
export const approvalDeployed: Approval = {
  ...approvalDeploying,
  execution: {
    state: 'succeeded',
    startedAt: SEED_NOW.toISOString(),
    finishedAt: SEED_NOW.toISOString(),
    durationMs: 134_000,
    resultUrl: 'https://staging.burrowhq.example/invoices/2026-000142.pdf',
    error: null,
  },
  executedAt: SEED_NOW.toISOString(),
};

/** DEPLOY FAILED — the executor gave up; Undo is still possible. */
export const approvalFailed: Approval = {
  ...approvalDeploying,
  execution: {
    state: 'failed',
    startedAt: SEED_NOW.toISOString(),
    finishedAt: SEED_NOW.toISOString(),
    durationMs: 48_000,
    resultUrl: null,
    error: 'billing-api did not become healthy within 5 minutes.',
  },
};

/** DECLINED — Mara said no. */
export const approvalDeclined: Approval = deployApproval({
  state: 'declined',
  decidedById: 'prn_mara',
  decidedAt: SEED_NOW.toISOString(),
});

/** An everyday ask (handle-it.md): a server call, “Neo needs your OK”, its answers and its lasting yes. */
export const approvalAsk: Approval = deployApproval({
  id: 'apr_restart-nest' as Approval['id'],
  number: 901,
  keyId: 'connections.write',
  action: {
    type: 'connection_call',
    params: {
      connectionId: 'con_servers',
      handle: 'servers',
      tool: 'guest_power',
      toolHash: 'a'.repeat(64),
      scope: 'shared',
      server: { id: 'pve-02', name: 'pve-02' },
    },
  },
  title: 'Restart arnica-prod-nest-01 on pve-02',
  question: 'Restart arnica-prod-nest-01 on pve-02?',
  target: 'pve-02 · arnica-prod-nest-01',
  whatHappens: [
    'Restart arnica-prod-nest-01 so it gets its extra memory (4 → 8 GB)',
    'It’s down for about 40 seconds',
  ],
  explainer: 'Restarting a guest always asks a person.',
  conditions: [
    {
      id: 'person',
      kind: 'person_approves',
      label: 'A person says yes',
      met: false,
      approverIds: ['prn_mara'],
    },
  ] as ApprovalCondition[],
} as Partial<Approval>);

/* Cards ------------------------------------------------------------------------------------------- */

export const research = cardOf(msg_dm_dusty_dusty_0941.card, 'research');
export const review = cardOf(msg_pr482_mara_1120.card, 'review');
export const commits = cardOf(msg_pr482_dusty_1048.card, 'commits');
export const pill = cardOf(msg_pr482_dusty_1055.card, 'pill');
/** Dusty's answer in #incidents: came from a search ("Open in search"). */
export const answerSearch = cardOf(msg_dm_dusty_dusty_1041.card, 'answer');
/** Dusty's DM answer: receipts deep-link to their sources. */
export const answerDm = cardOf(msg_dm_dusty_dusty_1402.card, 'answer');
/** The research thread's receipts (thread pane variant). */
export const answerThread = cardOf(msg_dm_dusty_dusty_0944.card, 'answer');

/**
 * Receipts whose `where` is a sentence, not a few words (from the maintainer's screenshot, CD-11): short
 * ones stay beside the source, long ones wrap under it; long unbroken ids don't spill.
 */
export const answerLong: AnswerCard = {
  kind: 'answer',
  query: null,
  receipts: [
    {
      n: 1,
      source: 'USPTO TSDR — reg. 5758873 prosecution history',
      detail: 'Sec. 8 & 15 accepted 02/12/2024; 2025 attorney/address updates',
    },
    {
      n: 2,
      source: 'USPTO TSDR — reg. 4125401',
      detail: 'DEAD: cancelled 21/10/2022, Sec. 8 (10-YR)/Sec. 9 not filed; owner Proofpoint',
    },
    {
      n: 3,
      source: 'UK IPO register — UK00003912504',
      detail: 'DON’T WOMBAT IT, Compare The Market Ltd, registered 11/08/2023, cl. 9/28/35/36/38/41/42/45',
    },
    { n: 4, source: 'Proofpoint — Wombat Security is now Proofpoint', detail: 'retired 2018' },
    { n: 5, source: 'github.com/mbsantiago/whombat', detail: 'v0.8.x' },
  ].map((r) => ({ ...r, link: null, resultId: null })),
};

/**
 * A personal assistant's inbox roundup (not in the mocks; docs/decisions/rich-messages.md RM-08): the
 * triage from the maintainer's screenshot, with a folded noise section.
 */
export const digest: DigestCard = {
  kind: 'digest',
  title: 'Inbox',
  summary: '7 unread',
  sections: [
    {
      label: 'Worth a look',
      collapsed: false,
      items: [
        {
          time: '15:33',
          title: 'New sign-in to your Lumio account',
          source: 'Lumio',
          note: '3 alerts in 30 minutes. If none were you, secure the account.',
          url: 'https://mail.google.com/mail/?authuser=john%40example.com#all/thr_lumio',
        },
        {
          time: '16:08',
          title: 'CI failed on main (73dc189)',
          source: 'GitHub',
          note: 'All jobs failed; CI / check has 4 annotations.',
          url: 'https://mail.google.com/mail/?authuser=john%40example.com#all/thr_ci',
        },
        {
          time: '09:49',
          title: 'Factuur 20260100439',
          source: 'Nmbrs Payroll',
          note: 'Direct debit, collected automatically.',
          url: null,
        },
      ],
    },
    {
      label: 'No action',
      collapsed: false,
      items: [
        {
          time: '12:10',
          title: 'RE: Volgende stappen',
          source: 'Klaas Veenstra',
          note: '“Ga ik doen, ben nog even bezig om wat te achterhalen.”',
          url: null,
        },
      ],
    },
    {
      label: 'Noise',
      collapsed: true,
      items: [
        { time: '07:02', title: 'Roddelpraat newsletter', source: 'Roddelpraat', note: null, url: null },
        { time: '11:15', title: 'New UniFi Design Center', source: 'Ubiquiti', note: null, url: null },
      ],
    },
  ],
};

/* Report (Whombat Feedback, docs/decisions/feedback.md FB-16) ---------------------------------------- */

/** Assessed by Dusty: a likely bug, with her summary on the card. */
export const reportAssessed = reportCardOf(reportLikelyBug);
/** Just received; waiting for an assessment slot. */
export const reportQueuedCard = reportCardOf(reportQueued);
/** The assessment turn ended without a result: shown honestly, in the failure tone. */
export const reportFailedCard = reportCardOf(reportFailed);
/** You removed the visitor's content; the reference and states stay. */
export const reportRemovedCard = reportCardOf(reportRemoved);
/** A feature request, assessed as one. */
export const reportFeatureCard = reportCardOf(reportFeature);

/* Guide (docs/decisions/assistant-guides.md AG-02…AG-17; no mock, AG-17) ------------------------------------------- */

const guide = (card: Record<string, unknown>): GuideCard =>
  GuideCard.parse({ kind: 'guide', state: 'open', ...card });
const CHAT_RETURN = '/burrow-hq/chat?guide=email';

/** The welcome (AG-04): what to set up, with Lucide icons, and “Maybe later”. */
export const guideWelcome = guide({
  guide: 'welcome',
  node: 'welcome',
  title: 'Hi Mara, I’m Neo, your agent.',
  body: 'Only you can see this conversation. Once they’re connected I can help with your email, calendar and files. What would you like to set up?\n\nYou can also just type what you need.',
  blocks: [
    {
      type: 'choices',
      id: 'topic',
      options: [
        { id: 'email', title: 'Email', description: 'Read, sort and draft replies', icon: { icon: 'mail' } },
        {
          id: 'calendar',
          title: 'Calendar',
          description: 'Your day and your meetings',
          icon: { icon: 'calendar' },
        },
        { id: 'files', title: 'Files', description: 'Drive, Docs and Sheets', icon: { icon: 'folder' } },
      ],
    },
    { type: 'actions', actions: [{ id: 'later', label: 'Maybe later', style: 'quiet' }] },
  ],
});

/** The provider choice (AG-05) with the brand logos (AG-16); Microsoft and IMAP are “Coming soon”. */
export const guideProvider = guide({
  guide: 'email',
  node: 'provider',
  title: 'Which email do you use?',
  body: 'I’ll guide you through it. You only do this once; after that it keeps working.',
  blocks: [
    {
      type: 'choices',
      id: 'provider',
      options: [
        {
          id: 'google',
          title: 'Google',
          description: 'Gmail or Google Workspace. I can also use your calendar and files if you like.',
          icon: { brand: 'google' },
        },
        {
          id: 'microsoft',
          title: 'Microsoft 365',
          description: 'Outlook and Exchange',
          icon: { brand: 'microsoft' },
          badge: { label: 'Coming soon' },
          disabled: true,
        },
        {
          id: 'imap',
          title: 'Other email',
          description: 'Any provider with IMAP',
          icon: { brand: 'mail' },
          badge: { label: 'Coming soon' },
          disabled: true,
        },
      ],
    },
  ],
});

/** The same card once Google was picked: locked, the answer quietly below. */
export const guideProviderDone: GuideCard = {
  ...guideProvider,
  state: 'done',
  answer: { actionId: 'provider', optionIds: ['google'], label: 'Google', at: at('14:02') },
};

/** The app guide, step 4 of 6 (AG-06): a value to copy, the console link, next and “I’m stuck”. */
export const guideAppStep = guide({
  guide: 'google_app',
  node: 'step_4',
  step: { index: 4, total: 6 },
  title: 'Create the OAuth client',
  body: 'Create a client of type Web application. Under Authorized redirect URIs, add this URI exactly.',
  blocks: [
    {
      type: 'copy',
      rows: [
        { label: 'Redirect URI', value: 'https://app.whombat.com/connect/google' },
        { label: 'Application type', value: 'Web application' },
      ],
    },
    {
      type: 'links',
      links: [{ label: 'Create the client', url: 'https://console.cloud.google.com/auth/clients/create' }],
    },
    {
      type: 'actions',
      actions: [
        { id: 'next', label: 'Done, next step', style: 'primary' },
        { id: 'stuck', label: 'I’m stuck', style: 'quiet' },
      ],
    },
  ],
});

/** Step 5 of 6: the secure form (Client ID, secret, or the downloaded JSON). */
export const guideAppForm = guide({
  guide: 'google_app',
  node: 'step_5',
  step: { index: 5, total: 6 },
  title: 'Paste the Client ID and secret',
  body: 'Paste them from the client’s page in Google Cloud, or drop the client_secret JSON you downloaded. It’s read here in your browser and saved on your Whombat, never in this chat.',
  blocks: [
    {
      type: 'form',
      id: 'client',
      fields: [
        {
          id: 'clientId',
          label: 'Client ID',
          kind: 'text',
          placeholder: '1234567890-abc.apps.googleusercontent.com',
        },
        { id: 'clientSecret', label: 'Client secret', kind: 'secret', placeholder: 'GOCSPX-…' },
        { id: 'file', label: 'Or the JSON file', kind: 'json_file', optional: true },
      ],
      submitLabel: 'Save',
    },
    { type: 'actions', actions: [{ id: 'stuck', label: 'I’m stuck', style: 'quiet' }] },
  ],
});

/** The form after saving: the server's words, never the secret. */
export const guideAppFormDone: GuideCard = {
  ...guideAppForm,
  state: 'done',
  answer: { actionId: 'client', optionIds: null, label: 'Client ID 1234567890ab… saved', at: at('14:09') },
};

/** Step 6 of 6 and every connect topic: Connect Google with the services ticked (CN-04). */
export const guideConnect = guide({
  guide: 'email',
  node: 'connect',
  title: 'Connect your Google account',
  body: 'Google will ask you to allow access. Everything stays ticked unless you want less; you can change it later in Settings → Connections.',
  blocks: [
    {
      type: 'connect',
      provider: 'google',
      services: ['mail', 'calendar', 'files', 'docs', 'sheets', 'contacts'],
      returnTo: CHAT_RETURN,
    },
  ],
});

/** Back from Google (AG-08): one status row per service, one needs an API turned on. */
export const guideResult = guide({
  guide: 'email',
  node: 'result',
  title: 'Google connected · mara@example.com',
  body: 'Done. I can now read and draft your email, see your calendar and find your files. I’ll always ask before I send anything or change your calendar.',
  state: 'done',
  blocks: [
    {
      type: 'status',
      rows: [
        { label: 'Gmail', state: 'ok', detail: 'Working' },
        { label: 'Google Calendar', state: 'ok', detail: 'Working' },
        {
          label: 'Google Drive',
          state: 'warn',
          detail: 'API turned off in your Google project · Turn it on',
          href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
        },
        { label: 'Google Contacts', state: 'mut', detail: null },
      ],
    },
  ],
});

/** A guide's multi choice: tick several, then save. No mock draws one. */
export const guideMulti = guide({
  guide: 'email',
  node: 'contents',
  title: 'What should I keep an eye on?',
  body: 'Pick as many as you like.',
  blocks: [
    {
      type: 'choices',
      id: 'contents',
      mode: 'multi',
      submitLabel: 'Save',
      options: [
        { id: 'mail', title: 'New mail', description: 'Needs-reply first', icon: { icon: 'mail' } },
        {
          id: 'calendar',
          title: 'Today’s meetings',
          description: 'With who and where',
          icon: { icon: 'calendar' },
        },
        {
          id: 'files',
          title: 'Shared files',
          description: 'Changed since yesterday',
          icon: { icon: 'file-text' },
        },
      ],
    },
    { type: 'actions', actions: [{ id: 'no', label: 'No thanks', style: 'quiet' }] },
  ],
});

/** A suggestion nobody answered for 7 days (AG-11). */
export const guideExpired: GuideCard = {
  ...guide({
    guide: 'email',
    node: 'suggest',
    title: 'Quick idea',
    body: 'I could keep an eye on your inbox and draft replies for you. Want to connect your email? It takes about a minute.',
    blocks: [
      {
        type: 'actions',
        actions: [
          { id: 'yes', label: 'Set it up', style: 'primary' },
          { id: 'not_now', label: 'Not now', style: 'secondary' },
          { id: 'never', label: 'Don’t ask again', style: 'quiet' },
        ],
      },
    ],
  }),
  state: 'expired',
};

/* Feature request (3.12) ------------------------------------------------------------------------------------------ */

const [featureWaiting, featureDeclined] = featureRequestViews() as [FeatureRequestView, FeatureRequestView];

/** A tracker customer's request waiting for the person: 7 of 10, both drafts, Approve and build. */
export const featureRequestWaiting: MessageCard = {
  kind: 'feature_request',
  requestId: featureWaiting.id,
  request: featureWaiting,
};

/** One the person declined with their own reason: a line that opens the card. */
export const featureRequestDecided: MessageCard = {
  kind: 'feature_request',
  requestId: featureDeclined.id,
  request: featureDeclined,
};

/** The “October release notes” plan of the delegation fixture world (`createWorkFixtures({ handoffs: true })`). */

/** Named card states for the gallery (stories, visual harness). */
export const CARD_STATES = {
  plan: { kind: 'plan', plan: planNow },
  'plan-all-markers': { kind: 'plan', plan: planAllMarkers },
  'plan-deployed': { kind: 'plan', plan: planDeployed },
  'plan-go-ahead': { kind: 'plan', plan: planGoAhead },
  /** Handoffs (delegation DG-17, AP-168): done with a report, declined, working, a person's; no mock draws them. */
  research,
  run: { kind: 'run', run: runLive },
  'run-done': { kind: 'run', run: runDone },
  'run-paused': { kind: 'run', run: runPaused },
  'run-failed': { kind: 'run', run: runFailed },
  'run-taken-over': { kind: 'run', run: runTakenOver },
  'run-line': { kind: 'run', run: runLineLive },
  'run-line-done': { kind: 'run', run: runLineDone },
  'run-line-attention': {
    kind: 'run',
    run: { ...runLineLive, attention: 'Neo stopped without finishing this run.' },
  },
  'run-line-failed': { kind: 'run', run: runLineFailed },
  review,
  approval: { kind: 'approval', approval: approvalPending },
  'approval-ready': { kind: 'approval', approval: approvalReady },
  'approval-waiting': { kind: 'approval', approval: approvalWaiting },
  'approval-waiting-review': { kind: 'approval', approval: approvalWaitingReview },
  'approval-deploying': { kind: 'approval', approval: approvalDeploying },
  'approval-deployed': { kind: 'approval', approval: approvalDeployed },
  'approval-failed': { kind: 'approval', approval: approvalFailed },
  'approval-declined': { kind: 'approval', approval: approvalDeclined },
  'approval-ask': { kind: 'approval', approval: approvalAsk },
  commits,
  pill,
  answer: answerSearch,
  'answer-dm': answerDm,
  'answer-thread': answerThread,
  'answer-long': answerLong,
  digest,
  report: reportAssessed,
  'report-queued': reportQueuedCard,
  'report-failed': reportFailedCard,
  'report-removed': reportRemovedCard,
  'report-feature': reportFeatureCard,
  'guide-welcome': guideWelcome,
  'guide-provider': guideProvider,
  'guide-provider-done': guideProviderDone,
  'guide-app-step': guideAppStep,
  'guide-form': guideAppForm,
  'guide-form-done': guideAppFormDone,
  'guide-connect': guideConnect,
  'guide-result': guideResult,
  'guide-multi': guideMulti,
  'guide-expired': guideExpired,
  'feature-request': featureRequestWaiting,
  'feature-request-decided': featureRequestDecided,
} satisfies Record<string, MessageCard>;

export type CardStateName = keyof typeof CARD_STATES;
