/**
 * The live face in a browser (the web app and the box's desk screen): draws `faceSvg` into an element and moves its
 * parts by `faceMotion`'s rules. It writes each part's `transform` attribute from `requestAnimationFrame`, round the
 * part's pivot in the drawing's units, so it behaves the same in every browser and like the phone's engine.
 *
 * At most one face on a page moves: the biggest, or the newest of the biggest (`holdsMotion`). The others still change
 * pose, at once. Nothing runs while the page is hidden.
 */
import { type FaceCrop, type FacePart, type FacePose, facePivot, faceSvg } from './face';
import {
  BLINK,
  composeFrames,
  EAR_FOLLOW_DEGREES,
  easing,
  FACE_TIMING,
  type FaceAllowance,
  type FaceMotionMode,
  type FaceState,
  type FaceStep,
  faceAllowance,
  faceSequence,
  frameAt,
  frameTransform,
  GLANCE,
  liveFaceCrop,
  mixTransforms,
  mouthOpening,
  type PartFrame,
  type PartMove,
  restingPose,
  SIGNATURE_GESTURES,
  SQUASH,
} from './faceMotion';
import type { AvatarFace } from './index';

export interface PuppetOptions {
  face: AvatarFace;
  /** Rendered size, px. */
  size: number;
  state: FaceState;
  mode: FaceMotionMode;
  /** The voice's loudness now, 0–1: the speaking mouth and the listening ears follow it. */
  level?: (() => number) | null;
  /** A tap pokes it (it is play, not a button: nothing depends on it). */
  pokeable?: boolean;
  /** The framing; by default the head under 40 px and the bust from 40 (`liveFaceCrop`). */
  crop?: FaceCrop;
  /** Plays its state's sequence when it first draws (a face that greets, `welcome`), where gestures are allowed. */
  greet?: boolean;
}

const cropOf = (o: PuppetOptions): FaceCrop => o.crop ?? liveFaceCrop(o.size);

const PUPPETS = new Set<FacePuppet>();
let nextId = 0;
let lastActivity = 0;
let listening = false;

/** The one face that may move: the biggest; among equals, the newest. */
function holder(): FacePuppet | null {
  let best: FacePuppet | null = null;
  for (const p of PUPPETS) {
    if (!best || p.size > best.size || (p.size === best.size && p.id > best.id)) best = p;
  }
  return best;
}

function reclaim(): void {
  for (const p of PUPPETS) p.holderChanged();
}

