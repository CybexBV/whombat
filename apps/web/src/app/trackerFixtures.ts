/**
 * A made-up report tracker in fixture mode, Acme Desk (docs/decisions/report-trackers.md): the burrow's two Acme Desk
 * connections (“Acme Desk dev” and “Acme Desk”, as the connections catalog's fixtures have them), the reports Try it
 * offers, and the reports three runs of “Assess new reports in Acme Desk dev” started from — with a reporter, a
 * screenshot and a conversation — which `tracker.item` reads and `tracker.update` answers (a reply and a status,
 * replayed for a known request id as a tracker does). Report #17 is a bug below the fixing threshold that the agent suggests fixing anyway (0.71,
 * automation-recipes.md AP-1056); the agent answered its customer, signed (0.75, AP-1113). Report #15's fix is live on
 * development and waits for production (TA-29). Two customers' feature requests were put to Mara (3.12):
 * #21 waits for her answer, #19 she declined. Served by `automationFixtures.ts`.
 */
import type {
  AutomationAssessmentInput,
  ConnectionView,
  FeatureRequestView,
  TrackerItemView,
  TrackerWords,
} from '@whombat/core';
import {
  assessmentLine,
  assessmentOffer,
  assessmentQuestion,
  customerSignature,
  signedReply,
} from '@whombat/core';
import type { AutomationReportSample } from '@whombat/core/contracts';
import { at, mara } from '@whombat/fixtures';
import { ASSISTANT_NAME } from './oneFixtures';

/** The ids and labels `catalogFixtures.ts` gives them too. */
export const TRACKER_DEV = 'con_fixture_tracker';
export const TRACKER_PROD = 'con_fixture_tracker_prod';

/** What the made-up tracker's driver calls it (`acme-desk`, the connections' `driver`). */
export const TRACKER_WORDS: TrackerWords = { product: 'Acme Desk', team: 'Acme team' };
export const TRACKER_DRIVER = 'acme-desk';
export const TRACKER_DEV_URL = 'https://dev.desk.acme.example';
export const TRACKER_PROD_URL = 'https://desk.acme.example';

function connection(id: string, label: string, handle: string, url: string): ConnectionView {
  return {
    id,
    catalogId: 'tracker',
    label,
    handle,
    connectedBy: { id: mara.id, name: mara.name },
    detail: new URL(url).host,
    signIn: 'token',
    transport: 'rest',
    fields: { url, driver: TRACKER_DRIVER },
    status: 'active',
    reauthReason: null,
    checks: [{ id: 'credential', state: 'ok', message: null }],
    checkedAt: at('09:00'),
    toolCount: 0,
    access: 'manage',
    poller: null,
    createdAt: at('09:00', -3),
    lastUsedAt: at('11:20'),
  };
}

/** `connections.list` when no other fixture layer serves it: the two Acme Desk connections. */
export const TRACKER_CONNECTIONS: ConnectionView[] = [
  connection(TRACKER_DEV, 'Acme Desk dev', 'tracker', TRACKER_DEV_URL),
  connection(TRACKER_PROD, 'Acme Desk', 'tracker-2', TRACKER_PROD_URL),
];

export const trackerConnectionLabel = (id: string) => TRACKER_CONNECTIONS.find((c) => c.id === id)?.label;

/** The reports' ids in the tracker (UUIDs; people say their numbers). */
export const REPORT_ID = {
  17: 'd4e6a8c0-2b4d-4f6a-8c0e-1a3b5c7d9e17',
  16: '3c0f6a52-7a1e-4d1b-9a35-0b6e2c7d4f16',
  15: '6f1c2a10-3b4d-4c5e-8f60-71a2b3c4d515',
  14: '9a7e1d33-5c2b-4f0a-8e19-2d4c6b8a0e14',
  13: 'b2d4f6a8-1c3e-4a5b-9d7f-0e2c4a6b8d13',
} as const;

/** What Try it offers on Acme Desk dev (TA-19): its open reports, newest first. */
export const TRACKER_SAMPLES: AutomationReportSample[] = [
  {
    kind: 'report',
    connectionId: TRACKER_DEV,
    reportId: REPORT_ID[16],
    number: 16,
    title: 'Can’t add a second administrator',
    type: 'bug',
    organization: 'Noordhoek Logistics',
    openedAt: at('11:31'),
  },
  {
    kind: 'report',
    connectionId: TRACKER_DEV,
    reportId: REPORT_ID[15],
    number: 15,
    title: 'The rollout never finishes',
    type: 'bug',
    organization: 'HollowMere College',
    openedAt: at('10:52'),
  },
  {
    kind: 'report',
    connectionId: TRACKER_DEV,
    reportId: REPORT_ID[13],
    number: 13,
    title: 'Export the device list as CSV',
    type: 'feature',
    organization: 'HollowMere College',
    openedAt: at('16:05', -1),
  },
];

