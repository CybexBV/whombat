import { ApiError, NetworkError } from '@whombat/client';
import { type TrackerItemView, TrackerUpdateBody, UNKNOWN_TRACKER_WORDS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  environmentWords,
  initialStatus,
  replyDoneText,
  replyProblem,
  replyStatusChoices,
  screenshotOf,
  statusChoices,
  statusDoneText,
  statusProblem,
  TRACKER_ITEM_TEXT,
  trackerItemErrorText,
  trackerItemModel,
  trackerRequest,
  trackerSend,
} from './trackerItem';

const NOW = new Date('2026-10-09T10:00:00.000Z');
const TZ = 'Europe/Amsterdam';
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const ACME = { product: 'Acme Desk', team: 'Acme team' };
const BEACON = { product: 'Beacon Helpdesk', team: 'Beacon support' };

const report = (over: Partial<TrackerItemView> = {}): TrackerItemView => ({
  connectionId: 'con_tracker-dev',
  connection: 'Acme Desk dev',
  words: ACME,
  reportId: '0f9c2a4e-7b1d-4c3e-9a55-2d8e6f1b3c70',
  number: 15,
  title: 'The rollout never finishes',
  type: 'bug',
  organization: 'HollowMere College',
  environment: 'production',
  status: 'investigating',
  priority: 'high',
  assessment: 'likely_bug',
  createdAt: '2026-10-09T07:12:00.000Z',
  reporter: { name: 'Anna de Vries', email: 'anna@hollowmere.example' },
  description: 'The rollout stays at 93% on the third till.',
  expected: 'All tills updated within ten minutes.',
  screenshot: PNG,
  messages: [],
  release: null,
  fix: null,
  ...over,
});

const model = (over: Partial<TrackerItemView> = {}, update = true) =>
  trackerItemModel(report(over), { update }, NOW, TZ);

