/**
 * The mouse pointer on the box's own screen (CG-410). A pointer at rest covers what the screen says: cage puts it in the
 * middle when it starts, on the Link code's dash, and a VM's tablet leaves it there. So the page shows one only while a
 * mouse really moves and hides it again after `POINTER_REST_MS` without movement; a key or a touch hides it at once.
 * The kiosk's cursor theme is empty (kiosk.nix), so the only pointer anyone sees is the page's own picture
 * (styles.css, `html[data-pointer]`).
 */
export const POINTER_REST_MS = 3000;

export interface PointerAt {
  x: number;
  y: number;
}

/**
 * A mouse that really moved: one at another place than its last event. The first event only says where it is, because
 * a pointer that is already there when Chromium starts sends one without moving. Touch and pen never show a pointer.
 */
export function mouseMoved(last: PointerAt | null, type: string, at: PointerAt): boolean {
  return type === 'mouse' && last !== null && (last.x !== at.x || last.y !== at.y);
}

interface PointerLike {
  pointerType?: string;
  screenX?: number;
  screenY?: number;
}

export interface PointerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: PointerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Follows the pointer for the whole page; `root.dataset.pointer` is `shown` while it moves. Returns the way to stop. */
export function followPointer(
  root: { dataset: DOMStringMap },
  target: EventTarget,
  timers: PointerTimers = realTimers,
): () => void {
  let last: PointerAt | null = null;
  let timer: unknown = null;
  const hide = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    delete root.dataset.pointer;
  };
  const show = () => {
    if (timer !== null) timers.clear(timer);
    root.dataset.pointer = 'shown';
    timer = timers.set(hide, POINTER_REST_MS);
  };
  const onMove = (e: Event) => {
    const p = e as PointerLike;
    const type = p.pointerType ?? '';
    if (type !== 'mouse') {
      hide();
      return;
    }
    const at = { x: p.screenX ?? 0, y: p.screenY ?? 0 };
    if (mouseMoved(last, type, at)) show();
    last = at;
  };
  // A click is the mouse in use: the pointer shows where it clicked. A touch or a key means nobody points.
  const onDown = (e: Event) => ((e as PointerLike).pointerType === 'mouse' ? show() : hide());
  const opts = { capture: true, passive: true } as const;
  target.addEventListener('pointermove', onMove, opts);
  target.addEventListener('pointerdown', onDown, opts);
  target.addEventListener('keydown', hide, opts);
  return () => {
    target.removeEventListener('pointermove', onMove, opts);
    target.removeEventListener('pointerdown', onDown, opts);
    target.removeEventListener('keydown', hide, opts);
    hide();
  };
}
