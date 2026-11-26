/** What the MCP server serves (prompt-efficiency.md PE-05): lean schemas, narrowed actions, the tools a turn can use. */
import {
  CONNECTOR_SERVICES,
  inputJsonSchema,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpToolName,
  PERSONAL_ACTION_TYPES,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  AHEAD_TOOLS,
  CODE_TOOLS,
  hiddenActionTypes,
  hiddenVariants,
  leanJsonSchema,
  loadSelection,
  NO_CODE_HIDDEN,
  NO_CODE_LINKS,
  OPTIONAL_EXECUTOR_ACTION_TYPES,
  OUTSIDERS_TOOLS,
  POSTABLE_CARD_KINDS,
  RUN_REPORT_TOOLS,
  SERVED_HIDDEN_PROPERTIES,
  type SelectionLoaders,
  type ServedSelection,
  servedInputSchema,
  servedToolNames,
  servedTools,
  servedVaultTools,
  servesTool,
  servesToolLazily,
  toolFitsTurn,
  withoutVariants,
} from './served';

type Node = Record<string, unknown>;

const KEPT = ['type', 'required', 'enum', 'const', 'description', 'format', 'default', '$ref'];

/** Everything a schema says about shape and meaning, by path: what the lean schema must keep. */
function meaning(node: unknown, path = '', out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      meaning(v, `${path}[${i}]`, out);
    });
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  for (const [key, value] of Object.entries(node as Node)) {
    if (KEPT.includes(key)) out.push(`${path}.${key}=${JSON.stringify(value)}`);
    else if (key === 'properties' || key === '$defs') {
      // Names here are data (a field may be called “description”): each is a schema.
      out.push(`${path}.${key}=${Object.keys(value as Node).join(',')}`);
      for (const [name, schema] of Object.entries(value as Node))
        meaning(schema, `${path}.${key}.${name}`, out);
    } else if (typeof value === 'object') meaning(value, `${path}.${key}`, out);
  }
  return out;
}

describe('lean schemas (PE-05)', () => {
  it('drops what only validates and keeps what guides the model', () => {
    const lean = leanJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        at: { type: 'string', format: 'date-time', pattern: '^\\d{4}-…$', description: 'When' },
        id: { type: 'string', pattern: '^msg_[A-Za-z0-9_-]{1,64}$' },
        count: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
        run: { type: 'integer', exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        body: { type: 'string', minLength: 1, maxLength: 20_000 },
        steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 280 } },
        files: { type: 'array', maxItems: 500, items: { type: 'string', minLength: 2 } },
        // Property names are data: a field called “pattern” or “$schema” stays.
        pattern: { type: 'string', format: 'regex' },
        $schema: { type: 'string' },
      },
      required: ['at'],
      $defs: { x: { anyOf: [{ type: 'string', format: 'email', pattern: '^.+@.+$' }, { type: 'null' }] } },
    });
    expect(lean).toEqual({
      type: 'object',
      properties: {
        at: { type: 'string', format: 'date-time', description: 'When' },
        id: { type: 'string', pattern: '^msg_[A-Za-z0-9_-]{1,64}$' },
        count: { type: 'integer' },
        run: { type: 'integer', exclusiveMinimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        title: { type: 'string', maxLength: 160 },
        body: { type: 'string' },
        steps: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 280 } },
        files: { type: 'array', items: { type: 'string', minLength: 2 } },
        pattern: { type: 'string', format: 'regex' },
        $schema: { type: 'string' },
      },
      required: ['at'],
      $defs: { x: { anyOf: [{ type: 'string', format: 'email' }, { type: 'null' }] } },
    });
  });

  it('keeps every property, requirement, type, enum, default and description of every tool', () => {
    for (const name of MCP_TOOL_NAMES) {
      // Less the arguments a tool isn't served with on purpose (all-skills-agent.md).
      const left = SERVED_HIDDEN_PROPERTIES[name] ?? [];
      const all = inputJsonSchema(name) as { properties?: Record<string, unknown>; required?: string[] };
      const full = left.length
        ? {
            ...all,
            properties: Object.fromEntries(
              Object.entries(all.properties ?? {}).filter(([k]) => !left.includes(k)),
            ),
            ...(all.required ? { required: all.required.filter((k) => !left.includes(k)) } : {}),
          }
        : all;
      const served = servedInputSchema(name);
      expect(meaning(served), name).toEqual(meaning(full));
      expect(JSON.stringify(served), name).not.toContain('9007199254740991');
      expect(JSON.stringify(served), name).not.toContain('"$schema":"http');
    }
  });

  it('is far smaller than the full schemas', () => {
    const chars = (names: readonly McpToolName[], f: (n: McpToolName) => unknown) =>
      names.reduce((n, name) => n + JSON.stringify(f(name)).length, 0);
    const full = chars(MCP_TOOL_NAMES, inputJsonSchema);
    const served = chars(MCP_TOOL_NAMES, (n) => servedInputSchema(n));
    expect(served).toBeLessThan(full * 0.8);
  });
});

