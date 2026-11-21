import { BEARER, type CatalogEntryInput, type ConnectionToolDef, DELETES_ASK, obj, str } from './shared.js';

/** `tasks_*` and `projects_list` (Todoist). */
export const TASKS_TOOLS: readonly ConnectionToolDef[] = [
  {
    name: 'tasks_list',
    title: 'List tasks',
    description:
      'List open tasks, optionally with a filter in the service’s own words (Todoist: “today | overdue”, “#Work & p1”) or in one project.',
    access: 'read',
    inputSchema: obj({
      filter: str('A filter query, like today | overdue'),
      project: str('A project’s name or id'),
    }),
  },
  {
    name: 'tasks_add',
    title: 'Add a task',
    description: 'Add a task. The due date may be natural language (“tomorrow at 9”, “every Monday”).',
    access: 'write',
    inputSchema: obj(
      {
        content: str('What to do'),
        description: str('More detail (optional)'),
        due: str('When, in words or as YYYY-MM-DD (optional)'),
        project: str('A project’s name or id (optional; the inbox otherwise)'),
        priority: { type: 'integer', minimum: 1, maximum: 4, description: '4 is the most urgent (optional)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names (optional)' },
      },
      ['content'],
    ),
  },
  {
    name: 'tasks_update',
    title: 'Change a task',
    description: 'Change a task’s text, description, due date, priority or labels.',
    access: 'write',
    inputSchema: obj(
      {
        id: str('The task’s id'),
        content: str('New text'),
        description: str('New description'),
        due: str('New due date, in words or as YYYY-MM-DD; “no date” removes it'),
        priority: { type: 'integer', minimum: 1, maximum: 4 },
        labels: { type: 'array', items: { type: 'string' } },
      },
      ['id'],
    ),
  },
  {
    name: 'tasks_complete',
    title: 'Complete a task',
    description: 'Mark a task done (a recurring task moves to its next date).',
    access: 'write',
    inputSchema: obj({ id: str('The task’s id') }, ['id']),
  },
  {
    name: 'projects_list',
    title: 'List projects',
    description: 'List the projects (id, name).',
    access: 'read',
    inputSchema: obj({}),
  },
];

export const entry = {
  id: 'todoist',
  name: 'Todoist',
  category: 'productivity',
  description: 'Your tasks and projects, added, changed and ticked off.',
  signIn: [
    // SG-20 (0.111, CT-748): Todoist's own MCP server, which any client registers with; the token second.
    { kind: 'mcp_oauth', label: 'Sign in with Todoist', mcpUrl: 'https://ai.todoist.net/mcp' },
    {
      kind: 'token',
      label: 'API token',
      transport: 'rest',
      auth: BEARER,
      secretLabel: 'API token',
      secretHelp: 'Copy it from Todoist → Settings → Integrations → Developer.',
      steps: [
        { text: 'Open Todoist’s settings → Integrations → Developer (the link opens it).' },
        { text: 'Click Copy API token and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{40})\\b' }],
    },
  ],
  fields: [],
  transport: 'mcp',
  baseUrl: 'https://api.todoist.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/v1/user' },
  tools: [...TASKS_TOOLS],
  request: { prefixes: ['/api/v1/'] },
  guide:
    'Todoist. Signed in with Todoist, use its own tools. With a token, Todoist’s API v1 (REST v2 is gone): the tasks_* and projects_list tools cover most work; tasks_list takes a Todoist filter (“today | overdue”, “#Work & p1”, “due before: next week”). Priorities run from 1 (normal) to 4 (urgent). With request, paths start with /api/v1/: GET /api/v1/tasks, GET /api/v1/tasks/filter?query=…, POST /api/v1/tasks {content, due_string, project_id, priority, labels}, POST /api/v1/tasks/<id> changes one, POST /api/v1/tasks/<id>/close and /reopen, GET /api/v1/projects, /api/v1/sections, /api/v1/labels, GET /api/v1/tasks/completed/by_completion_date?since=…&until=…. Ids are strings. Lists answer {results, next_cursor}: pass cursor=… for the next page.',
  sensitive: [DELETES_ASK],
  docsUrl: 'https://developer.todoist.com/api/v1/',
  tokenUrl: 'https://app.todoist.com/app/settings/integrations/developer',
  handle: 'todoist',
  access: {
    read: 'The agent can see your tasks and projects, and change nothing.',
    manage: 'The agent can also add, change and complete tasks. Deleting asks you first.',
  },
} satisfies CatalogEntryInput;
