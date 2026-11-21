import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useViewport } from './hooks';

/**
 * Every claim and installer screen is laid out for 1024×768 (CG-15, the usual OVMF/noVNC size), the desk's for
 * 1280×800 (CG-38: the Z13's 2560×1600 at 200 %), and zoomed to fill the screen: the stage scales by
 * `min(width / base width, height / base height)`, so the shorter side maps to the base and the other grows with
 * the aspect ratio (1920×1080 → 1365×768 for the claim screens, 1422×800 for the desk).
 */
export const BASE_WIDTH = 1024;
export const BASE_HEIGHT = 768;

export interface StageBase {
  width: number;
  height: number;
}

export const CLAIM_STAGE: StageBase = { width: BASE_WIDTH, height: BASE_HEIGHT };

export function stageScale(width: number, height: number, base: StageBase = CLAIM_STAGE): number {
  return Math.min(width / base.width, height / base.height);
}

const ScaleContext = createContext(1);
const SizeContext = createContext<StageBase>(CLAIM_STAGE);

/** The zoom factor of the stage (for pixel snapping). */
export const useScale = () => useContext(ScaleContext);
/** The stage's own size in layout px (the desk's 1280×800 on the Z13, 1422×800 on a 1920×1080 display). */
export const useStageSize = () => useContext(SizeContext);

export function Stage({ children, base = CLAIM_STAGE }: { children: ReactNode; base?: StageBase }) {
  const { width, height } = useViewport();
  const scale = stageScale(width, height, base);
  const size = useMemo(() => ({ width: width / scale, height: height / scale }), [width, height, scale]);
  return (
    <ScaleContext.Provider value={scale}>
      <SizeContext.Provider value={size}>
        <div className="stage" style={{ ...size, zoom: scale }} data-scale={scale.toFixed(3)}>
          {children}
        </div>
      </SizeContext.Provider>
    </ScaleContext.Provider>
  );
}
