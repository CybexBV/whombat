/**
 * External execution for a `connection_actions` step marked `running` after the person approved its card. Runs outside
 * any DB transaction, re-verifies the approval and every connection's current settings/limits, and executes each call
 * through `executeConnectionCall`.
 */
import { type AutomationStep, CONNECTOR_BINARY_MAX_BYTES, catalogEntry, lookOnlyText } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { callArgsAad, callTier, executeConnectionCall, needsReauthText } from '../../connections/call';
import { callTarget, changedSinceYesText } from '../../connections/call-target';
import { isCallableEntry } from '../../connections/callable';
import { keyTierOf } from '../../connections/context';
import { limitsProblem } from '../../connections/limits';
import { parseRequestUpload } from '../../connections/request';
import { catalogConnections, connectionTools } from '../../db/schema/index';
import { limitWordsFor } from '../../devices/store';
import { thePerson } from '../../domain/the-person';
import { readAll } from '../../files/previews';
import { callServerOf } from '../../hosts/asks';
import { loadGrants } from '../../read/principals';
import { automationAgent, publisherCheck } from '../authority';
import { listedThere, listedWords } from '../listed-actions';
import {
  approvedActionsRequest,
  emailFile,
  hashPlannedActions,
  isProposableEntry,
  notThisEmailsFile,
  outsidersCall,
} from '../proposed-actions';
import { actionsDoneLine } from '../proposed-card';
import { stepRoomsCheck } from '../steps';
import { freshCardOutput } from '../steps/connection-actions';
import type { AutomationStepRow } from '../store';
import type { LeasedRun } from './step-ops';

interface PreparedAction {
  callId: string;
  connectionId: string;
  /** Where the connection's calls went and as whom when the person said yes (`callTarget`). */
  target?: string;
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
  // A connection that goes elsewhere, or as someone else, than when the person said yes: nothing is sent, and the step
  // asks again on a fresh card, its names read again from where the calls go now.
  const askAgain = (label: string) =>
    lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'pending',
      error: changedSinceYesText(label),
      output: freshCardOutput([label]),
      from: ['running'],
    });

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
  const ready: {
    action: PreparedAction;
    args: Record<string, unknown>;
    done: string;
    label: string;
    /** The answer that means its thing was there already (a folder), and what the thread says then. */
    there: { status: number; done: string } | null;
  }[] = [];
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
    if (callTarget(conn) !== action.target) return void (await askAgain(conn.label));
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
    // The same check as when it was proposed and shown: a listed action, as Whombat sends it. These are the arguments
    // Whombat settled for the card, with the account ids it filled in.
    const call = outsidersCall(entry, conn, tool, args, conn.label, true);
    if (!call.ok) return void (await refuse(call.reason));
    args = call.args;
    const upload = tool.origin === 'request' ? parseRequestUpload(args.upload) : null;
    if (upload) {
      const att = await emailFile(db, run, upload.attachmentId);
      if (!att?.blobKey) return void (await refuse(notThisEmailsFile(conn.label)));
      if (att.size > maxUpload)
        return void (await refuse(`The attachment to upload to ${conn.label} isn’t available any more.`));
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
    // What the thread says once it ran, in Whombat's words for the call as it runs.
    const { done } = listedWords({ catalogId: conn.catalogId, label: conn.label, tool, args });
    const there = listedThere({ catalogId: conn.catalogId, label: conn.label, tool, args });
    ready.push({ action, args, done, label: conn.label, there });
  }

  // Re-verify the exact batch hash against what was approved before sending any network call.
  const openedHash = hashPlannedActions(
    ready.map(({ action, args }) => ({
      connectionId: action.connectionId,
      target: action.target ?? '',
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

  // Resolver scoped strictly to the files the server handed over from THIS run's email.
  const uploadAttachment = async (attachmentId: string) => {
    const att = await emailFile(db, run, attachmentId);
    if (!att?.blobKey || att.size > maxUpload) return null;
    const bytes = await readAll(services.files.store, att.blobKey);
    if (!bytes) return null;
    return { name: att.name, contentType: att.contentType, bytes };
  };

  const results: { handle: string; label: string; summary: string; ok: boolean; status?: number }[] = [];
  const doneWords: { done: string; label: string }[] = [];
  for (const { action, args, done, label, there } of ready) {
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
      // Checked again on the connection the request is made with.
      target: action.target ?? '',
    });
    if (res.kind === 'failed' && res.changed) {
      const ran = results.filter((r) => r.ok).length;
      if (!ran) return void (await askAgain(action.label));
      // Earlier actions ran already: asking again would run them twice, so the person checks instead.
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'uncertain',
        error:
          `${ran} earlier ${ran === 1 ? 'action' : 'actions'} succeeded, then ${action.label} changed since you said yes, so “${shown}” wasn’t sent. Check what ran, then say what happened.`.slice(
            0,
            1000,
          ),
        output: { ran: true, count: ran, results },
        from: ['running'],
      });
      return;
    }
    // A folder that is there already: nothing changed, and what comes after it can go on.
    const status = res.kind === 'ok' ? res.output.httpStatus : undefined;
    const wasThere = there !== null && status === there.status;
    const badHttpStatus = status !== undefined && (status < 200 || status >= 300);
    if (!wasThere && (res.kind === 'failed' || res.output.isError || badHttpStatus)) {
      const timedOut = res.kind === 'failed' && res.reason === 'timeout';
      const earlierSucceeded = results.some((r) => r.ok);
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
      const succeededCount = results.filter((r) => r.ok).length;
      // A timed-out call may have taken effect, and a batch that already ran earlier actions left partial state:
      // settle as `uncertain` (needs_review) so the person can check instead of seeing a misleading “failed”.
      const uncertain = timedOut || earlierSucceeded;
      const error = timedOut
        ? earlierSucceeded
          ? `${succeededCount} earlier ${succeededCount === 1 ? 'action' : 'actions'} succeeded, and ${action.label} didn’t answer in time for “${shown}”, so it may or may not have happened. Check, then say what happened.`
          : `${action.label} didn’t answer in time for “${shown}”, so it may or may not have happened. Check, then say what happened.`
        : earlierSucceeded
          ? `${succeededCount} earlier ${succeededCount === 1 ? 'action' : 'actions'} already succeeded before ${action.label} failed on “${shown}”: ${reason} Check what ran, then say what happened.`
          : `${action.label} couldn’t complete “${shown}”: ${reason}`;
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: uncertain ? 'uncertain' : 'failed',
        error: error.slice(0, 1000),
        output: { ran: earlierSucceeded, count: succeededCount, results },
        from: ['running'],
      });
      return;
    }
    results.push({
      handle: action.handle,
      label: action.label,
      summary: shown,
      ok: true,
      ...(res.kind === 'ok' && res.output.httpStatus ? { status: res.output.httpStatus } : {}),
    });
    doneWords.push({ done: wasThere && there ? there.done : done, label });
  }

  const doneLine = actionsDoneLine(doneWords);
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
