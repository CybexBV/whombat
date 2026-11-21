/**
 * The desk display (DK-01…DK-13, DK-60…DK-65, DK-83…DK-87, TF-14…TF-18, CG-37…, CG-190…, CG-256…, CG-280…): one paired
 * screen showing Whombat. This component holds what is the page's own (which sheet is open, the asks that came by
 * themselves, Talk, the microphone, the last touch, the new-ask alert, the screen a card opened) and asks Whombat for the
 * rest through the console server (§2.5): the state, while Talk shows the open conversation, and while a card's screen
 * shows its figures. The rules are pure functions in `lib/deskScene.ts`, `lib/askQueue.ts`, `lib/talk.ts`,
 * `lib/conversation.ts`, `lib/decide.ts`, `lib/unlock.ts`, `lib/deskServer.ts` and `lib/taskCard.ts`.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { ConsoleState } from '../lib/api';
import {
  afterAsk,
  enqueue,
  freshAsks,
  liveQueue,
  popupFor,
  popupLapsed,
  putFirst,
  queuePlace,
} from '../lib/askQueue';
import { askViewOf } from '../lib/askView';
import { burnIn, driftAt } from '../lib/burnin';
import type { DeskCalm } from '../lib/calm';
import type { Client } from '../lib/client';
import { conversation, sessionSig } from '../lib/conversation';
import { type DecideAnswer, type Decision, decideBody, parseDecideAnswer } from '../lib/decide';
import {
  type ChoiceScope,
  CLOSED_SESSION,
  type DeskAsk,
  type DeskLook,
  type DeskServer,
  type DeskSession,
  type DeskState,
  type DeskTalk,
  deskErrorCode,
  type LookQuietHow,
  parseSession,
  parseTalk,
  type ServerRange,
} from '../lib/desk';
import { DESK, DESK_WORDS, fill } from '../lib/deskCopy';
import { lockedDesk, unlockLapsed } from '../lib/deskHold';
import {
  type AskSig,
  alertFor,
  askSig,
  attention,
  deskScene,
  isPage,
  isUnlocked,
  locksIn,
  mayListen,
  pageKept,
  sheetOver,
  shouldTouch,
  touchUnlocks,
  wakesOnly,
} from '../lib/deskScene';
import {
  DICTATION_IDLE,
  type Dictation,
  type DictationError,
  dictating,
  dictationReducer,
  hearRefusal,
  hearTimeoutMs,
  MAX_HEAR_SECONDS,
  MAX_TALK_TEXT,
  MIN_HEAR_SECONDS,
  parseHeard,
  withHeard,
} from '../lib/dictation';
import type { DeskGrid } from '../lib/grid';
import {
  lookQuestion,
  lookQuietBody,
  lookStep,
  parseQuietAnswer,
  parseStepAnswer,
  QUIET_DONE_MS,
  quietRefusal,
  STEP_WAIT_MS,
} from '../lib/needsYou';
import { canAsk, TALK_READY, type TalkUi, talkBusy, talkId, talkReducer } from '../lib/talk';
import { pinLength } from '../lib/unlock';
import { toBase64 } from '../lib/wav';
import { useLastInput, useNow } from '../ui/hooks';
import { useOutputs } from '../ui/Outputs';
import { type Capture, chime, type Playback, playAnswer, primeAudio, startCapture } from './audio';
import { SelfScreen } from './Box';
import { CalmGlance } from './Calm';
import styles from './desk.module.css';
import { ClockOnly, Glance, type GlanceProps } from './Glance';
import { Night, Pairing } from './Night';
import { LockChip } from './parts';
import {
  GridGlance,
  type MonitorMode,
  MonitorScreens,
  onMonitor,
  useImageLoader,
  useSizeReport,
} from './Screens';
import { type PageGone, ServerScreen } from './Server';
import { ServersScreen } from './Servers';
import { ApprovePad, AskCard, LookCard, PinPad, Scrim, SheetGrid } from './Sheet';
import { Talk, type TalkAnchor } from './Talk';

export type Overlay =
  | null
  /**
   * The PIN pad alone; after the unlock, the first ask or Talk. `reason`: it opened by itself for an ask the locked
   * screen shows no title of (DK-60): “Neo needs your answer.” above it.
   */
  | { kind: 'unlock'; next: 'ask' | 'talk' | null; reason?: boolean }
  | { kind: 'ask'; number: number }
  /**
   * Something that needs a look (DK-95), by its key; `pin`: *Ignore*, *Not now* or the assistant's step (`fix`, 3.5,
   * CG-376) was touched on a locked screen, the PIN pad is beside the card and it goes once unlocked (QN-20, CG-333).
   */
  | { kind: 'look'; key: string; pin?: LookQuietHow | 'fix' };

/**
 * The screen a card opened (DK-83, DK-86, DK-87): a server's, with the servers it swipes through (the glance's or every
 * server's: `from`, where Back goes) and how the last swipe went; every server; This Whombat's.
 */
export type OpenPage =
  | { kind: 'server'; list: DeskServer[]; index: number; from: 'glance' | 'servers'; swipe?: 'next' | 'prev' }
  | { kind: 'servers' }
  | { kind: 'self' };

/** Fixtures only: the page's own state at the start. */
export interface DeskInitial {
  overlay?: Overlay;
  talkOpen?: boolean;
  talk?: TalkUi;
  /** Talk's mic (CG-359): recording, turning it into text, or a failure on its line. */
  dictation?: Dictation;
  digits?: string;
  levels?: number[];
  draft?: string;
  /** A new ask arrived this long ago (ms): the amber edge. */
  alertAgo?: number;
  /** The asks that came by themselves (DK-60): “1 of 3” on the card. */
  queue?: number[];
  /** The approve pad is open beside this risky ask's card (DK-62)… */
  approvePin?: number;
  /** …for this one of its wider choices (TF-14). */
  approveChoice?: ChoiceScope;
  /** Talk starts at the top of the conversation, newer messages below (“New message”). */
  convoTop?: boolean;
  /** Found on your network: the services the page saw before (`foundKey`); the rest arrived just now (DF-10). */
  foundSeen?: string[];
  /** The screen a card opened (DK-83), and a server screen's range (24 hours otherwise). */
  page?: OpenPage;
  range?: ServerRange;
  /** The look's card the overlay opens says it was ignored or put off (QN-20), and stays so. */
  lookDone?: LookQuietHow;
  /** The calm glance's Welcome back with this id was seen already (DK-121). */
  welcomeSeen?: string;
}

interface Props {
  state: ConsoleState;
  desk: DeskState;
  /** Server clock minus page clock. */
  offset: number;
  client: Client;
  refresh: () => void;
  /** Fixtures: the last touch was this long ago. */
  idleMs?: number;
  /** The last desk, kept locked while Whombat restarts (CG-49): nothing opens, nothing is sent. */
  held?: boolean;
  initial?: DeskInitial;
}

/** A pointer that moved this far between down and up swiped (window px): it didn't touch. */
const SWIPE_SLOP_PX = 24;

const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