describe('narrowed actions (PE-05)', () => {
  const actionTypes = (name: 'request_approval' | 'perform_action', hidden: readonly string[]) => {
    const action = (servedInputSchema(name, hidden).properties as Node).action as { oneOf: Node[] };
    return action.oneOf.map((v) => ((v.properties as Node).type as { const: string }).const);
  };

  it('serves a team agent no personal action, a personal agent those of the services the person connected', () => {
    expect(hiddenActionTypes(false, [...CONNECTOR_SERVICES])).toEqual([...PERSONAL_ACTION_TYPES]);
    expect(hiddenActionTypes(true, [...CONNECTOR_SERVICES])).toEqual([]);
    expect(hiddenActionTypes(true, ['mail', 'files'])).toEqual(['calendar_invite']);
    expect(hiddenActionTypes(true, [])).toEqual([...PERSONAL_ACTION_TYPES]);
    for (const name of ['request_approval', 'perform_action'] as const) {
      const team = actionTypes(name, hiddenActionTypes(false, []));
      expect(team).toEqual(expect.arrayContaining(['deploy', 'merge_pr', 'grant_key', 'custom']));
      for (const t of PERSONAL_ACTION_TYPES) expect(team).not.toContain(t);
      expect(actionTypes(name, [])).toEqual(expect.arrayContaining([...PERSONAL_ACTION_TYPES, 'deploy']));
      // The full schema still validates every action, personal ones included.
      expect(
        MCP_TOOLS[name].input.shape.action.safeParse({
          type: 'files_trash',
          params: { fileId: 'f1', fileName: 'Old.pdf' },
        }).success,
      ).toBe(true);
    }
    const teamSchema = JSON.stringify(servedInputSchema('request_approval', hiddenActionTypes(false, [])));
    for (const t of PERSONAL_ACTION_TYPES) expect(teamSchema).not.toContain(`"${t}"`);
  });

  it('drops the definitions only a removed variant used', () => {
    const schema = {
      type: 'object',
      properties: {
        action: {
          oneOf: [
            { type: 'object', properties: { type: { const: 'a' }, x: { $ref: '#/$defs/kept' } } },
            { type: 'object', properties: { type: { const: 'b' }, y: { $ref: '#/$defs/gone' } } },
          ],
        },
      },
      $defs: { kept: { $ref: '#/$defs/deep' }, deep: { type: 'string' }, gone: { type: 'number' } },
    };
    const narrowed = withoutVariants(schema, 'action', 'type', ['b']);
    expect(Object.keys(narrowed.$defs as Node)).toEqual(['kept', 'deep']);
    expect(((narrowed.properties as Node).action as { oneOf: unknown[] }).oneOf).toHaveLength(1);
    expect(withoutVariants(schema, 'action', 'type', [])).toBe(schema);
  });
});