/** A browser screenshot of the stuck rollout, drawn (fixture mode loads nothing from outside). */
const SCREENSHOT = `data:image/svg+xml;utf8,${encodeURIComponent(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">',
    '<rect width="960" height="540" fill="#f4f5f7"/>',
    '<rect width="960" height="44" fill="#0e0f12"/>',
    '<circle cx="24" cy="22" r="6" fill="#dd0034"/>',
    '<text x="44" y="27" font-family="sans-serif" font-size="14" fill="#ffffff">Acme Desk · Deployments</text>',
    '<text x="40" y="96" font-family="sans-serif" font-size="22" font-weight="600" fill="#15171c">Rollout 0.1.131 to Lab A</text>',
    '<text x="40" y="126" font-family="sans-serif" font-size="14" fill="#5b616e">11 of 12 devices updated · started 41 minutes ago</text>',
    '<rect x="40" y="150" width="880" height="14" rx="7" fill="#dfe2e8"/>',
    '<rect x="40" y="150" width="806" height="14" rx="7" fill="#2f6fde"/>',
    '<rect x="40" y="196" width="880" height="56" rx="10" fill="#ffffff" stroke="#dfe2e8"/>',
    '<text x="60" y="230" font-family="sans-serif" font-size="15" fill="#15171c">LAB-A-07 · Waiting for device…</text>',
    '<text x="780" y="230" font-family="sans-serif" font-size="14" fill="#b26b00">Pending</text>',
    '</svg>',
  ].join(''),
)}`;

/** The reports three runs started from, as `tracker.item` reads them; keyed by the run's id. */
export function trackerItemsByRun(): Map<string, TrackerItemView> {
  return new Map<string, TrackerItemView>([
    [
      'arn_49',
      {
        connectionId: TRACKER_DEV,
        connection: 'Acme Desk dev',
        words: TRACKER_WORDS,
        reportId: REPORT_ID[17],
        number: 17,
        title: 'Diagnostics are hard to read',
        type: 'bug',
        organization: 'Noordhoek Logistics',
        environment: 'production',
        status: 'investigating',
        priority: 'normal',
        assessment: 'likely_bug',
        createdAt: at('10:59'),
        reporter: { name: 'Joost Brink', email: 'j.brink@noordhoek.example' },
        description:
          'When a device has a problem I open its Diagnostics, but they start with the oldest event and every event takes a few lines. I have to scroll for a long time before I see what happened today.',
        expected: 'The latest events first, so I can see what is wrong right away.',
        screenshot: null,
        // The agent's answer (0.75): the tracker shows it as the team's.
        messages: [{ author: 'team', body: REPLY_17, at: at('11:04') }],
        release: null,
        fix: null,
      },
    ],
    [
      'arn_46',
      {
        connectionId: TRACKER_DEV,
        connection: 'Acme Desk dev',
        words: TRACKER_WORDS,
        reportId: REPORT_ID[15],
        number: 15,
        title: 'The rollout never finishes',
        type: 'bug',
        organization: 'HollowMere College',
        environment: 'production',
        status: 'investigating',
        priority: 'high',
        assessment: 'likely_bug',
        createdAt: at('10:52'),
        reporter: { name: 'Anna de Vries', email: 'a.devries@hollowmere.example' },
        description:
          'We started the 0.1.131 rollout to Lab A this morning. Eleven devices updated within ten minutes, but LAB-A-07 has said “Waiting for device…” for over half an hour now, and the rollout stays at 11 of 12. The device is on and connected: we can log in to it.',
        expected: 'The rollout finishes, or tells us what is wrong with LAB-A-07.',
        screenshot: SCREENSHOT,
        messages: [
          {
            author: 'reporter',
            body: 'It is still at 11 of 12. LAB-A-07 restarted on its own at 11:20, but nothing changed.',
            at: at('11:24'),
          },
        ],
        release: null,
        // A production report fixed in development (0.75, TA-30): live there, waiting for production's next update.
        fix: {
          state: 'development',
          repo: 'whombat/web',
          prNumber: 52,
          prUrl: 'https://github.com/whombat/web/pull/52',
          mergedAt: at('11:40'),
          development: { host: new URL(TRACKER_DEV_URL).host, version: '0.1.176', at: at('11:52') },
          production: null,
          note: null,
        },
      },
    ],
    [
      'arn_45',
      {
        connectionId: TRACKER_DEV,
        connection: 'Acme Desk dev',
        words: TRACKER_WORDS,
        reportId: REPORT_ID[14],
        number: 14,
        title: 'The dashboard shows yesterday’s date',
        type: 'bug',
        organization: 'Noordhoek Logistics',
        environment: 'production',
        status: 'needs_information',
        priority: null,
        assessment: null,
        createdAt: at('08:12'),
        reporter: { name: 'Joost Brink', email: null },
        description: 'Every morning until about ten the dashboard says it is still yesterday.',
        expected: '',
        screenshot: null,
        messages: [
          {
            author: 'team',
            body: 'Thanks, Joost. Could you check the time zone under Organization → Settings? It may still be set to UTC−10.',
            at: at('09:40'),
          },
        ],
        release: null,
        fix: null,
      },
    ],
  ]);
}

