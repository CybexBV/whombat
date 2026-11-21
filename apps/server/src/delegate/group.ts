/** Tasks share one thread only when doing so preserves their dependencies and the person's choices. */
interface AiOption {
  id: string;
  value: string | boolean;
}

export interface GroupAiDefaults {
  aiProvider?: string | null;
  aiModel?: string | null;
  aiOptions?: readonly AiOption[] | null;
}

interface GroupIdentity {
  id: string;
  groupId?: string | null;
  threadId?: string | null;
}

interface GroupTask extends GroupIdentity {
  state: string;
  afterId: string | null;
  kind?: string;
  sendPending?: string | null;
  position?: number;
  createdAt?: Date;
  provider?: string | null;
  model?: string | null;
  options?: readonly AiOption[] | null;
  mergeState?: string | null;
  picked?: boolean;
}

/** A group exists before its thread does; older tasks are grouped by the thread they already share. */
export function groupMembers<T extends GroupIdentity>(lead: T, tasks: readonly T[]): T[] {
  return tasks.filter((task) => {
    if (task.id === lead.id) return true;
    if (lead.groupId || task.groupId) return !!lead.groupId && task.groupId === lead.groupId;
    return !!lead.threadId && task.threadId === lead.threadId;
  });
}

function aiKey(task: GroupTask, defaults: GroupAiDefaults): string {
  const own = !!(task.provider && task.model);
  const inherited = !!(defaults.aiProvider && defaults.aiModel);
  const provider = own ? task.provider : inherited ? defaults.aiProvider : null;
  const model = own ? task.model : inherited ? defaults.aiModel : null;
  const options = own ? task.options : inherited ? defaults.aiOptions : null;
  return JSON.stringify([
    provider,
    model,
    (options ?? []).map(({ id, value }) => JSON.stringify([id, value])).sort(),
  ]);
}

/**
 * Queued descendants done in the starting task's thread, for lists handed over before one thread led them all (the
 * legacy path). Walk parents before children, keeping card order only among siblings. An incompatible AI or keep-open
 * choice leaves that task and its descendants for their own later thread.
 */
export function togetherWith<T extends GroupTask>(
  lead: GroupTask,
  tasks: readonly T[],
  defaults: GroupAiDefaults = {},
): T[] {
  const out: T[] = [];
  const parents = [lead.id];
  const seen = new Set(parents);
  const ai = aiKey(lead, defaults);
  const kept = lead.mergeState === 'kept';
  const ordered = cardOrder(tasks);
  for (let index = 0; index < parents.length; index++) {
    const parent = parents[index];
    for (const task of ordered) {
      if (
        task.afterId !== parent ||
        seen.has(task.id) ||
        task.state !== 'queued' ||
        task.sendPending ||
        task.kind === 'final' ||
        (task.mergeState === 'kept') !== kept ||
        aiKey(task, defaults) !== ai
      )
        continue;
      seen.add(task.id);
      out.push(task);
      parents.push(task.id);
    }
  }
  return out;
}

function cardOrder<T extends GroupTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort(
    (a, b) =>
      (a.position ?? 0) - (b.position ?? 0) || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
  );
}

/**
 * The queued tasks done in the starting task's thread, which leads them all (docs/decisions/delegate.md): every compatible one
 * that starts from the default branch, and every one that builds on a task of the group. The lead reads the code and
 * splits the work itself, so touching different files is no reason to keep tasks apart. Parents come before children,
 * card order among the rest. An incompatible AI or keep-open choice leaves that task and the tasks building on it for
 * their own later thread.
 */
export function leadsWith<T extends GroupTask>(
  lead: GroupTask,
  tasks: readonly T[],
  defaults: GroupAiDefaults = {},
): T[] {
  const ai = aiKey(lead, defaults);
  const kept = lead.mergeState === 'kept';
  const ordered = cardOrder(tasks);
  const fits = (task: T) =>
    task.id !== lead.id &&
    task.state === 'queued' &&
    task.picked !== false &&
    !task.sendPending &&
    task.kind !== 'final' &&
    (task.mergeState === 'kept') === kept &&
    aiKey(task, defaults) === ai;
  // Members: tasks from the default branch, then whatever builds on a member.
  const members = new Set(ordered.filter((t) => fits(t) && t.afterId === null).map((t) => t.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const task of ordered)
      if (
        !members.has(task.id) &&
        fits(task) &&
        (task.afterId === lead.id || members.has(task.afterId ?? ''))
      )
        grew = members.add(task.id).size > 0;
  }
  // In card order, each after what it builds on.
  const left = ordered.filter((t) => members.has(t.id));
  const out: T[] = [];
  while (left.length) {
    const next = left.findIndex((t) => !left.some((o) => o.id === t.afterId));
    out.push(...left.splice(Math.max(next, 0), 1));
  }
  return out;
}
