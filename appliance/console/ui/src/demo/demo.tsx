/** Dev-only fixture mode (`?demo=<name>`): a fake server per fixture. Not part of the production bundle. */
import { fixtureLoadImage } from '@whombat/screen/fixtures';
import type { ConsoleState, ServerState } from '../lib/api';
import type { Client } from '../lib/client';
import type { DeskState, DeskTalk, LookResearch, ServerRange } from '../lib/desk';
import { DESK_WORDS } from '../lib/deskCopy';
import { encodeWav } from '../lib/wav';
import { bluetoothDemo } from './bluetoothDemo';
import { FIXTURES, type Fixture } from './fixtures';
import { wifiDemo } from './wifiDemo';

export { FIXTURES };

/** The PIN the demo desk takes (fixtures only), by the PIN's length (DK-26). */
export const DEMO_PINS: Record<4 | 5 | 6, string> = { 4: '2580', 5: '25803', 6: '123456' };

/** What the demo desk answers when the fixture doesn't say. */
const DEMO_ANSWER: Partial<DeskTalk> = {
  answer: 'Yes, pve-02 is fine. The backup ran at 03:00 and finished in 14 minutes.',
  thing: {
    name: 'pve-02',
    mark: 'proxmox',
    state: 'ok',
    note: 'up 41 d · backup ran 03:00',
    cpu: { value: 12, tone: 'ok' },
    memory: { value: 61, tone: 'ok' },
    temp: { value: 49, tone: 'ok' },
  },
};

/** A short soft tone as the “spoken” answer (the demo has no voice). */
function demoWav(): Blob {
  const rate = 16_000;
  const s = new Float32Array(rate * 0.6);
  for (let i = 0; i < s.length; i++) {
    const env = Math.min(1, i / 800, (s.length - i) / 4000);
    s[i] = 0.15 * env * Math.sin((2 * Math.PI * 440 * i) / rate);
  }
  return new Blob([encodeWav(s, rate) as BlobPart], { type: 'audio/wav' });
}

/** A widget's picture as `@whombat/screen`'s fixtures draw it (an SVG), as the console server would answer it. */
async function demoPicture(path: string): Promise<Blob> {
  const q = new URLSearchParams(path.slice(path.indexOf('?')));
  const url = await fixtureLoadImage({
    thing: q.get('thing') ?? '',
    ref: q.get('ref') ?? '',
    shape: 'poster',
  });
  return new Blob([decodeURIComponent(url.slice(url.indexOf(',') + 1))], { type: 'image/svg+xml' });
}

