/**
 * Settings → Screens' words and lines (3.6; Whombat desk-display.md DK-128…DK-147), shared by the web and the phone:
 * a screen's lines in the list (what it is, its grid, its pages; what pops up and how it locks), the editor's words,
 * and the refusals in plain words. The contract's own (`DESK_SCREEN_WORDS`) are used where it has them.
 */
import { screenGrid } from '@whombat/screen';
import { ARRANGE_WORDS } from '../home/arrange';
import { OperationError } from '../session/managed-ops';
import {
  DESK_SCREEN_WORDS,
  DESK_WORDS,
  type DeskLockAgain,
  type DeskLockedView,
  type DeskScreenDetail,
  type DeskScreenSummary,
  type DeskWidgetType,
  fillDeskWords,
} from './contract';
import type { EditorRefusal, SizePresetKey } from './editor';
import { deskErrorCode } from './model';

/** The words of Settings → Screens and the editor, beyond the contract's. */
export const DESK_SCREENS_TEXT = {
  tab: 'Screens',
  title: 'Screens',
  intro: 'Where Whombat shows itself. Each screen has its own pages, and its own say in what pops up.',
  add: '+ Add a screen',
  editLayout: 'Edit layout',
  open: 'Settings',
  back: 'Screens',
  builtIn: 'Built in',
  boxScreen: 'A screen on this Whombat',
  output: 'Plugged into this Whombat',
  device: 'A screen elsewhere',
  grid: '{cols} × {rows}',
  pages: { one: '1 page', many: '{n} pages' },
  turning: { '30s': 'turning every 30 s', '60s': 'turning every minute' },
  popups: {
    all: 'Pops up for questions and problems',
    problems: 'Pops up for problems only',
    none: 'Doesn’t pop up',
  },
  locks: {
    idle: 'locks after 2 minutes',
    away: 'locks when you leave',
    never: 'locks when you press Lock',
  },
  lockedViews: {
    time: 'shows only the time while locked',
    summary: 'shows nothing private while locked',
    everything: 'shows everything while locked',
  },
  offline: 'Not showing now',
  lastSeen: 'Not showing now · last seen {when}',
  notSeen: 'Hasn’t shown anything yet',
  thumbnail: 'What {name} shows now',
  /** *Add a screen* (the mockups' `f-add`). */
  addDialog: {
    title: 'Add a screen',
    intro1: 'On the tablet, or the computer by the monitor, open Whombat and choose ',
    useAsScreen: 'Use as a screen',
    intro2: '. Type the six letters it shows.',
    letters: 'The six letters',
    name: 'What do you call it?',
    namePlaceholder: 'Kitchen tablet',
    popups: 'What pops up on it',
    popupsHint: 'Questions from {assistant} can be private; a kitchen is for everyone.',
    start: 'Start with',
    copy: 'A copy of this Whombat’s screen',
    empty: 'An empty page',
    cancel: 'Cancel',
    submit: 'Add screen',
    adding: 'Adding…',
    added: '{name} is a screen now.',
    needLetters: 'Type the six letters the screen shows.',
    needName: 'Give it a name.',
  },
  /** A screen's own page. */
  page: {
    name: 'Name',
    nameHint: 'How it shows in this list.',
    layout: 'Layout',
    layoutLine: '{pages} · {grid}',
    popups: 'What pops up',
    popupsHint: {
      all: 'Problems and {assistant}’s questions open over the screen.',
      problems: 'Only something that’s down opens over the screen; questions stay in the pill.',
      none: 'Nothing opens over the screen; the pill still says when something needs you.',
    },
    remove: 'Remove',
    removeLine: 'It stops being a screen at once and shows Use as a screen again.',
    removeOutput: 'Forget this monitor’s layout. It starts with the default when it’s plugged in again.',
    removeTitle: 'Remove {name}?',
    removeConfirm: 'Remove',
    removed: '{name} isn’t a screen any more.',
    forgotten: 'The monitor’s layout is forgotten.',
    doorbell: 'When the doorbell rings',
    doorbellHint: {
      big: 'Its camera opens big on this screen for a minute, then the screen goes back.',
      off: 'This screen stays as it is when someone rings.',
    },
    saved: 'Saved.',
    boxName: 'It has the Whombat’s name on its top bar.',
  },
  /** The editor (the mockups' `editor.html`). */
  editor: {
    undo: 'Undo',
    try: 'Try on the screen',
    trying: 'On the screen for a minute.',
    save: 'Save',
    saving: 'Saving…',
    dirty: 'Not saved yet',
    saved: 'Saved. The screen shows it within a few seconds.',
    undone: 'Undone.',
    addPage: '+ Page',
    pageMenu: 'Page {name}',
    rename: 'Rename',
    renameTitle: 'Rename the page',
    renameLabel: 'Page name',
    moveLeft: 'Move left',
    moveRight: 'Move right',
    deletePage: 'Delete page',
    deletedPage: '{name} deleted. Undo brings it back.',
    showAt: 'Show at set times…',
    times: {
      title: 'Show this page at set times',
      line: 'Outside these times it’s left out. When its time starts, the screen goes to it.',
      from: 'From',
      to: 'To',
      on: 'On',
      zone: 'In your time zone, {zone}. The same time twice is the whole day.',
      always: 'Always',
      save: 'Show at these times',
      noDays: 'Choose at least one day.',
      set: '{name} shows {when}.',
      cleared: '{name} shows all the time again.',
      allDay: 'All day',
      label: 'Shows {when}',
    },
    askPage: 'Ask {assistant}',
    askPageDraft: 'Make a page on the {screen} screen that shows ',
    askPageField: 'What should the page show?',
    newPage: 'A new page. Drag widgets onto it.',
    size: 'Size',
    turn: 'Pages turn',
    sizeChanged: 'Rearranged for {grid}.',
    sizeChangedLeft: 'Rearranged for {grid}. {n} didn’t fit and wait in Add a widget.',
    sizeOwn: 'Your {grid} layout.',
    turnTouch: 'Pages turn when someone swipes or touches a page’s name.',
    turnAuto: 'Pages turn by themselves {every}, and wait while someone touches the screen.',
    every: { '30s': 'every 30 seconds', '60s': 'every minute' },
    rearranged: 'Rearranged for {grid}.',
    rearrangedRest: ' Your {from} layout stays as it was. Change anything here and this one is kept too.',
    hint1: 'Drag a widget to move it, drag its corner to make it bigger or smaller, and drag one in from ',
    hintAdd: 'Add a widget',
    hint2: '. A chosen widget moves with',
    hint3: ', resizes with',
    hint4: 'and the arrows, and goes with',
    hintSwap: 'Moved onto one other widget, the two change places.',
    hintTidy: ' moves every widget up and to the left, each keeping its size.',
    keys: 'Keys',
    tidy: 'Tidy up',
    tidied: 'Tidied up.',
    alreadyTidy: 'Already tidy.',
    swapped: 'Swapped {a} and {b}.',
    empty: 'An empty page.',
    emptyHint: 'Drag widgets here, or press + on one.',
    addWidget: 'Add a widget',
    connections: 'Connections',
    search: 'Search widgets',
    noMatch: 'No widget called “{q}” yet.',
    onThisPage: 'On this page',
    didntFit: 'Didn’t fit after rearranging',
    ask: 'Missing something? Ask {assistant}, for example “put my solar panels on the screen”, and it makes a widget from that connection.',
    peekReading: 'Reading what it shows…',
    addOne: 'Add {name}',
    added: '{name} added.',
    addedSmaller: '{name} added, a bit smaller so it fits.',
    removed: '{name} removed. Undo brings it back.',
    backToAdd: 'Add a widget',
    remove: 'Remove from this page',
    removeOne: 'Remove {name}',
    resize: 'Make {name} bigger or smaller',
    sizeLabel: 'Size',
    wide: 'Wide',
    high: 'High',
    narrower: 'Narrower',
    wider: 'Wider',
    lower: 'Lower',
    higher: 'Higher',
    sizes: 'From {min} to {max}. It shows more as it grows.',
    shows: ARRANGE_WORDS.shows,
    reading: ARRANGE_WORDS.reading,
    couldntRead: ARRANGE_WORDS.couldntRead,
    shapes: {
      small: ARRANGE_WORDS.sizes.s,
      normal: DESK_SCREEN_WORDS.sizes.normal,
      wide: ARRANGE_WORDS.sizes.w,
      tall: 'Tall',
      large: ARRANGE_WORDS.sizes.l,
    } satisfies Record<SizePresetKey, string>,
    shape: '{name}, {size}',
    touch: 'Touching it on the screen',
    touchServer: 'Opens {name}’s page, full screen.',
    touchBig: 'Opens it big, with Back.',
    touchOwn: 'Opens what it did before: the list behind it.',
    server: 'Server',
    chart: 'Chart',
    ranges: { '1h': '1 h', '24h': '24 h', '7d': '7 d' },
    thing: 'Connection',
    account: 'Account',
    limits: 'Limits',
    limitsChoices: { used: 'Used', left: 'Left' },
    limitsHint: 'Used fills up as a subscription is used; left empties.',
    lock: 'On a locked screen',
    locks: { show: 'Show it', hide: 'Hide it' },
    lockHint: 'What it shows can be private. Hidden, a locked screen says “Unlock to see it”.',
    nowChoices: 'What may show here',
    nowHint: 'Up to three things happening now, from these.',
    stripOrder: 'Order',
    stripHint: 'The servers in this order; the rest after them.',
    server_: 'Server',
    leaveTitle: 'Leave without saving?',
    leaveLine: 'The changes you made here are not on the screen yet.',
    leave: 'Leave',
    stay: 'Keep editing',
    preview: 'Preview of {name}',
    widgetLabel: '{name}, {w} by {h}, column {x}, row {y}',
    chosen: '{name} chosen. Arrows move it, Shift and the arrows resize it, Delete removes it.',
    refused: {
      taken: 'That spot is taken. Drop it on an empty spot, or move the other one first.',
      noRoom: 'No room to make it that big there.',
      grow: 'No room to grow that way. Move it, or make room first.',
      tooSmall: 'It doesn’t get smaller than {size}.',
      tooBig: 'It doesn’t get bigger than {size}.',
      drop: 'No room there. Drop it on an empty spot, or make something smaller first.',
      full: 'No room on this page. Make a widget smaller, or add a page.',
      pagesFull: 'A screen has at most 6 pages.',
      lastPage: 'A screen keeps at least one page.',
      tidy: 'They don’t all fit packed together, so nothing moved.',
    },
  },
} as const;