describe('the tools a turn can use (PE-05)', () => {
  const chat = { personal: false, answer: false, run: false };
  it('serves post_answer only in answers, the run reports only on a run, no code to a personal agent', () => {
    expect(toolFitsTurn('post_answer', chat)).toBe(false);
    expect(toolFitsTurn('post_answer', { ...chat, answer: true })).toBe(true);
    for (const name of RUN_REPORT_TOOLS) {
      expect(toolFitsTurn(name, chat)).toBe(false);
      expect(toolFitsTurn(name, { ...chat, run: true })).toBe(true);
    }
    expect(toolFitsTurn('start_run', chat)).toBe(true);
    for (const name of CODE_TOOLS)
      expect(toolFitsTurn(name, { ...chat, personal: true, run: true })).toBe(false);
    for (const name of ['post_message', 'request_approval', 'schedule'] as const) {
      expect(toolFitsTurn(name, chat)).toBe(true);
      expect(toolFitsTurn(name, { ...chat, personal: true })).toBe(true);
    }
  });

  it('serves record_deploy to team agents’ turns, not to answers or personal agents (RF-02)', () => {
    expect(toolFitsTurn('record_deploy', chat)).toBe(true);
    expect(toolFitsTurn('record_deploy', { ...chat, run: true })).toBe(true);
    expect(toolFitsTurn('record_deploy', { ...chat, answer: true })).toBe(false);
    expect(toolFitsTurn('record_deploy', { ...chat, personal: true })).toBe(false);
  });
});

