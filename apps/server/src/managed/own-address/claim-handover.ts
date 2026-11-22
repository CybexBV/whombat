/**
 * Hands the box's claim link to the manager, which sends it to control with `link.status`. Control shows it only to the
 * account this box is linked to, so the person who just linked it on the account site opens the claim directly and
 * types only the four letters on the screen (docs/decisions/own-address.md). The link goes only while nobody claimed
 * the box and its own address serves its page; once claimed, or once the page is gone, the manager is told there is
 * none, and control forgets it. Control isn't a stranger from Certificate Transparency: the link still keeps those out.
 *
 * A change goes at once; the same link goes again every `CLAIM_HANDOVER_AGAIN_MS`, so a manager that restarted has it
 * back. An older manager answers 404: then only a change is tried again. The link is a secret: never logged here.
 */
import { LOCAL_API_VERSION } from '@whombat/control-contracts/local';
import type { Services } from '../../services';
import { ManagerCallError, type ManagerPort } from '../ports';

export const CLAIM_HANDOVER_AGAIN_MS = 60_000;

export interface ClaimHandoverOptions {
  manager: ManagerPort;
  /** The claim link's six letters while the box should hand it over, else null. */
  current: () => string | null;
  log: Services['log'];
  /** Tests: no timer. */
  timers?: boolean;
}

export class ClaimLinkHandover {
  /** What the manager last took (null: none); undefined until it took anything. */
  #told: string | null | undefined = undefined;
  /** The manager has no route for it (an older one). */
  #missing = false;
  #running: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ClaimHandoverOptions) {}

  start(): Promise<void> {
    if (this.options.timers !== false && !this.#timer) {
      this.#timer = setInterval(() => void this.sync(true), CLAIM_HANDOVER_AGAIN_MS);
      this.#timer.unref?.();
    }
    return this.sync();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Tells the manager the link it should send now, when that changed (`again`: a link it has is given again too). One
   * call at a time, in order, so a link taken back right after it was given is never undone by the slower call.
   */
  sync(again = false): Promise<void> {
    const run = async () => {
      const call = this.options.manager.linkClaim?.bind(this.options.manager);
      if (!call) return;
      const link = this.options.current();
      if (link === this.#told && !(again && link !== null && !this.#missing)) return;
      try {
        await call({ v: LOCAL_API_VERSION, ...(link ? { claimLink: link } : {}) });
        this.#told = link;
        this.#missing = false;
      } catch (err) {
        if (err instanceof ManagerCallError && err.status === 404) {
          this.#missing = true;
          this.#told = link;
          return;
        }
        // Not taken: the next change or the next regular hand-over tries again.
        this.#told = undefined;
        this.options.log.debug(
          { status: err instanceof ManagerCallError ? err.status : null },
          'own address: the claim link wasn’t handed to the manager',
        );
      }
    };
    this.#running = this.#running.then(run, run);
    return this.#running;
  }
}
