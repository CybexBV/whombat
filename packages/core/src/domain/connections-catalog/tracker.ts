import { BEARER, type CatalogEntryInput, urlField } from './shared.js';

/**
 * A report tracker (docs/decisions/report-trackers.md): a ticket system whose customers' reports start automations,
 * read and written by its driver, a plugin the person who runs this Whombat installed (`driver`, the plugin's id). Only
 * automations use it; the entry is offered once a driver is there.
 */
export const entry = {
  id: 'tracker',
  name: 'Report tracker',
  category: 'developer',
  description: 'Reports your customers send through your ticket system, assessed by automations.',
  use: 'automations',
  signIn: [
    {
      kind: 'token',
      label: 'API token',
      auth: BEARER,
      secretLabel: 'API token',
      secretHelp: 'A token of the tracker that reads its reports and writes to them.',
      steps: [
        { text: 'In your tracker, make an API token that reads reports and writes to them.' },
        { text: 'Paste it here.' },
      ],
    },
  ],
  fields: [
    urlField(
      'https://desk.example.com',
      'The tracker’s address. Development and production are two connections, each with its own token.',
    ),
    {
      id: 'driver',
      label: 'Driver',
      placeholder: 'acme-desk',
      help: 'Which installed driver reads this tracker (its plugin’s name).',
      kind: 'text',
      required: true,
      validation: {
        pattern: '[a-z][a-z0-9-]{1,39}',
        message: 'A driver’s name: lowercase letters, digits and dashes.',
      },
    },
    {
      // Whombat report-trackers.md: on a production installation, these reporters' bug fixes are released as soon as
      // development runs them. Read by the server only; an agent never sees it.
      id: 'releaseFor',
      label: 'Straight to production for',
      placeholder: 'name@example.com, other@example.com',
      help: 'Production only: bug fixes for reports from these email addresses go to production as soon as they are live on development, through the repository’s own release procedure.',
      kind: 'text',
      required: false,
      validation: {
        pattern: '\\s*[^\\s,@]+@[^\\s,@]+(\\s*,\\s*[^\\s,@]+@[^\\s,@]+)*\\s*',
        message: 'Email addresses, separated by commas.',
      },
    },
    {
      // The connection's own words end every reply instead of “<assistant> - AI Assistant”, so a team's replies can be
      // signed as the team (Whombat team-reports.md).
      id: 'signature',
      label: 'Reply signature',
      placeholder: 'Support team (AI assistant)',
      help: 'How replies to customers end. Leave it empty to sign with your assistant’s name, like “Dusty - AI Assistant”.',
      kind: 'text',
      required: false,
      validation: {
        pattern: '[^\\n]{1,60}',
        message: 'Up to 60 characters, on one line.',
      },
    },
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'driver' },
  tools: [],
  request: null,
  guide:
    'A report tracker, read by its driver. The agent doesn’t use this connection: automations read the new reports, write an assessment and a priority back and, when they reply to customers, send the reply and say when a fix is live; the agents of such a run read their own report with tracker_item.',
  sensitive: [],
  docsUrl: null,
  tokenUrl: null,
  handle: 'tracker',
} satisfies CatalogEntryInput;