describe('the list a turn is served (turn-efficiency.md TE-05)', () => {
  const team: ServedSelection = {
    turn: { personal: false, answer: false, run: false },
    usable: [],
    browser: 'preview',
    connections: false,
  };

  it('lists the contract’s tools that fit, then the browser and the connection tools; never the Vault’s relays', () => {
    const names = servedToolNames(team);
    expect(names).toContain('post_message');
    expect(names).toContain('browser_preview');
    // A page as a message shows it, with the browser that draws it (visual-replies.md).
    expect(names).toContain('page_preview');
    expect(servedToolNames({ ...team, browser: 'none' })).not.toContain('page_preview');
    for (const n of [
      'post_answer',
      'run_step',
      'skill_write',
      'propose_skill',
      'vault_request',
      'request_vault_key',
      'ssh_exec',
      'ssh_upload',
    ])
      expect(names).not.toContain(n);
    // Skills are Hermes's own tools (hermes-engine.md HE-41): Whombat serves none.
    for (const n of ['find_skill', 'read_skill']) expect(names).not.toContain(n);
    expect(names.filter((n) => n.startsWith('browser_'))).toEqual(['browser_preview']);
    const more = servedToolNames({ ...team, connections: true });
    expect(more.slice(-2)).toEqual(['connection_tools', 'connection_call']);
    expect(more.filter((n) => n.startsWith('browser_'))).toEqual(['browser_preview']);
    for (const gone of [
      'vault_request',
      'ssh_exec',
      'request_vault_key',
      'skill_write',
      'memory',
      'browser_open',
    ])
      expect(more).not.toContain(gone);
    expect(servedToolNames({ ...team, browser: 'none' }).some((n) => n.startsWith('browser_'))).toBe(false);
  });

  it('never lists the teammates’ tools (one-agent.md OA-06)', () => {
    for (const turn of [team.turn, { ...team.turn, personal: true }, { ...team.turn, answer: true }])
      for (const gone of ['delegate', 'pass_on', 'report_back'])
        expect(servedToolNames({ ...team, turn })).not.toContain(gone);
  });

  it('lists report_done in the person’s turns, never in a search answer or an outsiders’ turn (done-today.md DN-01)', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    expect(servedToolNames(personal)).toContain('report_done');
    expect(servedToolNames({ ...personal, turn: { ...personal.turn, teamWork: true } })).toContain(
      'report_done',
    );
    expect(servedToolNames(team)).not.toContain('report_done');
    expect(servedToolNames({ ...personal, turn: { ...personal.turn, answer: true } })).not.toContain(
      'report_done',
    );
    expect(toolFitsTurn('report_done', { ...personal.turn, outside: true })).toBe(false);
  });

  it('lists look_report only in the person’s look turns (look-research.md LR-05)', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    expect(servedToolNames(personal)).not.toContain('look_report');
    expect(servedToolNames({ ...personal, looks: true })).toContain('look_report');
    expect(servedToolNames({ ...team, looks: true })).not.toContain('look_report');
    expect(
      servedToolNames({ ...personal, looks: true, turn: { ...personal.turn, outside: true } }),
    ).not.toContain('look_report');
  });

  it('serves a Looks ahead check only its mail, file, doc, web and report tools (looks-ahead.md)', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    const check: ServedSelection = {
      ...personal,
      usable: [...CONNECTOR_SERVICES],
      browser: 'preview',
      connections: true,
      looks: true,
      aheadDocs: true,
      turn: { ...personal.turn, ahead: true },
    };
    expect(servedToolNames(check).sort()).toEqual(AHEAD_TOOLS.filter((n) => n !== 'ahead_triage').sort());
    // Without Paperless/Notion connected, ahead_read_docs stays unlisted.
    expect(servedToolNames({ ...check, aheadDocs: false })).not.toContain('ahead_read_docs');
    // Without the mail connected, no mail tools.
    expect(servedToolNames({ ...check, usable: ['calendar'] })).not.toContain('mail_read');
    // Its own tools nowhere else.
    for (const name of [
      'search_web',
      'read_web_page',
      'ahead_read_docs',
      'ahead_report',
      'ahead_triage',
    ] as const) {
      expect(servedToolNames({ ...personal, usable: [...CONNECTOR_SERVICES] })).not.toContain(name);
      expect(toolFitsTurn(name, { ...personal.turn, outside: true })).toBe(false);
    }
  });

  it('serves the weather and the news in the person’s turns, automations and checks, never to outsiders (weather-news.md)', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    for (const name of ['weather_forecast', 'news_headlines'] as const) {
      expect(servedToolNames(personal)).toContain(name);
      expect(servedToolNames({ ...personal, automationStep: true })).toContain(name);
      expect(servedToolNames({ ...personal, turn: { ...personal.turn, ahead: true } })).toContain(name);
      expect(
        servedToolNames({ ...personal, turn: { ...personal.turn, ahead: true, aheadTriage: true } }),
      ).not.toContain(name);
      expect(toolFitsTurn(name, { ...personal.turn, outside: true })).toBe(false);
    }
  });

  it('serves a triage pass only ahead_triage, and no other check ahead_triage (looks-ahead.md)', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    const check: ServedSelection = {
      ...personal,
      usable: [...CONNECTOR_SERVICES],
      browser: 'preview',
      connections: true,
      aheadDocs: true,
      turn: { ...personal.turn, ahead: true },
    };
    expect(servedToolNames({ ...check, turn: { ...check.turn, aheadTriage: true } })).toEqual([
      'ahead_triage',
    ]);
    expect(servedToolNames(check)).not.toContain('ahead_triage');
  });

  it('lists ahead_watch only in a turn the person began themselves (looks-ahead.md)', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    expect(servedToolNames(personal)).not.toContain('ahead_watch');
    expect(servedToolNames({ ...personal, aheadWatch: true })).toContain('ahead_watch');
    expect(servedToolNames({ ...personal, aheadWatch: true, automationStep: true })).not.toContain(
      'ahead_watch',
    );
    expect(
      servedToolNames({ ...personal, aheadWatch: true, turn: { ...personal.turn, ahead: true } }),
    ).not.toContain('ahead_watch');
    expect(
      servedToolNames({ ...personal, aheadWatch: true, turn: { ...personal.turn, outside: true } }),
    ).not.toContain('ahead_watch');
  });

  it('lists ahead_feedback only in the person’s turn in a finding’s thread', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    expect(servedToolNames(personal)).not.toContain('ahead_feedback');
    expect(servedToolNames({ ...personal, aheadThread: true })).toContain('ahead_feedback');
    expect(
      servedToolNames({ ...personal, aheadThread: true, turn: { ...personal.turn, ahead: true } }),
    ).not.toContain('ahead_feedback');
  });

  it('serves an automation’s step neither the automation tools nor schedule', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    for (const n of ['schedule', 'draft_automation', 'automation_read']) {
      expect(servedToolNames(personal)).toContain(n);
      expect(servedToolNames({ ...personal, automationStep: true })).not.toContain(n);
    }
    expect(servedToolNames({ ...personal, automationStep: true })).toContain('post_message');
  });

  it('lists report_assessment only in an automation’s assessment turn (AR-24)', () => {
    expect(servedToolNames(team)).not.toContain('report_assessment');
    expect(servedToolNames({ ...team, assesses: false })).not.toContain('report_assessment');
    expect(servedToolNames({ ...team, assesses: true })).toContain('report_assessment');
  });

  it('serves a personal agent the tools of the services the person connected, and no code tools', () => {
    const personal = { ...team, turn: { ...team.turn, personal: true } };
    expect(servedToolNames(personal)).not.toContain('start_run');
    const mail = servedToolNames({ ...personal, usable: ['mail'] });
    expect(mail.length).toBeGreaterThan(servedToolNames(personal).length);
  });

  it('lists the Vault’s own tools of the context, nothing relayed or bridged (HE-43)', () => {
    const tools = servedVaultTools(['vault_save', 'vault_request', 'vt_cf__purge']);
    expect(tools.map((t) => t.name)).toEqual(['vault_save']);
  });
});

