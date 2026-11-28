/** Guide cards, `guides.act`, `connections.finishGoogle` and the assistant's tools (assistant-guides.md, CT-80…CT-82). */
import { describe, expect, it } from 'vitest';
import {
  FinishGoogleBody,
  GUIDE_ERROR_STATUS,
  GUIDE_VALUE_MAX,
  GuideActBody,
  GuideErrorCode,
  inputJsonSchema,
  MCP_POSTING_TOOLS,
  MCP_TOOLS,
  mcpRequiredKey,
  mcpToolConnector,
  mcpToolPersonalOnly,
  PERSONAL_ONLY_TOOL_NAMES,
  WHOMBAT_TOOL_NAMES,
} from '../contracts/index.js';
import { PostableCard } from './cards.js';
import {
  GUIDE_TOPICS,
  GuideBlock,
  GuideCard,
  GuideTopic,
  guideCardLabel,
  guideCardText,
  isKnownGuideTopic,
} from './index.js';

const AT = '2026-09-26T09:00:00.000Z';

/** The welcome card of AG-04. */
const welcome = {
  kind: 'guide',
  guide: 'welcome',
  node: 'menu',
  title: 'Hi Mara, I’m Hazel, your personal assistant.',
  body: 'Only you can see this conversation.\n\nWhat would you like to set up?',
  blocks: [
    {
      type: 'choices',
      id: 'topic',
      options: [
        { id: 'email', title: 'Email', icon: { icon: 'mail' } },
        { id: 'calendar', title: 'Calendar', icon: { icon: 'calendar' } },
        { id: 'files', title: 'Files', icon: { icon: 'folder' } },
      ],
    },
    { type: 'actions', actions: [{ id: 'later', label: 'Maybe later', style: 'quiet' }] },
  ],
  state: 'open',
} as const;

/** Step 4 of the admin's Google app guide (AG-06). */
const step4 = {
  kind: 'guide',
  guide: 'google_app',
  node: 'step_4',
  step: { index: 4, total: 6 },
  title: 'Create the OAuth client',
  blocks: [
    {
      type: 'copy',
      rows: [{ label: 'Authorized redirect URI', value: 'https://app.whombat.com/connect/google' }],
    },
    {
      type: 'links',
      links: [{ label: 'Create OAuth client', url: 'https://console.cloud.google.com/auth/clients/create' }],
    },
    {
      type: 'actions',
      actions: [
        { id: 'next', label: 'Done, next step', style: 'primary' },
        { id: 'stuck', label: 'I’m stuck', style: 'quiet' },
      ],
    },
  ],
  state: 'open',
} as const;