/** A report a test run started from (Try it): what the tracker would say about it. */
export function sampleReport(sample: AutomationReportSample): TrackerItemView {
  return {
    connectionId: sample.connectionId,
    connection: trackerConnectionLabel(sample.connectionId) ?? TRACKER_WORDS.product,
    words: TRACKER_WORDS,
    reportId: sample.reportId,
    number: sample.number,
    title: sample.title,
    type: sample.type,
    organization: sample.organization,
    environment: 'production',
    status: 'new',
    priority: null,
    assessment: null,
    createdAt: sample.openedAt,
    reporter: { name: 'Sanne Visser', email: 's.visser@example.org' },
    description: `${sample.title}. It happens every time, on every device we tried.`,
    expected: '',
    screenshot: null,
    messages: [],
    release: null,
    fix: null,
  };
}

/**
 * An assessment as an agent step's output carries it: the fields, its `line`, and (0.71) the card's `question` and
 * `offer` the server adds.
 */
function assessed(a: AutomationAssessmentInput) {
  const full = {
    fixPlan: '',
    title: '',
    details: '',
    duplicateOf: null,
    reply: '',
    replyAsks: false,
    language: '',
    value: null,
    valueWhy: '',
    approvedReply: '',
    declineReason: '',
    declinedReply: '',
    ...a,
  };
  return {
    ...full,
    line: assessmentLine(full),
    question: assessmentQuestion(full),
    offer: assessmentOffer(full),
  };
}

/** The agent on report #15: a bug of high importance (written back as Likely bug · high priority). */
export const ASSESSMENT_15 = assessed({
  kind: 'bug',
  importance: 'high',
  confidence: 'medium',
  size: 'small',
  recommends: 'change',
  summary:
    'A device that restarts during a rollout is never asked again, so the rollout waits for it forever.',
  fixPlan: 'Re-queue a device whose session ends mid-rollout, in console/rollouts/queue.ts, with a test.',
  details:
    '- `nextDevice()` in `console/rollouts/queue.ts:72–90` skips devices marked `in_flight`, and nothing clears the mark when a device reconnects.\n- In HollowMere College’s audit, LAB-A-07 reconnected at 11:20 with the old version; the rollout still lists it as in flight.\n- To check: `pnpm test rollouts` passes today; a test that drops a session mid-rollout would fail.',
});
export const ANSWER_15 =
  'This is a bug: when a device restarts in the middle of a rollout, Acme Desk never asks it again, so the rollout waits for it forever. The other eleven devices are fine. Restarting the rollout for LAB-A-07 gets them going today; the fix is small.';

/** The agent on report #14: not a bug (the organization's time zone). */
export const ASSESSMENT_14 = assessed({
  kind: 'not_a_bug',
  importance: 'low',
  confidence: 'high',
  size: 'small',
  recommends: 'nothing',
  summary:
    'The organization’s time zone is set to UTC−10, so the dashboard’s day starts ten hours late; nothing is wrong in Acme Desk.',
  details:
    '- Noordhoek Logistics’s settings have `timeZone: Pacific/Honolulu` since 2 October (its audit: changed by an administrator).\n- The dashboard dates days in the organization’s zone (`console/dashboard/day.ts:14`).',
});
export const ANSWER_14 =
  'This isn’t a bug: the organization’s time zone is set to Hawaii, so the dashboard starts a new day ten hours late. Setting it to Amsterdam under Organization → Settings fixes it; nothing needs to change in Acme Desk.';

/** How the agent signs what a customer reads (0.75, TA-26): its name. */
export const AGENT_SIGNATURE = customerSignature(ASSISTANT_NAME);

/** What the agent told report #17's customer (0.75, AP-1113): what it found in their terms, no promise, unsigned. */
const REPLY_17_TEXT =
  'Thanks for letting us know. You’re right that Diagnostics start with the oldest events and take a lot of room, so the latest problem is hard to find. We’ve suggested showing the newest events first in a compact list, and we’ll let you know here what happens next.';

