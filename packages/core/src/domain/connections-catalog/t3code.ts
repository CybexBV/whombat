import { BEARER, type CatalogEntryInput, urlField } from './shared.js';

/**
 * T3 Code (docs/decisions/t3code.md): one computer's T3 Code, the coding agents' control surface, through its own MCP
 * server for outside agents (`/mcp`). Whombat signs in as T3 Code links two of its own computers: a pairing code from
 * its Sharing & access, exchanged on the server for a sign-in of its own that lasts 30 days.
 */
export const entry = {
  id: 't3code',
  name: 'T3 Code',
  category: 'developer',
  description:
    'Your coding agents’ projects and threads in T3 Code: what runs, what waits for you, and new work.',
  tagline: 'Coding agents and their threads',
  signIn: [
    {
      kind: 'password',
      label: 'Pairing code',
      account: null,
      secret: {
        label: 'Pairing code',
        placeholder: 'ABCD2345EFGH',
        help: 'Or run t3 auth pairing create on that computer. A code works once, for 5 minutes.',
        steps: [
          { text: 'In T3 Code on that computer, open Settings → Sharing & access and click Create link.' },
          { text: 'Leave the access as it is, create it and click Copy code.' },
          { text: 'Paste the code here within 5 minutes.' },
        ],
      },
      secondFactor: 'never',
      creates:
        'A sign-in named Whombat in T3 Code: Read only to look, Full access to manage. It lasts 30 days; Whombat says when it’s nearly over and asks for a new code.',
      serviceLimits: true,
    },
    {
      kind: 'token',
      label: 'Sign-in',
      auth: BEARER,
      secretLabel: 'Pairing code',
      secretHelp:
        'Make a new pairing code in T3 Code: Settings → Sharing & access → Create link → Copy code.',
      storedOnly: true,
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.20:3773',
      'The computer that runs T3 Code, with its port (3773 unless you chose another). It answers on your network as a background service (t3 service install) or started with t3 serve --host.',
    ),
  ],
  transport: 'mcp',
  baseUrl: '{url}',
  mcpPath: '/mcp',
  mcpMissingHint:
    'This T3 Code has no MCP server for outside agents: update it (t3 update), then connect it.',
  mcpReadyNote: null,
  mcpTools: {
    // Tools that only work inside a T3 Code thread (they act as the calling thread), and uploads Whombat can't make.
    hidden: [
      'preview_.*',
      't3_preview_.*',
      'device_.*',
      'html_.*',
      'delegate_task',
      'task_.*',
      't3_background_wait',
      'create_threads',
      'request_secret',
      't3_worktree_handoff',
      't3_worktree_status',
      't3_attachment_.*',
      't3_thread_send_attachments',
    ],
    // Reads T3 Code doesn't mark as reads.
    reads: [
      { name: 't3_thread_read' },
      { name: 't3_pending_request', arg: 'action', values: ['list', 'read'] },
      { name: 't3_queue', arg: 'action', values: ['list', 'read'] },
      { name: 't3_thread_transfer', arg: 'action', values: ['status'] },
    ],
  },
  check: { kind: 'mcp' },
  tools: [],
  request: null,
  guide:
    'T3 Code runs coding agents (Claude, ChatGPT and others) on the person’s computer. A project is a folder; a thread is a conversation with one agent there. Outside a T3 thread always name the target: t3_project_list first, then t3_thread_list {projectId} (newest first; statuses filter). Start work with t3_thread_launch {projectId, title, message} (it runs in the project folder, or a new worktree with workspaceStrategy), then t3_thread_wait {threadId, timeoutMs: 25000} (always pass it: a call ends after 30 s) and call it again while timedOut, or t3_thread_read (low limit and maxCharsPerItem). t3_thread_send adds a message, also to a thread that ended or was settled: it goes on with what it learned, so a follow-up goes to the thread that did the work; mode auto never interrupts. A thread waits for the person when t3_thread_read shows pendingRequestCount above 0: t3_pending_request list, read and respond answer its questions (answers keyed by each question’s id, an option’s label as the value); a permission request is approved only in T3 Code itself. Providers and models: orchestrator_capabilities. Threads it starts run with the connection’s access at most and are marked as started by an agent. Don’t message or stop the person’s own threads unless they ask. Name a thread by its title, never its id or t3-thread:// link.',
  // People connect T3 Code to hand work to its agents, so starting, stopping and scheduling that work doesn't ask;
  // deleting does, as on every connection.
  sensitive: [{ tools: ['t3_project_delete', 'delete_scheduled_task'], reason: 'Deletes something' }],
  docsUrl: 'https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md',
  tokenUrl: null,
  handle: 't3',
  access: {
    read: 'The agent can see your projects, threads and AI programs in T3 Code, and change nothing.',
    manage:
      'The agent can also start, message and stop threads, answer their questions and schedule work, with full access. Only deleting asks you first.',
  },
  discovery: {
    targets: [{ port: 3773, scheme: 'http' }],
    probes: [
      {
        path: '/.well-known/t3/environment',
        status: [200],
        bodyPattern: '"orchestrationProtocolVersion"\\s*:',
        version: { json: 'serverVersion' },
      },
    ],
  },
} satisfies CatalogEntryInput;
