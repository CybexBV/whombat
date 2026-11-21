import { useQuery } from '@tanstack/react-query';
import { WhombatLogo } from '@whombat/brand/react';
import { SWITCHER_COPY, showsSwitcher, switcherRows } from '@whombat/client/managed';
import { Check, ChevronDown, LayoutGrid, Plus } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { StatusDot } from '../../components/StatusDot';
import { useManaged } from '../providers';
import styles from './AssistantSidebar.module.css';

/** The directory changes rarely; the menu asks again each time it opens. */
const WHOMBATS_FRESH_MS = 60_000;

/**
 * The burrow at the top of the sidebar (whombat-switcher.md AP-3080…AP-3083). With another Whombat in the organization
 * it is a button with a chevron that opens YOUR WHOMBATS: the open one first and ticked, the others with the list's
 * words, “All Whombats” (the list) and “Claim a Whombat”. Opening one works as the list's Open
 * (AP-64): straight in where this browser is let in, else Set up this device. Alone, or not on a managed Whombat, it
 * is the name as before.
 */
export function WhombatSwitcher({ burrowName }: { burrowName: string }) {
  const managed = useManaged();
  const whombats = managed?.whombats ?? null;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const directory = useQuery({
    queryKey: ['managed', 'whombats', managed?.orgId ?? null],
    queryFn: () => (whombats ? whombats.list() : Promise.resolve([])),
    enabled: whombats !== null,
    staleTime: WHOMBATS_FRESH_MS,
  });
  const rows =
    whombats && managed && directory.data
      ? switcherRows(directory.data, { current: managed.applianceId, known: (d) => whombats.known(d) })
      : [];

  const brand = (
    <>
      <WhombatLogo height={24} className={styles.logo} />
      <span className={styles.burrow}>{burrowName}</span>
    </>
  );
  if (!whombats || !managed || !showsSwitcher(rows)) return <div className={styles.brand}>{brand}</div>;

  const toggle = () => {
    if (!open) void directory.refetch();
    setOpen((v) => !v);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the menu on Esc from inside it
    <div
      className={styles.switcher}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={cx(styles.brand, styles.brandButton, open && styles.brandOpen)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={SWITCHER_COPY.label(burrowName)}
        onClick={toggle}
        data-whombat-switcher=""
      >
        {brand}
        <Icon icon={ChevronDown} size={15} className={styles.brandChevron} />
      </button>
      {open && (
        <div id={menuId} className={styles.whombats}>
          <h2 className={styles.whombatsKicker}>{SWITCHER_COPY.kicker}</h2>
          <ul className={styles.whombatsList} aria-label="Whombats">
            {rows.map((r) => (
              <li key={r.device}>
                <button
                  type="button"
                  className={cx(styles.whombat, r.here && styles.whombatHere)}
                  aria-current={r.here ? 'true' : undefined}
                  data-whombat={r.device}
                  onClick={() => {
                    setOpen(false);
                    if (!r.here) whombats.open(r.appliance);
                  }}
                >
                  {r.setUp ? (
                    <span className={cx(styles.dot, styles.dotNew)} aria-hidden="true" />
                  ) : (
                    <StatusDot tone={r.online ? 'ok' : 'mut'} size={8} label={null} />
                  )}
                  <span className={styles.whombatText}>
                    <b>{r.name}</b>
                    <small>{r.meta}</small>
                  </span>
                  {r.here && <Icon icon={Check} size={15} className={styles.whombatTick} />}
                </button>
              </li>
            ))}
          </ul>
          <hr className={styles.menuDivider} />
          <button
            type="button"
            className={styles.whombatAction}
            onClick={() => {
              setOpen(false);
              managed.switchAppliance();
            }}
          >
            <Icon icon={LayoutGrid} size={15} />
            {SWITCHER_COPY.all}
          </button>
          <button
            type="button"
            className={styles.whombatAction}
            onClick={() => {
              setOpen(false);
              whombats.claim();
            }}
          >
            <Icon icon={Plus} size={15} />
            {SWITCHER_COPY.claim}
          </button>
        </div>
      )}
    </div>
  );
}
