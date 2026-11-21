/**
 * “Check connection” (docs/decisions/vault.md VT-44), the person's: an `mcp` entry initialises and lists its tools, an
 * `http` entry answers a GET of its base URL. The destination rule runs first (VT-13, the reason in full). Results:
 * “Reached · 12 tools”, “Reached · answered 200”, “The server rejected the secret (401).”, “Couldn’t reach it.”,
 * “Not allowed: …”. Nothing the server said is kept or shown; listed tools are scrubbed before they are stored.
 */
import {
  type RemoteVaultTool,
  VAULT_TOOLS_MAX,
  type VaultAuth,
  type VaultCheckOutcome,
  type VaultCheckResult,
  vaultCheckSummary,
  vaultCredential,
  withCredentialQuery,
} from '@whombat/core';
import { iso } from '../lib/time';
import { McpClientPool } from '../mcp/client-pool';
import type { Services } from '../services';
import { fieldError } from './commands';
import { VAULT_TOOL_OUTPUT_MAX } from './limits';
import { callDeadlineMs, destinationProblem, summarise, type VaultCallError, vaultFetch } from './net';
import { withCredentialHeaders } from './scrub';
import { type VaultEntryRow, vaultSecretAad } from './store';

/** A raw JSON-RPC answer is read up to this much. */
const ANSWER_MAX = 1024 * 1024;

/**
 * An `mcp` entry's tools, on a fresh connection closed again (`initialize`, `tools/list`): streamable HTTP through
 * `vaultFetch` (the destination rule, pinned DNS, no redirects, a deadline, capped answers), the credential added last.
 */
async function listMcpTools(
  services: Services,
  entry: VaultEntryRow,
  auth: VaultAuth,
  secret: string | null,
): Promise<RemoteVaultTool[]> {
  const url = entry.url as string;
  const credential = secret !== null ? vaultCredential(auth, secret) : null;
  const target = withCredentialQuery(url, credential?.query ?? null);
  const pool = new McpClientPool({
    clientName: 'whombat-vault',
    deadlineMs: () => callDeadlineMs(services),
    idleMs: 0,
    outputMax: VAULT_TOOL_OUTPUT_MAX,
  });
  try {
    return await pool.listTools({
      key: entry.id,
      url,
      version: `check:${Date.now()}`,
      forms: secret ? [{ secret, username: auth.type === 'basic' ? auth.username : undefined }] : [],
      post: (sent, body) =>
        vaultFetch(
          services,
          url,
          target,
          { method: 'POST', headers: withCredentialHeaders(sent, credential?.headers ?? {}), body },
          { maxBytes: ANSWER_MAX },
        ),
    });
  } finally {
    await pool.close();
  }
}

export interface CheckRun {
  result: VaultCheckResult;
  /** An `mcp` entry that was reached: the first `VAULT_TOOLS_MAX` tools as listed (scrubbed, bounded, unique). */
  tools: RemoteVaultTool[] | null;
  /** Tools listed beyond those (ignored, counted). */
  beyond: number;
}

function outcomeOfFailure(failure: VaultCallError, kind: 'mcp' | 'http'): VaultCheckOutcome {
  if (failure.status === 401 || failure.status === 403) return 'rejected';
  switch (failure.reason) {
    case 'timeout':
      return 'timeout';
    case 'not_allowed':
      return 'not_allowed';
    case 'unreachable':
      return 'unreachable';
    default:
      return kind === 'mcp' ? 'bad_answer' : 'unreachable';
  }
}

export async function runCheck(services: Services, entry: VaultEntryRow): Promise<CheckRun> {
  if (entry.kind === 'secret' || !entry.url) throw fieldError({ url: ['This secret has nothing to check.'] });
  // A website login is checked by Test sign-in in the browser (VT-D31), not by a request.
  if (entry.kind === 'login') throw fieldError({ url: ['Use Test sign-in to check a login.'] });
  // An SSH key's servers are checked one by one (contracts 0.32.0, VT-S05), never the entry.
  if (entry.kind === 'ssh') throw fieldError({ url: ['Check each server of an SSH key.'] });
  const kind = entry.kind;
  const auth = entry.auth as VaultAuth;
  const checkedAt = iso(services.clock());
  const finish = (
    outcome: VaultCheckOutcome,
    facts: { httpStatus?: number | null; toolCount?: number | null; reason?: string },
    tools: RemoteVaultTool[] | null = null,
  ): CheckRun => ({
    beyond: Math.max(0, (facts.toolCount ?? 0) - (tools?.length ?? 0)),
    result: {
      outcome,
      status: outcome === 'reached' ? 'reached' : 'failing',
      summary: vaultCheckSummary(outcome, {
        kind,
        httpStatus: facts.httpStatus ?? null,
        toolCount: facts.toolCount ?? null,
        ...(facts.reason ? { reason: facts.reason } : {}),
      }).slice(0, 300),
      httpStatus: facts.httpStatus ?? null,
      toolCount: facts.toolCount ?? null,
      checkedAt,
    },
    tools,
  });
  const problem = await destinationProblem(services, entry.url, 'save');
  if (problem) return finish('not_allowed', { reason: problem.message });
  if (auth.type !== 'none' && entry.sealed === null) throw fieldError({ secret: ['Set the secret first.'] });
  const secret = entry.sealed === null ? null : services.custody.open(vaultSecretAad(entry.id), entry.sealed);
  try {
    if (kind === 'mcp') {
      const tools = await listMcpTools(services, entry, auth, secret);
      // Only what an entry keeps goes into the record (VT-07: 64 tools); the rest is counted.
      const seen = new Set<string>();
      const unique = tools.filter((t) => !seen.has(t.name) && seen.add(t.name));
      return finish('reached', { toolCount: unique.length }, unique.slice(0, VAULT_TOOLS_MAX));
    }
    const credential = secret === null ? null : vaultCredential(auth, secret);
    const res = await vaultFetch(
      services,
      entry.url,
      withCredentialQuery(entry.url, credential?.query ?? null),
      { method: 'GET', headers: withCredentialHeaders({}, credential?.headers ?? {}) },
      { truncateAt: 1024 },
    );
    if (res.status === 401 || res.status === 403) return finish('rejected', { httpStatus: res.status });
    return finish('reached', { httpStatus: res.status >= 100 && res.status <= 599 ? res.status : null });
  } catch (err) {
    const failure = summarise(err);
    const outcome = outcomeOfFailure(failure, kind);
    return finish(outcome, {
      httpStatus: failure.status,
      ...(outcome === 'not_allowed' ? { reason: failure.message } : {}),
    });
  }
}
