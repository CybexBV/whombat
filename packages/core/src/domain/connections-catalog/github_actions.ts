import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME } from './shared.js';

/**
 * GitHub Actions as a connection of its own (docs/decisions/service-dashboards.md “GitHub Actions”): a fine-grained
 * token, often of another account than the person's GitHub sign-in (a personal repository's owner is the only one who
 * may list its runners), that looks at runners and workflow runs. The builtin `github` entry stays the sign-in
 * everything else on GitHub runs as.
 */
const TOKEN_FORM =
  'https://github.com/settings/personal-access-tokens/new?name=Whombat&description=Whombat+watches+the+runners+and+runs&expires_in=none&administration=read';

export const entry = {
  id: 'github_actions',
  name: 'GitHub Actions',
  category: 'developer',
  description: 'Runners and workflow runs of your GitHub repositories.',
  tagline: 'Runners, builds and checks',
  signIn: [
    {
      kind: 'token',
      label: 'Access token',
      auth: BEARER,
      secretLabel: 'Fine-grained token',
      secretPlaceholder: 'github_pat_…',
      secretHelp:
        'Create one on GitHub as the repositories’ owner: Settings → Developer settings → Fine-grained tokens, with Actions and Administration read access.',
      steps: [
        {
          text: 'Sign in to GitHub as the account that owns the repositories, then open the link: GitHub fills in the name and the access.',
        },
        {
          text: 'Under Repository access choose Only select repositories and pick the ones to watch.',
        },
        {
          text: 'Leave the access GitHub filled in for Actions and Administration, then click Generate token.',
        },
        { text: 'Copy the token and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b(github_pat_[A-Za-z0-9_]{20,255})\\b' }],
      links: { read: `${TOKEN_FORM}&actions=read`, manage: `${TOKEN_FORM}&actions=write` },
    },
  ],
  fields: [
    {
      id: 'repos',
      label: 'Repositories',
      placeholder: 'acme/web, acme/api',
      help: 'The repositories to watch, as owner/name, separated by commas. Empty: the ones the token can see, the most recently changed first.',
      kind: 'text',
      required: false,
      validation: {
        pattern: '\\s*[\\w.-]+/[\\w.-]+(\\s*,\\s*[\\w.-]+/[\\w.-]+){0,19}\\s*,?\\s*',
        message: 'Write each as owner/name, separated by commas (at most 20).',
      },
    },
  ],
  transport: 'rest',
  baseUrl: 'https://api.github.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/user' },
  tools: [],
  request: {
    prefixes: ['/repos/', '/orgs/', '/user'],
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  },
  guide:
    'GitHub REST API. Per repository (owner/name): GET /repos/<o>/<r>/actions/runs (?branch=, ?status=queued or in_progress, ?per_page=) lists workflow runs; /actions/runs/<id>/jobs each job with its runner, labels and steps; /actions/workflows the workflows; /actions/runners the repository’s self-hosted runners (needs Administration read). An organisation’s runners: /orgs/<org>/actions/runners. POST /repos/<o>/<r>/actions/runs/<id>/rerun-failed-jobs re-runs failed jobs and POST /actions/workflows/<file>/dispatches {ref} starts one (Actions write). Lists page with page and per_page (at most 100). Cancelling a run and deletes always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '/actions/runs/[0-9]+/(cancel|force-cancel)$',
      reason: 'Stops a workflow run',
    },
  ],
  docsUrl: 'https://docs.github.com/en/rest/actions',
  tokenUrl: 'https://github.com/settings/personal-access-tokens',
  handle: 'gh-actions',
  access: {
    read: 'The agent can see runners, workflows and their runs, and change nothing.',
    manage:
      'The agent can also re-run failed jobs and start workflows. Cancelling a run and removing anything ask you first.',
  },
} satisfies CatalogEntryInput;
