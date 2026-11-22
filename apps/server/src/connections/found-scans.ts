/**
 * Found on your network by itself (docs/decisions/desk-found.md DF-02, DF-04, DF-05, DF-07; DF-S02, DF-S06…DF-S08):
 * the burrow's own scans, and what follows them.
 *
 * - **When.** On a managed Whombat (an appliance) only: for every burrow where the person has their Chat with the agent — checked every
 *   minute, and at once when the screen pairs itself (DK-17), so right after the claim — then at every runtime start
 *   (the first check after it) and once a day; never after the screen's Not now put the view away (DF-04).
 * - **How.** The same scan as Found on your network (`scanBurrow`): one per burrow at a time, a running or fresh one
 *   taken over, planned as the person DF-03 names (the screen's paired person in that burrow, else the person).
 * - **After.** The burrow's first automatic scan's finish is kept (`connection_found_state.first_scan_at`: until then
 *   the screen shows its progress, DF-07); when something new was found and the assistant hasn't told yet, it tells
 *   that person once, in their Chat, with one button per find (DF-05; first-day.md). The welcome tells instead when it
 *   comes after the scan: whichever names the finds first claims the telling.
 *
 * The state is the burrow's own, not anyone's decision: written in the burrow's transaction, without an event (like a
 * read marker; the screen's Not now can come from a locked screen, which isn't anyone).
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { assistantStates, connectionFoundState, messages } from '../db/schema/index';
import { personPlaces } from '../desk/person';
import { loadDeskRow } from '../desk/store';
import { personalPlace } from '../guides/place';
import { type FoundNow, foundLaterSteps } from '../guides/welcome';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { burrowFound, type FinishedScan, newFoundTest, scanBurrow } from './discover';
import { orderFound } from './found-view';
import type { ConnectionViewer } from './store';

/** How often the automatic scans check what is due (DF-02). */
export const FOUND_CHECK_MS = 60_000;
/** A burrow's automatic scans are this far apart (DF-02: once a day). */
export const FOUND_EVERY_MS = 24 * 3_600_000;
export interface FoundState {
  firstScanAt: Date | null;
  toldAt: Date | null;
  putAwayAt: Date | null;
}

const NO_STATE: FoundState = { firstScanAt: null, toldAt: null, putAwayAt: null };

export async function foundStateOf(db: Db, burrowId: string): Promise<FoundState> {
  const [row] = await db
    .select({
      firstScanAt: connectionFoundState.firstScanAt,
      toldAt: connectionFoundState.toldAt,
      putAwayAt: connectionFoundState.putAwayAt,
    })
    .from(connectionFoundState)
    .where(eq(connectionFoundState.burrowId, burrowId));
  return row ?? NO_STATE;
}

/**
 * The person DF-03 names in a burrow: the screen's paired person when it is paired there, else the burrow's first
 * person's place (`places`, from `personPlaces`). Null when neither has a place there.
 */
export async function foundPersonOf(
  db: Db,
  burrowId: string,
  places: ReadonlyMap<string, string>,
): Promise<string | null> {
  const desk = await loadDeskRow(db);
  if (desk?.burrowId === burrowId && (await personalPlace(db, burrowId, desk.personId))) return desk.personId;
  return places.get(burrowId) ?? null;
}

/** A person as the viewer a scan is planned and answered for. */
export async function foundViewerOf(db: Db, personId: string): Promise<ConnectionViewer | null> {
  const principal = await loadPrincipalRow(db, personId);
  if (principal?.kind !== 'person' || !principal.accountId) return null;
  return {
    accountId: principal.accountId,
    burrowId: principal.burrowId,
    principal,
  };
}

/**
 * The screen's Not now (DF-04): the view put away for the burrow, final; the automatic scans stop. True the first
 * time, false when it was away already.
 */
export async function putFoundAway(services: Services, burrowId: string): Promise<boolean> {
  const now = services.clock();
  const { result } = await services.pipeline.transact(burrowId, async ({ tx }) => {
    const rows = await tx
      .insert(connectionFoundState)
      .values({ burrowId, putAwayAt: now })
      .onConflictDoUpdate({
        target: connectionFoundState.burrowId,
        set: { putAwayAt: now },
        setWhere: isNull(connectionFoundState.putAwayAt),
      })
      .returning({ burrowId: connectionFoundState.burrowId });
    return rows.length > 0;
  });
  return result;
}

