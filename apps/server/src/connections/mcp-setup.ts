/**
 * Whombat turns a missing MCP server on itself (docs/decisions/connections-catalog.md CX-54a; contracts CT-310): when
 * the entry has `mcpSetup` and its MCP server answers 404, Home Assistant's Model Context Protocol Server integration
 * (`ha_config_flow`, handler `mcp_server`) is added through Home Assistant's config flow API, as the connection:
 * `POST /api/config/config_entries/flow {handler}`, then the flow's form is submitted (empty in current versions; older
 * ones ask which LLM API, answered with Assist). Needs a Home Assistant administrator's token (401 otherwise). The
 * integration allows one entry, so a second attempt aborts instead of adding another.
 */
import type { CatalogEntry } from '@whombat/core';
import type { Services } from '../services';
import { VaultCallError } from '../vault/net';
import { jsonOf, signedConnectionFetch } from './http';
import type { CatalogConnectionRow } from './types';

export type McpSetupOutcome =
  | { done: true }
  /** What the check says instead (in our words): why Whombat couldn't, and what a person can do. */
  | { done: false; message: string | null };

const FLOW_PATH = '/api/config/config_entries/flow';
/** Older Home Assistants ask which LLM API the server offers; Assist is the one that controls the home. */
const LLM_API_FIELD = 'llm_hass_api';

interface FlowResult {
  type?: unknown;
  flow_id?: unknown;
  reason?: unknown;
  data_schema?: unknown;
}

/** The answer to the flow's form: nothing, or Assist for an older version's LLM API question. */
export function flowAnswer(schema: unknown): Record<string, unknown> {
  if (!Array.isArray(schema)) return {};
  const field = schema.find(
    (f): f is { name: string; selector?: { select?: { multiple?: boolean } } } =>
      typeof f === 'object' && f !== null && (f as { name?: unknown }).name === LLM_API_FIELD,
  );
  if (!field) return {};
  return { [LLM_API_FIELD]: field.selector?.select?.multiple === false ? 'assist' : ['assist'] };
}

async function post(
  services: Services,
  row: CatalogConnectionRow,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: FlowResult | null }> {
  const res = await signedConnectionFetch(services, row, {
    method: 'POST',
    url: `${row.baseUrl}${path}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = jsonOf(res);
  return { status: res.status, json: json && typeof json === 'object' ? (json as FlowResult) : null };
}

function notDone(entry: CatalogEntry, reason?: string): McpSetupOutcome {
  const hint = entry.mcpMissingHint;
  return { done: false, message: reason ? (hint ? `${reason} ${hint}` : reason) : hint };
}

function refused(entry: CatalogEntry, status: number): McpSetupOutcome | null {
  if (status === 401 || status === 403)
    return notDone(entry, 'Whombat couldn’t add it: the token isn’t a Home Assistant administrator’s.');
  if (status >= 300) return notDone(entry);
  return null;
}

/** Adds the entry's MCP server integration. Never throws: a failure is an outcome. */
export async function setUpMcp(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
): Promise<McpSetupOutcome> {
  if (entry.mcpSetup?.kind !== 'ha_config_flow' || !row.baseUrl) return notDone(entry);
  try {
    const started = await post(services, row, FLOW_PATH, {
      handler: entry.mcpSetup.handler,
      show_advanced_options: false,
    });
    let result = started.json;
    const startRefused = refused(entry, started.status);
    if (startRefused) return startRefused;
    for (let step = 0; step < 3 && result?.type === 'form'; step++) {
      if (typeof result.flow_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(result.flow_id))
        return notDone(entry);
      const next = await post(
        services,
        row,
        `${FLOW_PATH}/${result.flow_id}`,
        flowAnswer(result.data_schema),
      );
      const stepRefused = refused(entry, next.status);
      if (stepRefused) return stepRefused;
      result = next.json;
    }
    if (result?.type === 'create_entry') return { done: true };
    if (result?.type === 'abort' && result.reason === 'single_instance_allowed')
      return {
        done: false,
        message:
          'The Model Context Protocol Server integration is in Home Assistant but doesn’t answer: check that it’s enabled (Settings → Devices & services). Until then agents use the REST API.',
      };
    return notDone(entry);
  } catch (err) {
    services.log.warn(
      { err: err instanceof VaultCallError ? err.message : err instanceof Error ? err.name : 'error' },
      'could not set up the connection’s MCP server',
    );
    return notDone(entry);
  }
}
