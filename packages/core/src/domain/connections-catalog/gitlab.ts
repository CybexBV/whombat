import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'gitlab',
  name: 'GitLab',
  category: 'developer',
  description: 'Projects, issues and merge requests on GitLab.',
  signIn: [
    {
      kind: 'token',
      label: 'Access token',
      auth: BEARER,
      secretLabel: 'Personal access token',
      secretPlaceholder: 'glpat-…',
      secretHelp:
        'Create one in GitLab: your avatar → Edit profile → Access → Personal access tokens → Generate token (choose Legacy token if asked), with the api (or read_api) scope.',
      steps: [
        { text: 'Open the link: GitLab fills in the name and the scopes for the level you chose.' },
        { text: 'Pick the longest expiration (a year) and click Generate token.' },
        { text: 'Copy the token and paste it here.' },
      ],
      // An instance may put its own prefix in front (mycompany-glpat-…, GitLab 17.10).
      paste: [{ target: 'secret', pattern: '\\b((?:[A-Za-z0-9_]+-)?glpat-[A-Za-z0-9_.-]{20,300})' }],
      links: {
        read: '{url}/-/user_settings/personal_access_tokens?name=Whombat&scopes=read_api,read_repository',
        manage: '{url}/-/user_settings/personal_access_tokens?name=Whombat&scopes=api,write_repository',
      },
    },
  ],
  fields: [
    urlField('https://gitlab.com', 'GitLab.com, or your own GitLab’s address.', {
      default: 'https://gitlab.com',
    }),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/v4/user' },
  tools: [],
  // GraphQL (0.91, CT-405): its endpoint is outside /api/v4/; a query reads, a mutation is a change.
  request: {
    prefixes: ['/api/v4/', '/api/graphql'],
    readPaths: [{ method: 'POST', path: '^/api/graphql$', graphql: true }],
  },
  guide:
    'GitLab REST API under /api/v4/. GET /api/v4/projects?membership=true&search=… finds projects; a project is its numeric id or its path URL-encoded (group%2Fproject). Per project: /issues (POST opens one), /merge_requests, /merge_requests/<iid>/notes, /repository/files/<encoded path>/raw?ref=main, /repository/tree, /pipelines, /jobs. GET /api/v4/search?scope=issues&search=… searches. Lists page with page and per_page (at most 100); the X-Next-Page header gives the next page. POST /api/graphql runs GraphQL: queries read, mutations change. Merging and deletes always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PUT', 'POST'],
      path: '/merge_requests/[0-9]+/merge$',
      reason: 'Merges a merge request',
    },
  ],
  docsUrl: 'https://docs.gitlab.com/api/rest/',
  tokenUrl: '{url}/-/user_settings/personal_access_tokens',
  handle: 'gitlab',
  access: {
    read: 'The agent can read projects, issues, merge requests and code, and change nothing.',
    manage: 'The agent can also open issues, comment and push. Merging and deleting ask you first.',
  },
} satisfies CatalogEntryInput;