/** The burrow's first automatic scan finished (DF-07): kept once. */
async function firstScanDone(services: Services, burrowId: string, at: Date): Promise<void> {
  await services.pipeline.transact(burrowId, async ({ tx }) => {
    await tx
      .insert(connectionFoundState)
      .values({ burrowId, firstScanAt: at })
      .onConflictDoUpdate({
        target: connectionFoundState.burrowId,
        set: { firstScanAt: at },
        setWhere: isNull(connectionFoundState.firstScanAt),
      });
  });
}

/**
 * Claims the telling of the burrow's finds (DF-05), inside the caller's transaction: true the first time, false when
 * it was told already or the view was put away. The welcome and the scan's own message share it, so the finds are
 * named once.
 */
export async function claimFoundTold(tx: Tx, burrowId: string, now: Date): Promise<boolean> {
  const claimed = await tx
    .insert(connectionFoundState)
    .values({ burrowId, toldAt: now })
    .onConflictDoUpdate({
      target: connectionFoundState.burrowId,
      set: { toldAt: now },
      setWhere: and(isNull(connectionFoundState.toldAt), isNull(connectionFoundState.putAwayAt)),
    })
    .returning({ burrowId: connectionFoundState.burrowId });
  return claimed.length > 0;
}

/**
 * What the welcome can name now (first-day.md): the last finished scan's finds that are new for the person (DF-03),
 * in order, and whether the burrow's first automatic scan is still to come (the scans run here, nothing put away, no
 * first scan finished): then the finds come later as one message. A scan still running names nothing yet: what it
 * found so far is only part of it.
 */
export async function foundNowFor(services: Services, burrowId: string, personId: string): Promise<FoundNow> {
  const state = await foundStateOf(services.db, burrowId);
  const looking = foundScansFor(services).started && state.putAwayAt === null && state.firstScanAt === null;
  const viewer = await foundViewerOf(services.db, personId);
  const last = burrowFound(services, burrowId).last;
  if (!viewer || !last || state.putAwayAt) return { finds: [], looking };
  const isNew = await newFoundTest(services, viewer);
  return { finds: orderFound(last.found.filter(isNew)), looking };
}

/**
 * The assistant's one message (DF-05): to `personId` in their Chat, when the scan found something new for them and
 * nobody was told yet and the view wasn't put away — one button per find (first-day.md). Not before the person's
 * welcome: the welcome names the finds itself when it comes after the scan. It goes in the welcome's thread, so a new
 * person's Chat holds one thread from the assistant, not one per message; at the top of the Chat when the welcome is
 * gone. True when it posted.
 */
export async function tellFound(
  services: Services,
  burrowId: string,
  personId: string,
  scan: FinishedScan,
): Promise<boolean> {
  const viewer = await foundViewerOf(services.db, personId);
  if (!viewer) return false;
  const isNew = await newFoundTest(services, viewer);
  const fresh = orderFound(scan.found.filter(isNew));
  if (fresh.length === 0) return false;
  const ids = await services.guides.postTo(
    burrowId,
    personId,
    async (ctx, place) => {
      if (!(await welcomed(ctx.tx, burrowId, personId))) return null;
      if (!(await claimFoundTold(ctx.tx, burrowId, ctx.now))) return null;
      return {
        steps: foundLaterSteps(fresh),
        threadRootId: await welcomeThread(ctx.tx, place.dm.id, place.agent.id),
      };
    },
    { notify: true },
  );
  return ids.length > 0;
}

/**
 * The welcome's thread: the Chat's first top-level message, when the assistant wrote it and it is still there (the
 * welcome goes out only into an empty Chat). A welcome from before it was one thread is its first message too.
 */
async function welcomeThread(tx: Tx, conversationId: string, agentId: string): Promise<string | null> {
  const [first] = await tx
    .select({ id: messages.id, authorId: messages.authorId, deletedAt: messages.deletedAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.threadRootId)))
    .orderBy(asc(messages.ord))
    .limit(1);
  return first && first.authorId === agentId && !first.deletedAt ? first.id : null;
}

/** Whether the person's welcome went out (it names the finds itself when it comes after the scan). */
async function welcomed(tx: Tx, burrowId: string, personId: string): Promise<boolean> {
  const [state] = await tx
    .select({ welcomedAt: assistantStates.welcomedAt })
    .from(assistantStates)
    .where(and(eq(assistantStates.burrowId, burrowId), eq(assistantStates.personId, personId)));
  return !!state?.welcomedAt;
}