describe('guide cards (AG-02)', () => {
  it('are never postable by an agent', () => {
    expect(PostableCard.safeParse(welcome).success).toBe(false);
    expect(PostableCard.options.map((o) => o.shape.kind.value)).not.toContain('guide');
    expect(JSON.stringify(inputJsonSchema('post_card'))).not.toContain('"guide"');
  });

  it('take every block kind', () => {
    const blocks = [
      {
        type: 'choices',
        id: 'provider',
        mode: 'single',
        options: [
          {
            id: 'google',
            title: 'Google',
            description: 'Gmail or Google Workspace.',
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
        ],
      },
      {
        type: 'choices',
        id: 'services',
        mode: 'multi',
        options: [{ id: 'mail', title: 'Mail' }],
        submitLabel: 'Continue',
      },
      {
        type: 'actions',
        actions: [
          { id: 'settings', label: 'Open Settings', href: '/garden/settings?tab=connections' },
          { id: 'console', label: 'Open Google Cloud', href: 'https://console.cloud.google.com/' },
        ],
      },
      {
        type: 'form',
        id: 'client',
        fields: [
          { id: 'clientId', label: 'Client ID', kind: 'text' },
          { id: 'clientSecret', label: 'Client secret', kind: 'secret' },
          { id: 'json', label: 'Or drop the JSON file', kind: 'json_file', optional: true },
        ],
        submitLabel: 'Save',
      },
      {
        type: 'connect',
        provider: 'google',
        services: ['mail', 'calendar', 'files', 'docs', 'sheets', 'contacts'],
        returnTo: '/garden/dm/hazel?guide=msg_01',
      },
      {
        type: 'status',
        rows: [
          { label: 'Gmail', state: 'ok' },
          {
            label: 'Google Drive',
            state: 'warn',
            detail: 'The Drive API is turned off.',
            href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
          },
          { label: 'Contacts', state: 'mut' },
        ],
      },
    ];
    for (const block of blocks) expect(GuideBlock.safeParse(block).success, JSON.stringify(block)).toBe(true);
    const connect = GuideBlock.parse(blocks[4]);
    expect(connect.type === 'connect' && connect.reconnect).toBe(false);
  });

  it('are bounded', () => {
    const option = (i: number) => ({ id: `o${i}`, title: `Option ${i}` });
    const tooMany = { type: 'choices', id: 'x', options: Array.from({ length: 9 }, (_, i) => option(i)) };
    expect(GuideBlock.safeParse(tooMany).success).toBe(false);
    expect(GuideBlock.safeParse({ type: 'actions', actions: [] }).success).toBe(false);
    const action = (i: number) => ({ id: `a${i}`, label: 'Go' });
    expect(GuideBlock.safeParse({ type: 'actions', actions: [0, 1, 2, 3, 4].map(action) }).success).toBe(
      false,
    );
    expect(GuideCard.safeParse({ ...welcome, title: 'x'.repeat(121) }).success).toBe(false);
    expect(GuideCard.safeParse({ ...welcome, body: 'x'.repeat(1201) }).success).toBe(false);
    const seven = Array.from({ length: 7 }, () => welcome.blocks[1]);
    expect(GuideCard.safeParse({ ...welcome, blocks: seven }).success).toBe(false);
    expect(GuideCard.safeParse({ ...step4, step: { index: 7, total: 6 } }).success).toBe(false);
    expect(GuideCard.safeParse({ ...welcome, node: 'Has Spaces' }).success).toBe(false);
    // Links leave Whombat only over https; in-app paths never leave this origin.
    expect(
      GuideBlock.safeParse({ type: 'links', links: [{ label: 'x', url: 'http://example.com' }] }).success,
    ).toBe(false);
    expect(
      GuideBlock.safeParse({ type: 'actions', actions: [{ id: 'a', label: 'x', href: '//evil.com' }] })
        .success,
    ).toBe(false);
    expect(
      GuideBlock.safeParse({
        type: 'actions',
        actions: [{ id: 'a', label: 'x', href: 'javascript:alert(1)' }],
      }).success,
    ).toBe(false);
  });

  it('tolerate what a newer server may add: topics, block types, icons (CT-80)', () => {
    expect(GuideTopic.safeParse('ai_account').success).toBe(true);
    expect(GuideTopic.safeParse('Not A Topic').success).toBe(false);
    expect(isKnownGuideTopic('email')).toBe(true);
    expect(isKnownGuideTopic('ai_account')).toBe(false);
    const newer = GuideCard.parse({
      ...welcome,
      guide: 'ai_account',
      blocks: [
        { type: 'slider', id: 'x' },
        {
          type: 'choices',
          id: 'topic',
          options: [{ id: 'a', title: 'A', icon: { icon: 'rocket' } }],
        },
      ],
    });
    expect(newer.blocks).toHaveLength(1);
    expect(newer.blocks[0]?.type === 'choices' && newer.blocks[0].options[0]?.icon).toBeNull();
    expect(guideCardLabel(newer)).toBe('GUIDE');
    // A known block type must still be valid.
    expect(GuideCard.safeParse({ ...welcome, blocks: [{ type: 'actions', actions: [] }] }).success).toBe(
      false,
    );
  });

  it('label and read as text', () => {
    expect(guideCardLabel({ guide: 'email', step: null })).toBe('SET UP · EMAIL');
    expect(guideCardLabel({ guide: 'google_app', step: { index: 2, total: 6 } })).toBe(
      'SET UP · GOOGLE · STEP 2 OF 6',
    );
    expect(guideCardText({ title: 'Connect your email', answer: null })).toBe('[guide: Connect your email]');
    expect(
      guideCardText({
        title: 'Connect your email',
        answer: { actionId: 'provider', optionIds: ['google'], label: 'Google', at: AT },
      }),
    ).toBe('[guide: Connect your email; you chose Google]');
    expect(GUIDE_TOPICS).toEqual([
      'welcome',
      'email',
      'calendar',
      'files',
      'google_app',
      'repair',
      'skills',
      // 0.85 (CT-378): the card the Servers tool server_add posts.
      'add_server',
      // The cards connection_add and vault_ask post (Whombat connect-in-chat.md).
      'add_connection',
      'secret',
      'settings',
    ]);
  });

  it('lock with an answer', () => {
    const done = GuideCard.parse({
      ...step4,
      state: 'done',
      answer: { actionId: 'next', label: 'Done, next step', at: AT },
    });
    expect(done.answer?.optionIds).toBeNull();
    expect(GuideCard.safeParse({ ...step4, state: 'closed' }).success).toBe(false);
  });
});

describe('guides.act (AG-03)', () => {
  it('takes an action, options or bounded form values', () => {
    expect(GuideActBody.safeParse({ actionId: 'provider', optionIds: ['google'] }).success).toBe(true);
    expect(
      GuideActBody.safeParse({
        actionId: 'client',
        values: { clientId: '1234567890ab.apps.googleusercontent.com', json: 'x'.repeat(GUIDE_VALUE_MAX) },
      }).success,
    ).toBe(true);
    expect(
      GuideActBody.safeParse({ actionId: 'client', values: { json: 'x'.repeat(GUIDE_VALUE_MAX + 1) } })
        .success,
    ).toBe(false);
    const seven = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, 'v']));
    expect(GuideActBody.safeParse({ actionId: 'client', values: seven }).success).toBe(false);
    expect(GuideActBody.safeParse({ actionId: 'provider', optionIds: [] }).success).toBe(false);
    expect(GuideActBody.safeParse({ actionId: 'Bad Id' }).success).toBe(false);
  });

  it('names its refusals', () => {
    expect(GuideErrorCode.options).toEqual([
      'guide_closed',
      'not_yours',
      'invalid_values',
      'google_admin_only',
      'google_app_in_config',
      'google_unavailable',
    ]);
    expect(GUIDE_ERROR_STATUS.guide_closed).toBe('conflict');
    expect(GUIDE_ERROR_STATUS.not_yours).toBe('forbidden');
    expect(GUIDE_ERROR_STATUS.invalid_values).toBe('validation_failed');
  });
});

