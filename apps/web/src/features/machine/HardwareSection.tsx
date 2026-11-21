/**
 * Settings → This Whombat → About → HARDWARE (Whombat hardware-support.md HD-01, HD-03, HD-11; hardware-support-web.md
 * AP-3228…AP-3230): where the Whombat offers `host.hardware`, before DIAGNOSTICS — the machine in one row
 * with **Download report** (the client's `hardwareReportText` as `whombat-hardware-YYYY-MM-DD.txt`), the parts that
 * don't work in one line each (“This Wi-Fi card has no driver yet.”), then every part by group (Network · Sound ·
 * Graphics & screens · Storage · Power · Other) in compact rows with their drivers. Read once when About opens.
 */
import {
  HARDWARE_TEXT,
  type HardwareLoader,
  type HostHardware,
  hardwareReportFileName,
  hardwareReportText,
  hardwareSectionView,
} from '@whombat/client';
import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import { saveBlob } from '../../lib/saveBlob';
import styles from '../settings/SettingsScreen.module.css';
import { useWhombatVersions, versionLine } from '../settings/version';
import m from './Machine.module.css';
import { useMachineHere } from './useMachine';

const T = HARDWARE_TEXT;

/** The fold over every part and its driver. */
export const HARDWARE_PARTS_TEXT = { show: 'Show every part', hide: 'Hide the parts' } as const;

type Read = { hardware: HostHardware } | { failed: true } | null;

/** HARDWARE, on a Whombat with a manager; nothing elsewhere. */
export function HardwareSection({ burrow }: { burrow: string }) {
  const here = useMachineHere(burrow);
  if (!here.hardware) return null;
  return <Hardware load={here.hardware} name={here.name} timeZone={here.timeZone} />;
}

function Hardware({ load, name, timeZone }: { load: HardwareLoader; name: string; timeZone: string }) {
  const id = useId();
  const versions = useWhombatVersions();
  const [read, setRead] = useState<Read>(null);
  const [gone, setGone] = useState(false);
  // Every part with its driver is for whoever helps with a problem: folded, and in the report anyway.
  const [parts, setParts] = useState(false);
  const ask = useCallback(() => {
    let live = true;
    setRead(null);
    load().then(
      (r) => {
        if (!live) return;
        if (r.hardware) setRead({ hardware: r.hardware });
        else if (r.reason === 'not_managed') setGone(true);
        else setRead({ failed: true });
      },
      () => live && setRead({ failed: true }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  useEffect(ask, [ask]);
  if (gone) return null;
  const hardware = read && 'hardware' in read ? read.hardware : null;
  const v = hardware ? hardwareSectionView(hardware) : null;
  const download = () => {
    if (!hardware) return;
    const text = hardwareReportText(hardware, { burrow: name, version: versionLine(versions) });
    // A download, never a navigation (AP-16).
    saveBlob(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
      hardwareReportFileName(hardware, timeZone),
    );
  };
  return (
    // The anchor (`#hardware`, NETWORK's See hardware) once the rows are in, so the page is tall enough to scroll to it.
    <section
      className={styles.section}
      aria-labelledby={id}
      id={read === null ? undefined : 'hardware'}
      data-hardware=""
    >
      <SectionLabel as="h2" id={id}>
        {T.section}
      </SectionLabel>
      <div className={styles.card}>
        {read === null ? (
          <SkeletonRows count={3} lines={1} />
        ) : !v ? (
          <div className={cx(styles.row, styles.lastRow)}>
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>{T.unavailable}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={ask}>
              {T.tryAgain}
            </Button>
          </div>
        ) : (
          <>
            <div className={styles.row} data-row="hardware-machine">
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{v.machine}</span>
                <span className={cx(styles.rowMeta, m.machineMeta)}>{v.machineMeta}</span>
              </span>
              <Button variant="secondary" size="sm" onClick={download}>
                {T.download}
              </Button>
            </div>
            {v.problems.map((p) => (
              <div key={p.key} className={styles.row} data-row="hardware-problem">
                <StatusDot tone={p.dot} size={8} label={null} />
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{p.title}</span>
                  <span className={styles.rowMeta}>{p.meta}</span>
                </span>
              </div>
            ))}
            {v.groups.length > 0 ? (
              <div className={styles.row} data-row="hardware-parts">
                <span className={styles.rowMain}>
                  <Button
                    variant="link"
                    size="sm"
                    className={m.partsToggle}
                    aria-expanded={parts}
                    aria-controls={`${id}-parts`}
                    onClick={() => setParts((open) => !open)}
                  >
                    {parts ? HARDWARE_PARTS_TEXT.hide : HARDWARE_PARTS_TEXT.show}
                  </Button>
                </span>
              </div>
            ) : null}
            {parts ? (
              <div id={`${id}-parts`}>
                {v.groups.map((g) => (
                  <div key={g.group} className={m.group}>
                    <div className={m.groupLabel} id={`${id}-${g.group}`}>
                      {g.label.toUpperCase()}
                    </div>
                    <ul className={m.devices} aria-labelledby={`${id}-${g.group}`}>
                      {g.rows.map((row) => (
                        <li key={row.key} className={m.device} data-kind={row.kind}>
                          <span className={m.dotSlot}>
                            {row.dot ? <StatusDot tone={row.dot} size={7} label={null} /> : null}
                          </span>
                          <span className={m.deviceText}>
                            <span className={m.deviceName}>{row.title}</span>
                            {row.meta ? <span className={m.deviceMeta}>{row.meta}</span> : null}
                          </span>
                          {row.driver ? (
                            <span className={cx(m.driver, row.noDriver && m.noDriver)}>{row.driver}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
