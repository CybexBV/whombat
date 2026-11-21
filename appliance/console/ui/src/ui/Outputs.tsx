import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import type { PlacedOutput } from '../lib/outputs';
import styles from './app.module.css';
import { ViewportContext } from './hooks';

/**
 * The box's outputs as the page draws them (lib/outputs.ts): every output with its rectangle in the window, the main
 * one first, and the element the monitors' screens are drawn into (null with one output).
 */
export interface Outputs {
  placed: PlacedOutput[];
  host: HTMLElement | null;
}

const OutputsContext = createContext<Outputs>({ placed: [], host: null });
export const useOutputs = () => useContext(OutputsContext);

/**
 * The window, split per output when a monitor shares it with the box's own display: the page as it was in the main
 * output's rectangle (laid out for that rectangle, and holding everything it draws inside it), and a layer over the
 * rest for the monitors' screens, which the desk draws there (a portal). With one output, the page fills the window.
 */
export function OutputsFrame({ placed, children }: { placed: PlacedOutput[]; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const main = placed[0];
  const split = placed.length > 1 && main !== undefined;
  const value = useMemo(() => ({ placed, host: split ? host : null }), [placed, host, split]);
  const viewport = useMemo(() => (main ? { width: main.width, height: main.height } : null), [main]);
  if (!split || !main) return <OutputsContext.Provider value={value}>{children}</OutputsContext.Provider>;
  return (
    <OutputsContext.Provider value={value}>
      <div className={styles.outputs}>
        <div
          className={styles.output}
          style={{ left: main.left, top: main.top, width: main.width, height: main.height }}
          data-output={main.key}
        >
          <ViewportContext.Provider value={viewport}>{children}</ViewportContext.Provider>
        </div>
        <div ref={setHost} className={styles.monitors} />
      </div>
    </OutputsContext.Provider>
  );
}
