/**
 * Whombat's own plain words for one action an outsiders' run proposes (an automation started by an email): what the
 * approval card's title, the Chat line and the “Done:” message say. They come only from the connection's kind, the
 * tool, the HTTP method and the shape of the path — never from a value the agent or the email chose — so a stranger's
 * text can't become the card's words. The details under them show the call exactly.
 */
import { REQUEST_TOOL_NAME } from '@whombat/core';

/** What a card asks (“Upload a document to Paperless-ngx”) and what the thread says once it ran (“uploaded …”). */
export interface ActionWords {
  ask: string;
  done: string;
}

type Words = readonly [ask: string, done: string];

interface Call {
  tool: string;
  /** The `request` tool's method and path (upper case, canonical); empty for other tools. */
  method: string;
  path: string;
  args: Readonly<Record<string, unknown>>;
}

/** A request route: its methods and a pattern over the path, with the words when both match. */
function route(methods: readonly string[], path: RegExp, words: Words) {
  return (c: Call): Words | null =>
    c.tool === REQUEST_TOOL_NAME && methods.includes(c.method) && path.test(c.path) ? words : null;
}

/** A typed tool by name, with its words. */
function tool(name: RegExp, words: Words | ((c: Call) => Words)) {
  return (c: Call): Words | null =>
    c.tool !== REQUEST_TOOL_NAME && name.test(c.tool)
      ? typeof words === 'function'
        ? words(c)
        : words
      : null;
}

const CHANGE = ['PUT', 'PATCH'];

/** Paperless-ngx's vocabulary under /api/: the thing a path names. */
const PAPERLESS_THINGS: Readonly<Record<string, string>> = {
  tags: 'a tag',
  correspondents: 'a correspondent',
  document_types: 'a document type',
  storage_paths: 'a storage path',
  custom_fields: 'a custom field',
  saved_views: 'a saved view',
};

function paperlessThing(c: Call): Words | null {
  const m =
    /^\/api\/(tags|correspondents|document_types|storage_paths|custom_fields|saved_views)\/(\d+\/?)?$/.exec(
      c.path,
    );
  if (!m) return null;
  const thing = PAPERLESS_THINGS[m[1] as string] as string;
  if (m[2] && CHANGE.includes(c.method)) return [`Change ${thing} in {label}`, `changed ${thing} in {label}`];
  if (!m[2] && c.method === 'POST') return [`Add ${thing} to {label}`, `added ${thing} to {label}`];
  return null;
}

/** Home Assistant's service domains a person knows by name, with what calling one does. */
function homeAssistantService(domain: string, service: string): Words {
  const onOff =
    service === 'turn_on' ? 'on' : service === 'turn_off' ? 'off' : service === 'toggle' ? 'on or off' : null;
  if (domain === 'light')
    return onOff
      ? [`Switch a light ${onOff} in {label}`, `switched a light ${onOff} in {label}`]
      : ['Change a light in {label}', 'changed a light in {label}'];
  if (domain === 'switch')
    return onOff
      ? [`Switch something ${onOff} in {label}`, `switched something ${onOff} in {label}`]
      : ['Change a switch in {label}', 'changed a switch in {label}'];
  if (domain === 'climate' || domain === 'water_heater')
    return ['Change the heating or cooling in {label}', 'changed the heating or cooling in {label}'];
  if (domain === 'media_player')
    return ['Control a media player in {label}', 'controlled a media player in {label}'];
  if (domain === 'notify' || domain === 'persistent_notification')
    return ['Send a notification through {label}', 'sent a notification through {label}'];
  if (domain === 'todo' || domain === 'shopping_list')
    return ['Change a to-do list in {label}', 'changed a to-do list in {label}'];
  if (domain === 'calendar') return ['Add to a calendar in {label}', 'added to a calendar in {label}'];
  if (domain === 'script') return ['Run a script in {label}', 'ran a script in {label}'];
  if (domain === 'scene') return ['Turn on a scene in {label}', 'turned on a scene in {label}'];
  if (domain === 'automation') return ['Change an automation in {label}', 'changed an automation in {label}'];
  if (/^(input_[a-z]+|counter|timer)$/.test(domain))
    return ['Change a helper in {label}', 'changed a helper in {label}'];
  if (onOff) return [`Switch something ${onOff} in {label}`, `switched something ${onOff} in {label}`];
  return ['Run an action in {label}', 'ran an action in {label}'];
}