export function demoClient(f: Fixture): Client {
  const start = Date.now();
  /** The fixture's network, Wi-Fi and the networks around (CG-110): the chip, the sheet, the installer's step. */
  const wifi = f.wifi ? wifiDemo(f.wifi) : null;
  /** The fixture's Bluetooth (CG-211): the chip, the sheet, the devices around. */
  const bt = f.bluetooth ? bluetoothDemo(f.bluetooth) : null;
  let override: ServerState | null = null;
  let tries = 5;
  /** Talks the demo answered: when they started and what was asked. */
  const talks = new Map<string, { at: number; question: string | null }>();
  /** The fixture's conversation until Close conversation (DK-64). */
  let session = f.session ?? null;
  /** Found on your network put away with Not now (DF-04): Whombat sends it no more. */
  let foundDismissed = false;
  const current = (): ServerState | null => {
    const t = Date.now() - start;
    let s: ServerState | null = null;
    for (const step of f.timeline) if (step.at <= t) s = step.state;
    return override ?? s;
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  /** Unlocked until: 30 s ahead while the camera sees someone, else 2 minutes (DK-28). */
  const unlockedUntil = (now: number) => iso(now + (f.camera === 'present' ? 30_000 : 120_000));

  /** The demo's talk after `ms`: heard, then thinking, then a canned answer. */
  const talkNow = (id: string): DeskTalk | null => {
    const t = talks.get(id);
    if (!t) return null;
    const ms = Date.now() - t.at;
    const question = t.question ?? 'Is pve-02 okay?';
    if (ms < 1200 && !t.question) return { ...talkBase(id), state: 'transcribing' };
    if (ms < 3500) return { ...talkBase(id), state: 'thinking', question };
    // The fixture's answer under the asked talk's id (a fixture's `talkAnswer` may carry its own).
    return { ...talkBase(id), ...DEMO_ANSWER, ...f.talkAnswer, id, state: 'answered', question };
  };
  const talkBase = (id: string): DeskTalk => ({
    id,
    state: 'thinking',
    question: null,
    answer: null,
    thing: null,
    audio: true,
    reason: null,
  });

  const withDesk = (patch: (d: DeskState, s: ConsoleState) => Partial<DeskState>) => {
    const s = current();
    if (s?.mode !== 'console' || !s.desk) return;
    override = { ...s, desk: { ...s.desk, ...patch(s.desk, s) } };
  };

  /** The look's research and the calm hero about it, as the runtime would send them after a change (CG-376). */
  const withResearch = (d: DeskState, key: string, research: LookResearch): Partial<DeskState> => {
    const g = d.glance;
    if (!g) return {};
    const looks = (g.needsYou.looks ?? []).map((l) => (l.key === key ? { ...l, research } : l));
    const hero = g.calm?.hero;
    const calm =
      g.calm && hero?.look === key
        ? {
            ...g.calm,
            ...(research.state === 'fixed' && {
              headline: { tone: 'ok' as const, text: 'All fine', more: null },
            }),
            hero: {
              ...hero,
              research: research.state,
              fix: null,
              title: research.title ?? hero.title,
              detail: research.state === 'fixing' ? DESK_WORDS.looks.fixing : (research.summary ?? null),
            },
          }
        : g.calm;
    return { glance: { ...g, needsYou: { ...g.needsYou, looks }, calm } };
  };

  async function desk(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    // The fixture's clock: its states have a fixed `now`, and the page shows that time.
    const s0 = current();
    const now = s0?.mode === 'console' ? Date.parse(s0.now) : Date.now();
    switch (path) {
      case '/api/desk/unlock':
        // A screen without a PIN refuses one, as Whombat does (DK-18).
        if (s0?.mode === 'console' && s0.desk?.paired && !s0.desk.paired.hasPin) {
          return { status: 409, body: { message: 'no_pin' } };
        }
        if (s0?.mode === 'console' && body.pin === DEMO_PINS[s0.desk?.paired?.pinDigits ?? 6]) {
          tries = 5;
          const camera = f.camera ? { camera: true, present: f.camera === 'present' } : {};
          withDesk(() => ({
            lock: { state: 'unlocked', until: unlockedUntil(now), retryAt: null, expiresAt: null, ...camera },
            ...(f.unlockedGlance ? { glance: f.unlockedGlance } : {}),
          }));
          return { status: 200, body: { v: 1, result: 'unlocked' } };
        }
        tries -= 1;
        if (tries <= 0) {
          const retryAt = iso(now + 60_000);
          withDesk(() => ({ lock: { state: 'backoff', until: null, retryAt, expiresAt: null } }));
          return { status: 200, body: { v: 1, result: 'backoff', retryAt } };
        }
        return { status: 200, body: { v: 1, result: 'wrong', triesLeft: tries } };
      case '/api/desk/unlock/phone': {
        const expiresAt = iso(now + 120_000);
        withDesk((d) => ({ lock: { ...d.lock, state: 'phone', expiresAt } }));
        return { status: 200, body: { v: 1, expiresAt } };
      }
      case '/api/desk/lock':
        withDesk(() => ({ lock: { state: 'locked', until: null, retryAt: null, expiresAt: null } }));
        return { status: 200, body: { v: 1 } };
      case '/api/desk/touch':
        withDesk((d) =>
          d.lock.state === 'unlocked' ? { lock: { ...d.lock, until: unlockedUntil(now) } } : {},
        );
        return { status: 200, body: { v: 1, until: unlockedUntil(now) } };
      case '/api/desk/decide': {
        // A risky ask's Approve needs the PIN again (DK-62), checked as an unlock's.
        const ask =
          s0?.mode === 'console'
            ? s0.desk?.glance?.needsYou.items.find((a) => a.number === body.number)
            : null;
        // A wider choice (TF-14): one the ask offers, with the PIN, as Whombat checks it.
        const scope = typeof body.scope === 'string' && body.scope !== 'once' ? body.scope : null;
        if (scope && (f.notOffered || !ask?.choices?.some((c) => c.scope === scope)))
          return { status: 403, body: { message: 'not_offered' } };
        if (body.decision === 'approve' && (ask?.approveWithPin || scope)) {
          if (body.pin === undefined) return { status: 403, body: { message: 'pin_needed' } };
          if (body.pin !== DEMO_PINS[s0?.mode === 'console' ? (s0.desk?.paired?.pinDigits ?? 6) : 6]) {
            tries -= 1;
            if (tries <= 0)
              return { status: 200, body: { v: 1, result: 'backoff', retryAt: iso(now + 60_000) } };
            return { status: 200, body: { v: 1, result: 'wrong', triesLeft: tries } };
          }
          tries = 5;
        }
        withDesk((d) => {
          if (!d.glance) return {};
          const items = d.glance.needsYou.items.filter((a) => a.number !== body.number);
          return {
            glance: {
              ...d.glance,
              needsYou: { count: Math.max(0, d.glance.needsYou.count - 1), items },
            },
          };
        });
        return { status: 200, body: { v: 1, result: 'decided' } };
      }
      case '/api/desk/talk/session':
        return session
          ? { status: 200, body: { v: 1, ...session } }
          : { status: 404, body: { message: 'not_found' } };
      case '/api/desk/talk/close':
        if (session) session = { open: false, messages: [], earlier: 0, until: null };
        return { status: 200, body: { v: 1 } };
      case '/api/desk/servers':
      case '/api/desk/server': {
        // As the runtime (DK-84, DK-86): paired only, not in *Only the time* while locked; the alerts' titles only
        // unlocked or with *Everything*.
        const d = s0?.mode === 'console' ? s0.desk : null;
        if (!d?.paired) return { status: 409, body: { message: 'not_paired' } };
        const locked = d.lock.state !== 'unlocked';
        if (locked && d.paired.lockedView === 'time') return { status: 409, body: { message: 'locked' } };
        if (f.hostsAwayAfter !== undefined && Date.now() - start >= f.hostsAwayAfter)
          return { status: 503, body: { message: 'unavailable' } };
        if (path === '/api/desk/servers')
          return f.servers ? { status: 200, body: { v: 1, ...f.servers } } : { status: 404, body: null };
        const p = f.serverPage?.(String(body.id), body.range as ServerRange);
        if (!p) return { status: 404, body: { message: 'not_found' } };
        const titles = !locked || d.paired.lockedView === 'everything';
        const alerts = titles ? p.alerts : { count: p.alerts.count, items: [] };
        return { status: 200, body: { v: 1, ...p, now: iso(now), alerts } };
      }
      case '/api/desk/look/quiet': {
        // As the runtime (QN-20): unlocked only, the paired person may manage it, the look still there; then it leaves
        // Needs you.
        const d = s0?.mode === 'console' ? s0.desk : null;
        if (!d?.paired) return { status: 409, body: { message: 'not_paired' } };
        if (d.lock.state !== 'unlocked') return { status: 409, body: { message: 'locked' } };
        if (f.quietRefused)
          return { status: f.quietRefused === 'not_allowed' ? 403 : 404, body: { message: f.quietRefused } };
        const looks = d.glance?.needsYou.looks ?? [];
        if (
          !looks.some(
            (l) => l.key === body.key && l.notice?.check === (body.notice as { check?: unknown })?.check,
          )
        )
          return { status: 404, body: { message: 'not_found' } };
        withDesk((dd) => {
          if (!dd.glance) return {};
          const rest = (dd.glance.needsYou.looks ?? []).filter((l) => l.key !== body.key);
          const { looks: _gone, ...needsYou } = dd.glance.needsYou;
          return {
            glance: { ...dd.glance, needsYou: rest.length > 0 ? { ...needsYou, looks: rest } : needsYou },
          };
        });
        return { status: 200, body: { v: 1 } };
      }
      case '/api/desk/look/fix': {
        // As the runtime (LR-08): unlocked only, the paired person may manage it, the look still offers its step; then
        // the assistant is on it, and with the fixture's words it is fixed a moment later.
        const d = s0?.mode === 'console' ? s0.desk : null;
        if (!d?.paired) return { status: 409, body: { message: 'not_paired' } };
        if (d.lock.state !== 'unlocked') return { status: 409, body: { message: 'locked' } };
        if (f.stepRefused)
          return { status: f.stepRefused === 'not_allowed' ? 403 : 404, body: { message: f.stepRefused } };
        const look = d.glance?.needsYou.looks?.find((l) => l.key === body.key);
        if (!look?.research?.fix || look.research.state !== 'found')
          return { status: 404, body: { message: 'not_found' } };
        const { fix: _step, ...found } = look.research;
        withDesk((dd) => withResearch(dd, look.key, { ...found, state: 'fixing' }));
        const fixed = f.stepFixed;
        if (fixed) setTimeout(() => withDesk((dd) => withResearch(dd, look.key, fixed)), 4000);
        return { status: 200, body: { v: 1 } };
      }
      case '/api/desk/size':
        // What the page reported, for the shots to read (DK-147).
        document.documentElement.dataset.sizeReport = JSON.stringify(body);
        return { status: 200, body: { v: 1 } };
      case '/api/claim/letters': {
        // New letters asked for at the box: fresh ones that stay ten minutes.
        const s = current();
        if (s?.mode !== 'console' || !s.claim) return { status: 409, body: { message: 'not_available' } };
        override = {
          ...s,
          claim: {
            ...s.claim,
            state: 'claimable',
            code: s.claim.code === 'PRTV' ? 'KXQM' : 'PRTV',
            inApp: s.claim.inApp ?? '192.168.1.20',
            retryAt: null,
            lettersUntil: iso(Date.parse(s.now) + 600_000),
          },
        };
        return { status: 200, body: { v: 1 } };
      }
      case '/api/desk/remote-help/stop':
        // Allowed locked too, without a PIN (RH-04).
        withDesk(() => ({ remoteHelp: undefined }));
        return { status: 200, body: { v: 1 } };
      case '/api/desk/found/dismiss':
        // Allowed locked too (DF-04).
        foundDismissed = true;
        return { status: 200, body: { v: 1 } };
      case '/api/desk/hear': {
        // Talk's mic (CG-359): what the demo hears after a moment, as the box would.
        await new Promise((r) => setTimeout(r, 600));
        return { status: 200, body: { v: 1, text: 'Is pve-02 okay, and did last night’s backup run?' } };
      }
      case '/api/desk/talk': {
        const id = `demo-talk-${talks.size + 1}`;
        talks.set(id, { at: Date.now(), question: typeof body.text === 'string' ? body.text : null });
        return { status: 200, body: { v: 1, id } };
      }
      case '/api/desk/talk/get': {
        const s = current();
        const id = String(body.id);
        const fromState = s?.mode === 'console' && s.desk?.talk?.id === id ? s.desk.talk : null;
        const t = talkNow(id) ?? fromState;
        // Refusals as the console server writes them (`{"message": "<code>"}`, CG-56).
        return t ? { status: 200, body: { v: 1, ...t } } : { status: 404, body: { message: 'not_found' } };
      }
      default:
        return { status: 404, body: null };
    }
  }

  return {
    async state() {
      if (f.awayAfter !== undefined && Date.now() - start >= f.awayAfter) throw new Error('demo: away');
      let s = current();
      if (!s) throw new Error('demo: no state');
      if (foundDismissed && s.mode === 'console' && s.desk?.glance?.found)
        s = { ...s, desk: { ...s.desk, glance: { ...s.desk.glance, found: null } } };
      if (s.mode !== 'console') return structuredClone(s);
      return structuredClone({
        ...s,
        ...(wifi ? { network: wifi.summary() } : {}),
        ...(bt ? { bluetooth: bt.summary() } : {}),
      });
    },
    async get(path) {
      if (bt && path.startsWith('/api/bluetooth')) return bt.get(path);
      return wifi ? wifi.get(path) : { status: 404, body: { message: 'not found' } };
    },
    async post(path, body) {
      if (path.startsWith('/api/desk/')) return desk(path, (body ?? {}) as Record<string, unknown>);
      if (bt && path.startsWith('/api/bluetooth/'))
        return bt.post(path, (body ?? {}) as Record<string, unknown>);
      if (wifi && (path.startsWith('/api/network/') || path.startsWith('/api/wifi/')))
        return wifi.post(path, (body ?? {}) as Record<string, unknown>);
      const status = f.post?.[path] ?? 202;
      const s = current();
      if (status === 202 && path === '/api/install' && s?.mode === 'installer') {
        override = {
          ...s,
          install: { ...s.install, status: 'running', step: 'partition', percent: 2, log: [] },
        };
      }
      return { status, body: { ok: true } };
    },
    async blob(path) {
      if (path.startsWith('/api/desk/image')) return demoPicture(path);
      return path.startsWith('/api/desk/talk/audio') ? demoWav() : null;
    },
  };
}

export function DemoIndex() {
  return (
    <main style={{ padding: 32, height: '100%', overflow: 'auto', font: 'var(--type-body)' }}>
      <h1 style={{ font: 'var(--type-heading-28)', marginTop: 0 }}>Console UI fixtures</h1>
      <ul style={{ columns: 2, lineHeight: 1.8 }}>
        {Object.entries(FIXTURES).map(([name, f]) => (
          <li key={name}>
            <a href={`?demo=${name}`} style={{ color: 'var(--brand)' }}>
              {name}
            </a>{' '}
            <span style={{ color: 'var(--mut)' }}>{f.note}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