describe('cards and actions by turn shape (turn-efficiency.md TE-11)', () => {
  const team = { personal: false, answer: false, run: false };
  const kinds = (hidden: readonly string[]) => {
    const card = (servedInputSchema('post_card', hidden).properties as Node).card as { oneOf: Node[] };
    return card.oneOf.map((v) => ((v.properties as Node).kind as { const: string }).const);
  };
  const actions = (hidden: readonly string[]) => {
    const action = (servedInputSchema('request_approval', hidden).properties as Node).action as {
      oneOf: Node[];
    };
    return action.oneOf.map((v) => ((v.properties as Node).type as { const: string }).const);
  };

  it('serves a team agent no digest, and no push request outside a run', () => {
    const chat = hiddenVariants(team, []);
    expect(kinds(chat)).toEqual(POSTABLE_CARD_KINDS.filter((k) => k !== 'digest'));
    expect(actions(chat)).not.toContain('push_shared_branch');
    expect(actions(chat)).toEqual(expect.arrayContaining(['deploy', 'merge_pr', 'grant_key', 'custom']));
    expect(actions(hiddenVariants({ ...team, run: true }, []))).toContain('push_shared_branch');
  });

  it('serves the assistant shell’s assistant a team agent’s code tools, actions and cards (AN-10)', () => {
    const shell = { ...team, personal: true, teamWork: true };
    const hidden = hiddenVariants(shell, ['mail']);
    expect(kinds(hidden)).toEqual(POSTABLE_CARD_KINDS);
    expect(actions(hidden)).toEqual(expect.arrayContaining(['deploy', 'merge_pr', 'mail_send']));
    expect(actions(hidden)).not.toContain('push_shared_branch');
    expect(actions(hiddenVariants({ ...shell, run: true }, ['mail']))).toContain('push_shared_branch');
    for (const name of ['start_run', 'open_pull_request', 'merge_pull_request', 'record_deploy'] as const)
      expect(toolFitsTurn(name, shell), name).toBe(true);
    expect(toolFitsTurn('start_run', { ...shell, teamWork: false })).toBe(false);
  });

  it('keeps what every card and action it serves says, and the full schema still validates the rest', () => {
    const full = inputJsonSchema('post_card') as Node;
    const served = servedInputSchema('post_card', ['digest']);
    const variants = ((full.properties as Node).card as { oneOf: Node[] }).oneOf.filter(
      (v) => ((v.properties as Node).kind as { const: string }).const !== 'digest',
    );
    expect(meaning(((served.properties as Node).card as { oneOf: Node[] }).oneOf)).toEqual(meaning(variants));
    expect(
      MCP_TOOLS.post_card.input.shape.card.safeParse({
        kind: 'digest',
        title: 'Inbox',
        sections: [{ label: 'Worth a look', items: [{ title: 'Invoice' }] }],
      }).success,
    ).toBe(true);
  });
});

