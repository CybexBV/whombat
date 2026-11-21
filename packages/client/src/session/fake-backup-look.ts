/**
 * Getting one thing back from a backup in the web's fixture mode, its fake managed world and the phone's demo (Whombat
 * backup-look.md; app backup-look.md AP-6940…): any backup opens after a short wait, holds a few chats (one about the roof that isn’t here
 * any more), files and automations, and brings back what is picked — anything here already stays and is said so.
 */
import type {
  BackupLook,
  BackupLookBringResult,
  BackupLookCategory,
  BackupLookItem,
} from '@whombat/protocol/session';

type Answer = { status: number; body: unknown };

export interface FakeBackupLookOptions {
  now?: () => number;
  /** How long a backup takes to open. */
  openMs?: number;
  /** The ops answer `unknown_op`: a box from before. */
  available?: boolean;
}

export interface FakeBackupLook {
  call(op: string, input: unknown): Promise<Answer> | null;
}

const OPS = new Set(['backup.look', 'backup.lookContents', 'backup.lookBring', 'backup.lookClose']);

const ago = (now: number, hours: number) => new Date(now - hours * 3600_000).toISOString();

function seed(now: number): BackupLookItem[] {
  return [
    {
      id: 'thread:msg_roof',
      category: 'messages',
      title: 'Our roof is leaking again above the kitchen',
      at: ago(now, 26),
      detail: 'In Chat · 4 replies',
      here: false,
    },
    {
      id: 'thread:msg_invoice',
      category: 'messages',
      title: 'Why is the heating invoice so high?',
      at: ago(now, 50),
      detail: 'In Chat · 2 replies',
      here: true,
    },
    {
      id: 'chat:cnv_garden',
      category: 'messages',
      title: 'Garden lights schedule',
      at: ago(now, 120),
      detail: 'A chat · 12 messages',
      here: false,
    },
    {
      id: 'file:att_quote',
      category: 'files',
      title: 'roofer-quote.pdf',
      at: ago(now, 26),
      detail: '240 KB',
      here: false,
    },
    {
      id: 'automation:aut_bins',
      category: 'automations',
      title: 'Remind me to put the bins out',
      at: ago(now, 300),
      detail: null,
      here: true,
    },
  ];
}

export function createFakeBackupLook(options: FakeBackupLookOptions = {}): FakeBackupLook {
  const now = options.now ?? (() => Date.now());
  const openMs = options.openMs ?? 1200;
  let look: (BackupLook & { openedAt: number }) | null = null;
  let items = seed(now());
  const ok = (body: unknown): Answer => ({ status: 200, body });
  const view = (): BackupLook | null => {
    if (!look) return null;
    const { openedAt, ...rest } = look;
    if (rest.state === 'opening' && now() - openedAt >= openMs) look.state = rest.state = 'ready';
    return rest;
  };
  const counts = () => {
    const by = new Map<BackupLookCategory, number>();
    for (const i of items) by.set(i.category, (by.get(i.category) ?? 0) + 1);
    return [...by].map(([id, count]) => ({ id, count }));
  };
  return {
    call(op, raw) {
      if (!OPS.has(op)) return null;
      if (options.available === false)
        return Promise.resolve({
          status: 404,
          body: { error: { code: 'unknown_op', message: `No operation ${op}` } },
        });
      const input = (raw ?? {}) as Record<string, unknown>;
      if (op === 'backup.look') {
        items = seed(now());
        look = {
          lookId: 'bkl_fixture0001',
          checkpointId: String(input.checkpointId ?? ''),
          madeAt: ago(now(), 24),
          state: 'opening',
          expiresAt: new Date(now() + 2 * 3600_000).toISOString(),
          problem: null,
          bring: null,
          openedAt: now(),
        };
        return Promise.resolve(ok(view()));
      }
      const current = view();
      if (!current || current.lookId !== input.lookId)
        return Promise.resolve({
          status: 404,
          body: { error: { code: 'not_found', message: 'This backup isn’t open any more.' } },
        });
      if (op === 'backup.lookClose') {
        if (look) look.state = 'closed';
        return Promise.resolve(ok(view()));
      }
      if (op === 'backup.lookContents') {
        const ready = current.state === 'ready';
        const category = (input.category as BackupLookCategory | undefined) ?? null;
        const words = String(input.query ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length >= 2);
        const listed =
          ready && category
            ? items.filter(
                (i) => i.category === category && words.every((w) => i.title.toLowerCase().includes(w)),
              )
            : [];
        return Promise.resolve(
          ok({
            look: current,
            categories: ready ? counts() : [],
            category,
            items: listed,
            nextCursor: null,
          }),
        );
      }
      // backup.lookBring
      const picked = ((input.items as string[] | undefined) ?? []).filter((id) =>
        items.some((i) => i.id === id),
      );
      const back = picked.filter((id) => items.find((i) => i.id === id)?.here === false);
      const titles = back.map((id) => items.find((i) => i.id === id)?.title ?? '');
      items = items.map((i) => (picked.includes(i.id) ? { ...i, here: true } : i));
      const bring: BackupLookBringResult = {
        state: 'done',
        picked: picked.length,
        back: back.length,
        already: picked.length - back.length,
        notBack: 0,
        titles,
        signIn: [],
        error: null,
        finishedAt: new Date(now()).toISOString(),
      };
      if (look) look.bring = bring;
      return Promise.resolve(ok({ look: view(), say: '' }));
    },
  };
}
