/**
 * A fake support service (remote-help-server.md RH-S10), for development and the app's e2e (`WHOMBAT_SUPPORT=fake`, a
 * test Whombat: Forever, no help code; `fake-prod`, a customer's: a help code, no Forever). In memory, on the given clock:
 * two earlier visits to look at (one with a command line), a grant that expires, and — when it is turned on — “Support”
 * connecting a moment later and looking around until it is stopped or runs out, so the card, the desk line and the
 * person's messages all have something to show. Events go out as the real service's do (`GET /v1/events`).
 */
import { randomBytes } from 'node:crypto';
import type {
  SupportEvent,
  SupportEventsAnswer,
  SupportGrantRequest,
  SupportState,
  SupportStopRequest,
} from '@whombat/control-contracts/local';
import { helpCodeFromBytes, type RemoteHelpLevel, remoteHelpDurationSeconds } from '@whombat/core';
import type { RemoteHelpStep } from '@whombat/protocol/session';
import { SupportCallError, type SupportPort, type SupportVisit } from './remote-help-client';

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHdob21iYXQtZmFrZS1zdXBwb3J0LWhvc3Qta2V5ISEh';
const DAY = 86_400_000;

export interface FakeSupportOptions {
  /** `local`: a test Whombat (Forever, no help code); `prod`: a customer's (a help code, no Forever). */
  environment?: 'local' | 'prod';
  /** How long after a grant “Support” connects; null: nobody connects by themselves (tests). */
  visitAfterMs?: number | null;
  /** Runs `fn` in `ms`; returns what cancels it (tests: none, or their clock's). */
  after?: (ms: number, fn: () => void) => () => void;
}

const timer = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

interface Visit extends SupportVisit {
  transcript: string;
}

type Grant = NonNullable<SupportState['grant']>;

const TRANSCRIPT = [
  '\u001b[1;32mroot@whombat\u001b[0m:~# systemctl status whombat-voice --no-pager | head -3',
  '\u001b[1;32m●\u001b[0m whombat-voice.service - Whombat voice',
  '     Loaded: loaded (/etc/systemd/system/whombat-voice.service; enabled)',
  '     Active: \u001b[1;31mfailed\u001b[0m (Result: exit-code) since Mon 2026-10-19 08:12:03 UTC',
  '\u001b[1;32mroot@whombat\u001b[0m:~# systemctl restart whombat-voice',
  '\u001b[1;32mroot@whombat\u001b[0m:~# systemctl is-active whombat-voice',
  'active',
  '\u001b[1;32mroot@whombat\u001b[0m:~# exit',
  '',
].join('\r\n');

export class FakeSupport implements SupportPort {
  readonly #now: () => number;
  readonly #environment: 'local' | 'prod';
  readonly #visitAfterMs: number | null;
  readonly #after: (ms: number, fn: () => void) => () => void;
  #grant: Grant | null = null;
  readonly #visits: Visit[];
  readonly #events: SupportEvent[] = [];
  #seq = 0;
  #serial = 0;
  readonly #waiters = new Set<() => void>();
  #cancelVisit: (() => void) | null = null;

  constructor(now: () => number = Date.now, options: FakeSupportOptions = {}) {
    this.#now = now;
    this.#environment = options.environment ?? 'local';
    this.#visitAfterMs = options.visitAfterMs === undefined ? 3_000 : options.visitAfterMs;
    this.#after = options.after ?? timer;
    this.#visits = earlierVisits(now());
  }