describe('only what this Whombat can do (turn-overhead.md TO-03, TO-04)', () => {
  const shell: ServedSelection = {
    turn: { personal: true, answer: false, run: false, teamWork: true, code: false },
    usable: [],
    browser: 'preview',
    connections: true,
  };
  const schemaOf = (sel: ServedSelection, name: McpToolName) =>
    servedTools(sel).find((t) => t.name === name)?.inputSchema as Node;
  /** Every `type` a union member of the schema stands for, at any depth. */
  const unionTypes = (node: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(node)) for (const v of node) unionTypes(v, out);
    else if (typeof node === 'object' && node !== null)
      for (const [k, v] of Object.entries(node as Node)) {
        if ((k === 'oneOf' || k === 'anyOf') && Array.isArray(v))
          for (const m of v) {
            const t = ((m as Node)?.properties as Node | undefined)?.type as { const?: string } | undefined;
            if (t?.const) out.add(t.const);
          }
        unionTypes(v, out);
      }
    return out;
  };

  it('serves no code tools, cards, actions or links without a repository or GitHub', () => {
    const names = servedToolNames(shell);
    for (const name of [...CODE_TOOLS, 'record_deploy'] as const) expect(names, name).not.toContain(name);
    expect(names).toEqual(expect.arrayContaining(['reply_in_thread', 'post_card', 'request_approval']));
    expect(hiddenVariants(shell.turn, [])).toEqual(expect.arrayContaining([...NO_CODE_HIDDEN]));
    const links = unionTypes(schemaOf(shell, 'post_card'));
    for (const gone of NO_CODE_LINKS) expect(links, gone).not.toContain(gone);
    for (const kept of ['message', 'chat', 'approval', 'external']) expect(links.has(kept), kept).toBe(true);
  });

  it('serves them all when the burrow can do code work, as before', () => {
    const code = { ...shell, turn: { ...shell.turn, code: true } };
    expect(servedToolNames(code)).toEqual(
      expect.arrayContaining(['start_run', 'merge_pull_request', 'record_deploy']),
    );
    const links = unionTypes(schemaOf(code, 'post_card'));
    for (const kept of NO_CODE_LINKS) expect(links.has(kept), kept).toBe(true);
    const { code: _, ...absent } = code.turn;
    expect(servedToolNames({ ...code, turn: absent })).toEqual(servedToolNames(code));
  });

  it('doesn’t offer actions nothing here carries out', () => {
    const sel = {
      ...shell,
      turn: { ...shell.turn, code: true },
      unavailableActions: OPTIONAL_EXECUTOR_ACTION_TYPES,
    };
    for (const name of ['request_approval', 'perform_action'] as const) {
      const actions = unionTypes(schemaOf(sel, name));
      for (const gone of OPTIONAL_EXECUTOR_ACTION_TYPES)
        expect(actions.has(gone), `${name} ${gone}`).toBe(false);
      expect(actions.has('grant_key')).toBe(true);
    }
  });
});

