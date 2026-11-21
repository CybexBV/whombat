/**
 * External execution for a `connection_actions` step marked `running` after the person approved its card. Runs outside
 * any DB transaction, re-verifies the approval and every connection's current settings/limits, and executes each call
 * through `executeConnectionCall`.
 */
import {
  type AutomationStep,
  CONNECTOR_BINARY_MAX_BYTES,
  catalogEntry,
  lookOnlyText,
  requestAllowed,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { callArgsAad, callTier, executeConnectionCall, needsReauthText } from '../../connections/call';
import { isCallableEntry } from '../../connections/callable';
import { keyTierOf } from '../../connections/context';
import { limitsProblem } from '../../connections/limits';
import { ConnectionArgumentError, normaliseRequestArgs, parseRequestUpload } from '../../connections/request';
import { normaliseSocketArgs } from '../../connections/socket/call';
import { catalogConnections, connectionTools } from '../../db/schema/index';
import { limitWordsFor } from '../../devices/store';
import { thePerson } from '../../domain/the-person';
import { readAll } from '../../files/previews';
import { callServerOf } from '../../hosts/asks';
import { loadGrants } from '../../read/principals';
import { automationAgent, publisherCheck } from '../authority';
import {
  actionsDoneLine,
  approvedActionsRequest,
  hashPlannedActions,
  isProposableEntry,
  proposeCallRefusal,
  threadAttachment,
} from '../proposed-actions';
import { stepRoomsCheck } from '../steps';
import type { AutomationStepRow } from '../store';
import type { LeasedRun } from './step-ops';

interface PreparedAction {
  callId: string;
  connectionId: string;
  handle: string;
  label: string;
  tool: string;
  toolHash: string;
  description?: string;
  summary: string;
  argsEnc: string;
}

export async function runConnectionActions(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'connection_actions' }>,
): Promise<void> {
  const { services, run } = lease;
  const db = services.db;
  const out = row.output as {
    actionsApprovalId?: string;
    actionsHash?: string;
    actions?: PreparedAction[];
  };
  const refuse = (error: string) =>
    lease.commit({ op: 'settle', idx: row.idx, state: 'blocked', error, from: ['running'] });

  const who = await publisherCheck(db, run.burrowId, run.publishedById);
  if (!who.ok) return void (await refuse(who.reason));
  const rooms = await stepRoomsCheck(db, run, row.idx, who.publisher);
  if (!rooms.ok) return void (await refuse(rooms.reason));

  // Belt-and-braces: never execute without a verified approved approval row matching this run, step, attempt and hash.
  if (
    !out.actionsApprovalId ||
    !out.actionsHash ||
    !(await approvedActionsRequest(db, out.actionsApprovalId, run.id, step, row.attempt, out.actionsHash))
  ) {
    return void (await refuse('These actions changed since you approved them, so they need a new approval.'));
  }

  const actions = Array.isArray(out.actions) ? out.actions : [];
  if (actions.length === 0) {
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'skipped',
      error: 'No actions were proposed.',
      output: { ran: false, count: 0 },
      from: ['running'],
    });
    return;
  }

  const agent = await automationAgent(db, run.burrowId);
  if (!agent) return void (await refuse('The burrow’s agent isn’t available.'));
  const grants = await loadGrants(db, agent.id);
  const person = await thePerson(db, run.burrowId);
  const maxUpload = Math.min(CONNECTOR_BINARY_MAX_BYTES, services.files.maxBytes);

  // Open and re-validate every action before sending any network request.
  const ready: { action: PreparedAction; args: Record<string, unknown> }[] = [];
  for (const action of actions) {
    const [conn] = await db
      .select()
      .from(catalogConnections)
      .where(
        and(eq(catalogConnections.id, action.connectionId), eq(catalogConnections.burrowId, run.burrowId)),
      );
    const entry = conn ? catalogEntry(conn.catalogId) : null;
    if (!conn || !entry || !isCallableEntry(entry))
      return void (await refuse(`${action.label} isn’t connected any more.`));
    if (!isProposableEntry(entry))
      return void (await refuse(`Actions on ${conn.label} can’t be proposed from an outsiders’ run.`));
    if (conn.status !== 'active') return void (await refuse(needsReauthText(conn)));
    const [tool] = await db
      .select()
      .from(connectionTools)
      .where(and(eq(connectionTools.connectionId, conn.id), eq(connectionTools.name, action.tool)));
    if (!tool || tool.hash !== action.toolHash)
      return void (await refuse(`${action.tool} on ${conn.label} changed since you approved it.`));
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(services.custody.open(callArgsAad(action.callId), action.argsEnc)) as Record<
        string,
        unknown
      >;
    } catch {
      return void (await refuse('The approved action details could not be opened.'));
    }
    if (tool.origin === 'request') {
      try {
        args = normaliseRequestArgs(args);
      } catch (err) {
        return void (await refuse(
          `${conn.label}: ${err instanceof ConnectionArgumentError ? err.message : 'invalid request arguments.'}`,
        ));
      }
      const refused = proposeCallRefusal(entry, tool, args, conn.label);
      if (refused) return void (await refuse(refused));
      if (!requestAllowed(entry, conn.fields, String(args.method), String(args.path)))
        return void (await refuse(`${conn.label} no longer allows that request.`));
      const upload = parseRequestUpload(args.upload);
      if (upload) {
        const att = await threadAttachment(db, run, upload.attachmentId);
        if (!att?.blobKey || att.size > maxUpload)
          return void (await refuse(`The attachment to upload to ${conn.label} isn’t available any more.`));
      }
    } else if (tool.origin === 'socket') {
      try {
        args = normaliseSocketArgs(entry, args, conn.label);
      } catch (err) {
        return void (await refuse(
          `${conn.label}: ${err instanceof ConnectionArgumentError ? err.message : 'invalid socket arguments.'}`,
        ));
      }
      const refused = proposeCallRefusal(entry, tool, args, conn.label);
      if (refused) return void (await refuse(refused));
    } else {
      const refused = proposeCallRefusal(entry, tool, args, conn.label);
      if (refused) return void (await refuse(refused));
    }
    const server = await callServerOf(db, services, conn.burrowId, conn.catalogId, args);
    const decided = callTier(
      entry,
      tool,
      args,
      (keyId) => keyTierOf(agent.id, grants, keyId),
      conn.access,
      server,
    );
    if (decided.lookOnly) return void (await refuse(lookOnlyText(conn.label)));
    if (decided.toolTier === 'off')
      return void (await refuse(`${tool.name} is turned off for ${conn.label}.`));
    if (decided.keyTier === 'cannot')
      return void (await refuse(`${agent.name} isn’t allowed to use ${conn.label}.`));
    const outside = limitsProblem(tool.limits, args, await limitWordsFor(db, conn, tool));
    if (outside) return void (await refuse(outside));
    ready.push({ action, args });
  }

  // Re-verify the exact batch hash against what was approved before sending any network call.
  const openedHash = hashPlannedActions(
    ready.map(({ action, args }) => ({
      connectionId: action.connectionId,
      tool: action.tool,
      toolHash: action.toolHash,
      description: action.description ?? action.summary,
      summary: action.summary,
      args,
    })),
  );
  if (openedHash !== out.actionsHash) {
    return void (await refuse('These actions changed since you approved them, so they need a new approval.'));
  }

  // Resolver scoped strictly to ready attachments on THIS run's thread.
  const uploadAttachment = async (attachmentId: string) => {
    const att = await threadAttachment(db, run, attachmentId);
    if (!att?.blobKey || att.size > maxUpload) return null;
    const bytes = await readAll(services.files.store, att.blobKey);
    if (!bytes) return null;
    return { name: att.name, contentType: att.contentType, bytes };
  };

  const results: { handle: string; label: string; summary: string; ok: boolean; status?: number }[] = [];
  for (const { action, args } of ready) {
    const shown = action.description ?? action.summary;
    const res = await executeConnectionCall(services, {
      burrowId: run.burrowId,
      agentId: agent.id,
      connectionId: action.connectionId,
      tool: action.tool,
      handle: action.handle,
      callId: action.callId,
      args,
      where: null,
      conversationId: run.conversationId,
      personId: person?.id ?? null,
      threadRootId: run.threadRootId,
      change: shown,
      approvalId: out.actionsApprovalId,
      uploadAttachment,
    });
    if (res.kind === 'failed' || res.output.isError) {
      const reason =
        res.kind === 'failed'
          ? res.message
          : res.output.httpStatus
            ? `${action.label} answered HTTP ${res.output.httpStatus}.`
            : `${action.label} said it couldn’t do it.`;
      results.push({
        handle: action.handle,
        label: action.label,
        summary: shown,
        ok: false,
        ...(res.kind === 'ok' && res.output.httpStatus ? { status: res.output.httpStatus } : {}),
      });
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'failed',
        error: `${action.label} couldn’t complete “${shown}”: ${reason}`.slice(0, 1000),
        output: { ran: results.some((r) => r.ok), count: results.filter((r) => r.ok).length, results },
        from: ['running'],
      });
      return;
    }
    results.push({
      handle: action.handle,
      label: action.label,
      summary: shown,
      ok: true,
      ...(res.output.httpStatus ? { status: res.output.httpStatus } : {}),
    });
  }

  const doneLine = actionsDoneLine(
    ready.map((r) => ({
      label: r.action.label,
      description: r.action.description,
      summary: r.action.summary,
    })),
  );
  await lease.commit({
    op: 'settle',
    idx: row.idx,
    state: 'succeeded',
    output: {
      ran: true,
      count: results.length,
      results,
      summary: doneLine,
    },
    from: ['running'],
  });
}