describe('the report on the run page (TA-14)', () => {
  it('heads it with its number and title, then where it came from', () => {
    const m = model();
    expect(m.heading).toBe('#15 · The rollout never finishes');
    expect(m.place).toBe('Acme Desk dev · HollowMere College · Production');
    expect(m.context).toBe('Acme Desk dev #15 · The rollout never finishes');
    expect(m.canUpdate).toBe(true);
    expect(model({}, false).canUpdate).toBe(false);
  });

  it('leaves out the organization and the environment it doesn’t know', () => {
    expect(model({ organization: null }).place).toBe('Acme Desk dev · Production');
    expect(model({ environment: null }).place).toBe('Acme Desk dev · HollowMere College');
    expect(model({ organization: null, environment: null }).place).toBe('Acme Desk dev');
    expect(model({ environment: 'development' }).place).toBe(
      'Acme Desk dev · HollowMere College · Development',
    );
    expect(environmentWords('staging')).toBe('Staging');
    expect(environmentWords('on_premises')).toBe('On premises');
    expect(environmentWords('  ')).toBeNull();
  });

  it('tags the type first, the status, the priority and the assessment', () => {
    expect(model().tags).toEqual(['Bug report', 'Investigating', 'High priority', 'Likely bug']);
    expect(
      model({ type: 'feature', priority: null, assessment: null, status: 'awaiting_release' }).tags,
    ).toEqual(['Feature request', 'Fixed, waiting for a release']);
    expect(model({ priority: 'urgent', assessment: null }).tags).toEqual([
      'Bug report',
      'Investigating',
      'Urgent priority',
    ]);
    expect(model({ priority: null, assessment: 'needs_information', status: 'on_hold' }).tags).toEqual([
      'Bug report',
      'On hold',
      'Needs information',
    ]);
    expect(model().accessibilityLabel).toBe(
      '#15 · The rollout never finishes. Acme Desk dev · HollowMere College · Production. Bug report, Investigating, High priority, Likely bug.',
    );
  });

  it('names the reporter as far as the tracker knows them', () => {
    expect(model().reporter).toBe('Anna de Vries · anna@hollowmere.example');
    expect(model({ reporter: { name: 'Anna de Vries', email: null } }).reporter).toBe('Anna de Vries');
    expect(model({ reporter: { name: null, email: 'anna@hollowmere.example' } }).reporter).toBe(
      'anna@hollowmere.example',
    );
    expect(model({ reporter: { name: ' ', email: null } }).reporter).toBe('Not given');
  });

  it('shows what they wrote as they wrote it, and what’s missing in words', () => {
    const m = model();
    expect(m.filed).toBe('09:12');
    expect(m.description).toBe('The rollout stays at 93% on the third till.');
    expect(m.expected).toBe('All tills updated within ten minutes.');
    const empty = model({ description: ' ', expected: '' });
    expect(empty.description).toBe('Nothing written.');
    expect(empty.expected).toBeNull();
    // Markdown and links stay text: nothing is parsed.
    expect(model({ description: '**Broken** — see [this](https://evil.example)' }).description).toBe(
      '**Broken** — see [this](https://evil.example)',
    );
  });

  it('shows a raster screenshot, and leaves out none or anything else', () => {
    expect(model().screenshot).toBe(PNG);
    expect(model({ screenshot: null }).screenshot).toBeNull();
    expect(screenshotOf('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull();
    expect(screenshotOf('https://tracker.example/shot.png')).toBeNull();
    expect(screenshotOf('data:image/jpeg;base64,/9j/4AAQ')).toBe('data:image/jpeg;base64,/9j/4AAQ');
  });

  it('shows the conversation oldest first, by who wrote it', () => {
    const m = model({
      messages: [
        { author: 'team', body: 'We’re looking into it.', at: '2026-10-09T08:40:00.000Z' },
        { author: 'reporter', body: 'It happened again on till 4.', at: '2026-10-09T08:05:00.000Z' },
      ],
    });
    expect(m.messages.map((x) => [x.author, x.time, x.body])).toEqual([
      ['The reporter', '10:05', 'It happened again on till 4.'],
      ['Acme team', '10:40', 'We’re looking into it.'],
    ]);
    expect(m.messages[0]?.accessibilityLabel).toBe('The reporter, 10:05: It happened again on till 4.');
    expect(model().messages).toEqual([]);
    expect(TRACKER_ITEM_TEXT.noReplies).toBe('No replies yet.');
  });

  it('says which release fixed it', () => {
    expect(model().release).toBeNull();
    expect(
      model({ release: { component: 'Acme Agent', version: '4.2.1', evidence: 'Fixed in #212' } }).release,
    ).toBe('Released in Acme Agent 4.2.1.');
  });

  it('names the tracker and its team in the words it is given', () => {
    const m = model({
      messages: [{ author: 'team', body: 'Thanks.', at: '2026-10-09T08:40:00.000Z' }],
    });
    expect(m.messages[0]?.author).toBe('Acme team');
    expect(m.emails).toMatch(/^Acme Desk emails/);
    expect(m.replyNote).toContain('“Acme team”');
    expect(m.statusNote).toMatch(/^Acme Desk emails/);
    const beacon = model({
      words: BEACON,
      messages: [{ author: 'team', body: 'Thanks.', at: '2026-10-09T08:40:00.000Z' }],
    });
    expect(beacon.messages[0]?.author).toBe('Beacon support');
    expect([beacon.emails, beacon.replyNote, beacon.statusNote].join(' ')).not.toContain('Acme');
    expect(beacon.emails).toMatch(/^Beacon Helpdesk emails/);
    // A tracker whose driver isn't known reads plainly.
    const plain = model({ words: UNKNOWN_TRACKER_WORDS });
    expect(plain.emails).toMatch(/^The tracker emails/);
    expect(plain.replyNote).not.toMatch(/the the/i);
  });

  it('says why it didn’t load in the server’s words when there are some', () => {
    const refused = new ApiError(
      502,
      'unknown',
      'Acme Desk didn’t answer.',
      { error: { code: 'tracker_unavailable', message: 'Acme Desk didn’t answer.' } },
      'tracker.item',
    );
    expect(trackerItemErrorText(refused, ACME)).toBe(
      'Couldn’t read the report from Acme Desk: Acme Desk didn’t answer.',
    );
    const unstopped = new ApiError(
      409,
      'conflict',
      'The report moved on in Acme Desk',
      { error: { code: 'conflict', message: 'The report moved on in Acme Desk' } },
      'tracker.item',
    );
    expect(trackerItemErrorText(unstopped, ACME)).toBe(
      'Couldn’t read the report from Acme Desk: The report moved on in Acme Desk.',
    );
    // The client's own words for a body without the server's are no message to show.
    const bare = new ApiError(502, 'unknown', 'Request failed with status 502', '<html>', 'tracker.item');
    expect(trackerItemErrorText(bare, BEACON)).toBe(
      'Couldn’t read the report from Beacon Helpdesk. Try again in a moment.',
    );
    expect(trackerItemErrorText(new NetworkError('tracker.item', new Error('offline')))).toBe(
      'Couldn’t read the report from the tracker. Try again in a moment.',
    );
  });
});

describe('Reply to the reporter (TA-15)', () => {
  it('offers to leave the status, then the seven a person sets', () => {
    expect(replyStatusChoices('new').map((c) => c.label)).toEqual([
      'Leave it at New',
      'Investigating',
      'Needs information',
      'Planned',
      'In progress',
      'Fixed, waiting for a release',
      'Closed',
      'Not planned',
    ]);
    expect(replyStatusChoices('investigating')[0]).toEqual({
      value: null,
      label: 'Leave it at Investigating',
    });
  });

  it('needs a reply', () => {
    expect(replyProblem('  ')).toEqual({ field: 'message', text: 'Write a reply.' });
    expect(replyProblem('We found it.')).toBeNull();
  });

  it('sends the reply trimmed, the status only when one is chosen, and says what went', () => {
    expect(trackerSend('  We found it.\n', null)).toEqual({ message: 'We found it.' });
    expect(trackerSend('We found it.', 'in_progress')).toEqual({
      message: 'We found it.',
      status: 'in_progress',
    });
    expect(replyDoneText({ message: 'We found it.' })).toBe('Sent to the reporter.');
    expect(replyDoneText({ message: 'We found it.', status: 'awaiting_release' })).toBe(
      'Sent to the reporter, and set to Fixed, waiting for a release.',
    );
  });
});

describe('Set the status (TA-15)', () => {
  it('offers the seven in the contract’s order, on the current one when it is one of them', () => {
    expect(statusChoices().map((c) => c.value)).toEqual([
      'investigating',
      'needs_information',
      'planned',
      'in_progress',
      'awaiting_release',
      'closed',
      'not_planned',
    ]);
    expect(initialStatus('in_progress')).toBe('in_progress');
    expect(initialStatus('new')).toBeNull();
    expect(initialStatus('available')).toBeNull();
  });

  it('needs a status, a change or a reply, and a reason when it isn’t planned', () => {
    expect(statusProblem('new', null, '')).toEqual({ field: 'status', text: 'Choose a status.' });
    expect(statusProblem('investigating', 'investigating', ' ')).toEqual({
      field: 'status',
      text: 'It’s Investigating already.',
    });
    expect(statusProblem('investigating', 'investigating', 'Still on it.')).toBeNull();
    expect(statusProblem('investigating', 'not_planned', '')).toEqual({
      field: 'message',
      text: 'Tell the reporter why when it isn’t planned: write a reply.',
    });
    expect(statusProblem('investigating', 'not_planned', 'It works as designed.')).toBeNull();
    expect(statusProblem('new', 'planned', '')).toBeNull();
  });

  it('says what changed, and that the reply went too', () => {
    expect(statusDoneText(trackerSend('', 'in_progress'))).toBe('Set to In progress.');
    expect(statusDoneText(trackerSend('We’re on it.', 'in_progress'))).toBe(
      'Set to In progress. Your reply was sent.',
    );
  });

  it('sends what the contract takes', () => {
    const send = trackerSend('', 'closed');
    expect(send).toEqual({ status: 'closed' });
    const body = { requestId: '6f1d5a0e-2b7c-4e3a-8d91-0c4b5e6f7a81', ...send };
    expect(TrackerUpdateBody.safeParse(body).success).toBe(true);
  });
});

describe('a send’s request id (TA-15)', () => {
  const ids = () => {
    let n = 0;
    return () => `00000000-0000-4000-8000-00000000000${++n}`;
  };

  it('is new for each send, the same for a retry of the same words and status', () => {
    const next = ids();
    const first = trackerRequest(null, { message: 'We found it.' }, next);
    expect(first.id).toBe('00000000-0000-4000-8000-000000000001');
    // A lost answer or a refusal: the same send again is replayed by the tracker, not emailed twice.
    expect(trackerRequest(first, { message: 'We found it.' }, next)).toBe(first);
    // Changed words, or a status with them: a new request.
    const changed = trackerRequest(first, { message: 'We found it!' }, next);
    expect(changed.id).toBe('00000000-0000-4000-8000-000000000002');
    expect(trackerRequest(changed, { message: 'We found it!', status: 'in_progress' }, next).id).toBe(
      '00000000-0000-4000-8000-000000000003',
    );
  });

  it('is new after a send went through', () => {
    const next = ids();
    const first = trackerRequest(null, { status: 'closed' }, next);
    // Success: the run page forgets it, so the same status again is a new request.
    expect(trackerRequest(null, { status: 'closed' }, next).id).not.toBe(first.id);
  });

  it('tells a reply from a status with the same words apart', () => {
    const next = ids();
    const reply = trackerRequest(null, { message: 'closed' }, next);
    expect(trackerRequest(reply, { status: 'closed' }, next).id).not.toBe(reply.id);
  });
});

describe('where the report’s fix is (0.75, AP-1114)', () => {
  const fix: NonNullable<TrackerItemView['fix']> = {
    state: 'development',
    repo: 'whombat/web',
    prNumber: 52,
    prUrl: 'https://github.com/whombat/web/pull/52',
    mergedAt: '2026-10-11T09:00:00.000Z',
    development: { host: 'dev.desk.acme.example', version: '0.1.176', at: '2026-10-12T09:00:00.000Z' },
    production: null,
    note: null,
  };
  const prod = { host: 'desk.acme.example', version: '0.1.180', at: '2026-10-20T09:00:00.000Z' };

  it('says it in the web’s words, under FILED, a line for what the customer said and Whombat’s note', () => {
    expect(model().fix).toBeNull();
    expect(model({ fix }).fix).toBe(
      'PR #52 merged · live on dev.desk.acme.example (Acme Desk 0.1.176) · waiting for production',
    );
    expect(model({ fix: { ...fix, state: 'confirmed', production: prod } }).fix).toBe(
      'PR #52 merged · live on desk.acme.example (Acme Desk 0.1.180)\nThe customer says it works.',
    );
    const stopped = {
      ...fix,
      state: 'stopped' as const,
      note: 'PR #52 changes the device agent, which reaches computers with its own release.',
    };
    expect(model({ fix: stopped }).fix).toBe(
      'PR #52 merged · live on dev.desk.acme.example (Acme Desk 0.1.176) · no longer followed\nPR #52 changes the device agent, which reaches computers with its own release.',
    );
  });
});
