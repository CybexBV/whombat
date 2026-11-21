/**
 * What the runtime remembers about the box's network (`box_network`, one row; docs/decisions/network-move-server.md):
 * read leniently (a part an older or newer runtime wrote that this one can't read is left out), written through the
 * commit pipeline's account-level transaction (the box's network is the box's, not one burrow's; no event, nothing
 * signed).
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '../db/client';
import { boxNetwork } from '../db/schema/index';
import type { Services } from '../services';

const ROW_ID = 1;
const Iso = z.string().refine((s) => Number.isFinite(Date.parse(s)));
const Ip = z.string().min(2).max(45);

const Move = z.object({ from: Ip.optional(), to: Ip, since: Iso });
const Cable = z.object({ interface: z.string().min(1).max(64), seenAt: Iso });
const Lost = z.object({ interface: z.string().min(1).max(64), at: Iso });
const Backup = z.object({ changeId: z.string().min(1).max(64), at: Iso });
/** An address change and the connections that worked in their last check before it. */
const Change = z.object({
  from: Ip,
  to: Ip,
  at: Iso,
  /** Connection ids. */
  before: z.array(z.string().min(1).max(100)).max(500),
  /** The connections were checked again after it. */
  checked: z.boolean(),
});
/** A connection that stopped letting Whombat in after the address changed (NM-10). */
const Refused = z.object({
  connectionId: z.string().min(1).max(100),
  burrowId: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  from: Ip,
  to: Ip,
  at: Iso,
});

/** One part, or undefined when it can't be read. */
function part<T extends z.ZodType>(schema: T, v: unknown): z.output<T> | undefined {
  const r = schema.safeParse(v);
  return r.success ? r.data : undefined;
}

export interface BoxNetworkState {
  /** The servers' latest move with the box (NM-05, NM-07). */
  move?: z.output<typeof Move>;
  /** The box's address as last seen from the manager. */
  address?: string;
  /** The hosts service's latest agents' address change Whombat handled (`agent_url_changed_at`). */
  hubChangedAt?: string;
  cable?: z.output<typeof Cable>;
  cableLost?: z.output<typeof Lost>;
  backup?: z.output<typeof Backup>;
  change?: z.output<typeof Change>;
  refused: RefusedConnection[];
}

/** The kept state from its JSON, every part read on its own (a part this runtime can't read is left out). */
export function boxNetworkStateOf(raw: unknown): BoxNetworkState {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    move: part(Move, o.move),
    address: part(Ip, o.address),
    hubChangedAt: part(Iso, o.hubChangedAt),
    cable: part(Cable, o.cable),
    cableLost: part(Lost, o.cableLost),
    backup: part(Backup, o.backup),
    change: part(Change, o.change),
    refused: (Array.isArray(o.refused) ? o.refused : []).flatMap((r) => {
      const p = Refused.safeParse(r);
      return p.success ? [p.data] : [];
    }),
  };
}
export type RefusedConnection = z.output<typeof Refused>;

/** The kept state, every part read on its own; empty without a row. `lock`: held until the transaction ends. */
export async function loadBoxNetwork(db: Db | Tx, lock = false): Promise<BoxNetworkState> {
  const query = db.select({ state: boxNetwork.state }).from(boxNetwork).where(eq(boxNetwork.id, ROW_ID));
  const [row] = lock ? await query.for('update') : await query;
  return boxNetworkStateOf(row?.state);
}

/** Drops the parts that are undefined, so the stored JSON holds only what is known. */
function stored(state: BoxNetworkState): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined));
}

/**
 * Changes the kept state in one transaction (read, `change`, write when it moved). `change` returns the new state, or
 * null to leave it. Returns the state after.
 */
export async function updateBoxNetwork(
  services: Pick<Services, 'pipeline' | 'clock'>,
  change: (state: BoxNetworkState) => BoxNetworkState | null,
): Promise<BoxNetworkState> {
  return services.pipeline.transactAccount(async (tx) => {
    // The row exists before it is locked: two first writers would otherwise both start from nothing and the later one
    // would drop what the first wrote.
    await tx
      .insert(boxNetwork)
      .values({ id: ROW_ID, state: {}, updatedAt: services.clock() })
      .onConflictDoNothing({ target: boxNetwork.id });
    const before = await loadBoxNetwork(tx, true);
    const after = change(before);
    if (!after) return before;
    const value = stored(after);
    if (JSON.stringify(value) === JSON.stringify(stored(before))) return before;
    const now = services.clock();
    await tx
      .insert(boxNetwork)
      .values({ id: ROW_ID, state: value, updatedAt: now })
      .onConflictDoUpdate({ target: boxNetwork.id, set: { state: value, updatedAt: now } });
    return after;
  });
}