const T = DESK_SCREENS_TEXT;

/** “8 × 5”. */
export const gridText = (cols: number, rows: number) => fillDeskWords(T.grid, { cols, rows });
/** “3 pages”, “1 page”. */
export const pagesText = (n: number) => (n === 1 ? T.pages.one : fillDeskWords(T.pages.many, { n }));

/** What a screen is, in a few words: “Built in”, “DELL U2720Q”, “Plugged into this Whombat”, “iPad · Safari”. */
export function screenWhat(
  screen: Pick<DeskScreenSummary, 'kind' | 'device'>,
  box?: { builtIn: boolean; name: string | null } | null,
): string {
  if (screen.kind === 'box') return box?.builtIn ? T.builtIn : (box?.name ?? T.boxScreen);
  if (screen.kind === 'output') return T.output;
  return screen.device ?? T.device;
}

/** The screen's grid as it last said its size (else the default 1280 × 800), at its layout's Size. */
export function screenShape(screen: Pick<DeskScreenDetail, 'size' | 'layout'>): {
  cols: number;
  rows: number;
} {
  const size = screen.size ?? { width: 1280, height: 800 };
  const g = screenGrid(size.width, size.height, screen.layout.size);
  return { cols: g.cols, rows: g.rows };
}

/**
 * A screen's lines in the list (the mockups' `f-screens`): “Built in · 8 × 5 · 3 pages” (“, turning every 30 s”),
 * “Pops up for questions and problems · locks after 2 minutes” (the box's own by its *Lock again*, a screen elsewhere
 * by what a locked screen shows), and for one that isn't showing, since when.
 */