/** The automatic scans of one runtime (DF-02). */
export class FoundScans {
  #off: (() => void) | null = null;
  /** When each burrow's last automatic scan started in this runtime: none yet means due (each start). */
  readonly #startedAt = new Map<string, number>();
  readonly #scans = new Map<string, Promise<void>>();
  #check: Promise<void> | null = null;
  #closed = false;

  constructor(private readonly services: Services) {}

  /** The automatic scans run in this runtime (a managed Whombat), and haven't been closed. */
  get started(): boolean {
    return this.#off !== null && !this.#closed;
  }

  /** The check every minute, the first one at the next housekeeping tick (each start, DF-02). */
  start(): void {
    if (this.#off || this.#closed) return;
    this.#off = this.services.housekeeping.add('found scans', FOUND_CHECK_MS, () => this.check(), {
      first: 'tick',
    });
  }

  /** The screen paired itself (DK-17): check now rather than within the minute. Only once started. */
  kick(): void {
    if (!this.#off || this.#closed) return;
    void this.check().catch((err) =>
      this.services.log.warn({ err: String(err) }, 'found scans: the check failed'),
    );
  }

  close(): void {
    this.#closed = true;
    this.#off?.();
    this.#off = null;
  }

  /** Waits for the scans started so far and what follows them (tests). */
  async settle(): Promise<void> {
    await this.#check;
    while (this.#scans.size) await Promise.allSettled([...this.#scans.values()]);
  }

  /**
   * Starts the scans that are due (one check at a time): every burrow where the person has their Chat with the agent, not put away,
   * none running, and none started by this runtime within a day. Never waits for the scans.
   */
  check(): Promise<void> {
    this.#check ??= this.#due().finally(() => {
      this.#check = null;
    });
    return this.#check;
  }

  async #due(): Promise<void> {
    if (this.#closed || this.services.maintenance.paused) return;
    const db = this.services.db;
    const places = await personPlaces(db);
    if (places.size === 0) return;
    const away = new Set(
      (
        await db
          .select({ burrowId: connectionFoundState.burrowId, putAwayAt: connectionFoundState.putAwayAt })
          .from(connectionFoundState)
          .where(inArray(connectionFoundState.burrowId, [...places.keys()]))
      )
        .filter((r) => r.putAwayAt !== null)
        .map((r) => r.burrowId),
    );
    const now = this.services.clock().getTime();
    for (const burrowId of places.keys()) {
      if (away.has(burrowId) || this.#scans.has(burrowId)) continue;
      const last = this.#startedAt.get(burrowId);
      if (last !== undefined && now - last < FOUND_EVERY_MS) continue;
      this.#startedAt.set(burrowId, now);
      const scan = this.#scan(burrowId, places)
        .catch((err) =>
          this.services.log.warn({ err: String(err), burrowId }, 'found scans: the scan failed'),
        )
        .finally(() => this.#scans.delete(burrowId));
      this.#scans.set(burrowId, scan);
    }
  }

  /** One automatic scan of a burrow, and what follows it (DF-07, DF-05). */
  async #scan(burrowId: string, places: ReadonlyMap<string, string>): Promise<void> {
    const db = this.services.db;
    const personId = await foundPersonOf(db, burrowId, places);
    const viewer = personId ? await foundViewerOf(db, personId) : null;
    // Not now may have come since the check.
    if (!personId || !viewer || (await foundStateOf(db, burrowId)).putAwayAt) return;
    const scan = await scanBurrow(this.services, viewer);
    if (!scan || this.#closed) return;
    await firstScanDone(this.services, burrowId, scan.finishedAt);
    // Whom to tell is decided after the scan: the screen may have paired itself meanwhile.
    const tellWhom = (await foundPersonOf(db, burrowId, await personPlaces(db))) ?? personId;
    if ((await foundStateOf(db, burrowId)).toldAt === null)
      await tellFound(this.services, burrowId, tellWhom, scan);
  }
}

const scansOf = new WeakMap<Services, FoundScans>();

/** The runtime's automatic scans (one per `Services`). */
export function foundScansFor(services: Services): FoundScans {
  let scans = scansOf.get(services);
  if (!scans) {
    scans = new FoundScans(services);
    scansOf.set(services, scans);
  }
  return scans;
}
