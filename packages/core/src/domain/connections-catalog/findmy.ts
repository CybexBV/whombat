import { z } from 'zod';
import type { JsonObject } from '../common.js';
import { FIND_MY_BACKGROUND_CHOICES, FindMyPeopleArgs } from '../hosts-findmy.js';
import type { CatalogEntryInput, ConnectionToolDef } from './shared.js';

/** The one tool of a Find My connection: where each person is, read first when the last read is old. */
export const FIND_MY_PEOPLE_TOOL: ConnectionToolDef = {
  name: 'findmy_people',
  title: 'See where people are',
  description:
    'Where each person is, as Find My on the Mac shows them: their name, place (Find My’s own words, such as Home), street, how long ago Find My saw them, whether they are nearby, and when Whombat read it. Give person (a name or first name) for one person. When the last read is older than 2 minutes and the Mac can be used, it reads Find My first, waiting up to 45 seconds; otherwise it answers the last read with its age and why it couldn’t read. Never pictures or coordinates.',
  access: 'read',
  inputSchema: z.toJSONSchema(FindMyPeopleArgs) as JsonObject,
};

/**
 * Find My through one of the person's Macs (docs/implementation/macos/findmy-connection.md): no sign-in and no address
 * of its own; its `mac` field names the Mac (a server Whombat watches), and the check (`mac`) proves that Mac is there,
 * runs macOS and has a new enough Whombat Helper. The base URL is the Servers connection's, never requested.
 */
export const entry = {
  id: 'findmy',
  name: 'Find My',
  category: 'home',
  description: 'Where your family and friends are, as Find My on your Mac shows them.',
  signIn: [{ kind: 'none', label: 'Through your Mac' }],
  fields: [
    {
      id: 'mac',
      label: 'Mac',
      kind: 'select',
      required: true,
      fromService: true,
      help: 'The Mac that reads Find My. It must be signed in to iCloud with Find My on.',
    },
    {
      id: 'background',
      label: 'Read in the background',
      kind: 'select',
      required: false,
      default: 'off',
      options: [...FIND_MY_BACKGROUND_CHOICES],
      help: 'How often Whombat reads Find My while nobody looks. Each read uses the Mac’s screen for a moment.',
    },
  ],
  transport: 'rest',
  baseUrl: 'whombat-hosts:',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'mac' },
  tools: [FIND_MY_PEOPLE_TOOL],
  request: null,
  guide:
    'Find My as the person’s Mac shows it, read through Whombat Helper on that Mac. findmy_people answers each person’s name, place, street, how long ago Find My saw them and whether they are nearby; give person to ask about one. A read uses the Mac’s screen for a moment and leaves a Mac someone is using alone: then the answer is the last read, with its age and why. Say places as Find My words them. There are never pictures or coordinates. To tell the person when someone arrives somewhere or leaves, make an automation with a findmy trigger.',
  sensitive: [],
  docsUrl: null,
  tokenUrl: null,
  handle: 'findmy',
  access: {
    read: 'The assistant can see where each person is, and change nothing.',
    manage: 'The same: Find My has nothing the assistant can change.',
  },
} satisfies CatalogEntryInput;
