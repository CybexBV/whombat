import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'forgejo',
  name: 'Forgejo / Gitea',
  category: 'developer',
  description: 'Repositories, issues and pull requests on Forgejo or Gitea.',
  tagline: 'Code, issues and pull requests',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'mara',
        help: 'The name you sign in with (not your email address).',
      },
      secondFactor: 'optional',
      creates:
        'An access token named whombat with read scopes to look or write scopes to manage (never site administration).',
      serviceLimits: true,
    },
    {
      kind: 'token',
      label: 'Access token',
      auth: { type: 'header', name: 'Authorization', template: 'token {secret}' },
      secretLabel: 'Access token',
      secretHelp:
        'Create one under Settings → Applications → Generate new token, with the scopes the agent needs.',
      steps: [
        {
          text: 'Open Settings → Applications → Generate new token.',
          values: [{ label: 'Token name', value: 'whombat' }],
        },
        {
          text: 'Choose Read (look only) or Read and write (manage) for repository, issue and organization, then generate it.',
        },
        { text: 'Copy the token and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{40})\\b' }],
    },
  ],
  fields: [urlField('https://codeberg.org', 'Your Forgejo’s or Gitea’s address.')],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/v1/user' },
  tools: [],
  request: { prefixes: ['/api/v1/'] },
  guide:
    'Forgejo or Gitea API under /api/v1/ (the server’s /api/swagger lists everything). GET /api/v1/user/repos and /api/v1/repos/search?q=… find repositories; per repository /repos/<owner>/<repo>/issues (POST opens one; state=open|closed), /issues/<n>/comments, /pulls, /pulls/<n>/files, /contents/<path>?ref=main (base64 content), /releases, /branches. Lists page with page and limit. A token only has the scopes it was given (read:repository, write:issue, …): a 403 means one is missing. Merging and deletes always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '/pulls/[0-9]+/merge$',
      reason: 'Merges a pull request',
    },
  ],
  docsUrl: 'https://forgejo.org/docs/latest/user/api-usage/',
  tokenUrl: '{url}/user/settings/applications',
  handle: 'forgejo',
  access: {
    read: 'The agent can read repositories, issues, pull requests and code, and change nothing.',
    manage:
      'The agent can also open issues and pull requests, comment and push. Merging and deleting ask you first.',
  },
  discovery: {
    targets: [
      { port: 3000, scheme: 'http' },
      { port: 443, scheme: 'https' },
    ],
    probes: [
      {
        path: '/api/v1/version',
        status: [200],
        bodyPattern: '^\\s*\\{\\s*"version"\\s*:',
        version: { json: 'version' },
      },
    ],
  },
} satisfies CatalogEntryInput;
