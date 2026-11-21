/** Test helper: a DispatchContext built from the fixtures (Mara mentions Dusty in PR #482's room). */

import {
  DEFAULT_AGENT_RUNTIME,
  type DispatchContext,
  KEY_CATALOG,
  type KeyId,
  type Message,
} from '@whombat/core';
import { cnv_pr482, dusty, mara } from '@whombat/fixtures';

/** Mara asks Dusty in the branch room (the mock's “Typeset works for me”, one-agent.md OA-04: no channels). */
export const maraAsks: Message = {
  id: 'msg_pr482-mara-1002',
  conversationId: cnv_pr482.id,
  authorId: mara.id,
  createdAt: '2026-09-23T08:02:00.000Z',
  text: 'Typeset works for me. @Dusty go for it.',
  mentions: [dusty.id],
  editedAt: null,
  attachments: [],
  clientId: null,
  card: null,
  suggestions: [],
  more: null,
  reactions: [],
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  threadParticipantIds: [],
};

export function testContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    dispatch: {
      id: 'dsp_turn',
      burrowId: 'bur_burrow-hq',
      agentId: dusty.id,
      trigger: 'mention',
      mode: 'reply',
      conversationId: cnv_pr482.id,
      messageId: maraAsks.id,
      threadRootId: null,
      runId: null,
      state: 'claimed',
      providerSessionId: null,
      runnerId: null,
      error: null,
      createdAt: '2026-09-23T09:22:00.000Z',
      claimedAt: null,
      finishedAt: null,
      postedAt: null,
    },
    burrow: { id: 'bur_burrow-hq', slug: 'burrow-hq', name: 'Burrow HQ', timeZone: 'Europe/Amsterdam' },
    agent: {
      id: dusty.id,
      name: 'Dusty',
      handle: 'dusty',
      face: dusty.face,
      runtime: { ...DEFAULT_AGENT_RUNTIME },
      keys: {
        can: [
          { id: 'branch.feature.readwrite', label: 'Read and write feat/* branches' },
          { id: 'tests.run', label: 'Run tests' },
        ],
        ask: [{ id: 'branch.shared.push', label: 'Push to shared branches' }],
        cannot: [{ id: 'merge.main', label: 'Merge into main' }],
      },
    },
    conversation: {
      id: cnv_pr482.id,
      kind: 'branch',
      title: cnv_pr482.title,
      topic: cnv_pr482.topic,
      link: { type: 'pr', number: 482 },
    },
    trigger: maraAsks,
    window: [maraAsks],
    thread: null,
    principals: [
      { id: mara.id, kind: 'person', name: mara.name, handle: 'mara', title: 'Engineering lead' },
      { id: dusty.id, kind: 'agent', name: 'Dusty', handle: 'dusty', title: null },
    ],
    run: null,
    planStep: null,
    schedule: null,
    gateway: null,
    gh: null,
    commands: null,
    outside: false,
    vault: null,
    files: null,
    search: null,
    workspace: null,
    facts: ['Repos switched on for the agent: whombat/billing.'],
    onBehalfOf: null,
    attachments: [],
    session: null,
    logins: [],
    notes: null,
    agentToken: { token: 'wat_turn', expiresAt: '2026-09-23T10:00:00.000Z' },
    mcpPath: '/mcp',
    now: '2026-09-23T09:22:00.000Z',
    // Read only by a turn on `local` (the fake providers' default kind, as the scripted one was).
    localModel: { v: 1, baseUrl: 'http://192.168.1.20:11434/v1', model: 'llama4', apiKey: null },
    webSearch: null,
    ...overrides,
  };
}

const key = (id: KeyId) => ({ id, label: KEY_CATALOG[id].label });

/**
 * Dusty, asked by Mara in PR #482's room to deploy the website: a writable checkout, her SSH keys and Cloudflare token
 * for its commands, and web-1 and nas-prod production servers.
 */
export function commandsTurnContext(over: Partial<DispatchContext> = {}): DispatchContext {
  const base = testContext();
  return {
    ...base,
    agent: {
      ...base.agent,
      runtime: { ...base.agent.runtime, provider: 'claude' },
      keys: {
        can: [
          'repos.read',
          'branch.feature.readwrite',
          'tests.run',
          'pr.open',
          'web.browse',
          'browser.use',
          'workspace.scratch',
        ].map((id) => key(id as KeyId)),
        ask: ['merge.main', 'deploy'].map((id) => key(id as KeyId)),
        cannot: ['branch.main.push'].map((id) => key(id as KeyId)),
      },
    },
    workspace: {
      repo: 'whombat/website',
      branch: 'feat/hero',
      baseBranch: 'main',
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/whombat/website.git',
      access: 'write',
      writeApproved: false,
    },
    commands: {
      productionServers: [
        {
          entryId: 'vlt_server000001',
          name: 'web-1',
          host: 'web1.example.com',
          port: 22,
          addresses: ['203.0.113.10'],
        },
        {
          entryId: 'vlt_maranas00001',
          name: 'nas-prod',
          host: '198.51.100.7',
          port: 22,
          addresses: ['198.51.100.7'],
        },
      ],
      homeNetworks: ['192.168.1.0/24'],
      lan: true,
    },
    vault: {
      entries: [
        {
          id: 'vlt_server000001',
          name: 'Server Access Key',
          description: 'Deploys the website',
          kind: 'ssh',
          url: null,
          envNames: [],
          servers: [{ name: 'web-1', target: 'deploy@web1.example.com:22', ready: true }],
        },
        {
          id: 'vlt_cloudflare01',
          name: 'Cloudflare API token',
          description: '',
          kind: 'http',
          url: 'https://api.cloudflare.com/client/v4',
          envNames: ['CLOUDFLARE_API_TOKEN'],
        },
        {
          id: 'vlt_maranas00001',
          name: 'a private Vault entry of Mara',
          description: '',
          kind: 'ssh',
          url: null,
          envNames: [],
          servers: [{ name: 'nas-prod', target: 'nas@nas.home:22', ready: true }],
        },
      ],
      unheld: [],
    },
    ...over,
  };
}