export function Desk({
  state,
  desk: sent,
  offset,
  client,
  refresh,
  idleMs = 0,
  held = false,
  initial,
}: Props) {
  const now = useNow(1000);
  // The server's clock at this render (a poll re-renders with a new offset between the page's ticks).
  const serverNow = Date.now() + offset;
  const lastInput = useLastInput(idleMs);
  // Unlocked only until Whombat's `until`: one that ran out before the next poll is drawn locked and trimmed, as
  // `App` does while the polls fail (CG-51).
  const lapsed = unlockLapsed(sent.lock, serverNow, false);
  // Found on your network put away with Not now (DF-04): gone at once, back only if Whombat refused.
  const [foundGone, setFoundGone] = useState(false);
  const sentFound = sent.glance?.found != null;
  useEffect(() => {
    if (!sentFound) setFoundGone(false);
  }, [sentFound]);
  const desk = useMemo(() => {
    const d = lapsed ? lockedDesk(sent) : sent;
    return foundGone && d.glance?.found ? { ...d, glance: { ...d.glance, found: null } } : d;
  }, [sent, lapsed, foundGone]);
  const paired = desk.paired;
  const glance = desk.glance;
  const unlocked = isUnlocked(desk.lock, serverNow);
  // The screen of widgets (3.6): the box's grid, the monitors beside it, and what the modal put away with Not now.
  const grid = glance?.grid ?? null;
  const { placed, host: monitorsHost } = useOutputs();
  useSizeReport(client, placed, !held);
  const loadImage = useImageLoader(client);
  const [notNow, setNotNow] = useState<string[]>([]);
  const attentionKeys = grid?.attention.items.map((i) => i.key).join('\n') ?? '';
  useEffect(() => {
    const live = new Set(attentionKeys.split('\n'));
    setNotNow((k) => (k.every((key) => live.has(key)) ? k : k.filter((key) => live.has(key))));
  }, [attentionKeys]);

  const [overlay, setOverlay] = useState<Overlay>(initial?.overlay ?? null);
  const [talkOpen, setTalkOpen] = useState(initial?.talkOpen ?? false);
  const [talk, dispatch] = useReducer(talkReducer, initial?.talk ?? TALK_READY);
  // Talk's mic is voice typing (CG-359): its own state, beside the talk's.
  const [dictation, dictate] = useReducer(dictationReducer, initial?.dictation ?? DICTATION_IDLE);
  const [followed, setFollowed] = useState<DeskTalk | null>(null);
  const [levels, setLevels] = useState<number[]>(initial?.levels ?? []);
  const [draft, setDraft] = useState<string | null>(initial?.draft ?? null);
  // The box holds words Talk's mic heard (edited or not): they go as said by voice (CG-361).
  const [spokenDraft, setSpokenDraft] = useState(false);
  useEffect(() => {
    if (!draft?.trim()) setSpokenDraft(false);
  }, [draft]);
  const [freshTopic, setFreshTopic] = useState(false);
  const [alertAt, setAlertAt] = useState<number | null>(
    initial?.alertAgo === undefined ? null : Date.now() - initial.alertAgo,
  );
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetNote, setSheetNote] = useState<string | null>(null);
  const [padDigits, setPadDigits] = useState(initial?.digits ?? '');
  // Asks that come to you (DK-60, CG-194): the queue of cards, whether one should open, when it opened locked.
  const [queue, setQueue] = useState<number[]>(initial?.queue ?? []);
  const [popupWanted, setPopupWanted] = useState(false);
  const [popupAt, setPopupAt] = useState<number | null>(null);
  // A risky ask's Approve, or one of an ask's wider choices: the approve pad beside its card (DK-62, CG-195, TF-14).
  const [approvePin, setApprovePin] = useState<{ number: number; scope: ChoiceScope | null } | null>(
    initial?.approvePin === undefined
      ? null
      : { number: initial.approvePin, scope: initial.approveChoice ?? null },
  );
  // The open conversation from Whombat while Talk shows (DK-63, CG-196); null: none known (an older runtime too).
  const [session, setSession] = useState<DeskSession | null>(null);
  const [sessionTick, setSessionTick] = useState(0);
  // After a lock, Talk shows nothing of the conversation until Whombat gave it again (TF-18, CG-286); where it was read
  // to, when not to the end (a row's key), so it opens there again.
  const [convoHidden, setConvoHidden] = useState(false);
  const convoAnchor = useRef<TalkAnchor | null>(null);
  // What the page last read of the conversation (`sessionSig`): a change is use (TF-18).
  const lastSession = useRef<string | null>(null);
  // The screen a card opened (DK-83, DK-86, DK-87), and the server Talk was opened about (DK-85).
  const [page, setPage] = useState<OpenPage | null>(initial?.page ?? null);
  // The calm glance's Welcome back that was seen (DK-121): gone after a minute or a touch, until the next one.
  const [welcomeSeen, setWelcomeSeen] = useState<string | null>(initial?.welcomeSeen ?? null);
  const welcomeShown = useRef<string | null>(null);
  const [talkServer, setTalkServer] = useState<string | null>(null);
  // *Ask {assistant} to look into it* on a locked screen (DK-96): asked once the PIN unlocks it.
  const pendingFix = useRef<DeskLook | null>(null);
  // A look ignored or put off (QN-20): its card says so, then closes (CG-334).
  const [lookDone, setLookDone] = useState<{ key: string; how: LookQuietHow } | null>(
    initial?.lookDone && initial.overlay?.kind === 'look'
      ? { key: initial.overlay.key, how: initial.lookDone }
      : null,
  );
  const lookDoneHeld = initial?.lookDone !== undefined;
  // The assistant's step was taken (CG-376): its button waits until the state says the assistant is on it.
  const [stepSent, setStepSent] = useState<string | null>(null);
  /** The PIN pad, alone or beside an ask; `digit`: a key typed on the locked glance. */
  const openPad = (next: 'ask' | 'talk' | null, digit = '') => {
    setPadDigits(digit);
    setOverlay({ kind: 'unlock', next });
  };

  // Talk in use (the mic, thinking or working, speaking) holds the screen awake, and the time to idle counts from its
  // end: waiting for or hearing an answer is using the screen (DK-71, CG-172), and so is the assistant working in the
  // open conversation (TF-18, CG-287). Only while unlocked: a locked screen goes idle as it would.
  const [speaking, setSpeaking] = useState(false);
  const convoWorking = talkOpen && session?.open === true && !!session.working;
  const busy = unlocked && (talkBusy(talk, speaking) || dictating(dictation) || convoWorking);
  const busyAt = useRef(0);
  if (busy) busyAt.current = now;
  // A new message or a change in the open conversation is use too (TF-18): when the last one came.
  const usedAt = useRef(0);
  const lastUse = Math.max(lastInput, busyAt.current, usedAt.current);
  // Since when nobody's there (the dimmed glance, DK-97): until a touch, a key, a face or a new ask (CG-171).
  const idleSince = useRef<number | null>(null);
  const scene =
    paired || desk.pairing
      ? deskScene({
          desk,
          now,
          serverNow,
          lastInput: lastUse,
          talkOpen,
          alertAt,
          talkBusy: busy,
          idleSince: idleSince.current,
          page: page?.kind ?? null,
        })
      : 'glance';
  if (scene !== 'idle') idleSince.current = null;
  else if (idleSince.current === null) idleSince.current = now;
  // The sheets show over the glance, the clock, Talk and the screens a card opened (DK-60).
  const sheetScene = sheetOver(scene);
  const sheetOpen = overlay?.kind === 'ask' && sheetScene;
  const att = attention({ scene, lastInput, alertAt, needsYou: glance?.needsYou.count ?? 0, sheetOpen });
  // Burn-in (CG-09): the night's clock drifts 10 minutes after the last touch; the dimmed glance of nobody there from
  // when it dimmed (DK-97). The glance itself only shows while someone uses or looks at it, so it stays put.
  const night = burnIn(now - lastUse, scene === 'night');
  const drift = scene === 'idle' ? driftAt(now - (idleSince.current ?? now)) : night.dimmed ? night : null;

  // The ask the sheet shows, kept when it leaves the glance (answered somewhere else); dropped when the screen locks,
  // and drawn locked without its words or buttons (CG-50).
  const sheetAsk = useRef<DeskAsk | null>(null);
  const liveAsk =
    overlay?.kind === 'ask' ? glance?.needsYou.items.find((a) => a.number === overlay.number) : null;
  if (liveAsk) sheetAsk.current = liveAsk;
  if (overlay?.kind !== 'ask') sheetAsk.current = null;
  // The look the sheet shows, kept when it leaves Needs you (fine again, DK-95).
  const sheetLook = useRef<DeskLook | null>(null);
  const liveLook =
    overlay?.kind === 'look' ? glance?.needsYou.looks?.find((l) => l.key === overlay.key) : null;
  if (liveLook) sheetLook.current = liveLook;
  if (overlay?.kind !== 'look') sheetLook.current = null;

  // A new ask by day: wake, amber edge, one chime (DK-08), and its card opens by itself (DK-60); never in quiet hours
  // (DK-09). Asks answered somewhere else leave the queue.
  const prevSig = useRef<AskSig | null>(null);
  const quiet = paired?.quiet ?? false;
  const openNumber = overlay?.kind === 'ask' ? overlay.number : null;
  useEffect(() => {
    if (!glance) return;
    const sig = askSig(glance);
    const a = alertFor(prevSig.current, sig, quiet);
    const fresh = freshAsks(prevSig.current, sig);
    prevSig.current = sig;
    setQueue((q) => {
      const next = liveQueue(a.wake ? enqueue(q, fresh) : q, glance, openNumber);
      return next.length === q.length && next.every((n, i) => n === q[i]) ? q : next;
    });
    if (a.wake) {
      setAlertAt(Date.now());
      setPopupWanted(true);
    }
    if (a.chime) chime();
  }, [glance, quiet, openNumber]);

  // Quiet, black, pairing, nobody there (Talk in use holds it off) or Whombat away: no sheet stays open, none opens by
  // itself, and what was typed goes (DK-71). Talk closes, but not for nobody there: the conversation that was open shows
  // again when someone is back on an unlocked screen (TF-18, CG-286).
  useEffect(() => {
    if (held || scene === 'night' || scene === 'black' || scene === 'pairing' || scene === 'idle') {
      setOverlay(null);
      if (scene !== 'idle' || held) setTalkOpen(false);
      setDraft(null);
      setPopupWanted(false);
      setQueue([]);
      setApprovePin(null);
      pendingFix.current = null;
    }
  }, [scene, held]);

  // A card's screen stays while it shows (and under Talk, DK-85); Back, two minutes untouched, the night, nobody there,
  // *Only the time* while locked or Whombat away close it (DK-83, DK-84). This Whombat's needs This Whombat.
  const selfBox = glance?.box ?? glance?.self ?? null;
  useEffect(() => {
    if (!page) return;
    if (held || !pageKept(scene, page.kind) || (page.kind === 'self' && !selfBox)) setPage(null);
  }, [page, scene, held, selfBox]);
  /** Back: to every server when the server was opened from there, else to the glance (DK-83, DK-86). */
  const pageBack = () =>
    setPage((p) => (p?.kind === 'server' && p.from === 'servers' ? { kind: 'servers' } : null));
  /** The runtime won't show it (locked into *Only the time*, DK-84) or knows no such server: back to the glance. */
  const pageGone = (code: PageGone) => {
    setPage(null);
    if (code !== 'not_found') refresh();
  };

  // Unlocked: what the PIN pad was opened for. Locked again (2 min after the last touch, the lock button, Whombat
  // says so, its `until` passed): the ask sheet closes, the ask the sheet kept goes (DK-04, CG-50). Talk keeps which
  // conversation was open and the talk it follows, and shows them again after the unlock (TF-18, CG-286).
  const wasUnlocked = useRef(unlocked);
  useEffect(() => {
    if (unlocked && !wasUnlocked.current) {
      setSheetNote(null);
      setPadDigits('');
      setPopupAt(null);
      if (overlay?.kind === 'unlock') {
        // The ask that came first (DK-60), else the first in Needs you.
        const pop = popupFor(queue, glance, true);
        const first = pop?.kind === 'ask' ? pop.number : glance?.needsYou.items[0]?.number;
        if (overlay.next === 'ask' && first !== undefined) setOverlay({ kind: 'ask', number: first });
        else if (overlay.next === 'talk') {
          setOverlay(null);
          const look = pendingFix.current;
          pendingFix.current = null;
          if (look) fixLook(look);
          else setTalkOpen(true);
        } else setOverlay(null);
      } else if (overlay?.kind === 'look' && overlay.pin) {
        // Ignore, Not now or the step after the PIN (CG-333, CG-376): the card alone again, and it goes, unless the look
        // went meanwhile.
        const how = overlay.pin;
        setOverlay({ kind: 'look', key: overlay.key });
        if (liveLook) void (how === 'fix' ? fixStep(liveLook) : quietLook(liveLook, how));
      }
    }
    if (!unlocked && wasUnlocked.current) {
      setOverlay(null);
      setQueue([]);
      setApprovePin(null);
      // The conversation's words leave the screen with the lock (DK-03, DK-63); Whombat gives them again after it, and
      // until then Talk shows none of them.
      setSession(null);
      setConvoHidden(true);
      lastSession.current = null;
      sheetAsk.current = null;
      setDraft(null);
      discardCapture();
      stopPlayback();
    }
    wasUnlocked.current = unlocked;
  });

  // Tell Whombat the screen is in use, at most every 20 s, so it stays unlocked (DK-04).
  const lastTouch = useRef<number | null>(null);
  const unlockedRef = useRef(unlocked);
  unlockedRef.current = unlocked;
  // A touch that wakes the night's clock, black or the dimmed glance only wakes it; one on a layer over the desk (the
  // Wi-Fi sheet, which may outlast the idle minute) is that layer's (CG-171).
  const wakeOnly = useRef(false);
  wakeOnly.current = wakesOnly(scene);
  const root = useRef<HTMLDivElement>(null);
  const swallowUntil = useRef(0);
  const touch = useCallback(() => {
    // A touch after Welcome back showed puts it away (DK-121).
    if (welcomeShown.current) setWelcomeSeen(welcomeShown.current);
    const t = Date.now();
    if (!shouldTouch(lastTouch.current, t, unlockedRef.current)) return;
    lastTouch.current = t;
    void client.post('/api/desk/touch', {}).catch(() => {});
  }, [client]);
  // A layout effect, so this listener is the window's first (before `useLastInput`'s, a passive effect): it must see
  // the scene from before the input. The last input's update re-renders the desk between two listeners (a microtask),
  // and a listener after it saw the glance already: a key on the night's clock, or a touch on the dimmed glance,
  // opened the PIN pad (CG-177). Stopped in the capture phase, a key still reaches the window's other capture
  // listeners (the last input), not the desk's keys.
  useLayoutEffect(() => {
    const onLayer = (t: EventTarget | null) =>
      t instanceof Element &&
      t !== document.body &&
      t !== document.documentElement &&
      !root.current?.contains(t);
    const onInput = (e: Event) => {
      // A monitor only shows: touching it is no use of the box's own display.
      if (onMonitor(e.target)) return;
      primeAudio();
      if (wakeOnly.current && !onLayer(e.target)) {
        swallowUntil.current = Date.now() + 600;
        if (e.type === 'keydown') e.stopPropagation();
      }
      touch();
    };
    const onClick = (e: MouseEvent) => {
      if (onMonitor(e.target)) return;
      if (Date.now() < swallowUntil.current) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    window.addEventListener('pointerdown', onInput, true);
    window.addEventListener('keydown', onInput, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('pointerdown', onInput, true);
      window.removeEventListener('keydown', onInput, true);
      window.removeEventListener('click', onClick, true);
    };
  }, [touch]);

  // Locked: a touch anywhere on the glance, or on a card's screen, opens the PIN pad (“Locked · touch to use”); a card is
  // a button and opens its screen instead (DK-84).
  const tapOpens = touchUnlocks(scene) && !unlocked && overlay === null && !!paired && !held;
  useEffect(() => {
    if (!tapOpens) return;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const on = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('button')) return;
      if (onMonitor(e.target)) return;
      // A swipe through the screen of widgets' pages is no touch to unlock.
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > SWIPE_SLOP_PX) return;
      setPadDigits('');
      setOverlay({ kind: 'unlock', next: null });
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('click', on);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('click', on);
    };
  }, [tapOpens]);

  // The microphone, open from the tap until Done or Cancel (DK-07, CG-360), and the words the box is hearing.
  const capture = useRef<Promise<Capture> | null>(null);
  const hearing = useRef<AbortController | null>(null);
  // The recording in progress (0: none): what Cancel stops, and what words arriving late must still belong to.
  const dictations = useRef(0);
  const dictationRun = useRef(0);
  const playback = useRef<Playback | null>(null);

  const stopPlayback = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
    setSpeaking(false);
  }, []);

  /**
   * *Cancel*, or Talk closed, the screen locked, the voice off (CG-52): the microphone closes without anything sent
   * (one still opening as soon as it has opened) and words still being heard are dropped.
   */
  const discardCapture = useCallback(() => {
    if (dictationRun.current === 0) return;
    dictationRun.current = 0;
    const p = capture.current;
    capture.current = null;
    p?.then((c) => c.stop()).catch(() => {});
    hearing.current?.abort();
    hearing.current = null;
    dictate({ type: 'cancel' });
  }, []);

  const send = useCallback(
    async (
      body: { text: string; spoken?: true },
      /** A question that starts its own conversation about this server (DK-96), whatever Talk had. */
      about?: { server: string | null },
    ) => {
      // The open conversation goes on until it is closed or times out (DK-64): every question continues it but the
      // first after Close conversation or after Ask on another conversation's card. A runtime from before 0.108
      // continues only within its 2 minutes. Asked from a server's screen, the talk names the server (DK-85): only one
      // with an id, which an older runtime never sends.
      const server = about ? about.server : talkServer;
      const res = await client
        .post('/api/desk/talk', { ...body, continue: !about && !freshTopic, ...(server && { server }) })
        .catch(() => null);
      if (!res) return dispatch({ type: 'netFailed' });
      const b = (res.body ?? {}) as { id?: unknown };
      if (res.status === 200 && typeof b.id === 'string') {
        setFreshTopic(false);
        dispatch({ type: 'sent', id: b.id });
        // Waiting for an answer is using the screen: it stays unlocked meanwhile.
        touch();
      } else {
        const code = deskErrorCode(res.body);
        dispatch({ type: 'refused', status: res.status, code });
        if (res.status === 409 && code === 'locked') refresh();
      }
    },
    [client, freshTopic, talkServer, refresh, touch],
  );

  /**
   * *Done*, or five minutes recorded (CG-360): the microphone closes and the box turns the recording into text, which
   * goes at the end of Talk's box to read, change and send (Whombat dictation.md). Nothing is sent from here.
   */
  async function finishDictation() {
    const p = capture.current;
    const run = dictationRun.current;
    if (!p || run === 0) return;
    capture.current = null;
    dictate({ type: 'done' });
    // Cancelled, or the screen locked or Talk closed meanwhile: the words go nowhere.
    const gone = () => dictationRun.current !== run;
    const fail = (error: DictationError) => {
      dictationRun.current = 0;
      dictate({ type: 'failed', error, at: Date.now() });
    };
    let rec: Awaited<ReturnType<Capture['stop']>>;
    try {
      rec = await (await p).stop();
    } catch {
      return gone() ? undefined : fail('microphone');
    }
    if (gone()) return;
    // The microphone opened too late to hear anything, or Done came at once.
    if (rec.seconds < MIN_HEAR_SECONDS) return fail('nothing');
    const abort = new AbortController();
    hearing.current = abort;
    const res = await client
      .post(
        '/api/desk/hear',
        { audioWav: toBase64(rec.wav()) },
        { timeoutMs: hearTimeoutMs(rec.seconds), signal: abort.signal },
      )
      .catch(() => null);
    if (gone()) return;
    hearing.current = null;
    if (!res) return fail('failed');
    if (res.status !== 200) {
      const error = hearRefusal(res.status, deskErrorCode(res.body));
      if (!error) {
        discardCapture();
        return refresh();
      }
      return fail(error);
    }
    const heard = parseHeard(res.body);
    if (!heard) return fail(heard === '' ? 'nothing' : 'failed');
    dictationRun.current = 0;
    setDraft((d) => withHeard(d, heard));
    setSpokenDraft(true);
    dictate({ type: 'heard' });
    touch();
  }

  /** The mic tapped (CG-360): the microphone opens and records until *Done*, *Cancel* or five minutes. */
  function startDictation() {
    if (!paired?.voice || dictationRun.current !== 0 || dictating(dictation)) return;
    stopPlayback();
    dictations.current += 1;
    dictationRun.current = dictations.current;
    dictate({ type: 'start' });
    setLevels([]);
    const p = startCapture(
      (l) => setLevels((ls) => [...ls.slice(-31), l]),
      () => void finishDictation(),
      MAX_HEAR_SECONDS,
    );
    capture.current = p;
    p.then(
      () => {
        if (capture.current === p) dictate({ type: 'open', at: Date.now() });
      },
      () => {
        if (capture.current !== p) return;
        capture.current = null;
        dictationRun.current = 0;
        dictate({ type: 'failed', error: 'microphone', at: Date.now() });
      },
    );
  }

  // Only in Talk, unlocked, with the voice on and Whombat there, and no card over Talk (DK-60); and never past the desk
  // itself (unpaired from the phone: the console comes back): a microphone held or still opening then is closed and
  // nothing is sent (CG-52).
  const micAllowed =
    mayListen({ scene, unlocked, voice: paired?.voice ?? false, held }) && !(overlay !== null && sheetScene);
  useEffect(() => {
    if (!micAllowed) discardCapture();
  }, [micAllowed, discardCapture]);
  useEffect(() => () => discardCapture(), [discardCapture]);

  /** Talk, about `server` when asked from its screen (DK-85): the talk names it until Talk closes. */
  const openTalk = (fresh: boolean, server: string | null = null) => {
    convoAnchor.current = null;
    setOverlay(null);
    setFreshTopic(fresh);
    setTalkServer(server);
    if (canAsk(talk)) dispatch({ type: 'reset' });
    setTalkOpen(true);
  };

  const closeTalk = () => {
    discardCapture();
    stopPlayback();
    setDraft(null);
    setTalkOpen(false);
    setTalkServer(null);
    convoAnchor.current = null;
    setConvoHidden(false);
  };

  /** The server on the screen now, when it is a server's screen: what a talk from it is about (DK-85). */
  const shownServer =
    page?.kind === 'server' && scene === 'server' ? (page.list[page.index]?.id ?? null) : null;

  /** Ask {assistant} about {server} (DK-85): Talk about it, after the PIN when locked (DK-04). */
  const askAbout = (s: DeskServer) => {
    if (held || !s.id) return;
    if (unlocked) return openTalk(false, s.id);
    setTalkServer(s.id);
    openPad('talk');
  };

  /**
   * *Ask {assistant} to fix it* (DK-96): Talk on a new conversation, the question sent as the person's typed words, the
   * server named; after the PIN when locked. While Talk still waits for an answer, the words wait in its box.
   */
  function fixLook(look: DeskLook) {
    if (held) return;
    if (!unlocked) {
      pendingFix.current = look;
      openPad('talk');
      return;
    }
    const text = lookQuestion(look);
    const server = look.server ?? null;
    openTalk(true, server);
    if (!canAsk(talk)) return setDraft(text);
    stopPlayback();
    setDraft(null);
    dispatch({ type: 'type', text });
    void send({ text }, { server });
  }

  /**
   * *Ignore* or *Not now* on a look (QN-20, CG-333, CG-334): locked, the PIN pad beside the card first; unlocked, sent
   * once; then the card says what happens now and closes, or says why not.
   */
  async function quietLook(look: DeskLook, how: LookQuietHow) {
    const body = lookQuietBody(look, how);
    if (held || !body || sheetBusy) return;
    setSheetNote(null);
    if (!unlocked) {
      setPadDigits('');
      setOverlay({ kind: 'look', key: look.key, pin: how });
      return;
    }
    setSheetBusy(true);
    const res = await client.post('/api/desk/look/quiet', body).catch(() => null);
    const a = res ? parseQuietAnswer(res.status, res.body) : 'failed';
    setSheetBusy(false);
    if (a === 'quieted') setLookDone({ key: look.key, how });
    else setSheetNote(quietRefusal(a, look.name));
    // Quieted, gone or the screen locked meanwhile: the state shows it.
    if (a !== 'failed' && a !== 'notAllowed') refresh();
  }

  /**
   * The step the assistant offers on a look (LR-08, CG-376), the person's go-ahead: locked, the PIN pad beside the
   * look's card first, as Approve; unlocked, sent once, and the state then says the assistant is on it. Refused, the
   * look's card says why (opened for it when the step was pressed on the hero).
   */
  async function fixStep(look: DeskLook) {
    if (held || sheetBusy || !lookStep(look)) return;
    setSheetNote(null);
    if (!unlocked) {
      setPadDigits('');
      setOverlay({ kind: 'look', key: look.key, pin: 'fix' });
      return;
    }
    setSheetBusy(true);
    const res = await client.post('/api/desk/look/fix', { key: look.key }).catch(() => null);
    const a = res ? parseStepAnswer(res.status, res.body) : 'failed';
    setSheetBusy(false);
    if (a === 'taken') setStepSent(look.key);
    else if (a !== 'locked') {
      setOverlay({ kind: 'look', key: look.key });
      setSheetNote(quietRefusal(a, look.name));
    }
    if (a !== 'failed' && a !== 'notAllowed') refresh();
  }

  // The step taken waits until the look's research moves on (or goes), at most STEP_WAIT_MS: then it may be pressed again.
  const sentLook = stepSent ? glance?.needsYou.looks?.find((l) => l.key === stepSent) : undefined;
  const stepWaits = stepSent !== null && sentLook?.research?.state === 'found';
  useEffect(() => {
    if (!stepSent) return;
    if (!stepWaits) {
      setStepSent(null);
      return;
    }
    const timer = setTimeout(() => setStepSent(null), STEP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [stepSent, stepWaits]);

  // Ignored or put off: the card says so for a moment, then closes (CG-334).
  useEffect(() => {
    if (!lookDone || lookDoneHeld) return;
    const timer = setTimeout(() => {
      setLookDone(null);
      setOverlay((o) => (o?.kind === 'look' && o.key === lookDone.key ? null : o));
    }, QUIET_DONE_MS);
    return () => clearTimeout(timer);
  }, [lookDone, lookDoneHeld]);

  /** *Close conversation* (DK-64): Whombat ends it, Talk starts empty and the next question starts a new one. */
  const closeConversation = () => {
    discardCapture();
    stopPlayback();
    setDraft(null);
    setFreshTopic(true);
    setSession(CLOSED_SESSION);
    lastSession.current = null;
    convoAnchor.current = null;
    if (canAsk(talk)) dispatch({ type: 'reset' });
    void client
      .post('/api/desk/talk/close', {})
      .catch(() => null)
      .then(() => setSessionTick((t) => t + 1));
  };

  // A card opens by itself for the asks that came (DK-60): over the glance, the clock or Talk; it waits while the
  // person dictates or types the PIN, and doesn't open over a card already open (the queue goes on after it).
  const listening = dictating(dictation);
  // On a screen of widgets the modal does that on the glance (it shows the ask's card when touched).
  const modalPops = grid !== null && scene === 'glance';
  useEffect(() => {
    if (!popupWanted) return;
    if (held || !paired || !sheetScene || modalPops) return setPopupWanted(false);
    if (listening || capture.current || overlay?.kind === 'unlock') return;
    setPopupWanted(false);
    if (overlay) return;
    const pop = popupFor(queue, glance, unlocked);
    if (!pop) return;
    setSheetNote(null);
    setApprovePin(null);
    if (pop.kind === 'ask') setOverlay({ kind: 'ask', number: pop.number });
    else {
      setPadDigits('');
      setOverlay({ kind: 'unlock', next: 'ask', reason: true });
    }
    setPopupAt(unlocked ? null : Date.now());
  }, [popupWanted, held, paired, sheetScene, modalPops, listening, overlay, queue, glance, unlocked]);

  // A card that opened by itself on a locked screen and nobody touched closes after 2 minutes (DK-60).
  useEffect(() => {
    if (!popupLapsed(popupAt, lastInput, now, unlocked)) return;
    setPopupAt(null);
    setQueue([]);
    setOverlay(null);
  }, [popupAt, lastInput, now, unlocked]);

  /** The card is answered or closed: the next that came opens, else none (DK-60). */
  const closeAsk = (done: number) => {
    setApprovePin(null);
    setSheetNote(null);
    setPopupAt(null);
    const rest = afterAsk(queue, done);
    setQueue(rest);
    const pop = unlocked && rest.length > 0 ? popupFor(rest, glance, true) : null;
    setOverlay(pop?.kind === 'ask' && pop.number !== done ? { kind: 'ask', number: pop.number } : null);
  };

  /** An ask opened from Needs you or the conversation: first in the queue. */
  const openAsk = (number: number) => {
    setSheetNote(null);
    setApprovePin(null);
    setQueue((q) => putFirst(q, number));
    setOverlay({ kind: 'ask', number });
  };

  // The open conversation while Talk shows (DK-63): read now, after every change of the talk and after a decision,
  // then every 1.5 s (every second while an answer is awaited). A runtime without it (404) leaves Talk as before. A new
  // message or a change in it, and the assistant working in it, are use: the screen stays awake and unlocked (TF-18).
  const sessionOn = scene === 'talk' && unlocked && !held;
  const waiting = talk.phase === 'waiting' || talk.phase === 'sending';
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionTick and the talk's phase start a read at once
  useEffect(() => {
    if (!sessionOn) return;
    let stopped = false;
    const read = async () => {
      const res = await client.post('/api/desk/talk/session', {}).catch(() => null);
      if (stopped) return;
      // No answer: what the page has shows (an older runtime's own talk, the opening line).
      if (!res) return setConvoHidden(false);
      if (res.status === 200) {
        const s = parseSession(res.body);
        if (s) {
          const sig = sessionSig(s);
          if (lastSession.current !== null && sig !== lastSession.current) {
            usedAt.current = Date.now();
            touch();
          } else if (s.working) touch();
          lastSession.current = sig;
          setSession(s);
        }
      } else if (res.status === 404) setSession(null);
      else if (res.status === 409 && deskErrorCode(res.body) === 'locked') return refresh();
      setConvoHidden(false);
    };
    void read();
    const timer = setInterval(() => void read(), waiting ? 1000 : 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, sessionOn, waiting, talk.phase, sessionTick, refresh, touch]);

  // The keyboard (a keyboard cover): typing asks in words, voice or not (DK-T12, CG-53); Escape cancels the mic, else
  // closes. Talk's mic is a tap, never a held key (CG-360).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || !paired || held) return;
    if (!sheetOver(scene)) return;
    const padOpen =
      overlay?.kind === 'unlock' ||
      (overlay?.kind === 'ask' && !unlocked) ||
      (overlay?.kind === 'look' && !!overlay.pin && !unlocked);
    if (padOpen || approvePin !== null) return; // the PIN pad (or the approve pad) has the keys
    if (e.key === 'Escape') {
      if (dictating(dictation)) discardCapture();
      else if (overlay?.kind === 'ask') closeAsk(overlay.number);
      else if (overlay) setOverlay(null);
      else if (scene === 'talk') closeTalk();
      else if (isPage(scene)) pageBack();
      return;
    }
    // The arrows go through the servers as a swipe does (DK-83).
    if (!overlay && page?.kind === 'server' && scene === 'server' && /^Arrow(Left|Right)$/.test(e.key)) {
      const next = page.index + (e.key === 'ArrowRight' ? 1 : -1);
      if (next >= 0 && next < page.list.length)
        setPage({ ...page, index: next, swipe: next > page.index ? 'next' : 'prev' });
      e.preventDefault();
      return;
    }
    if (!unlocked) {
      if (e.key.length === 1 || e.key === 'Enter') {
        openPad(null, /^[0-9]$/.test(e.key) ? e.key : '');
        e.preventDefault();
      }
      return;
    }
    if (overlay || dictating(dictation)) return;
    if (e.key.length === 1) {
      e.preventDefault();
      if (scene !== 'talk') openTalk(false, shownServer);
      setDraft((d) => (d ?? '') + e.key);
    }
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  });

  // Follow the talk until it settles: `/api/state` carries the latest one, `talk/get` the one asked for.
  const id = talkId(talk);
  useEffect(() => {
    if (desk.talk && desk.talk.id === id) {
      setFollowed(desk.talk);
      dispatch({ type: 'update', talk: desk.talk });
    }
  }, [desk.talk, id]);
  // Thinking, then working past 90 s (TF-16): followed until it is answered or fails, and only while unlocked (Whombat
  // answers `locked` otherwise); after an unlock it goes on.
  useEffect(() => {
    if (!id || talk.phase !== 'waiting' || !unlocked) return;
    let stopped = false;
    const poll = async () => {
      const res = await client.post('/api/desk/talk/get', { id }).catch(() => null);
      if (!stopped && res?.status === 404) return dispatch({ type: 'lost', id });
      const t = res?.status === 200 ? parseTalk(res.body) : null;
      if (stopped || !t || t.id !== id) return;
      setFollowed(t);
      dispatch({ type: 'update', talk: t });
      touch();
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, id, talk.phase, unlocked, touch]);

  // A reloaded page picks up a talk that is still going (the kiosk restarted when the keyboard was attached).
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const t = desk.talk;
    if (
      unlocked &&
      paired &&
      t &&
      (t.state === 'transcribing' || t.state === 'thinking' || t.state === 'working')
    ) {
      setTalkOpen(true);
      dispatch({ type: 'resume', id: t.id });
    }
  }, [desk.talk, unlocked, paired]);

  // Speak the answer once, when it arrives (DK-06); a tap on it plays it again.
  const played = useRef(new Set<string>());
  const play = useCallback(
    (talkIdToPlay: string) => {
      stopPlayback();
      // The handle comes back before the audio is fetched: locking or closing Talk meanwhile stops it (CG-52). Speaking
      // until it is over, however it ends (CG-172).
      const pb = playAnswer(client, talkIdToPlay, () => {
        if (playback.current !== pb) return;
        playback.current = null;
        setSpeaking(false);
      });
      playback.current = pb;
      setSpeaking(true);
    },
    [client, stopPlayback],
  );
  useEffect(() => {
    if (followed?.state !== 'answered' || !followed.audio || played.current.has(followed.id)) return;
    if (talk.phase !== 'done' || talk.id !== followed.id || scene !== 'talk') return;
    played.current.add(followed.id);
    play(followed.id);
  }, [followed, talk, scene, play]);
  useEffect(() => () => stopPlayback(), [stopPlayback]);

  /**
   * Sends a decision (and a risky ask's PIN, DK-62; a wider choice's scope with its PIN, TF-14); Whombat's answer,
   * `failed` when it didn't come.
   */
  const postDecision = async (
    number: number,
    decision: Decision,
    o: { pin?: string; scope?: ChoiceScope } = {},
  ): Promise<DecideAnswer> => {
    const res = await client.post('/api/desk/decide', decideBody(number, decision, o)).catch(() => null);
    return res ? parseDecideAnswer(res.status, res.body) : { result: 'failed' };
  };

  /** What the sheet does with Whombat's answer to a decision (CG-193). */
  const decided = (number: number, a: DecideAnswer) => {
    switch (a.result) {
      case 'decided':
        refresh();
        setSessionTick((t) => t + 1);
        // The assistant's next words in the conversation are said, as an answer is (DK-63); its line goes once the
        // assistant says something newer than now (TF-16).
        if (a.talk && canAsk(talk)) dispatch({ type: 'resume', id: a.talk, at: Date.now() + offset });
        closeAsk(number);
        return;
      case 'pinNeeded':
        setApprovePin({ number, scope: null });
        return;
      case 'notOffered':
        // The choice isn't the person's to make here, or not any more: nothing was decided (TF-14).
        setApprovePin(null);
        return setSheetNote(DESK_WORDS.notOffered);
      case 'onPhone':
        setApprovePin(null);
        return setSheetNote(DESK_WORDS.onPhone);
      case 'gone':
        setApprovePin(null);
        return setSheetNote(DESK.alreadyAnswered);
      case 'locked':
      case 'backoff':
        return refresh();
      default:
        return setSheetNote(DESK_WORDS.talkFailed);
    }
  };

  const decide = async (number: number, decision: Decision) => {
    setSheetBusy(true);
    setSheetNote(null);
    const a = await postDecision(number, decision);
    setSheetBusy(false);
    decided(number, a);
  };

  /**
   * An answer behind the PIN from the pop-up (CG-397): the ask's card opens with the approve pad beside it, as its own
   * Approve or wider choice would open it.
   */
  const answerWithPin = (number: number, scope: ChoiceScope | null) => {
    openAsk(number);
    setApprovePin({ number, scope });
  };

  /** Approve or Deny from the pop-up (CG-397): Whombat asking for the PIN after all opens the card with the pad. */
  const decideInPopup = async (number: number, decision: Decision) => {
    setSheetBusy(true);
    setSheetNote(null);
    const a = await postDecision(number, decision);
    setSheetBusy(false);
    if (a.result === 'pinNeeded') return answerWithPin(number, null);
    decided(number, a);
  };

  /** Lock (DK-04): the conversation stays open underneath and shows again after the unlock (TF-18, CG-286). */
  const lock = () => {
    discardCapture();
    stopPlayback();
    setDraft(null);
    setOverlay(null);
    void client.post('/api/desk/lock', {}).then(refresh, refresh);
  };

  // Not now on Found on your network (DF-04): allowed locked; the panel goes at once and comes back if Whombat
  // refused or didn't answer.
  const dismissFound = () => {
    setFoundGone(true);
    void client.post('/api/desk/found/dismiss', {}).then(
      (res) => {
        if (res.status !== 200) setFoundGone(false);
        refresh();
      },
      () => setFoundGone(false),
    );
  };

  const burrow = paired?.burrow ?? state.claim?.burrows?.first ?? null;
  // Unlocked until Lock (DK-74): no minutes on the chip, “Unlocked as John”.
  const stays = unlocked && desk.lock.stays === true;
  const minutes = stays ? null : locksIn(desk.lock.until, serverNow);
  // The camera's mark and “stays unlocked while you’re here” only while unlocked now (DK-28, DK-30).
  const camera = unlocked && desk.lock.camera === true;
  const present = camera && !stays && desk.lock.present === true;
  // The camera looking for someone (DK-72, DK-73): its mark on the top bar and the idle clock.
  const looking = desk.presence?.camera === true;

  const lockChip = paired && (
    <LockChip
      unlocked={unlocked}
      name={paired.person.name}
      minutes={minutes}
      camera={camera}
      present={present}
      looking={looking}
      onLock={lock}
    />
  );

  let body: ReactNode = null;
  if (scene === 'pairing' && desk.pairing) {
    body = (
      <Pairing
        code={desk.pairing.code}
        expiresAt={desk.pairing.expiresAt}
        burrow={burrow}
        power={desk.power}
        now={serverNow}
      />
    );
  } else if (paired && scene === 'black') {
    body = <div className={styles.black} />;
  } else if (paired && scene === 'night') {
    body = <Night paired={paired} glance={glance} power={desk.power} now={serverNow} />;
  } else if (paired && scene === 'talk') {
    const convo = convoHidden
      ? { earlier: 0, rows: [], open: false }
      : conversation(session, talk, followed, paired.assistant.name, paired.voice);
    body = (
      <Talk
        paired={paired}
        power={desk.power}
        burrow={burrow}
        convo={convo}
        now={serverNow}
        anchor={convoAnchor}
        dictation={dictation}
        pageNow={now}
        thinking={waiting || convoWorking}
        startAtTop={initial?.convoTop}
        canOpenAsk={(n) => glance?.needsYou.items.some((a) => a.number === n) ?? false}
        onOpenAsk={openAsk}
        onCloseConversation={convo.open ? closeConversation : undefined}
        levels={levels}
        draft={draft}
        canAsk={canAsk(talk)}
        voice={paired.voice}
        locksIn={minutes}
        camera={camera}
        present={present}
        looking={looking}
        onDraft={setDraft}
        onSend={(text) => {
          if (!canAsk(talk) || dictating(dictation)) return;
          stopPlayback();
          setDraft(null);
          dispatch({ type: 'type', text });
          void send({
            text: [...text.trim()].slice(0, MAX_TALK_TEXT).join(''),
            ...(spokenDraft && { spoken: true }),
          });
          setSpokenDraft(false);
        }}
        onDictate={startDictation}
        onDictationDone={() => void finishDictation()}
        onDictationCancel={discardCapture}
        onBack={closeTalk}
        onLock={lock}
        onReplay={play}
      />
    );
  } else if (paired && page?.kind === 'server' && scene === 'server') {
    body = (
      <ServerScreen
        client={client}
        list={page.list}
        index={page.index}
        swipe={page.swipe}
        timeZone={paired.timeZone}
        assistant={paired.voice ? paired.assistant.name : null}
        lock={lockChip}
        initialRange={initial?.range}
        onBack={pageBack}
        onIndex={(index, swipe) => setPage({ ...page, index, swipe })}
        onAsk={askAbout}
        onGone={pageGone}
      />
    );
  } else if (paired && page?.kind === 'servers' && scene === 'servers') {
    body = (
      <ServersScreen
        client={client}
        fallback={[...(glance?.servers ?? []), ...(glance?.extraServers ?? [])]}
        lock={lockChip}
        onBack={pageBack}
        onServer={(list, index) => setPage({ kind: 'server', list, index, from: 'servers' })}
        onGone={pageGone}
      />
    );
  } else if (paired && page?.kind === 'self' && scene === 'self' && selfBox) {
    body = <SelfScreen box={selfBox} assistant={paired.assistant.name} lock={lockChip} onBack={pageBack} />;
  } else if (paired) {
    const props: GlanceProps = {
      paired,
      glance,
      power: desk.power,
      burrow,
      now: serverNow,
      unlocked,
      locksIn: minutes,
      camera,
      present,
      looking,
      onLock: lock,
      onAsk: (number) => {
        if (held) return;
        openAsk(number);
      },
      onAnswer: () => {
        if (held) return;
        const first = glance?.needsYou.items[0];
        if (unlocked && first) openAsk(first.number);
        else openPad('ask');
      },
      onLook: (key) => {
        if (held) return;
        setSheetNote(null);
        setOverlay({ kind: 'look', key });
      },
      onTalk: () => openTalk(false),
      appUrl: state.claim?.appUrl ?? '',
      // Nothing is sent while Whombat is away (CG-49).
      onFoundDismiss: held ? undefined : dismissFound,
      foundSeen: initial?.foundSeen,
      // A card opens its screen, locked too (DK-84); nothing while Whombat is away (CG-49).
      onServer: held ? undefined : (list, index) => setPage({ kind: 'server', list, index, from: 'glance' }),
      onServers: held ? undefined : () => setPage({ kind: 'servers' }),
      onSelf: held ? undefined : () => setPage({ kind: 'self' }),
    };
    // Nobody there (DK-97): what showed, dimmed and drifting (the first touch only wakes it); *Only the time* stays that.
    const timeOnly = scene === 'clock' || (scene === 'idle' && !unlocked && paired.lockedView === 'time');
    const calm = glance?.calm ?? null;
    const lookOf = (key: string) => glance?.needsYou.looks?.find((l) => l.key === key);
    // Welcome back (DK-120…DK-122) shows as the calm glance had it, over the whole screen, until it was seen.
    const welcoming = calm?.digest != null && calm.digest.id !== welcomeSeen;
    if (grid && glance && !timeOnly && !welcoming) {
      // The screen of widgets (3.6): the runtime sent the box's grid, so this page draws it under its own chips. The
      // modal's buttons open what the calm glance's hero opened: the ask's card, the look's step, a server's screen.
      welcomeShown.current = null;
      const servers = gridServers(grid, calm);
      body = (
        <GridGlance
          grid={grid}
          calmGlance={calm}
          done={glance.done}
          found={glance.found ?? null}
          appUrl={props.appUrl}
          onFoundDismiss={props.onFoundDismiss}
          name={desk.name ?? burrow ?? ''}
          paired={paired}
          power={desk.power}
          now={serverNow}
          unlocked={unlocked}
          locksIn={minutes}
          camera={camera}
          present={present}
          looking={looking}
          onLock={lock}
          onTalk={() => openTalk(false)}
          notNow={notNow}
          loadImage={loadImage}
          onAsk={props.onAsk}
          askView={
            held
              ? undefined
              : (item) =>
                  askViewOf(
                    item.ask !== undefined
                      ? glance.needsYou.items.find((a) => a.number === item.ask)
                      : undefined,
                    {
                      unlocked,
                      voice: paired.voice,
                      busy: sheetBusy,
                      note: sheetNote,
                      assistant: paired.assistant.name,
                      decide: (n, d) => void decideInPopup(n, d),
                      withPin: answerWithPin,
                      talk: (ask) => openTalk(ask.inTalk !== true),
                      unlock: () => openPad(null),
                    },
                  )
          }
          onLook={props.onLook}
          onStep={
            held
              ? undefined
              : (key) => {
                  const look = lookOf(key);
                  if (look) void fixStep(look);
                }
          }
          onFix={
            held
              ? undefined
              : (key) => {
                  const look = lookOf(key);
                  if (look) fixLook(look);
                }
          }
          onServer={
            held
              ? undefined
              : (id) => {
                  const index = servers.findIndex((s) => s.id === id);
                  if (index >= 0) setPage({ kind: 'server', list: servers, index, from: 'glance' });
                }
          }
          onServers={props.onServers}
          onUnlock={held ? undefined : () => openPad(null)}
          onNotNow={(keys) => setNotNow((k) => [...new Set([...k, ...keys])])}
        />
      );
      // A box without servers keeps This Whombat and Found on your network as they were (DK-100, DF-06).
    } else if (calm && glance && !timeOnly && !glance.box) {
      // The calm glance (DK-101): the runtime sent it, so this page draws it instead of the glance it knew.
      welcomeShown.current = calm.digest && calm.digest.id !== welcomeSeen ? calm.digest.id : null;
      const looks = glance.needsYou.looks ?? [];
      const stripList = calm.strip.flatMap((s) =>
        s.id
          ? [
              {
                id: s.id,
                name: s.name,
                mark: s.mark,
                state: s.state,
                note: s.say ?? '',
                cpu: null,
                memory: null,
                temp: null,
              },
            ]
          : [],
      );
      body = (
        <CalmGlance
          paired={paired}
          calm={calm}
          glance={glance}
          name={desk.name ?? burrow ?? ''}
          power={desk.power}
          now={serverNow}
          unlocked={unlocked}
          locksIn={minutes}
          camera={camera}
          present={present}
          looking={looking}
          onLock={lock}
          onTalk={() => openTalk(false)}
          onAsk={props.onAsk}
          onLook={props.onLook}
          onFix={held ? undefined : (look) => fixLook(looks.find((l) => l.key === look.key) ?? look)}
          onStep={held ? undefined : (look) => void fixStep(looks.find((l) => l.key === look.key) ?? look)}
          onIgnore={held ? undefined : (look) => void quietLook(look, 'ignore')}
          stepBusy={sheetBusy || stepWaits}
          onServer={
            held
              ? undefined
              : (id) => {
                  const index = stripList.findIndex((s) => s.id === id);
                  if (index >= 0) setPage({ kind: 'server', list: stripList, index, from: 'glance' });
                }
          }
          onServers={props.onServers}
          appUrl={props.appUrl}
          onFoundDismiss={props.onFoundDismiss}
          welcomeSeen={welcomeSeen}
          onWelcomeSeen={setWelcomeSeen}
        />
      );
    } else body = timeOnly ? <ClockOnly {...props} /> : <Glance {...props} />;
  }

  // The sheets, over the glance, the clock and Talk (DK-60).
  let sheet: ReactNode = null;
  if (paired && !held && sheetScene && overlay) {
    const pad = !unlocked && (
      <PinPad
        person={paired.person}
        hasPin={paired.hasPin}
        length={pinLength(paired)}
        lock={desk.lock}
        now={serverNow}
        client={client}
        refresh={refresh}
        initialDigits={padDigits}
        reason={
          overlay.kind === 'unlock' && overlay.reason
            ? fill(DESK.needsAnswer, { assistant: paired.assistant.name })
            : null
        }
        onCancel={() => {
          setPadDigits('');
          setPopupAt(null);
          setQueue([]);
          // Ignore, Not now or the step's PIN (CG-333, CG-376): back to the look's card.
          setOverlay(overlay.kind === 'look' ? { kind: 'look', key: overlay.key } : null);
          pendingFix.current = null;
        }}
      />
    );
    const ask = overlay.kind === 'ask' ? sheetAsk.current : null;
    if (overlay.kind === 'ask' && ask) {
      // The wider choice the approve pad is for (TF-14): one the ask still offers, else none and no pad.
      const choice =
        approvePin?.scope != null ? (ask.choices ?? []).find((c) => c.scope === approvePin.scope) : undefined;
      const pinPad =
        unlocked &&
        approvePin?.number === ask.number &&
        !!liveAsk &&
        (approvePin.scope === null || choice !== undefined);
      sheet = (
        <>
          <Scrim onClose={() => closeAsk(ask.number)} glow />
          <SheetGrid one={unlocked && !pinPad}>
            <AskCard
              ask={ask}
              gone={!liveAsk}
              assistant={paired.assistant}
              now={serverNow}
              locked={!unlocked}
              voice={paired.voice}
              busy={sheetBusy}
              note={sheetNote}
              place={queuePlace(queue, ask.number)}
              onDecide={(d) => void decide(ask.number, d)}
              onApproveWithPin={() => {
                setSheetNote(null);
                setApprovePin({ number: ask.number, scope: null });
              }}
              onChoose={(c) => {
                setSheetNote(null);
                setApprovePin({ number: ask.number, scope: c.scope });
              }}
              onTalk={() => {
                closeAsk(ask.number);
                // Back to the conversation it was asked in, else a new one (DK-64).
                openTalk(ask.inTalk !== true);
              }}
              onClose={() => closeAsk(ask.number)}
            />
            {pad}
            {pinPad && (
              <ApprovePad
                // A new pad for another choice: its digits start over.
                key={choice?.scope ?? 'once'}
                length={pinLength(paired)}
                now={serverNow}
                title={choice && fill(DESK_WORDS.choiceWithPin, { choice: choice.label })}
                onPin={async (pin) => {
                  const a = await postDecision(ask.number, 'approve', { pin, scope: choice?.scope });
                  if (a.result === 'backoff') refresh();
                  return a;
                }}
                onResult={(a) => decided(ask.number, a)}
                onCancel={() => setApprovePin(null)}
              />
            )}
          </SheetGrid>
        </>
      );
    } else if (overlay.kind === 'look' && sheetLook.current) {
      const look = sheetLook.current;
      const server = look.server;
      // Its screen, from the glance's servers (DK-83): the card's, else the look's own id.
      const list = [...(glance?.servers ?? []), ...(glance?.extraServers ?? [])].filter((x) => x.id);
      const at = list.findIndex((x) => x.id === server);
      const done = lookDone?.key === look.key ? lookDone.how : null;
      // Ignore, Not now or the step on a locked screen (CG-333, CG-376): the PIN pad beside the card while the look is
      // still there.
      const pending = pad && overlay.pin && liveLook && !done ? overlay.pin : null;
      const withPad = pending !== null;
      sheet = (
        <>
          <Scrim onClose={() => setOverlay(null)} glow={false} />
          <SheetGrid one={!withPad}>
            <LookCard
              look={look}
              gone={!liveLook}
              assistant={paired.assistant}
              busy={sheetBusy || (stepWaits && stepSent === look.key)}
              note={sheetNote}
              done={done}
              pending={pending}
              onFix={() => {
                setOverlay(null);
                fixLook(look);
              }}
              onStep={() => void fixStep(look)}
              onQuiet={(how) => void quietLook(look, how)}
              onOpen={
                server && at >= 0
                  ? () => {
                      setOverlay(null);
                      setPage({ kind: 'server', list, index: at, from: 'glance' });
                    }
                  : undefined
              }
              onClose={() => setOverlay(null)}
            />
            {withPad && pad}
          </SheetGrid>
        </>
      );
    } else if (overlay.kind === 'unlock' && pad) {
      sheet = (
        <>
          <Scrim onClose={() => setOverlay(null)} glow={att.glow} />
          <SheetGrid one>{pad}</SheetGrid>
        </>
      );
    }
  }

  return (
    <div className={styles.desk} data-scene={scene} ref={root}>
      <div
        className={styles.drift}
        // Behind a sheet the glance is only a picture: no focus, no clicks, not read out.
        inert={sheet !== null}
        data-overflow-ok={drift ? true : undefined}
        style={drift ? { transform: `translate(${drift.x}px, ${drift.y}px)` } : undefined}
      >
        {body}
      </div>
      {sheet}
      {att.glow && !sheet && !modalPops && <div className={styles.glow} />}
      {monitorsHost &&
        placed.length > 1 &&
        createPortal(
          <MonitorScreens
            monitors={placed.slice(1)}
            grids={glance?.outputs ?? []}
            mode={monitorMode(scene, held)}
            calm={glance?.calm ?? null}
            name={desk.name ?? burrow ?? ''}
            assistant={paired?.assistant.name ?? ''}
            face={paired?.assistant.face ?? null}
            now={serverNow}
            timeZone={paired?.timeZone ?? 'UTC'}
            unlocked={unlocked}
            onlyTime={!unlocked && paired?.lockedView === 'time'}
            loadImage={loadImage}
          />,
          monitorsHost,
        )}
    </div>
  );
}