/** Touches and keys keep the faces blinking; without them blinking stops after `blinkFor`. */
function listenForActivity(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const mark = () => {
    lastActivity = now();
    for (const p of PUPPETS) p.woke();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const)
    window.addEventListener(type, mark, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => {
    for (const p of PUPPETS) p.visibilityChanged();
  });
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const hasFrames = () => typeof requestAnimationFrame === 'function';
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export class FacePuppet {
  readonly id = ++nextId;
  private o: PuppetOptions;
  private readonly prefix: string;
  private svg: SVGSVGElement | null = null;
  private pose: FacePose = 'neutral';
  private mouthFrom: FacePose | undefined;
  /** Bumped by every state change and render: work started under an older value stops. */
  private run = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private loops = new Set<ReturnType<typeof setInterval>>();
  /** Blends and moves: each runs to its end, so a face is never left halfway between two poses. */
  private frames = new Set<number>();
  /** What runs while a state lasts (breathing): stopped whenever the state, the holder or the page changes. */
  private ambientFrames = new Set<number>();
  /** Where held moves left a part (eyes glancing at a card): later moves, like a blink, start from there. */
  private held = new Map<FacePart, PartFrame>();
  private lastPoke = -Infinity;
  private activeSince = now();
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly host: Element,
    options: PuppetOptions,
  ) {
    this.o = { ...options };
    this.prefix = `wf${this.id}-`;
    host.addEventListener('click', this.onTap);
    PUPPETS.add(this);
    listenForActivity();
    if (this.o.greet && this.allow.gestures) void this.play(this.o.state, null);
    else this.settle(this.o.state);
    reclaim();
  }

  get size(): number {
    return this.o.size;
  }

  private get allow(): FaceAllowance {
    return faceAllowance(this.o.size, this.o.mode, holder() === this);
  }

  /** New options: a new face or size draws again; a new state plays its sequence. */
  set(next: Partial<PuppetOptions>): void {
    if (this.destroyed) return;
    const prev = this.o;
    this.o = { ...prev, ...next };
    const redraw =
      next.face !== undefined && next.face !== prev.face
        ? true
        : cropOf(this.o) !== cropOf(prev) || this.o.mode !== prev.mode;
    if (this.o.size !== prev.size) reclaim();
    if (next.state !== undefined && next.state !== prev.state) {
      this.activeSince = now();
      if (redraw) this.settle(this.o.state);
      else void this.play(this.o.state, prev.state);
    } else if (redraw) {
      this.settle(this.o.state);
    } else if (next.level !== prev.level) {
      this.ambient();
    }
  }

  /** A tap on the face: a small squash, surprised for a moment, then its own gesture. */
  async poke(): Promise<void> {
    const t = now();
    if (!this.allow.gestures || t - this.lastPoke < FACE_TIMING.pokeGap) return;
    this.lastPoke = t;
    this.activeSince = t;
    const run = ++this.run;
    this.stopAmbient();
    void this.move(SQUASH);
    await this.toPose('surprised', undefined, run);
    if (!(await this.sleep(FACE_TIMING.pokeHold, run))) return;
    await this.toPose(restingPose(this.o.state), this.o.state === 'speaking' ? 'happy' : undefined, run);
    if (run !== this.run) return;
    if (this.o.state === 'needs') this.hold(GLANCE);
    await this.move(SIGNATURE_GESTURES[this.o.face]);
    if (run === this.run) this.ambient();
  }

  /** The face's own gesture, once (a face just picked). */
  async gesture(): Promise<void> {
    if (!this.allow.gestures) return;
    this.activeSince = now();
    await this.move(SIGNATURE_GESTURES[this.o.face]);
  }

  destroy(): void {
    this.destroyed = true;
    this.run++;
    this.stopAll();
    for (const id of this.frames) cancelAnimationFrame(id);
    this.frames.clear();
    PUPPETS.delete(this);
    reclaim();
    this.host.removeEventListener('click', this.onTap);
    this.host.replaceChildren();
  }

  private readonly onTap = () => {
    if (this.o.pokeable) void this.poke();
  };

  /** @internal */
  holderChanged(): void {
    if (this.destroyed) return;
    this.ambient();
  }

  /** @internal */
  woke(): void {
    if (this.blinkTimer === null && !this.destroyed && this.svg && !hidden() && this.allow.blink)
      this.scheduleBlink();
  }

  /** @internal */
  visibilityChanged(): void {
    if (hidden()) this.stopAmbient();
    else this.ambient();
  }

  // ---- states ----

  /** Shows `state`'s resting pose at once (first draw, a new face), with a held glance for `needs`. */
  private settle(state: FaceState): void {
    this.run++;
    this.stopAll();
    this.render(restingPose(state), state === 'speaking' ? 'happy' : undefined);
    if (state === 'needs') this.hold(GLANCE);
    this.ambient();
  }

  private async play(state: FaceState, from: FaceState | null): Promise<void> {
    const run = ++this.run;
    this.stopAll();
    const steps: FaceStep[] = faceSequence(state, from);
    for (const step of steps) {
      if (run !== this.run) return;
      if ('pose' in step) await this.toPose(step.pose, step.mouthFrom, run);
      else if ('wait' in step) {
        if (!(await this.sleep(step.wait, run))) return;
      } else if ('moves' in step) {
        if (this.allow.gestures) await this.move(step.moves);
        else this.hold(step.moves.filter((m) => m.hold));
      } else if (this.allow.gestures) await this.move(SIGNATURE_GESTURES[this.o.face]);
    }
    if (run === this.run) this.ambient();
  }

  // ---- drawing ----

  private render(pose: FacePose, mouthFrom?: FacePose): SVGSVGElement | null {
    if (typeof document === 'undefined') return null;
    this.pose = pose;
    this.mouthFrom = mouthFrom;
    const box = document.createElement('div');
    box.innerHTML = faceSvg(this.o.face, {
      pose,
      idPrefix: this.prefix,
      crop: cropOf(this.o),
      mouthFrom,
      cue: this.allow.cue && pose !== 'listening',
    });
    const svg = box.firstElementChild as SVGSVGElement | null;
    if (!svg) return null;
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.display = 'block';
    svg.style.overflow = 'visible';
    svg.dataset.facePose = pose;
    this.held.clear();
    this.host.replaceChildren(svg);
    this.svg = svg;
    return svg;
  }

  /**
   * Goes to `pose`: at once when blends aren't allowed; otherwise the eyes close, the drawing changes, the head, ears
   * and brows slide from where they were to the new pose and the eyes open on it.
   */
  private async toPose(pose: FacePose, mouthFrom: FacePose | undefined, run: number): Promise<void> {
    if (pose === this.pose && mouthFrom === this.mouthFrom && this.svg) return;
    const old = this.svg;
    if (!old || !this.allow.blend || !hasFrames() || hidden()) {
      this.render(pose, mouthFrom);
      return;
    }
    const before = this.snapshot(old);
    await this.animate(old, {
      part: 'eyes',
      frames: [{ at: 0 }, { at: 1, sy: 0.1 }],
      duration: FACE_TIMING.eyesClose,
      easing: 'in',
      hold: true,
    });
    if (run !== this.run) return;
    const svg = this.render(pose, mouthFrom);
    if (!svg) return;
    const after = this.snapshot(svg);
    const targets = this.targets(svg);
    // Each part starts where it was; a part the two poses don't share takes its new place at once.
    for (const [el, key, i] of targets) {
      const from = pick(before, key, i);
      if (from !== undefined && pick(after, key, i) !== undefined) el.setAttribute('transform', from);
    }
    void this.animate(svg, {
      part: 'eyes',
      frames: [{ at: 0, sy: 0.1 }, { at: 1 }],
      duration: FACE_TIMING.eyesOpen,
      easing: 'out',
    });
    void this.animate(svg, {
      part: 'mouth',
      frames: [{ at: 0, sy: 0.6 }, { at: 1 }],
      duration: 160,
      easing: 'out',
    });
    void this.animate(svg, {
      part: 'cue',
      frames: [{ at: 0, sx: 0.6, sy: 0.6, opacity: 0 }, { at: 1 }],
      duration: 280,
      easing: 'standard',
    });
    const ease = easing('standard');
    const start = now();
    await new Promise<void>((done) => {
      const step = () => {
        // Finishes even when a new state came meanwhile: the next blend starts from where this one ends.
        if (!svg.isConnected) return done();
        const elapsed = now() - start;
        for (const [el, key, i] of targets) {
          const delay =
            key === 'head' || key === 'shadow'
              ? FACE_TIMING.headDelay
              : key === 'brows'
                ? 0
                : FACE_TIMING.earsDelay;
          const t = ease(Math.min(1, Math.max(0, (elapsed - delay) / FACE_TIMING.blend)));
          const from = pick(before, key, i);
          const to = pick(after, key, i);
          if (from !== undefined && to !== undefined)
            el.setAttribute('transform', mixTransforms(from, to, t));
        }
        if (elapsed < FACE_TIMING.blend + FACE_TIMING.earsDelay) this.frame(step);
        else done();
      };
      this.frame(step);
    });
  }

  /** The transforms a blend slides: the head and its shadow, the ears, each brow. */
  private snapshot(svg: SVGSVGElement): Snapshot {
    const t = (sel: string) => svg.querySelector(sel)?.getAttribute('transform') ?? undefined;
    return {
      head: t(`#${this.prefix}head`),
      shadow: t(`#${this.prefix}shadow`),
      earL: t(`#${this.prefix}ear-l`),
      earR: t(`#${this.prefix}ear-r`),
      brows: [...svg.querySelectorAll(`#${this.prefix}brows rect`)].map(
        (r) => r.getAttribute('transform') ?? '',
      ),
    };
  }

  private targets(svg: SVGSVGElement): [Element, keyof Snapshot, number][] {
    const out: [Element, keyof Snapshot, number][] = [];
    const add = (sel: string, key: keyof Snapshot) => {
      const el = svg.querySelector(sel);
      if (el) out.push([el, key, 0]);
    };
    add(`#${this.prefix}head`, 'head');
    add(`#${this.prefix}shadow`, 'shadow');
    add(`#${this.prefix}ear-l`, 'earL');
    add(`#${this.prefix}ear-r`, 'earR');
    for (const [i, el] of [...svg.querySelectorAll(`#${this.prefix}brows rect`)].entries())
      out.push([el, 'brows', i]);
    return out;
  }

  // ---- moves ----

  private move(moves: readonly PartMove[]): Promise<void> {
    const svg = this.svg;
    if (!svg) return Promise.resolve();
    return Promise.all(moves.map((m) => this.animate(svg, m))).then(() => undefined);
  }

  /** Puts held moves at their last frame at once (a glance under reduced motion still says “look here”). */
  private hold(moves: readonly PartMove[]): void {
    const svg = this.svg;
    if (!svg) return;
    for (const m of moves) {
      const last = m.frames[m.frames.length - 1];
      if (!last) continue;
      this.held.set(m.part, { ...last, at: 1 });
      for (const el of this.parts(svg, m.part)) this.apply(el, m.part, { at: 1 });
    }
  }

  private parts(svg: SVGSVGElement, part: FacePart): Element[] {
    return [...svg.querySelectorAll(`[data-face-part="${part}"]`)];
  }

  /** Puts a part at `frame`, on top of where a held move left it. */
  private apply(el: Element, part: FacePart, moved: PartFrame): void {
    const frame = composeFrames(this.held.get(part), moved);
    const transform = frameTransform(frame, facePivot(this.o.face, this.pose, part));
    if (transform) el.setAttribute('transform', transform);
    else el.removeAttribute('transform');
    if (frame.opacity !== undefined) el.setAttribute('opacity', String(round(frame.opacity)));
    if (frame.draw !== undefined) el.setAttribute('stroke-dashoffset', String(round(1 - frame.draw)));
  }

  private animate(svg: SVGSVGElement, move: PartMove): Promise<void> {
    const els = this.parts(svg, move.part);
    if (!els.length) return Promise.resolve();
    const ease = easing(move.easing);
    const total = move.duration * (move.iterations ?? 1);
    const last = move.frames[move.frames.length - 1] as PartFrame;
    // A held move goes from the part's own place to its new one, and stays there.
    if (move.hold) this.held.delete(move.part);
    const finish = () => {
      if (move.hold) this.held.set(move.part, { ...last, at: 1 });
      for (const el of els) this.apply(el, move.part, { at: 1 });
    };
    if (!hasFrames() || hidden()) {
      if (move.hold) finish();
      return Promise.resolve();
    }
    return new Promise((done) => {
      const startAt = now() + (move.delay ?? 0);
      const step = () => {
        if (!svg.isConnected) return done();
        const elapsed = now() - startAt;
        if (elapsed < 0) return this.frame(step);
        if (elapsed >= total) {
          finish();
          return done();
        }
        const t = ease((elapsed % move.duration) / move.duration);
        const frame = frameAt(move.frames, t);
        for (const el of els) this.apply(el, move.part, frame);
        this.frame(step);
      };
      this.frame(step);
    });
  }

  // ---- what runs while a state lasts ----

  private ambient(): void {
    this.stopAmbient();
    if (this.destroyed || !this.svg || hidden()) return;
    const allow = this.allow;
    const state = this.o.state;
    if (allow.blink && this.pose !== 'sleepy') this.scheduleBlink();
    const level = this.o.level;
    if (state === 'speaking' && allow.mouth && level) {
      const pivot = facePivot(this.o.face, this.pose, 'mouth');
      this.every(FACE_TIMING.mouthStep, () => {
        const mouth = this.svg?.querySelector('[data-face-part="mouth"]');
        if (mouth)
          mouth.setAttribute(
            'transform',
            frameTransform({ at: 0, sy: mouthOpening(level()) }, pivot) || 'scale(1)',
          );
      });
    }
    if (state === 'thinking' && allow.dots) {
      let k = 0;
      this.every(FACE_TIMING.dotsStep, () => {
        const dots = this.svg?.querySelectorAll('[data-face-part="cue"] circle');
        if (!dots?.length) return;
        k = (k + 1) % dots.length;
        for (const [i, dot] of [...dots].entries()) dot.setAttribute('opacity', i === k ? '1' : '0.3');
      });
    }
    if (state === 'listening' && allow.loops && level) {
      this.every(FACE_TIMING.earStep, () => {
        const a = level() * EAR_FOLLOW_DEGREES;
        const svg = this.svg;
        if (!svg) return;
        for (const el of this.parts(svg, 'ear-l')) this.apply(el, 'ear-l', { at: 0, rotate: a });
        for (const el of this.parts(svg, 'ear-r')) this.apply(el, 'ear-r', { at: 0, rotate: -a });
      });
    }
    if (state === 'working' && allow.loops && hasFrames()) {
      const svg = this.svg;
      const start = now();
      const step = () => {
        const elapsed = now() - start;
        if (!svg.isConnected || elapsed > FACE_TIMING.breatheFor) {
          for (const el of this.parts(svg, 'head')) el.removeAttribute('transform');
          return;
        }
        const y = -(1 - Math.cos((2 * Math.PI * elapsed) / FACE_TIMING.breathe)) * 1;
        for (const el of this.parts(svg, 'head')) this.apply(el, 'head', { at: 0, y });
        this.frame(step, true);
      };
      this.frame(step, true);
    }
  }

  private scheduleBlink(): void {
    if (this.blinkTimer !== null) clearTimeout(this.blinkTimer);
    const wait = FACE_TIMING.blinkMin + Math.random() * (FACE_TIMING.blinkMax - FACE_TIMING.blinkMin);
    this.blinkTimer = setTimeout(() => {
      this.blinkTimer = null;
      const svg = this.svg;
      if (this.destroyed || !svg || hidden() || !this.allow.blink || this.pose === 'sleepy') return;
      const quiet = now() - Math.max(this.activeSince, lastActivity) > FACE_TIMING.blinkFor;
      if (quiet) return; // stays still until the next touch or state (`woke`)
      const twice = Math.random() < FACE_TIMING.doubleBlink;
      void this.move(BLINK.map((m) => ({ ...m, iterations: twice ? 2 : 1 })));
      this.scheduleBlink();
    }, wait);
  }

  private stopAmbient(): void {
    if (this.blinkTimer !== null) clearTimeout(this.blinkTimer);
    this.blinkTimer = null;
    for (const id of this.loops) clearInterval(id);
    this.loops.clear();
    for (const id of this.ambientFrames) cancelAnimationFrame(id);
    this.ambientFrames.clear();
  }

  private stopAll(): void {
    this.stopAmbient();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  private every(ms: number, fn: () => void): void {
    this.loops.add(setInterval(fn, ms));
  }

  private frame(fn: () => void, ambient = false): void {
    const set = ambient ? this.ambientFrames : this.frames;
    const id = requestAnimationFrame(() => {
      set.delete(id);
      fn();
    });
    set.add(id);
  }

  private sleep(ms: number, run: number): Promise<boolean> {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        this.timers.delete(id);
        resolve(run === this.run);
      }, ms);
      this.timers.add(id);
    });
  }
}

interface Snapshot {
  head: string | undefined;
  shadow: string | undefined;
  earL: string | undefined;
  earR: string | undefined;
  brows: string[];
}

function pick(s: Snapshot, key: keyof Snapshot, i: number): string | undefined {
  const v = s[key];
  return Array.isArray(v) ? v[i] : v;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Faces drawn now (tests). */
export function livePuppetCount(): number {
  return PUPPETS.size;
}
