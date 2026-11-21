/** A line of words in parts, some strong or in the mono face (“Avg **14.2 %**”, “Home Assistant **2026.10.2**”). */
import type { ThingLine } from '@whombat/core';
import styles from './Dashboard.module.css';

export function LineParts({ line }: { line: ThingLine }) {
  return (
    <>
      {line.map((p, i) => {
        const key = `${i}${p.text}`;
        if (p.strong) return <b key={key}>{p.text}</b>;
        if (p.mono)
          return (
            <span key={key} className={styles.mono}>
              {p.text}
            </span>
          );
        return <span key={key}>{p.text}</span>;
      })}
    </>
  );
}