/** A file service's typed tools (Dropbox, Nextcloud): `files_write`, `files_move`. */
const FILE_TOOLS = [
  tool(/^files_write$/, (c) =>
    c.args.overwrite === true
      ? ['Write or replace a file in {label}', 'wrote a file in {label}']
      : ['Write a file in {label}', 'wrote a file in {label}'],
  ),
  tool(/^files_move$/, ['Move or rename a file in {label}', 'moved or renamed a file in {label}']),
];

/** Words by catalog id, first match wins; a connection without its own words, or a call none matches, is generic. */
const WORDS: Readonly<Record<string, readonly ((c: Call) => Words | null)[]>> = {
  paperless: [
    route(['POST'], /^\/api\/documents\/post_document\/?$/, [
      'Upload a document to {label}',
      'uploaded a document to {label}',
    ]),
    route(CHANGE, /^\/api\/documents\/\d+\/?$/, [
      'Change a document’s details in {label}',
      'changed a document’s details in {label}',
    ]),
    route(['POST'], /^\/api\/documents\/bulk_edit\/?$/, [
      'Change several documents in {label}',
      'changed several documents in {label}',
    ]),
    route(['POST'], /^\/api\/documents\/\d+\/notes\/?$/, [
      'Add a note to a document in {label}',
      'added a note to a document in {label}',
    ]),
    (c) => (c.tool === REQUEST_TOOL_NAME ? paperlessThing(c) : null),
  ],
  moneybird: [
    route(['POST'], /^\/[^/]+\/sales_invoices(\.json)?$/, [
      'Draft a sales invoice in {label}',
      'drafted a sales invoice in {label}',
    ]),
    route(['POST'], /^\/[^/]+\/sales_invoices\/[^/]+\/attachments(\.json)?$/, [
      'Attach a file to a sales invoice in {label}',
      'attached a file to a sales invoice in {label}',
    ]),
    route(CHANGE, /^\/[^/]+\/sales_invoices\/[^/]+(\.json)?$/, [
      'Change a sales invoice in {label}',
      'changed a sales invoice in {label}',
    ]),
    route(['POST'], /^\/[^/]+\/documents\/purchase_invoices(\.json)?$/, [
      'Add a purchase invoice to {label}',
      'added a purchase invoice to {label}',
    ]),
    route(['POST'], /^\/[^/]+\/documents\/receipts(\.json)?$/, [
      'Add a receipt to {label}',
      'added a receipt to {label}',
    ]),
    route(['POST'], /^\/[^/]+\/documents\/typeless_documents(\.json)?$/, [
      'Add a document to {label}',
      'added a document to {label}',
    ]),
    route(['POST'], /^\/[^/]+\/documents\/[^/]+\/[^/]+\/attachments(\.json)?$/, [
      'Attach a file to a document in {label}',
      'attached a file to a document in {label}',
    ]),
    route(CHANGE, /^\/[^/]+\/documents\/[^/]+\/[^/]+(\.json)?$/, [
      'Change a document in {label}',
      'changed a document in {label}',
    ]),
    route(['POST'], /^\/[^/]+\/contacts(\.json)?$/, [
      'Add a contact to {label}',
      'added a contact to {label}',
    ]),
    route(CHANGE, /^\/[^/]+\/contacts\/[^/]+(\.json)?$/, [
      'Change a contact in {label}',
      'changed a contact in {label}',
    ]),
    route(['POST'], /^\/[^/]+\/estimates(\.json)?$/, [
      'Draft a quote in {label}',
      'drafted a quote in {label}',
    ]),
    route(['POST'], /^\/[^/]+\/products(\.json)?$/, [
      'Add a product to {label}',
      'added a product to {label}',
    ]),
    route(['POST'], /^\/[^/]+\/.+\/notes(\.json)?$/, ['Add a note in {label}', 'added a note in {label}']),
  ],
  homeassistant: [
    (c) => {
      const m =
        c.tool === REQUEST_TOOL_NAME && c.method === 'POST'
          ? /^\/api\/services\/([a-z0-9_]+)\/([a-z0-9_]+)$/.exec(c.path)
          : null;
      return m ? homeAssistantService(m[1] as string, m[2] as string) : null;
    },
    route(['POST'], /^\/api\/events\/[^/]+$/, ['Send an event to {label}', 'sent an event to {label}']),
    // The Model Context Protocol server's tools, often with a prefix (`assist__HassTurnOn`).
    tool(/HassTurnOn$/, ['Switch something on in {label}', 'switched something on in {label}']),
    tool(/HassTurnOff$/, ['Switch something off in {label}', 'switched something off in {label}']),
    tool(/HassLightSet$/, ['Change a light in {label}', 'changed a light in {label}']),
    tool(/HassClimateSetTemperature$/, [
      'Change the temperature in {label}',
      'changed the temperature in {label}',
    ]),
    tool(/Hass(ShoppingList|List)AddItem$/, [
      'Add an item to a list in {label}',
      'added an item to a list in {label}',
    ]),
    tool(/HassListCompleteItem$/, [
      'Tick off an item on a list in {label}',
      'ticked off an item on a list in {label}',
    ]),
    tool(/Hass(Media[A-Za-z]*|SetVolume)$/, [
      'Control a media player in {label}',
      'controlled a media player in {label}',
    ]),
    tool(/HassBroadcast$/, [
      'Say something on the speakers in {label}',
      'said something on the speakers in {label}',
    ]),
    tool(/script/i, ['Run a script in {label}', 'ran a script in {label}']),
  ],
  dropbox: [
    ...FILE_TOOLS,
    route(['POST'], /^\/2\/files\/(upload|upload_session\/(start|append_v2|finish))$/, [
      'Upload a file to {label}',
      'uploaded a file to {label}',
    ]),
    route(['POST'], /^\/2\/files\/create_folder(_v2|_batch)?$/, [
      'Make a folder in {label}',
      'made a folder in {label}',
    ]),
    route(['POST'], /^\/2\/files\/move(_v2|_batch_v2)$/, [
      'Move or rename files in {label}',
      'moved or renamed files in {label}',
    ]),
    route(['POST'], /^\/2\/files\/copy(_v2|_batch_v2)$/, [
      'Copy files in {label}',
      'copied files in {label}',
    ]),
    route(['POST'], /^\/2\/files\/save_url$/, [
      'Save a file from the web to {label}',
      'saved a file from the web to {label}',
    ]),
    route(['POST'], /^\/2\/sharing\/create_shared_link(_with_settings)?$/, [
      'Make a share link in {label}',
      'made a share link in {label}',
    ]),
    route(['POST'], /^\/2\/sharing\/(share_folder|add_folder_member|add_file_member)$/, [
      'Share a file or folder from {label}',
      'shared a file or folder from {label}',
    ]),
  ],
  nextcloud: [
    ...FILE_TOOLS,
    route(['PUT'], /./, ['Upload a file to {label}', 'uploaded a file to {label}']),
    route(['MKCOL'], /./, ['Make a folder in {label}', 'made a folder in {label}']),
    route(['MOVE'], /./, ['Move or rename a file in {label}', 'moved or renamed a file in {label}']),
    route(['COPY'], /./, ['Copy a file in {label}', 'copied a file in {label}']),
  ],
  todoist: [
    tool(/^tasks_add$/, ['Add a task to {label}', 'added a task to {label}']),
    tool(/^tasks_update$/, ['Change a task in {label}', 'changed a task in {label}']),
    tool(/^tasks_complete$/, ['Tick off a task in {label}', 'ticked off a task in {label}']),
  ],
};

/** The honest line for a call Whombat has no words of its own for: what it does, in general. */
function generic(c: Call): Words {
  if (c.tool === REQUEST_TOOL_NAME && c.method === 'POST')
    return ['Send something to {label}', 'sent something to {label}'];
  return ['Change something in {label}', 'changed something in {label}'];
}

/**
 * Whombat's words for one proposed action: `label` is the person's own name for the connection. Nothing the agent or
 * the email chose is part of them.
 */
export function actionWords(input: {
  catalogId: string;
  label: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
}): ActionWords {
  const call: Call = {
    tool: input.tool,
    method: input.tool === REQUEST_TOOL_NAME ? String(input.args.method ?? '').toUpperCase() : '',
    path: input.tool === REQUEST_TOOL_NAME ? String(input.args.path ?? '') : '',
    args: input.args,
  };
  let words: Words | null = null;
  for (const match of WORDS[input.catalogId] ?? []) {
    words = match(call);
    if (words) break;
  }
  const [ask, done] = words ?? generic(call);
  // A function, so a `$` in the person's label is never read as a replacement pattern.
  const named = (text: string) => text.replace('{label}', () => input.label);
  return { ask: named(ask), done: named(done) };
}