describe('an outsiders’ turn (outsiders-turns.md OT-01…OT-03)', () => {
  const outside: ServedSelection = {
    turn: { personal: false, answer: false, run: false, teamWork: true, outside: true },
    usable: ['mail', 'calendar', 'files'],
    browser: 'preview',
    connections: true,
  };

  it('fits only the allowlist, whatever else its shape would allow', () => {
    for (const name of MCP_TOOL_NAMES) {
      const allowed = (OUTSIDERS_TOOLS as readonly string[]).includes(name);
      if (!allowed) expect(toolFitsTurn(name, { ...outside.turn, run: true }), name).toBe(false);
    }
    for (const name of ['read_conversation', 'reply_in_thread', 'read_attachment'] as const)
      expect(toolFitsTurn(name, outside.turn), name).toBe(true);
    for (const name of ['post_message', 'post_card', 'search', 'schedule', 'set_status'] as const)
      expect(toolFitsTurn(name, outside.turn), name).toBe(false);
  });

  it('opens a pull request only with a writable checkout and code work', () => {
    expect(toolFitsTurn('open_pull_request', outside.turn)).toBe(false);
    expect(toolFitsTurn('open_pull_request', { ...outside.turn, run: true })).toBe(true);
    expect(toolFitsTurn('open_pull_request', { ...outside.turn, run: true, code: false })).toBe(false);
  });

  it('is served a subset of the allowlist: no browser, account or Vault tool, even if selected', () => {
    const names = servedToolNames({ ...outside, connections: false });
    for (const name of names) expect(OUTSIDERS_TOOLS as readonly string[], name).toContain(name);
    expect([...names].sort()).toEqual(
      ['completion_evidence', 'read_attachment', 'read_conversation', 'reply_in_thread'].sort(),
    );
  });

  it('gets the connection tools only with a connection it sees: T3 Code, on a tracker report (OT-11)', () => {
    expect(servedToolNames(outside)).toEqual(expect.arrayContaining(['connection_tools', 'connection_call']));
  });

  it('gets its automation step’s own tools only where the step has them', () => {
    expect(servedToolNames({ ...outside, assesses: true })).toContain('report_assessment');
    expect(servedToolNames({ ...outside, proposes: false })).not.toContain('propose_connection_actions');
    expect(servedToolNames({ ...outside, proposes: true })).toContain('propose_connection_actions');
    expect(servedToolNames({ ...outside, tracker: { report: true, read: false } })).toContain('tracker_item');
    expect(servedToolNames({ ...outside, tracker: { report: true, read: false } })).not.toContain(
      'tracker_read',
    );
    expect(servedToolNames({ ...outside, tracker: { report: true, read: true } })).toContain('tracker_read');
    expect(servedToolNames({ ...outside, turn: { ...outside.turn, run: true } })).toContain(
      'open_pull_request',
    );
  });

  it('leaves the person’s turns as they were', () => {
    const { outside: _, ...person } = outside.turn;
    expect(servedToolNames({ ...outside, turn: person })).toEqual(
      servedToolNames({ ...outside, turn: { ...person, outside: false } }),
    );
    expect(servedToolNames({ ...outside, turn: person })).toEqual(
      expect.arrayContaining(['post_message', 'schedule', 'browser_preview', 'connection_call']),
    );
  });
});

describe('whether a called tool is served', () => {
  /** Turn shapes and selections across every rule's inputs: each flag on and off, outsiders' turns among them. */
  function selections(): ServedSelection[] {
    const out: ServedSelection[] = [];
    const flags = [false, true];
    for (const personal of flags)
      for (const answer of flags)
        for (const run of flags)
          for (const teamWork of flags)
            for (const code of flags)
              for (const outside of flags)
                for (const extra of [0, 1, 2])
                  out.push({
                    turn: { personal, answer, run, teamWork, code, outside },
                    usable: extra === 1 ? ['mail', 'calendar', 'files'] : [],
                    browser: extra === 0 ? 'none' : 'preview',
                    connections: extra !== 0,
                    assesses: extra === 1,
                    looks: extra === 2,
                    tracker: { report: extra !== 0, read: extra === 2 },
                    automationStep: extra === 1,
                    council: extra !== 1,
                  });
    return out;
  }

  it('answers exactly what the list says, for every tool and turn', () => {
    for (const sel of selections()) {
      const listed = servedToolNames(sel);
      for (const name of MCP_TOOL_NAMES) expect(servesTool(name, sel), name).toBe(listed.includes(name));
    }
  });

  it('loads only the parts of the selection the rules read for that tool, with the same answer', async () => {
    for (const sel of selections().filter((_, i) => i % 7 === 0)) {
      const listed = servedToolNames(sel);
      for (const name of [
        'plan_read',
        'post_answer',
        'mail_search',
        'connection_call',
        'look_report',
      ] as const) {
        const asked: string[] = [];
        const load = Object.fromEntries(
          Object.entries(sel).map(([key, value]) => [
            key,
            async () => {
              asked.push(key);
              return value;
            },
          ]),
        ) as unknown as SelectionLoaders;
        for (const key of [
          'assesses',
          'looks',
          'tracker',
          'unavailableActions',
          'automationStep',
          'council',
        ] as const)
          load[key] ??= async () => {
            asked.push(key);
            return undefined;
          };
        expect(await servesToolLazily(name, load), name).toBe(listed.includes(name));
        expect(new Set(asked).size, name).toBe(asked.length);
        if (name === 'plan_read') expect(asked).toEqual(['turn']);
        expect(asked, name).not.toContain('unavailableActions');
        if (name !== 'mail_search') expect(asked, name).not.toContain('usable');
      }
    }
  });

  it('loads every part at once for the whole list', async () => {
    const sel = selections()[5] as ServedSelection;
    const load = Object.fromEntries(
      Object.entries({ ...sel, unavailableActions: ['deploy'] }).map(([key, value]) => [
        key,
        async () => value,
      ]),
    ) as unknown as SelectionLoaders;
    expect(await loadSelection(load)).toEqual({ ...sel, unavailableActions: ['deploy'] });
  });
});

