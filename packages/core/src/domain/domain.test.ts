import { describe, expect, it } from 'vitest';
import { at, dusty, GRANTS, mara, plan, pr } from '../__fixtures__/world.js';
import {
  Canvas,
  CanvasComment,
  countSearchResults,
  emailInitials,
  formatReaction,
  Grant,
  groupCommentThreads,
  initialsOf,
  LinkRef,
  linkPath,
  Message,
  mergeBlock,
  needsName,
  Person,
  PersonName,
  PR_STATUS_LABELS,
  PR_STATUS_TONES,
  PullRequest,
  parseReaction,
  prStatus,
  SearchResult,
  searchFilterOf,
  shortNameOf,
  toneFor,
} from './index.js';

function message(overrides: Partial<Message>): Message {
  return Message.parse({
    id: 'msg_x',
    conversationId: 'cnv_dm-dusty',
    authorId: dusty.id,
    createdAt: at('11:22'),
    editedAt: null,
    text: 'Fixing both now. Watch along if you like.',
    mentions: [],
    card: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...overrides,
  });
}

describe('principals', () => {
  it('derive names and initials', () => {
    expect(shortNameOf(mara)).toBe('Mara');
    expect(shortNameOf(dusty)).toBe('Dusty');
    expect(initialsOf('Mara Okafor')).toBe('MO');
    expect(initialsOf('Ivo de Vries')).toBe('IV');
    expect(initialsOf('Banjo')).toBe('BA');
    expect(initialsOf('Éva Kovács')).toBe('ÉK');
    expect(initialsOf('mara.okafor')).toBe('MO');
    expect(initialsOf('  mara_ ')).toBe('MA');
    expect(initialsOf('李雷')).toBe('李雷');
    expect(initialsOf('---')).toBe('?');
    expect(Person.shape.initials.safeParse(initialsOf('Éva Kovács')).success).toBe(true);
    expect(PersonName.safeParse('  Mara Okafor ').data).toBe('Mara Okafor');
    expect(PersonName.safeParse('   ').success).toBe(false);
    expect(PersonName.safeParse('---').success).toBe(false);
    expect(PersonName.safeParse('x'.repeat(81)).success).toBe(false);
    expect(needsName({ name: '' })).toBe(true);
    expect(needsName({ name: ' Mara ' })).toBe(false);
    expect(emailInitials('mara@burrowhq.example')).toBe('MA');
    expect(toneFor(0)).toBe('#bfd0bf');
    expect(toneFor(5)).toBe('#bfd0bf');
    expect(toneFor(-1)).toBe('#cfd2b8');
  });
});

describe('grants', () => {
  it('parse and reject unknown keys', () => {
    for (const g of GRANTS) expect(Grant.parse(g)).toEqual(g);
    expect(Grant.safeParse({ agentId: dusty.id, keyId: 'fly', tier: 'can' }).success).toBe(false);
    expect(Grant.safeParse({ agentId: dusty.id, keyId: 'tests.run', tier: 'maybe' }).success).toBe(false);
  });
});

describe('messages and cards', () => {
  it('carry reactions, mentions and threads', () => {
    const m = message({
      text: 'Typeset works for me. @Dusty go for it.',
      authorId: mara.id,
      mentions: [dusty.id],
      reactions: [{ value: '+1', count: 2, mine: true, principalIds: [mara.id, dusty.id] }],
    });
    expect(formatReaction(m.reactions[0] as { value: string; count: number })).toBe('+1 · 2');
    expect(parseReaction('finally · 4')).toEqual({ value: 'finally', count: 4 });
    expect(parseReaction('nope')).toBeNull();
    const root = message({
      id: 'msg_research',
      authorId: dusty.id,
      replyCount: 5,
      lastReplyAt: at('10:06'),
      threadParticipantIds: [dusty.id, mara.id],
    });
    expect(root.replyCount).toBe(5);
    expect(message({ threadRootId: 'msg_research' }).threadRootId).toBe('msg_research');
    expect(Message.safeParse({ ...m, createdAt: 'yesterday' }).success).toBe(false);
  });
});

describe('pull requests', () => {
  it('derive the branch room status like the mock', () => {
    expect(PullRequest.parse(pr).number).toBe(482);
    expect(prStatus(pr)).toBe('changes_requested');
    expect(PR_STATUS_LABELS[prStatus(pr)]).toBe('Open · changes requested');
    expect(PR_STATUS_TONES[prStatus(pr)]).toBe('warn');
    expect(mergeBlock(pr, 'person')).toBe('checks');

    const green = {
      ...pr,
      checks: pr.checks.map((c) => ({ ...c, state: 'passed' as const })),
      reviewers: [{ principalId: mara.id, state: 'approved' as const, at: at('11:38') }],
    };
    expect(prStatus(green)).toBe('ready');
    expect(PR_STATUS_LABELS.ready).toBe('Open · ready');
    expect(PR_STATUS_TONES.ready).toBe('ok');
    expect(mergeBlock(green, 'person')).toBeNull();
    expect(mergeBlock(green, 'agent')).toBe('agent');
    expect(prStatus({ ...green, state: 'merged' })).toBe('merged');
    expect(PR_STATUS_LABELS.merged).toBe('Merged');
    expect(mergeBlock({ ...green, state: 'merged' }, 'person')).toBe('not_open');
    const noReview = { ...green, reviewers: [] };
    expect(prStatus(noReview)).toBe('in_review');
    expect(mergeBlock(noReview, 'person')).toBe('review');
    expect(prStatus({ ...pr, reviewers: [] })).toBe('checks_failing');
  });
});

