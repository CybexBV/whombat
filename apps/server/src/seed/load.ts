/**
 * Loads a `SeedWorld` in one commit-pipeline transaction (burrow lock held): domain rows with their seeded
 * ids and times, then every audit event — explicit history plus hidden internal events — appended in time
 * order through the same signing/append path as live commits, so the chain verifies end to end.
 */
import {
  actionHash,
  canonicalizeMentions,
  conversationLabel,
  conversationLink,
  deriveSeedKeypair,
  type EventDraft,
  IDLE_EXECUTION,
  type LinkRef,
  type MentionTarget,
  newId,
  resolveMentions,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { FEEDBACK_ROOM_KEY, FEEDBACK_ROOM_TITLE } from '../chats/rooms';
import { seedCanvasDocument } from '../collab/document';
import type { Session } from '../commit/pipeline';
import {
  accounts,
  applianceState,
  approvals,
  burrows,
  canvasComments,
  canvases,
  conversations,
  grants,
  messages,
  notifications,
  ONBOARDING_LAST_STEP,
  plans,
  prChecks,
  prCommits,
  prFiles,
  principals,
  prReviewers,
  pullRequests,
  reactions,
  readStates,
  repos,
  runFiles,
  runLog,
  runSteps,
  runs,
  searchAnswers,
} from '../db/schema/index';
import {
  indexApproval,
  indexCanvas,
  indexMessage,
  indexPlan,
  indexPullRequest,
  indexRun,
  upsertSearchDoc,
} from '../domain/search-index';
import type { Services } from '../services';
import { type ParsedSeedWorld, SeedWorld } from './world';

/** A person's Feedback room in a seed world: said so, or named like the fixtures' (`feedback-<person>`). */
const feedbackRoom = (c: { kind: string; slug: string; room?: 'chat' | 'feedback' | undefined }) =>
  c.kind === 'dm' && (c.room === 'feedback' || (c.room === undefined && c.slug.startsWith('feedback-')));

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shifts every ISO instant by `ms` and every calendar date by whole days (`--relative`). */
export function shiftTimestamps<T>(value: T, ms: number): T {
  const days = Math.round(ms / 86_400_000);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (ISO_INSTANT.test(v)) return new Date(new Date(v).getTime() + ms).toISOString();
      if (ISO_DATE.test(v)) {
        const d = new Date(`${v}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export interface LoadResult {
  burrowId: string;
  events: number;
  messages: number;
}

const date = (s: string) => new Date(s);
const dateOrNull = (s: string | null | undefined) => (s ? new Date(s) : null);

export async function loadSeedWorld(
  services: Services,
  input: SeedWorld,
  options: { shiftMs?: number } = {},
): Promise<LoadResult> {
  const world: ParsedSeedWorld = SeedWorld.parse(
    options.shiftMs ? shiftTimestamps(input, options.shiftMs) : input,
  );
  const burrowId = world.burrow.id;
  const seed = world.keySeed;

  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const tx = session.tx;
    await tx.insert(burrows).values({
      id: burrowId,
      name: world.burrow.name,
      slug: world.burrow.slug,
      timeZone: world.burrow.timeZone,
      createdAt: date(world.burrow.createdAt),
      onboarding: {
        step: ONBOARDING_LAST_STEP,
        githubConnected: world.repos.length > 0,
        completedAt: world.burrow.onboardingCompletedAt ?? world.burrow.createdAt,
      },
    });

    // People, with an account per email. The first one is the Whombat's person, the account that claimed it
    // (one-person.md OP-01, OP-S02).
    let claimer: string | null = null;
    for (const [position, p] of world.people.entries()) {
      const email = p.email.toLowerCase();
      const createdAt = date(p.createdAt);
      const [account] = await tx
        .insert(accounts)
        .values({
          id: newId('account'),
          email,
          name: p.name,
          createdAt,
          emailVerifiedAt: createdAt,
        })
        .onConflictDoUpdate({ target: accounts.email, set: { name: p.name } })
        .returning();
      claimer ??= account?.id ?? null;
      const keys = checkedKeys(services, p.id, seed, p.publicKey, p.fingerprint);
      await tx.insert(principals).values({
        id: p.id,
        burrowId,
        kind: 'person',
        name: p.name,
        handle: p.handle,
        ...keys,
        createdAt: date(p.createdAt),
        accountId: account?.id ?? null,
        shortName: p.shortName ?? null,
        initials: p.initials,
        tone: p.tone,
        title: p.title ?? null,
        email,
        position,
      });
    }

    if (claimer)
      await tx
        .insert(applianceState)
        .values({ id: 1, claimedByAccountId: claimer })
        .onConflictDoUpdate({ target: applianceState.id, set: { claimedByAccountId: claimer } });

    for (const [i, a] of world.agents.entries()) {
      const keys = checkedKeys(services, a.id, seed, a.publicKey, a.fingerprint);
      await tx.insert(principals).values({
        id: a.id,
        burrowId,
        kind: 'agent',
        name: a.name,
        handle: a.handle,
        ...keys,
        createdAt: date(a.createdAt),
        // The world's one agent (one-agent.md OA-01) and its face (OA-08).
        agentFace: a.face,
        status: a.status,
        doing: a.doing,
        runtime: a.runtime,
        position: world.people.length + i,
      });
      if (a.grants.length) {
        await tx.insert(grants).values(
          a.grants.map((g, i) => ({
            burrowId,
            agentId: a.id,
            keyId: g.keyId,
            tier: g.tier,
            scope: g.scope ?? null,
            position: i,
          })),
        );
      }
    }

    for (const [i, r] of world.repos.entries()) {
      await tx.insert(repos).values({
        id: r.id,
        burrowId,
        fullName: r.fullName,
        description: r.description,
        language: r.language,
        defaultBranch: r.defaultBranch,
        enabled: r.enabled,
        pushedAt: dateOrNull(r.pushedAt),
        position: i,
      });
    }

    const lastMessage = new Map<string, string>();
    for (const m of world.messages) {
      if (m.threadRootId) continue;
      const prev = lastMessage.get(m.conversationId);
      if (!prev || prev < m.createdAt) lastMessage.set(m.conversationId, m.createdAt);
    }
    const kindCount = new Map<string, number>();
    for (const c of world.conversations) {
      const position = c.position ?? kindCount.get(c.kind) ?? 0;
      kindCount.set(c.kind, position + 1);
      await tx.insert(conversations).values({
        id: c.id,
        burrowId,
        kind: c.kind,
        slug: c.slug,
        title: c.title,
        topic: c.topic,
        actions: c.actions,
        prNumber: c.prNumber,
        repoId: c.repoId,
        // A person's Chat is with the world's agent (one-agent.md OA-04).
        dmAgentId: c.kind === 'dm' ? (world.agents[0]?.id ?? null) : null,
        dmPersonId: c.dmPersonId ?? (c.kind === 'dm' ? (world.people[0]?.id ?? null) : null),
        // A person's Feedback room has its own key and title beside their Chat (chat-channel.md CHT-03).
        ...(feedbackRoom(c) ? { taskKey: FEEDBACK_ROOM_KEY, chatTitle: FEEDBACK_ROOM_TITLE } : {}),
        position,
        createdAt: date(c.createdAt),
        lastMessageAt: dateOrNull(c.lastMessageAt ?? lastMessage.get(c.id)),
      });
    }

    for (const pr of world.pullRequests) {
      await tx.insert(pullRequests).values({
        id: pr.id,
        burrowId,
        repoId: pr.repoId,
        number: pr.number,
        branch: pr.branch,
        baseBranch: pr.baseBranch,
        title: pr.title,
        state: pr.state,
        headSha: pr.headSha,
        authorId: pr.authorId,
        diff: pr.diff,
        conversationId: pr.conversationId,
        openedAt: date(pr.openedAt),
        mergedAt: dateOrNull(pr.mergedAt),
        mergedById: pr.mergedById,
        url: pr.url,
      });
      if (pr.checks.length)
        await tx.insert(prChecks).values(pr.checks.map((c, i) => ({ prId: pr.id, ...c, position: i })));
      if (pr.reviewers.length)
        await tx.insert(prReviewers).values(
          pr.reviewers.map((r, i) => ({
            prId: pr.id,
            principalId: r.principalId,
            state: r.state,
            at: dateOrNull(r.at),
            position: i,
          })),
        );
      if (pr.files.length)
        await tx.insert(prFiles).values(pr.files.map((f, i) => ({ prId: pr.id, ...f, position: i })));
      if (pr.commits.length)
        await tx.insert(prCommits).values(
          pr.commits.map((c, i) => ({
            prId: pr.id,
            sha: c.sha,
            message: c.message,
            authorId: c.authorId,
            at: date(c.at),
            position: i,
          })),
        );
    }

    const names = new Map([...world.people, ...world.agents].map((p) => [p.id, p.name]));
    for (const c of world.canvases) {
      // The canvas body becomes its Yjs document now; comments are re-anchored on their quotes.
      const seeded = seedCanvasDocument(c.markdown, {
        title: c.title,
        plan: world.plans.find((p) => p.id === c.planId) ?? null,
        comments: c.comments,
        names,
      });
      await tx.insert(canvases).values({
        id: c.id,
        burrowId,
        slug: c.slug,
        title: c.title,
        conversationId: c.conversationId,
        planId: c.planId,
        provenance: c.provenance,
        markdown: seeded.markdown,
        ydoc: Buffer.from(seeded.state),
        ydocUpdatedAt: date(c.updatedAt),
        createdAt: date(c.createdAt),
        updatedAt: date(c.updatedAt),
      });
      for (const cm of c.comments) {
        await tx.insert(canvasComments).values({
          id: cm.id,
          canvasId: c.id,
          burrowId,
          anchor: seeded.anchors.get(cm.id) ?? cm.anchor,
          parentId: cm.parentId,
          authorId: cm.authorId,
          text: cm.text,
          resolved: cm.resolved,
          createdAt: date(cm.createdAt),
        });
      }
    }

    for (const p of world.plans) {
      // The plan card that introduced it: who made the plan, when, and its card message (WS-01).
      const card = world.messages.find(
        (m) => m.conversationId === p.conversationId && m.card?.kind === 'plan' && m.card.planId === p.id,
      );
      await tx.insert(plans).values({
        id: p.id,
        burrowId,
        title: p.title,
        due: p.due,
        conversationId: p.conversationId,
        canvasId: p.canvasId,
        steps: p.steps,
        updatedAt: date(p.updatedAt),
        createdById: card?.authorId ?? null,
        createdAt: card ? date(card.createdAt) : null,
        messageId: card?.id ?? null,
      });
    }

    for (const r of world.runs) {
      await tx.insert(runs).values({
        id: r.id,
        burrowId,
        number: r.number,
        agentId: r.agentId,
        title: r.title,
        branch: r.branch,
        repoId: r.repoId,
        prNumber: r.prNumber,
        status: r.status,
        askedById: r.askedById,
        conversationId: r.conversationId,
        messageId: r.messageId,
        startedAt: date(r.startedAt),
        finishedAt: dateOrNull(r.finishedAt),
        progress: r.progress,
        activity: r.activity,
        summary: r.summary,
        tests: r.tests,
        diff: r.diff,
        keysUsed: r.keysUsed,
        logCount: r.logCount ?? r.log.length,
        pausedById: r.pausedById,
        takenOverById: r.takenOverById,
      });
      if (r.steps.length)
        await tx.insert(runSteps).values(
          r.steps.map((s, idx) => ({
            runId: r.id,
            idx,
            title: s.title,
            detail: s.detail,
            at: dateOrNull(s.at),
            state: s.state,
          })),
        );
      if (r.log.length)
        await tx
          .insert(runLog)
          .values(r.log.map((l, seq) => ({ runId: r.id, seq, at: date(l.at), text: l.text })));
      if (r.files.length)
        await tx.insert(runFiles).values(r.files.map((f, i) => ({ runId: r.id, ...f, position: i })));
    }

    for (const a of world.approvals) {
      await tx.insert(approvals).values({
        id: a.id,
        burrowId,
        number: a.number,
        requesterId: a.requesterId,
        keyId: a.keyId,
        action: a.action,
        title: a.title,
        question: a.question,
        target: a.target,
        whatHappens: a.whatHappens,
        explainer: a.explainer,
        summary: a.summary,
        conditions: a.conditions,
        state: a.state,
        decidedById: a.decidedById,
        decidedAt: dateOrNull(a.decidedAt),
        execution: a.execution ?? IDLE_EXECUTION,
        executedAt: dateOrNull(a.executedAt),
        conversationId: a.conversationId,
        messageId: a.messageId,
        involvedIds: a.involvedIds,
        eventId: a.eventId,
        // Every approval carries the hash its execution is checked against, signed in its request event.
        actionHash: seededActionHash(a),
        createdAt: date(a.createdAt),
      });
    }

    // Messages in time order (stable), so insertion order (`ord`) follows the clock.
    const targets: MentionTarget[] = [
      ...world.people.map((p) => ({
        id: p.id,
        kind: 'person' as const,
        name: p.name,
        ...(p.shortName ? { shortName: p.shortName } : {}),
      })),
      ...world.agents.map((a) => ({ id: a.id, kind: 'agent' as const, name: a.name })),
    ];
    const ordered = world.messages
      .map((m, i) => ({ m, i }))
      .sort((a, b) => a.m.createdAt.localeCompare(b.m.createdAt) || a.i - b.i)
      .map((x) => x.m);
    const replies = new Map<string, typeof ordered>();
    for (const m of ordered) {
      if (!m.threadRootId) continue;
      const list = replies.get(m.threadRootId) ?? [];
      list.push(m);
      replies.set(m.threadRootId, list);
    }
    for (const m of ordered) {
      const thread = replies.get(m.id) ?? [];
      const participants: string[] = [];
      for (const r of thread) {
        const idx = participants.indexOf(r.authorId);
        if (idx >= 0) participants.splice(idx, 1);
        participants.push(r.authorId);
      }
      await tx.insert(messages).values({
        id: m.id,
        burrowId,
        conversationId: m.conversationId,
        authorId: m.authorId,
        createdAt: date(m.createdAt),
        editedAt: dateOrNull(m.editedAt),
        // Stored canonical like a sent message (messaging.md MS-C02); the mock world's texts already are.
        text: canonicalizeMentions(m.text, targets),
        mentions: m.mentions ?? resolveMentions(m.text, targets).filter((id) => id !== m.authorId),
        card: m.card ?? null,
        threadRootId: m.threadRootId ?? null,
        replyCount: thread.length,
        lastReplyAt: thread.length ? date(thread[thread.length - 1]?.createdAt as string) : null,
        threadParticipantIds: participants.slice(-3),
      });
      for (const r of m.reactions ?? []) {
        await tx.insert(reactions).values(
          r.principalIds.map((principalId, i) => ({
            messageId: m.id,
            principalId,
            value: r.value,
            burrowId,
            createdAt: new Date(date(m.createdAt).getTime() + 1000 + i),
          })),
        );
      }
    }

    // Read markers of the world's person and agent: explicit ones, else everything read.
    const readers = [...world.people.map((p) => p.id), ...world.agents.map((a) => a.id)];
    const explicit = new Map(world.readMarkers.map((r) => [`${r.conversationId}|${r.principalId}`, r]));
    const stored = await tx
      .select({
        id: messages.id,
        ord: messages.ord,
        createdAt: messages.createdAt,
        conversationId: messages.conversationId,
        threadRootId: messages.threadRootId,
      })
      .from(messages)
      .where(eq(messages.burrowId, burrowId));
    const byId = new Map(stored.map((s) => [s.id, s]));
    for (const c of world.conversations) {
      const top = stored
        .filter((s) => s.conversationId === c.id && !s.threadRootId)
        .sort((a, b) => a.ord - b.ord);
      const latest = top[top.length - 1];
      for (const principalId of readers) {
        const marker = explicit.get(`${c.id}|${principalId}`);
        const target = marker
          ? marker.lastReadMessageId
            ? byId.get(marker.lastReadMessageId)
            : undefined
          : latest;
        if (marker && marker.lastReadMessageId === null) continue;
        if (!target) continue;
        await tx.insert(readStates).values({
          conversationId: c.id,
          principalId,
          lastReadMessageId: target.id,
          lastReadAt: target.createdAt,
          lastReadOrd: target.ord,
        });
      }
    }

    for (const n of world.notifications) {
      await tx.insert(notifications).values({
        id: n.id,
        burrowId,
        principalId: n.principalId,
        kind: n.kind,
        actorId: n.actorId,
        where: n.where,
        text: n.text,
        link: n.link,
        approvalId: n.approvalId,
        createdAt: date(n.createdAt),
        readAt: dateOrNull(n.readAt),
      });
    }
    for (const a of world.searchAnswers) {
      await tx.insert(searchAnswers).values({
        id: a.id,
        burrowId,
        query: a.query,
        agentId: a.agentId,
        askedById: a.askedById,
        status: a.status,
        text: a.text,
        citations: a.citations,
        durationMs: a.durationMs,
        actions: a.actions,
        createdAt: date(a.createdAt),
      });
    }

    const events = await appendSeedEvents(session, world);
    return { burrowId, events, messages: world.messages.length };
  });

  // Search index: everything the pipeline would have indexed live, plus the search-only history.
  const db = services.db;
  for (const m of world.messages) await indexMessage(db, m.id);
  for (const r of world.runs) await indexRun(db, r.id);
  for (const pr of world.pullRequests) await indexPullRequest(db, pr.id, world.burrow.timeZone);
  for (const c of world.canvases) await indexCanvas(db, c.id);
  for (const p of world.plans) await indexPlan(db, p.id);
  for (const a of world.approvals) await indexApproval(db, a.id);
  for (const d of world.searchDocuments)
    await upsertSearchDoc(db, { ...d, burrowId, createdAt: date(d.createdAt) });
  return result;
}

function checkedKeys(services: Services, id: string, seed: string, publicKey?: string, fingerprint?: string) {
  const keys = services.custody.wrap(id, deriveSeedKeypair(id, seed));
  if (publicKey && publicKey !== keys.publicKey)
    throw new Error(`Seed public key for ${id} does not match deriveSeedKeypair(${id}, ${seed})`);
  if (fingerprint && fingerprint !== keys.fingerprint)
    throw new Error(`Seed fingerprint for ${id} is ${keys.fingerprint}, not ${fingerprint}`);
  return keys;
}

/** A seeded approval's action hash: seeded approvals run no deferred command and have no binding. */
function seededActionHash(a: ParsedSeedWorld['approvals'][number]): string {
  return actionHash({ action: a.action, input: null });
}

/** Explicit history + hidden internal events, appended in time order (ties keep input order). */
async function appendSeedEvents(session: Session, world: ParsedSeedWorld): Promise<number> {
  const person = world.people[0];
  const drafts: {
    at: string;
    order: number;
    actorId: string;
    fields: Omit<EventDraft, 'burrowId' | 'actorId'>;
  }[] = [];
  let order = 0;
  if (person) {
    drafts.push({
      at: world.burrow.createdAt,
      order: order++,
      actorId: person.id,
      fields: {
        id: `evt_${hexId(`${world.burrow.id}:created`)}`,
        type: 'burrow.created',
        kind: 'System',
        text: null,
        where: null,
        payload: { burrowId: world.burrow.id, seeded: true },
        createdAt: world.burrow.createdAt,
      },
    });
  }
  const convById = new Map(world.conversations.map((c) => [c.id, c]));
  for (const m of world.messages) {
    const conv = convById.get(m.conversationId);
    const ref: LinkRef | undefined = conv
      ? {
          type: 'message',
          in: conversationLink(conv),
          messageId: m.id,
          ...(m.threadRootId ? { threadRootId: m.threadRootId } : {}),
        }
      : undefined;
    drafts.push({
      at: m.createdAt,
      order: order++,
      actorId: m.authorId,
      fields: {
        id: `evt_${hexId(`message:${m.id}`)}`,
        type: 'message.posted',
        kind: 'Messages',
        text: null,
        where: conv ? conversationLabel(conv) : null,
        ...(ref ? { ref } : {}),
        payload: { messageId: m.id, conversationId: m.conversationId, seeded: true },
        createdAt: m.createdAt,
      },
    });
  }
  const hashByEvent = new Map(
    world.approvals.flatMap((a) => (a.eventId ? [[a.eventId, seededActionHash(a)] as const] : [])),
  );
  for (const e of world.events) {
    const { actorId, ...rest } = e;
    const hash = e.type === 'approval.requested' ? hashByEvent.get(e.id) : undefined;
    const fields = hash ? { ...rest, payload: { ...rest.payload, actionHash: hash } } : rest;
    drafts.push({ at: e.createdAt, order: order++, actorId, fields });
  }
  drafts.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.order - b.order);
  for (const d of drafts) {
    await session.append(d.actorId, { ...d.fields, createdAt: new Date(d.fields.createdAt).toISOString() });
  }
  return drafts.length;
}

/** Deterministic 12-hex id body for internal seed events (so reseeding gives the same ids). */
function hexId(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}
