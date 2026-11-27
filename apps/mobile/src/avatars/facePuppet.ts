/**
 * The live face's engine on the phone: the browser engine's rules (`@whombat/avatars/puppet`), with the parts moved on
 * the display thread. Each movable part, and each pose transform a blend slides, has a track: a table of frames worked
 * out here (`faceEngine.ts`) and a progress that Reanimated runs from 0 to 1. The part's matrix follows on the display
 * thread, with no React render. The drawing itself (the pose) is React state (`LiveFace.tsx`).
 *
 * At most one face on screen moves: the biggest, or the newest of the biggest, among the faces on a screen in view
 * (`holdsMotion`). The others still change pose, at once. While idle only the blink timer runs, and it stops two
 * minutes after the last touch or change; nothing runs while the app is in the background.
 */
import type { AvatarFace } from '@whombat/avatars';
import { FACE_PARTS, type FacePart, type FacePose, faceHasPart, facePivot } from '@whombat/avatars/face';
import {
  BLINK,
  EAR_FOLLOW_DEGREES,
  FACE_TIMING,
  type FaceAllowance,
  type FaceMotionMode,
  type FaceState,
  type FaceStep,
  faceAllowance,
  faceSequence,
  GLANCE,
  liveFaceCrop,
  mouthOpening,
  type PartFrame,
  type PartMove,
  restingPose,
  SIGNATURE_GESTURES,
  SQUASH,
} from '@whombat/avatars/motion';
import { AppState } from 'react-native';
import {
  cancelAnimation,
  Easing,
  makeMutable,
  type SharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { lastFaceActivity, onFaceActivity } from './faceActivity';
import { type Drawing, faceTreeFor } from './faceDrawing';
import {
  BLEND_TARGETS,
  type BlendTarget,
  blendTable,
  breathTable,
  type FaceTree,
  matrixSample,
  moveTable,
  type PartRest,
  parseTransform,
  pickHolder,
  stillSample,
} from './faceEngine';

/** A part, or a pose transform a blend slides (`b:head`, `b:brow-0`, …). */
export type Channel = FacePart | `b:${BlendTarget}`;

/** A table of frames and how far through it the part is (0–1). */
export interface Track {
  samples: SharedValue<number[]>;
  progress: SharedValue<number>;
}

export interface FaceTracks {
  channels: Record<Channel, Track>;
  /** The thought dot that is lit, or −1 when the dots stand still. */
  dot: SharedValue<number>;
}

const CHANNELS: readonly Channel[] = [...FACE_PARTS, ...BLEND_TARGETS.map((t) => `b:${t}` as const)];

/** Hazel's tick is hidden and undrawn until her gesture; every other part is fully there. */
const restOf = (channel: Channel): PartRest =>
  channel === 'tick' ? { opacity: 0, draw: 0 } : { opacity: 1, draw: 1 };

/** The tracks of a face that starts with `tree`: every part still, each pose transform where the pose puts it. */
export function makeTracks(tree: FaceTree): FaceTracks {
  const channels = {} as Record<Channel, Track>;
  for (const channel of CHANNELS) {
    const target = channel.startsWith('b:') ? (channel.slice(2) as BlendTarget) : null;
    const samples = target
      ? matrixSample(parseTransform(tree.targets[target] ?? ''))
      : stillSample(undefined, [0, 0], restOf(channel));
    channels[channel] = { samples: makeMutable(samples), progress: makeMutable(0) };
  }
  return { channels, dot: makeMutable(-1) };
}

/* On the display thread ------------------------------------------------------------------------------------------- */

function startTrack(
  samples: SharedValue<number[]>,
  progress: SharedValue<number>,
  table: number[],
  delay: number,
  duration: number,
  repeat: number,
  done: (finished: boolean) => void,
): void {
  'worklet';
  cancelAnimation(progress);
  samples.value = table;
  progress.value = 0;
  if (duration <= 0) {
    progress.value = 1;
    scheduleOnRN(done, true);
    return;
  }
  const finish = (finished?: boolean) => {
    'worklet';
    scheduleOnRN(done, finished === true);
  };
  const timing = { duration, easing: Easing.linear };
  const played =
    repeat > 1 ? withRepeat(withTiming(1, timing), repeat, false, finish) : withTiming(1, timing, finish);
  progress.value = delay > 0 ? withDelay(delay, played) : played;
}

function setStill(samples: SharedValue<number[]>, progress: SharedValue<number>, table: number[]): void {
  'worklet';
  cancelAnimation(progress);
  samples.value = table;
  progress.value = 0;
}

/* Which face moves ------------------------------------------------------------------------------------------------- */

const PUPPETS = new Set<PhonePuppet>();
let nextId = 0;
let appActive = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
let watching: (() => void) | null = null;

function watchApp(): void {
  if (watching) return;
  const app = AppState.addEventListener('change', (next) => {
    const active = next === 'active';
    if (active === appActive) return;
    appActive = active;
    for (const p of PUPPETS) p.activeChanged();
  });
  const touches = onFaceActivity(() => {
    for (const p of PUPPETS) p.woke();
  });
  watching = () => {
    app.remove();
    touches();
  };
}

function unwatchApp(): void {
  if (PUPPETS.size > 0 || !watching) return;
  watching();
  watching = null;
}

/** The face that may move now, among faces on a screen in view. */
function holder(): PhonePuppet | null {
  const id = pickHolder([...PUPPETS].filter((p) => p.inView).map((p) => ({ id: p.id, size: p.size })));
  for (const p of PUPPETS) if (p.id === id) return p;
  return null;
}

function reclaim(): void {
  for (const p of PUPPETS) p.holderChanged();
}

const now = () => Date.now();

export interface PuppetOptions {
  face: AvatarFace;
  size: number;
  state: FaceState;
  mode: FaceMotionMode;
  /** The voice's loudness now, 0–1, while speaking or listening. */
  level: (() => number) | null;
  /** Its screen is the one in view. */
  focused: boolean;
}

/** How the engine shows a pose: the face's React state, which says when it is on screen. */
export type ShowDrawing = (drawing: Drawing) => Promise<void>;

export class PhonePuppet {
  readonly id = ++nextId;
  readonly prefix = `wf${this.id}-`;
  private o: PuppetOptions;
  private drawing: Drawing;
  private show: ShowDrawing | null = null;
  /** Bumped by every state change and new drawing: work started under an older value stops. */
  private run = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private loops = new Set<ReturnType<typeof setInterval>>();
  /** Where held moves left a part (eyes glancing at a card): later moves, like a blink, start from there. */
  private held = new Map<FacePart, PartFrame>();
  /** What each part shows when nothing moves it: its opacity and how much of its line is drawn. */
  private rests = new Map<Channel, PartRest>();
  /** The channels a move or blend is playing on now, by the move's number. */
  private busy = new Map<Channel, number>();
  private moves = 0;
  /** The eyes were closed for a blend that a newer state cut short. */
  private eyesClosed = false;
  /** The head's breathing while at work (a loop, big faces only), by its number; 0 while it doesn't breathe. */
  private breathing = 0;
  private lastPoke = Number.NEGATIVE_INFINITY;
  private activeSince = now();
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  private attached = false;

  /** The parts' tracks, which the drawing's groups follow. */
  readonly tracks: FaceTracks;

  constructor(options: PuppetOptions) {
    this.o = { ...options };
    this.drawing = this.drawingFor(
      restingPose(options.state),
      options.state === 'speaking' ? 'happy' : undefined,
    );
    this.tracks = makeTracks(faceTreeFor(this.drawing));
  }

  /** The drawing it shows first: the state's resting pose (a run already done shows glad-then-calm's end, not a replay). */
  get firstDrawing(): Drawing {
    return this.drawing;
  }

  get size(): number {
    return this.o.size;
  }

  get inView(): boolean {
    return this.o.focused;
  }

  private get allow(): FaceAllowance {
    return faceAllowance(this.o.size, this.o.mode, holder() === this);
  }

  /** On screen: it takes part in choosing the face that moves, and shows `show`'s drawings. */
  attach(show: ShowDrawing): void {
    this.show = show;
    if (this.attached) return;
    this.attached = true;
    PUPPETS.add(this);
    watchApp();
    if (this.held.size === 0 && this.o.state === 'needs') this.hold(GLANCE);
    reclaim();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.run++;
    this.stopAll();
    PUPPETS.delete(this);
    unwatchApp();
    this.show = null;
    reclaim();
  }

  /** New options: a new face, framing or motion draws again; a new state plays its sequence. */
  set(next: Partial<PuppetOptions>): void {
    const prev = this.o;
    this.o = { ...prev, ...next };
    if (!this.attached) return;
    const redraw =
      this.o.face !== prev.face ||
      liveFaceCrop(this.o.size) !== liveFaceCrop(prev.size) ||
      faceAllowance(this.o.size, 'full').cue !== faceAllowance(prev.size, 'full').cue ||
      this.o.mode !== prev.mode;
    if (this.o.size !== prev.size || this.o.focused !== prev.focused) reclaim();
    if (this.o.state !== prev.state) {
      this.activeSince = now();
      if (redraw) this.settle(this.o.state);
      else void this.play(this.o.state, prev.state);
    } else if (redraw) {
      this.settle(this.o.state);
    } else if (this.o.level !== prev.level) {
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

  /** @internal The face allowed to move changed. */
  holderChanged(): void {
    if (this.attached) this.ambient();
  }

  /** @internal A touch: blinking starts again if it had stopped. */
  woke(): void {
    if (this.blinkTimer === null && this.attached && appActive && this.inView && this.allow.blink)
      this.scheduleBlink();
  }

  /** @internal The app came to the front or went to the background. */
  activeChanged(): void {
    if (appActive) this.ambient();
    else this.stopAmbient();
  }

  // ---- states ----

  /** Shows `state`'s resting pose at once (a new face, framing or motion), with a held glance for `needs`. */
  private settle(state: FaceState): void {
    this.run++;
    this.stopAll();
    void this.render(restingPose(state), state === 'speaking' ? 'happy' : undefined, false);
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

  private drawingFor(pose: FacePose, mouthFrom: FacePose | undefined): Drawing {
    return {
      face: this.o.face,
      crop: liveFaceCrop(this.o.size),
      pose,
      mouthFrom,
      cue: faceAllowance(this.o.size, 'full').cue && pose !== 'listening',
      prefix: this.prefix,
    };
  }

  /**
   * Shows `pose`: every part back at rest and, without a blend, the head, ears and brows at once where the pose puts
   * them. With a blend the eyes stay closed (the caller opens them) and the blend has set the pose transforms.
   */
  private async render(pose: FacePose, mouthFrom: FacePose | undefined, blend: boolean): Promise<void> {
    const drawing = this.drawingFor(pose, mouthFrom);
    this.drawing = drawing;
    this.held.clear();
    this.eyesClosed = false;
    this.breathing = 0;
    for (const part of FACE_PARTS) {
      if (blend && part === 'eyes') continue;
      this.rests.delete(part);
      this.still(part, undefined);
    }
    if (!blend) {
      const tree = faceTreeFor(drawing);
      for (const target of BLEND_TARGETS) {
        const transform = tree.targets[target];
        if (transform !== undefined) this.stillMatrix(target, transform);
      }
    }
    await this.show?.(drawing);
  }

  /**
   * Goes to `pose`: at once when blends aren't allowed; otherwise the eyes close, the head, ears and brows slide from
   * where they were to the new pose while the drawing changes, and the eyes open on it.
   */
  private async toPose(pose: FacePose, mouthFrom: FacePose | undefined, run: number): Promise<void> {
    if (pose === this.drawing.pose && mouthFrom === this.drawing.mouthFrom) {
      if (this.eyesClosed) await this.render(pose, mouthFrom, false);
      return;
    }
    if (!this.allow.blend || !appActive || !this.inView) {
      await this.render(pose, mouthFrom, false);
      return;
    }
    const before = faceTreeFor(this.drawing).targets;
    // Eyes a cut-short blend left closed stay closed for this one.
    if (!this.eyesClosed) {
      this.eyesClosed = true;
      await this.animate({
        part: 'eyes',
        frames: [{ at: 0 }, { at: 1, sy: 0.1 }],
        duration: FACE_TIMING.eyesClose,
        easing: 'in',
        hold: true,
      });
      if (run !== this.run) return;
    }
    const after = faceTreeFor(this.drawingFor(pose, mouthFrom)).targets;
    const total = FACE_TIMING.blend + FACE_TIMING.earsDelay;
    const slides: Promise<boolean>[] = [];
    // Each transform starts where it was; one the two poses don't share takes its new place at once.
    for (const target of BLEND_TARGETS) {
      const from = before[target];
      const to = after[target];
      if (to === undefined) continue;
      if (from === undefined) {
        this.stillMatrix(target, to);
        continue;
      }
      const delay =
        target === 'head' || target === 'shadow'
          ? FACE_TIMING.headDelay
          : target === 'ear-l' || target === 'ear-r'
            ? FACE_TIMING.earsDelay
            : 0;
      slides.push(this.playTable(`b:${target}`, blendTable(from, to, delay, total), total, 0));
    }
    await this.render(pose, mouthFrom, true);
    // The eyes open on the new drawing.
    void this.animate({
      part: 'eyes',
      frames: [{ at: 0, sy: 0.1 }, { at: 1 }],
      duration: FACE_TIMING.eyesOpen,
      easing: 'out',
    });
    void this.animate({
      part: 'mouth',
      frames: [{ at: 0, sy: 0.6 }, { at: 1 }],
      duration: 160,
      easing: 'out',
    });
    if (this.drawing.cue)
      void this.animate({
        part: 'cue',
        frames: [{ at: 0, sx: 0.6, sy: 0.6, opacity: 0 }, { at: 1 }],
        duration: 280,
        easing: 'standard',
      });
    await Promise.all(slides);
  }

  // ---- moves ----

  private move(moves: readonly PartMove[]): Promise<void> {
    return Promise.all(moves.map((m) => this.animate(m))).then(() => undefined);
  }

  /** Puts held moves at their last frame at once (a glance under reduced motion still says “look here”). */
  private hold(moves: readonly PartMove[]): void {
    for (const m of moves) {
      const last = m.frames[m.frames.length - 1];
      if (!last) continue;
      this.held.set(m.part, { ...last, at: 1 });
      this.still(m.part, this.held.get(m.part));
    }
  }

  private rest(channel: Channel): PartRest {
    return this.rests.get(channel) ?? restOf(channel);
  }

  private pivot(part: FacePart): readonly [number, number] {
    return facePivot(this.o.face, this.drawing.pose, part);
  }

  /** A part standing still at `frame` (on top of nothing: callers compose what is held). */
  private still(part: FacePart, frame: PartFrame | undefined): void {
    const { samples, progress } = this.tracks.channels[part];
    this.busy.delete(part);
    scheduleOnUI(setStill, samples, progress, stillSample(frame, this.pivot(part), this.rest(part)));
  }

  private stillMatrix(target: BlendTarget, transform: string): void {
    const channel = `b:${target}` as const;
    const { samples, progress } = this.tracks.channels[channel];
    this.busy.delete(channel);
    scheduleOnUI(setStill, samples, progress, matrixSample(parseTransform(transform)));
  }

  /** Plays a table on a channel; true when it ran to its end. */
  private playTable(
    channel: Channel,
    table: number[],
    duration: number,
    delay: number,
    repeat = 1,
  ): Promise<boolean> {
    const { samples, progress } = this.tracks.channels[channel];
    const id = ++this.moves;
    this.busy.set(channel, id);
    return new Promise((resolve) => {
      const done = (finished: boolean) => {
        if (this.busy.get(channel) === id) this.busy.delete(channel);
        resolve(finished);
      };
      scheduleOnUI(startTrack, samples, progress, table, delay, duration, repeat, done);
    });
  }

  private async animate(move: PartMove): Promise<void> {
    if (!faceHasPart(this.o.face, move.part)) return;
    // A held move goes from the part's own place to its new one, and stays there.
    const held = this.held.get(move.part);
    if (move.hold) this.held.delete(move.part);
    const table = moveTable(move, this.pivot(move.part), move.hold ? undefined : held, this.rest(move.part));
    this.rests.set(move.part, table.rest);
    if (move.hold && table.held) this.held.set(move.part, table.held);
    if (!appActive) {
      this.still(move.part, this.held.get(move.part));
      return;
    }
    await this.playTable(move.part, table.samples, table.duration, table.delay);
  }

  // ---- what runs while a state lasts ----

  private ambient(): void {
    this.stopAmbient();
    if (!this.attached || !appActive || !this.inView) return;
    const allow = this.allow;
    const { state, level } = this.o;
    if (allow.blink && this.drawing.pose !== 'sleepy') this.scheduleBlink();
    if (state === 'speaking' && allow.mouth && level) {
      this.every(FACE_TIMING.mouthStep, () => this.still('mouth', { at: 0, sy: mouthOpening(level()) }));
    }
    const dots = faceTreeFor(this.drawing).dots;
    if (state === 'thinking' && allow.dots && dots > 0) {
      let k = 0;
      this.tracks.dot.value = 0;
      this.every(FACE_TIMING.dotsStep, () => {
        k = (k + 1) % dots;
        this.tracks.dot.value = k;
      });
    }
    if (state === 'listening' && allow.loops && level) {
      this.every(FACE_TIMING.earStep, () => {
        const a = level() * EAR_FOLLOW_DEGREES;
        this.still('ear-l', { at: 0, rotate: a });
        this.still('ear-r', { at: 0, rotate: -a });
      });
    }
    if (state === 'working' && allow.loops && !this.busy.has('head')) {
      // About the first 20 seconds: whole breaths, ending where the head rests.
      const breaths = Math.max(1, Math.floor(FACE_TIMING.breatheFor / FACE_TIMING.breathe));
      const breath = ++this.moves;
      this.breathing = breath;
      void this.playTable('head', breathTable(this.pivot('head')), FACE_TIMING.breathe, 0, breaths).then(
        () => {
          if (this.breathing === breath) this.breathing = 0;
        },
      );
    }
  }

  private scheduleBlink(): void {
    if (this.blinkTimer !== null) clearTimeout(this.blinkTimer);
    const wait = FACE_TIMING.blinkMin + Math.random() * (FACE_TIMING.blinkMax - FACE_TIMING.blinkMin);
    this.blinkTimer = setTimeout(() => {
      this.blinkTimer = null;
      if (!this.attached || !appActive || !this.inView || !this.allow.blink || this.drawing.pose === 'sleepy')
        return;
      const quiet = now() - Math.max(this.activeSince, lastFaceActivity()) > FACE_TIMING.blinkFor;
      if (quiet) return; // stays still until the next touch or state (`woke`)
      // Not over eyes that are moving (a glance, a gesture): it would jump.
      if (!this.busy.has('eyes')) {
        const twice = Math.random() < FACE_TIMING.doubleBlink;
        void this.move(BLINK.map((m) => ({ ...m, iterations: twice ? 2 : 1 })));
      }
      this.scheduleBlink();
    }, wait);
  }

  private stopAmbient(): void {
    if (this.blinkTimer !== null) clearTimeout(this.blinkTimer);
    this.blinkTimer = null;
    for (const id of this.loops) clearInterval(id);
    this.loops.clear();
    if (this.tracks.dot.value !== -1) this.tracks.dot.value = -1;
    if (this.breathing) {
      this.breathing = 0;
      this.still('head', this.held.get('head'));
    }
  }

  private stopAll(): void {
    this.stopAmbient();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  private every(ms: number, fn: () => void): void {
    this.loops.add(setInterval(fn, ms));
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

/** Faces on screen now (tests, diagnostics). */
export function livePuppetCount(): number {
  return PUPPETS.size;
}