describe('connections.finishGoogle (AG-14)', () => {
  it('takes the redirect’s code and state, or its error', () => {
    expect(FinishGoogleBody.safeParse({ code: '4/0AbCd', state: 'oas_12345678' }).success).toBe(true);
    expect(FinishGoogleBody.safeParse({ state: 'oas_12345678', error: 'access_denied' }).success).toBe(true);
    expect(FinishGoogleBody.safeParse({ code: '4/0AbCd' }).success).toBe(false);
    expect(FinishGoogleBody.safeParse({ code: 'x'.repeat(2049), state: 's' }).success).toBe(false);
  });
});

describe('the assistant’s tools (AG-18)', () => {
  it('are personal-agent tools that need no key', () => {
    expect([...PERSONAL_ONLY_TOOL_NAMES].sort()).toEqual([
      // Looks ahead's own: a check's report, connected docs, a look's picks, the person's word on a finding and what
      // they asked it to keep an eye on (Whombat looks-ahead.md).
      'ahead_feedback',
      'ahead_read_docs',
      'ahead_report',
      'ahead_triage',
      'ahead_watch',
      // One thing back from a backup, on the person's yes (Whombat backup-look.md).
      'backup_bring_back',
      // Setting up from the chat with cards (Whombat connect-in-chat.md).
      'connection_add',
      // A Custom connection's logo and page (Whombat connection-looks.md).
      'connection_look',
      // The council the assistant leads, when the person asks (Whombat council.md).
      'council_finish',
      'council_note',
      'council_read',
      'council_start',
      'council_tell',
      // Tasks the assistant hands to T3 Code from a checklist card (Whombat delegate.md).
      'delegate_finish',
      'delegate_offer',
      'delegate_read',
      'delegate_update',
      'device_probe',
      // What the assistant found out about a look (Whombat look-research.md LR-05).
      'look_report',
      'pin_widget',
      'propose_device_skill',
      // Keeping a thing quiet for a while, on the person's word.
      'quiet_until',
      // A Looks ahead check's web: a page it saw (Whombat looks-ahead.md).
      'read_web_page',
      // What the assistant finished, for the desk's Done today (Whombat done-today.md DN-01).
      'report_done',
      // A report to the Whombat Team, drafted for the person's press (Whombat team-reports.md).
      'report_to_whombat_team',
      'search_web',
      'set_chat_title',
      // Whombat's settings for the person (Whombat assistant-settings.md).
      'settings_change',
      'settings_find',
      'settings_open',
      'settings_read',
      // Sharing a thread by link, always on the person's yes (Whombat share-links.md).
      'share_link',
      'start_guide',
      'thing_watch',
      // 0.112.0 (CT-782): the assistant runs its person's Vault.
      'vault_add_server',
      'vault_ask',
      'vault_save',
      // What Whombat watches, switched on the person's word (Whombat on-purpose.md).
      'watch_checks',
      // How everything is and what went wrong, read-only.
      'watch_history',
      'watch_status',
      // Where everything's data is kept and the restore tests, read-only (Whombat backup-trust.md).
      'whats_protected',
      // This Whombat's own backups, on the person's yes (Whombat first-day.md).
      'whombat_backup',
      // The person's reports to the Whombat Team, without the team's words.
      'whombat_team_reports',
    ]);
    for (const name of PERSONAL_ONLY_TOOL_NAMES) {
      expect(mcpToolPersonalOnly(name)).toBe(true);
      expect(mcpToolConnector(name)).toBeNull();
      expect(mcpRequiredKey(name, {})).toBeNull();
      expect(WHOMBAT_TOOL_NAMES).not.toContain(name);
    }
    expect(mcpToolPersonalOnly('post_message')).toBe(false);
    expect(MCP_POSTING_TOOLS.has('start_guide')).toBe(true);
  });

  it('start only the guides an agent may start', () => {
    const input = MCP_TOOLS.start_guide.input;
    expect(input.safeParse({ topic: 'email' }).success).toBe(true);
    expect(input.safeParse({ topic: 'repair' }).success).toBe(false);
    expect(input.safeParse({ topic: 'ai_account' }).success).toBe(false);
  });
});