export function screenLines(
  screen: DeskScreenDetail,
  context: {
    box?: { builtIn: boolean; name: string | null } | null;
    lockAgain?: DeskLockAgain | null;
    lockedView?: DeskLockedView | null;
    /** “14:02”, “yesterday”: the last seen time in words. */
    when?: (iso: string) => string;
  } = {},
): { what: string; how: string; status: string | null } {
  const { cols, rows } = screenShape(screen);
  const turn = screen.layout.turn === 'touch' ? '' : `, ${T.turning[screen.layout.turn]}`;
  const what = [
    screenWhat(screen, context.box),
    gridText(cols, rows),
    `${pagesText(screen.pages)}${turn}`,
  ].join(' · ');
  const lock =
    screen.kind === 'box'
      ? context.lockAgain
        ? T.locks[context.lockAgain]
        : null
      : context.lockedView
        ? T.lockedViews[context.lockedView]
        : null;
  const how = [T.popups[screen.popups], lock].filter(Boolean).join(' · ');
  let status: string | null = null;
  if (!screen.online && screen.kind !== 'box')
    status = screen.lastSeenAt
      ? fillDeskWords(T.lastSeen, {
          when: context.when ? context.when(screen.lastSeenAt) : screen.lastSeenAt,
        })
      : T.notSeen;
  return { what, how, status };
}