/** The reply as the tracker got it and emailed it: signed. */
export const REPLY_17 = signedReply(REPLY_17_TEXT, AGENT_SIGNATURE);

/**
^ * The agent on report #17 (0.71, AP-1056; after John's report of 2026-10-10): a usability bug of medium importance, below the
 * automation's “high or more”, and the agent suggests fixing it anyway — so the card asks. Since 0.75 it answers the
 * customer too (AP-1113).
 */
export const ASSESSMENT_17 = assessed({
  kind: 'bug',
  importance: 'medium',
  confidence: 'high',
  size: 'small',
  recommends: 'change',
  summary:
    'A device’s Diagnostics start with the oldest event and give each a few lines, so the latest problem is a long scroll away.',
  fixPlan:
    'Show Diagnostics newest first, one compact line per event with its details on click, in console/devices/Diagnostics.tsx, with tests.',
  reply: REPLY_17_TEXT,
  language: 'en',
  details:
    '- `DiagnosticsList` in `console/devices/Diagnostics.tsx:41–77` sorts events by `occurredAt` ascending and draws each as a card of three to five lines.\n- Noordhoek Logistics’s LAB-B-02 has 1,284 events; the newest is at the bottom of the page.\n- To check: `pnpm test devices` passes today; a test that the newest event comes first would fail.',
});
export const ANSWER_17 =
  'This is a usability problem rather than something broken: Diagnostics start with the oldest events and take a lot of room, so the latest problem is hard to find. I suggest showing the newest events first in a compact list. It’s a small change.';

/* Feature requests put to the person (3.12) --------------------------------------------------------------------- */

/** Their ids, and the reports they are about. */
export const FEATURE_REQUEST_IDS = { waiting: 'tfr_report-21', decided: 'tfr_report-19' } as const;

/**
 * The cards' requests, fresh for each world: report #21, scored 7, with both drafts and Approve and build, waits for
 * Mara; report #19, scored 3, she declined with her own reason.
 */
export function featureRequestViews(): FeatureRequestView[] {
  const base = {
    automationId: 'aut_tracker-dev',
    connection: 'Acme Desk dev',
    agent: ASSISTANT_NAME,
    canBuild: true,
    choice: null,
    note: null,
    decidedById: null,
    decidedAt: null,
  } as const;
  return [
    {
      ...base,
      id: FEATURE_REQUEST_IDS.waiting,
      runId: 'arn_50',
      number: 21,
      title: 'Choose when a rollout starts',
      organization: 'HollowMere College',
      value: 7,
      valueWhy:
        'Three other schools asked for this in the last month, and it saves each of them an evening at work. It’s a small change: a rollout already has a start time.',
      summary:
        'They want to choose when a rollout starts, so devices update after school instead of during lessons.',
      importance: 'medium',
      size: 'small',
      approvedMessage: signedReply(
        'Thanks for the suggestion, it’s a good one. We’re going to build it: you’ll be able to choose when a rollout starts.\n\nWe’ll let you know here when it’s ready.',
        AGENT_SIGNATURE,
      ),
      declinedMessage: signedReply(
        'Thanks for the suggestion. We won’t build this for now: we’re making rollouts faster first.\n\nUntil then you can start a rollout yourself after school.',
        AGENT_SIGNATURE,
      ),
      declineReason: 'We’re making rollouts faster first.',
      state: 'waiting',
      createdAt: at('11:26'),
    },
    {
      ...base,
      id: FEATURE_REQUEST_IDS.decided,
      runId: 'arn_51',
      number: 19,
      title: 'A dark theme for the console',
      organization: 'Noordhoek Logistics',
      value: 3,
      valueWhy: 'Only this customer asked for it, and it changes every screen.',
      summary: 'They want the console in dark colours for the night shift.',
      importance: 'low',
      size: 'large',
      approvedMessage: signedReply(
        'Thanks for the suggestion. We’re going to build a dark theme, and we’ll let you know here when it’s ready.',
        AGENT_SIGNATURE,
      ),
      declinedMessage: signedReply(
        'Thanks for the suggestion. We won’t build a dark theme for now: it changes every screen, and few people have asked for it.',
        AGENT_SIGNATURE,
      ),
      declineReason: 'It changes every screen and few people asked for it.',
      state: 'decided',
      choice: 'decline',
      note: 'It only helps one customer for now.',
      decidedById: mara.id,
      decidedAt: at('10:14'),
      createdAt: at('10:05'),
    },
  ];
}
