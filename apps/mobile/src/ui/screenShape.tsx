/**
 * The window's shape for every screen (docs/app/decisions/iphone-duo.md; the rules are `data/screenShape.ts`): the
 * window's size, its safe area and what `modules/whombat-fold` reports (the system's vertical bar, the fold, the clock,
 * the hinge), read again on every fold, turn and Split View change.
 *
 * `AppFrame` keeps the app clear of the system's vertical bar (the Duo's clock down the right edge) until the
 * navigator draws its own side bar there (`useSideBarHere`), so the screens before the tabs — signing in, choosing a
 * Whombat — don't put buttons under the clock. Its children get their own safe area, measured inside the frame.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { I18nManager, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { currentFold, type FoldInfo, onFoldChange } from '../../modules/whombat-fold';
import {
  type PageSide,
  PHONE_SHAPE,
  pageFrame,
  type ScreenShape,
  type Side,
  sameShape,
  screenShape,
} from '../data/screenShape';
import { useTheme } from '../theme/theme';

const ShapeContext = createContext<ScreenShape>(PHONE_SHAPE);

/** Says that the side bar is drawn on the system's edge now; returns the undo. */
const SideBarHereContext = createContext<() => () => void>(() => () => {});

/** The window's shape: where the tabs go, one page or two, where they meet. */
export function useScreenShape(): ScreenShape {
  return useContext(ShapeContext);
}

/** While `here`, the navigator draws its side bar on the system's edge, so the frame stops keeping clear of it. */
export function useSideBarHere(here: boolean): void {
  const claim = useContext(SideBarHereContext);
  useLayoutEffect(() => (here ? claim() : undefined), [here, claim]);
}

/**
 * Where the line between the two pages is now, from the content's left edge (null: no two pages drawn). Kept outside
 * React so what floats over the pages (the toast, a sheet) can sit on one of them without the pages drawing again.
 */
let listWidthNow: number | null = null;
const listWidthListeners = new Set<() => void>();

export const pageLine = {
  set(width: number | null) {
    if (width === listWidthNow) return;
    listWidthNow = width;
    for (const listener of listWidthListeners) listener();
  },
  get: () => listWidthNow,
  subscribe(listener: () => void) {
    listWidthListeners.add(listener);
    return () => listWidthListeners.delete(listener);
  },
};

/** The list's width now: where the person left the line, else the shape's own. */
export function useListWidth(): number {
  const shape = useScreenShape();
  const now = useSyncExternalStore(pageLine.subscribe, pageLine.get, pageLine.get);
  return shape.pages === 2 && now !== null ? now : shape.listWidth;
}

/** Which of the two pages this is drawn on (the split stack sets it); `only` with one page. */
export const PageSideContext = createContext<PageSide>('only');

/** The left and right edges, in the window, of the page this is drawn on (or of `side`). */
export function usePageFrame(side?: PageSide): { left: number; right: number } {
  const shape = useScreenShape();
  const listWidth = useListWidth();
  const here = useContext(PageSideContext);
  return pageFrame(shape, listWidth, side ?? here);
}

function useFoldInfo(): FoldInfo | null {
  const [info, setInfo] = useState<FoldInfo | null>(currentFold);
  useEffect(() => {
    setInfo(currentFold());
    return onFoldChange(setInfo);
  }, []);
  return info;
}

function sideOf(edge: FoldInfo['barEdge'] | undefined): Side | null {
  if (!edge) return null;
  const leading: Side = I18nManager.isRTL ? 'right' : 'left';
  return edge === 'leading' ? leading : leading === 'left' ? 'right' : 'left';
}

export function AppFrame({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const fold = useFoldInfo();
  // A report that changes nothing the layout uses (the app coming to the front, the hinge moving) keeps the same
  // shape, so the screens don't draw again.
  const kept = useRef<ScreenShape | null>(null);
  const shape = useMemo(() => {
    const next = screenShape({
      width: window.width,
      height: window.height,
      insets: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left },
      barSide: sideOf(fold?.barEdge),
      folds: fold?.folds ?? [],
      occlusions: fold?.occlusions ?? [],
    });
    if (kept.current && sameShape(kept.current, next)) return kept.current;
    kept.current = next;
    return next;
  }, [window.width, window.height, insets.top, insets.right, insets.bottom, insets.left, fold]);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const keepClear = claims === 0 ? shape.reserve : null;
  return (
    <ShapeContext.Provider value={shape}>
      <SideBarHereContext.Provider value={claim}>
        <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.bg }}>
          {keepClear?.side === 'left' ? <View style={{ width: keepClear.width }} /> : null}
          <SafeAreaProvider style={{ flex: 1 }}>{children}</SafeAreaProvider>
          {keepClear?.side === 'right' ? <View style={{ width: keepClear.width }} /> : null}
        </View>
      </SideBarHereContext.Provider>
    </ShapeContext.Provider>
  );
}