/**
 * How the monitors show beside the box's own display: dark while it is (the night, black, pairing), dimmed while
 * nobody is there, else their screens. Whombat away changes nothing: they keep what they showed.
 */
function monitorMode(scene: string, held: boolean): MonitorMode {
  if (held) return 'screen';
  if (scene === 'night' || scene === 'black' || scene === 'pairing') return 'dark';
  return scene === 'idle' ? 'dim' : 'screen';
}

/**
 * Every server the screen of widgets names, for a server's screen to swipe through: the strip's, then the server
 * widgets' that aren't in it.
 */
function gridServers(grid: DeskGrid, calm: DeskCalm | null): DeskServer[] {
  const out: DeskServer[] = [];
  for (const s of calm?.strip ?? [])
    if (s.id)
      out.push({
        id: s.id,
        name: s.name,
        mark: s.mark,
        state: s.state,
        note: s.say ?? '',
        cpu: null,
        memory: null,
        temp: null,
      });
  for (const v of grid.views)
    if (v.kind === 'server' && !out.some((s) => s.id === v.server))
      out.push({
        id: v.server,
        name: v.title,
        mark: v.mark ?? null,
        state: v.state,
        note: v.say ?? '',
        cpu: null,
        memory: null,
        temp: null,
      });
  return out;
}