describe('canvas, search, notifications, dispatch, onboarding', () => {
  it('groups canvas comments into threads', () => {
    const anchor = {
      relativePosition: 'AQID',
      quote: 'Invoice numbers come from the invoice-number service.',
    };
    const comments = [
      {
        id: 'cmt_2',
        canvasId: 'cvs_x',
        anchor: null,
        parentId: 'cmt_1',
        authorId: mara.id,
        text: 'Agreed. Made it a rule.',
        createdAt: at('14:07', -1),
        resolved: false,
      },
      {
        id: 'cmt_1',
        canvasId: 'cvs_x',
        anchor,
        parentId: null,
        authorId: dusty.id,
        text: 'Step 2 should read the number from the invoice-number service.',
        createdAt: at('14:05', -1),
        resolved: false,
      },
      {
        id: 'cmt_3',
        canvasId: 'cvs_x',
        anchor,
        parentId: null,
        authorId: mara.id,
        text: 'This is the one that bit us in March.',
        createdAt: at('11:21'),
        resolved: false,
      },
    ].map((c) => CanvasComment.parse(c));
    const threads = groupCommentThreads(comments);
    expect(threads.map((t) => t.comments.map((c) => c.id))).toEqual([['cmt_1', 'cmt_2'], ['cmt_3']]);
    expect(
      Canvas.parse({
        id: 'cvs_invoice-pdf-plan',
        burrowId: 'bur_burrow-hq',
        slug: 'invoice-pdf-export-plan',
        title: 'Invoice PDF export · plan',
        conversationId: 'cnv_dm-dusty',
        planId: plan.id,
        provenance: { createdById: dusty.id, requestedById: mara.id, editorIds: [mara.id, dusty.id] },
        createdAt: at('09:13'),
        updatedAt: at('11:10'),
      }).slug,
    ).toBe('invoice-pdf-export-plan');
  });

  it('counts search results per filter like the mock', () => {
    const types = ['THREAD', 'PATCH', 'RUN', 'CANVAS', 'MESSAGE'] as const;
    const results = types.map((type, i) =>
      SearchResult.parse({
        id: `res_${i}`,
        type,
        where: 'Chat · 3 Mar 2026',
        authorId: mara.id,
        snippet: 'Credit note 4471 is a cent off.',
        citedAs: i < 3 ? i + 1 : null,
        link: { type: 'dm' },
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    );
    expect(countSearchResults(results)).toEqual({
      all: 5,
      threads: 2,
      patches: 1,
      runs: 1,
      canvases: 1,
      plans: 0,
      decisions: 0,
      automations: 0,
    });
    expect(searchFilterOf('MESSAGE')).toBe('threads');
  });
});

describe('links', () => {
  it('route every link type to the web app', () => {
    const cases: [LinkRef, string][] = [
      [{ type: 'dm' }, '/burrow-hq/chat'],
      [{ type: 'dm', room: 'feedback' }, '/burrow-hq/feedback'],
      [{ type: 'chat', id: 'cnv_task-1' }, '/burrow-hq/chats/cnv_task-1'],
      [{ type: 'pr', number: 482 }, '/burrow-hq/pr/482'],
      [{ type: 'pr', number: 482, tab: 'files' }, '/burrow-hq/pr/482?tab=files'],
      [
        { type: 'message', in: { type: 'dm' }, messageId: 'msg_1', threadRootId: 'msg_research' },
        '/burrow-hq/chat?thread=msg_research',
      ],
      [{ type: 'message', in: { type: 'dm' }, messageId: 'msg_2' }, '/burrow-hq/chat#msg_2'],
      [{ type: 'run', number: 1907 }, '/burrow-hq/runs/1907'],
      [{ type: 'approval', number: 12, in: { type: 'dm' } }, '/burrow-hq/chat?approval=12'],
      [
        { type: 'approval', number: 12, in: { type: 'pr', number: 482, tab: 'files' } },
        '/burrow-hq/pr/482?tab=files&approval=12',
      ],
      [{ type: 'agent' }, '/burrow-hq/settings/agent'],
      [{ type: 'canvas', slug: 'invoice-pdf-export-plan' }, '/burrow-hq/canvases/invoice-pdf-export-plan'],
      [{ type: 'log', who: 'dusty', eventId: 'evt_9f18' }, '/burrow-hq/log?who=dusty&open=evt_9f18'],
      [
        { type: 'search', q: 'invoice rounding', filter: 'threads' },
        '/burrow-hq/search?q=invoice%20rounding&type=threads',
      ],
      [
        { type: 'external', url: 'https://staging.burrowhq.example/x.pdf' },
        'https://staging.burrowhq.example/x.pdf',
      ],
    ];
    for (const [link, path] of cases) expect(linkPath('burrow-hq', LinkRef.parse(link))).toBe(path);
    expect(linkPath('burrow-hq', { type: 'approval', number: 12 })).toBe('/burrow-hq/log?approval=12');
    expect(linkPath('burrow-hq', { type: 'approval', number: 12 }, { type: 'dm' })).toBe(
      '/burrow-hq/chat?approval=12',
    );
  });
});