/** A widget's name in the editor's words (its view's title, else its type's name). */
export function ownWidgetName(type: DeskWidgetType, assistant: string): string | null {
  const own = (DESK_SCREEN_WORDS.own as Record<string, { name: string } | undefined>)[type];
  return own ? fillDeskWords(own.name, { assistant }) : null;
}

/** An editor refusal in words; `size` the widget's smallest or largest (“2 × 1”). */
export function refusalText(why: EditorRefusal, size?: { w: number; h: number }, grow = false): string {
  const r = T.editor.refused;
  if (why === 'noRoom') return grow ? r.grow : r.noRoom;
  if (why === 'tooSmall' || why === 'tooBig')
    return fillDeskWords(r[why], { size: size ? gridText(size.w, size.h) : '' });
  return r[why];
}

/** A refusal of a `desk.screen.*` op in words: the desk's code (`unknown_screen`, `bad_layout`, …), else a fallback. */
export function screensErrorText(error: unknown, fallback = 'That didn’t work. Try again.'): string {
  const code = deskErrorCode(error);
  const words = code ? (DESK_SCREEN_ERRORS as Record<string, string | undefined>)[code] : undefined;
  if (words) return words;
  if (error instanceof OperationError && error.code === 'revoked') return T.page.removed;
  return fallback;
}

const DESK_SCREEN_ERRORS: Record<string, string> = {
  not_paired: 'Pair this Whombat’s screen first: its choices are the paired person’s.',
  unknown_screen: DESK_WORDS.errors.unknown_screen,
  screens_full: DESK_WORDS.errors.screens_full,
  bad_layout: DESK_WORDS.errors.bad_layout,
  wrong_code: 'Those letters aren’t on a screen. Check them on the screen and try again.',
  pairing_expired: 'Those letters ran out. Choose Use as a screen again on the screen for new ones.',
};