  #iso(ms = this.#now()): string {
    return new Date(ms).toISOString();
  }

  /** A grant whose time ran out ends now (its visitors leave). */
  #tick(): void {
    const until = this.#grant?.until;
    if (until && Date.parse(until) <= this.#now()) this.#end({ kind: 'expired' });
  }

  #emit(event: Omit<SupportEvent, 'seq' | 'at'>): void {
    this.#events.push({ seq: ++this.#seq, at: this.#iso(), ...event });
    if (this.#events.length > 500) this.#events.splice(0, this.#events.length - 500);
    for (const wake of [...this.#waiters]) wake();
  }

  #end(event: Omit<SupportEvent, 'seq' | 'at'>): void {
    this.#cancelVisit?.();
    this.#cancelVisit = null;
    for (const visit of this.#visits)
      if (visit.endedAt === null) {
        visit.steps.push({ at: this.#iso(), kind: 'left' });
        visit.endedAt = this.#iso();
        this.#emit({
          kind: 'visit_end',
          visitId: visit.id,
          who: visit.who,
          level: visit.level,
          startedAt: visit.startedAt,
          steps: visit.steps.length,
        });
      }
    this.#grant = null;
    this.#emit(event);
  }

  /** “Support” connects and looks around (development; tests call it themselves). */
  startVisit(who = 'Support'): string | null {
    this.#tick();
    if (!this.#grant) return null;
    const at = this.#iso();
    const id = `v_fake_${++this.#serial}`;
    const steps: RemoteHelpStep[] = [
      { at, kind: 'connected' },
      { at, kind: 'look', command: 'status' },
      { at, kind: 'look', command: 'logs', units: ['whombat-voice.service'] },
    ];
    this.#visits.unshift({
      id,
      who,
      level: this.#grant.level,
      startedAt: at,
      endedAt: null,
      steps,
      truncated: false,
      transcriptBytes: 0,
      transcript: '',
    });
    this.#emit({ kind: 'visit_start', visitId: id, who, level: this.#grant.level });
    return id;
  }

  /** A wrong help code was typed (tests): five end the grant. */
  wrongCode(): void {
    this.#tick();
    if (!this.#grant) return;
    this.#grant.wrongCodes += 1;
    if (this.#grant.wrongCodes >= 5) this.#end({ kind: 'locked_out' });
  }

  async state(): Promise<SupportState> {
    this.#tick();
    const connected = this.#visits
      .filter((v) => v.endedAt === null)
      .slice(0, 8)
      .map((v) => ({ visitId: v.id, who: v.who, since: v.startedAt }));
    return {
      v: 1,
      available: true,
      foreverAllowed: this.#environment !== 'prod',
      helpCodeRequired: this.#environment === 'prod',
      environment: this.#environment,
      hostKey: HOST_KEY,
      grant: this.#grant ? { ...this.#grant, grantedBy: { ...this.#grant.grantedBy } } : null,
      connected,
    };
  }

  async grant(request: Omit<SupportGrantRequest, 'v'>): Promise<SupportState> {
    this.#tick();
    if (request.duration === 'forever' && this.#environment === 'prod')
      throw new SupportCallError('/v1/grant', 403, 'forever_not_allowed', 'support /v1/grant: 403');
    const now = this.#now();
    const before = this.#grant;
    const seconds = remoteHelpDurationSeconds(request.duration);
    this.#grant = {
      level: request.level,
      since: before?.since ?? this.#iso(now),
      until: seconds === null ? null : this.#iso(now + seconds * 1000),
      grantedBy: { ...request.grantedBy },
      helpCode:
        this.#environment === 'prod'
          ? (before?.helpCode ?? helpCodeFromBytes(new Uint8Array(randomBytes(6))))
          : null,
      wrongCodes: before?.wrongCodes ?? 0,
    };
    this.#emit({ kind: 'grant', level: request.level, duration: request.duration, by: request.grantedBy });
    const someone = this.#visits.some((v) => v.endedAt === null);
    if (!someone && this.#visitAfterMs !== null && !this.#cancelVisit)
      this.#cancelVisit = this.#after(this.#visitAfterMs, () => {
        this.#cancelVisit = null;
        this.startVisit();
      });
    return this.state();
  }

  async stop(request: Omit<SupportStopRequest, 'v'>): Promise<SupportState> {
    this.#tick();
    if (this.#grant)
      this.#end({ kind: 'stop', reason: request.reason, ...(request.by ? { by: request.by } : {}) });
    return this.state();
  }

  async visits(query: { before?: string; limit?: number }): Promise<SupportVisit[]> {
    this.#tick();
    let list = this.#visits;
    if (query.before !== undefined) {
      const at = list.findIndex((v) => v.id === query.before);
      list = at < 0 ? [] : list.slice(at + 1);
    }
    return list.slice(0, query.limit ?? 20).map(({ transcript: _t, ...visit }) => ({
      ...visit,
      steps: visit.steps.slice(-200),
    }));
  }

  async transcript(visitId: string): Promise<AsyncIterable<Uint8Array> | null> {
    const visit = this.#visits.find((v) => v.id === visitId);
    if (!visit?.transcript) return null;
    const bytes = new TextEncoder().encode(visit.transcript);
    return (async function* () {
      yield bytes;
    })();
  }

  async events(after: number, waitS: number, signal?: AbortSignal): Promise<SupportEventsAnswer> {
    this.#tick();
    const pending = () => this.#events.filter((e) => e.seq > after);
    if (pending().length === 0 && waitS > 0 && !signal?.aborted) {
      // The grant's end is an event too: wait no longer than until then.
      const until = this.#grant?.until
        ? Date.parse(this.#grant.until) - this.#now()
        : Number.POSITIVE_INFINITY;
      await new Promise<void>((resolve) => {
        const done = () => {
          cancel();
          this.#waiters.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const cancel = this.#after(Math.max(0, Math.min(waitS * 1000, until)), done);
        this.#waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
      this.#tick();
    }
    return { v: 1, events: pending().slice(0, 100), next: this.#seq };
  }
}

/** Two earlier visits: Support looked (three days ago), and looked and fixed the voice (yesterday). */
function earlierVisits(now: number): Visit[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  const look = now - 3 * DAY;
  const fix = now - DAY;
  const visit = (
    id: string,
    level: RemoteHelpLevel,
    start: number,
    minutes: number,
    steps: RemoteHelpStep[],
    transcript = '',
  ): Visit => ({
    id,
    who: 'Support',
    level,
    startedAt: iso(start),
    endedAt: iso(start + minutes * 60_000),
    steps,
    truncated: false,
    transcriptBytes: new TextEncoder().encode(transcript).length,
    transcript,
  });
  return [
    visit(
      'v_fake_fix',
      'fix',
      fix,
      25,
      [
        { at: iso(fix), kind: 'connected' },
        { at: iso(fix + 60_000), kind: 'look', command: 'report' },
        { at: iso(fix + 4 * 60_000), kind: 'exec', line: 'systemctl status whombat-voice --no-pager' },
        { at: iso(fix + 6 * 60_000), kind: 'shell', seconds: 260 },
        { at: iso(fix + 12 * 60_000), kind: 'restart', units: ['whombat-voice.service'] },
        { at: iso(fix + 14 * 60_000), kind: 'forward', target: '127.0.0.1:8123', bytes: 18_234 },
        { at: iso(fix + 25 * 60_000), kind: 'left' },
      ],
      TRANSCRIPT,
    ),
    visit('v_fake_look', 'look', look, 12, [
      { at: iso(look), kind: 'connected' },
      { at: iso(look + 30_000), kind: 'look', command: 'status' },
      { at: iso(look + 2 * 60_000), kind: 'look', command: 'logs', units: ['whombat-voice.service'] },
      { at: iso(look + 5 * 60_000), kind: 'look', command: 'network' },
      { at: iso(look + 9 * 60_000), kind: 'refused', reason: 'level' },
      { at: iso(look + 12 * 60_000), kind: 'left' },
    ]),
  ];
}
