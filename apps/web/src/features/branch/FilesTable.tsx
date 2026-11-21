import type { FileChange } from '@whombat/core';
import type { MouseEvent, ReactNode } from 'react';
import { cx } from '../../components/cx';
import { EmptyNote } from '../../components/ListState';
import styles from './FilesTable.module.css';
import { fileRows } from './model';

export interface FilesTableProps {
  files: readonly FileChange[];
  /** "Every patch here is a signed event from Banjo’s key. Open any file to comment on a line." */
  note?: string;
  /** A file's view (AP-664); without it (a runtime without `prs.file`) the rows don't open. */
  fileHref?: (path: string) => string;
  onNavigate?: (href: string) => void;
}

/** Files changed: [path · +add · −del · mini bar] rows, each opening the file's view, then the signing note. */
export function FilesTable({ files, note, fileHref, onNavigate }: FilesTableProps) {
  const rows = fileRows(files);
  const row = (path: string, cells: ReactNode) => {
    if (!fileHref) return <div className={styles.row}>{cells}</div>;
    const href = fileHref(path);
    const follow = (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        !onNavigate ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      onNavigate(href);
    };
    return (
      <a href={href} className={cx(styles.row, styles.link)} onClick={follow}>
        {cells}
      </a>
    );
  };
  if (rows.length === 0) return <EmptyNote className={styles.files}>No files changed.</EmptyNote>;
  return (
    <div className={styles.files}>
      <ul className={styles.table} aria-label="Files changed">
        {rows.map((f) => (
          <li key={f.path} className={styles.item}>
            {row(
              f.path,
              <>
                <span className={styles.path} title={f.path}>
                  {f.path}
                </span>
                <span className={styles.add}>{f.add}</span>
                <span className={styles.del}>{f.del}</span>
                <span className={styles.bar} role="img" aria-label={f.summary}>
                  <span className={styles.barAdd} style={{ width: `${f.addWidth}%` }} />
                  <span className={styles.barDel} style={{ width: `${f.delWidth}%` }} />
                </span>
              </>,
            )}
          </li>
        ))}
      </ul>
      {note && <span className={styles.note}>{note}</span>}
    </div>
  );
}