describe('the council’s tools (council.md CNL-03, CNL-05)', () => {
  const person: ServedSelection = {
    turn: { personal: true, answer: false, run: false, teamWork: true, code: false },
    usable: [],
    browser: 'preview',
    connections: true,
  };
  const COUNCIL = ['council_start', 'council_note', 'council_tell', 'council_finish', 'council_read'];

  it('are served in the person’s own turns while T3 Code manages', () => {
    expect(servedToolNames({ ...person, council: true })).toEqual(expect.arrayContaining(COUNCIL));
  });

  it('are not served without T3 Code, in an automation’s step or a turn for nobody', () => {
    const none = (sel: ServedSelection) =>
      COUNCIL.filter((n) => servedToolNames(sel).includes(n as McpToolName));
    expect(none(person)).toEqual([]);
    expect(none({ ...person, council: true, automationStep: true })).toEqual([]);
    expect(none({ ...person, council: true, turn: { ...person.turn, personal: false } })).toEqual([]);
    expect(none({ ...person, council: true, turn: { ...person.turn, outside: true } })).toEqual([]);
  });
});

describe('the delegation’s tools (delegate.md)', () => {
  const person: ServedSelection = {
    turn: { personal: true, answer: false, run: false, teamWork: true, code: false },
    usable: [],
    browser: 'preview',
    connections: true,
  };
  const DELEGATE = ['delegate_offer', 'delegate_update', 'delegate_finish', 'delegate_read'];

  it('are served in the person’s own turns while T3 Code manages, and nowhere else', () => {
    expect(servedToolNames({ ...person, council: true })).toEqual(expect.arrayContaining(DELEGATE));
    const none = (sel: ServedSelection) =>
      DELEGATE.filter((n) => servedToolNames(sel).includes(n as McpToolName));
    expect(none(person)).toEqual([]);
    expect(none({ ...person, council: true, automationStep: true })).toEqual([]);
    expect(none({ ...person, council: true, turn: { ...person.turn, personal: false } })).toEqual([]);
  });
});

describe('the tools for reports to the Whombat Team (team-reports.md)', () => {
  const person: ServedSelection = {
    turn: { personal: true, answer: false, run: false, teamWork: true, code: false },
    usable: [],
    browser: 'preview',
    connections: true,
  };
  const TEAM = ['report_to_whombat_team', 'whombat_team_reports'];
  const served = (sel: ServedSelection) =>
    TEAM.filter((n) => servedToolNames(sel).includes(n as McpToolName));

  it('are served in the person’s own turns where they can send reports or have some', () => {
    expect(served({ ...person, teamReports: true })).toEqual(TEAM);
  });

  it('are not served elsewhere: no reports here, an automation’s step, a turn for nobody, an outsiders’ turn', () => {
    expect(served(person)).toEqual([]);
    expect(served({ ...person, teamReports: true, automationStep: true })).toEqual([]);
    expect(served({ ...person, teamReports: true, turn: { ...person.turn, personal: false } })).toEqual([]);
    expect(served({ ...person, teamReports: true, turn: { ...person.turn, outside: true } })).toEqual([]);
  });
});
