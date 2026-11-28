/**
 * A place's list (servers-connections-places.md): Chat's list shape for Servers or Connections —
 * the heading, the line of what it holds, the `+` that adds one, then a row each: the logo, the name (a server's in the
 * row's sans face as the mock draws it), a server's processor at the end, and under the name how it is, with its status mark when it isn't fine.
 * A row is a link to its page (read while the pointer rests on it, page-speed.md); right-click offers Open and
 * Rename, F2 renames the row in focus (server-names.md). Under Servers' rows, the place's own rows side by side, Open
 * to the internet (internet-exposure.md) and What's protected (backup-trust.md), then a server that ran the install
 * command and waits to be added, with Review (Add a server's waiting list).
 */
import { BrandMark } from '@whombat/brand/react';
import {
  EXPOSURE_PATH,
  exposureText,
  type PlaceRow,
  placeSummaryParts,
  placeWords,
  type ThingPlace,
  thingRenameTarget,
} from '@whombat/client';
import { useProtectedSupported, useSessionProtocol } from '@whombat/client/react';
import { protectedPageWords } from '@whombat/core';
import { EXPOSURE_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { Globe, Plus, ShieldCheck } from 'lucide-react';
import { Fragment, type KeyboardEvent, type MouseEvent } from 'react';
import { useNavigateHref } from '../../../app/routing/navigation';
import { useRowMenu } from '../../../app/shell/ContextMenu';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { InlineRename } from '../../../components/InlineRename';
import { ErrorNote } from '../../../components/ListState';
import { StatusMark } from '../../../components/StatusMark';
import { useWebI18n } from '../../../i18n/provider';
import { AppLink } from '../../files/AppLink';
import { useThingLinkProps } from '../prefetch';
import { THING_ICONS } from '../thingIcons';
import styles from './Places.module.css';
import { type ThingRenaming, useThingRename } from './useThingRename';

export interface PlaceListProps {
  burrow: string;
  place: ThingPlace;
  rows: readonly PlaceRow[];
  /** The page open beside the list (its thing id, or `EXPOSURE_PATH` for Open to the internet), or null. */
  selected: string | null;
  /** Where the `+` goes; null where it can't add (no hosts service, a guest). */
  addHref: string | null;
  /** The list is the screen (a narrow window, nothing picked): its heading is the page's. */
  alone: boolean;
  /** The rows aren't final yet: no “No servers yet.” before it is known. */
  loading?: boolean;
  /** Nothing could be read and nothing is listed: what went wrong and Retry, which reads again. */
  failure?: { message: string; onRetry: () => void } | null;
  /** Servers waiting to be added (only Servers has them); Review goes to `addHref`. */
  pending?: number;
}

/** The tones a row's line and the place's line take (a problem in red, a look in amber). */
const TONE_CLASS = { bad: styles.toneBad, warn: styles.toneWarn } as const;

export function PlaceList({
  burrow,
  place,
  rows,
  selected,
  addHref,
  alone,
  loading = false,
  failure,
  pending = 0,
}: PlaceListProps) {
  const i18n = useWebI18n();
  const words = placeWords(i18n.tag)[place];
  const summary = placeSummaryParts(place, rows, i18n.tag);
  const linkProps = useThingLinkProps(burrow);
  const menu = useRowMenu();
  const navigate = useNavigateHref();
  const rename = useThingRename(burrow);
  const Heading = alone ? 'h1' : 'h2';
  const headId = `place-${place}-title`;
  // The place's own rows under Servers' rows: the first of them is set apart by a rule.
  const protocol = useSessionProtocol();
  const protectedSupported = useProtectedSupported();
  const internet = place === 'servers' && protocolAtLeast(protocol, EXPOSURE_MINOR);
  const protectedShown = protectedSupported && place === 'servers' && rows.length > 0;
  return (
    <div className={styles.list} data-place={place}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <Heading id={headId} className={styles.title}>
            {words.title}
          </Heading>
          {addHref ? (
            <AppLink
              href={addHref}
              className={styles.add}
              aria-label={words.add}
              title={words.add}
              data-add={place === 'servers' ? 'server' : 'connection'}
            >
              <Icon icon={Plus} size={18} />
            </AppLink>
          ) : null}
        </div>
        {summary.length ? (
          <p className={styles.summary}>
            {summary.map((part, i) => (
              // The dot between stays grey; only the count's words take its tone.
              <Fragment key={part.text}>
                {i ? ' · ' : ''}
                <span className={part.tone ? TONE_CLASS[part.tone] : undefined}>{part.text}</span>
              </Fragment>
            ))}
          </p>
        ) : null}
      </div>
      <nav className={styles.rows} aria-labelledby={headId}>
        {rows.length ? (
          rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              selected={row.id === selected}
              linkProps={linkProps(row.href)}
              rename={rename}
              menuOpen={menu.openKey === `row:${row.id}`}
              onMenu={(event) => {
                const target = thingRenameTarget(row);
                menu.open(event, `row:${row.id}`, row.name, [
                  { label: i18n.t('sidebar.open'), onSelect: () => navigate(row.href) },
                  ...(target
                    ? [{ label: i18n.t('sidebar.rename'), onSelect: () => rename.start(row.id) }]
                    : []),
                ]);
              }}
            />
          ))
        ) : loading ? null : failure ? (
          <ErrorNote message={failure.message} onRetry={failure.onRetry} />
        ) : (
          <p className={styles.empty}>{words.empty}</p>
        )}
        {internet ? <InternetRow selected={selected === EXPOSURE_PATH} /> : null}
        {protectedShown ? <ProtectedRow first={!internet} /> : null}
        {pending && addHref ? (
          <div className={styles.waiting} data-server-waiting={pending}>
            <div className={styles.waitingText}>
              <span className={styles.waitingName}>{i18n.tp('servers.waiting', pending)}</span>
              <span className={styles.waitingHint}>{i18n.t('servers.waitingHint')}</span>
            </div>
            <AppLink href={addHref} className={styles.waitingReview}>
              {i18n.t('servers.review')}
            </AppLink>
          </div>
        ) : null}
      </nav>
      {menu.element}
    </div>
  );
}

/**
 * Open to the internet at the end of Servers (Whombat internet-exposure.md): what the internet can reach through the
 * proxies, tunnels and routers Whombat is connected to. Only on a Whombat that can say.
 */
function InternetRow({ selected }: { selected: boolean }) {
  const i18n = useWebI18n();
  const words = exposureText(i18n.tag);
  return (
    <AppLink
      href={EXPOSURE_PATH}
      className={cx(styles.row, styles.extra, selected && styles.on)}
      aria-current={selected ? 'page' : undefined}
      aria-label={`${words.title}, ${words.row}`}
      data-row="internet"
    >
      <span className={styles.logo} aria-hidden="true">
        <Icon icon={Globe} size={20} />
      </span>
      <span className={styles.name}>{words.title}</span>
      <span />
      <span className={styles.line}>
        <span className={styles.lineText}>{words.row}</span>
      </span>
    </AppLink>
  );
}

/**
 * What's protected beside Open to the internet, the same kind of row: what holds data and where its copies are, on a
 * Whombat that has the page. Set apart by the rule when it is the first of the place's own rows.
 */
function ProtectedRow({ first }: { first: boolean }) {
  const i18n = useWebI18n();
  const words = protectedPageWords(i18n.tag);
  return (
    <AppLink
      href="/protected"
      className={cx(styles.row, first && styles.extra)}
      aria-label={`${words.link}, ${words.linkHint}`}
      data-row="protected"
      data-protected-link=""
    >
      <span className={styles.logo} aria-hidden="true">
        <Icon icon={ShieldCheck} size={20} />
      </span>
      <span className={styles.name}>{words.link}</span>
      <span />
      <span className={styles.line}>
        <span className={styles.lineText}>{words.linkHint}</span>
      </span>
    </AppLink>
  );
}

function Row({
  row,
  selected,
  linkProps,
  rename,
  menuOpen,
  onMenu,
}: {
  row: PlaceRow;
  selected: boolean;
  linkProps: ReturnType<ReturnType<typeof useThingLinkProps>>;
  rename: ThingRenaming;
  menuOpen: boolean;
  onMenu: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const i18n = useWebI18n();
  const logo = (
    <span className={styles.logo} aria-hidden="true">
      {row.mark ? <BrandMark mark={row.mark} size={22} /> : <Icon icon={THING_ICONS[row.glyph]} size={20} />}
    </span>
  );
  const target = thingRenameTarget(row);
  if (target && rename.editing === row.id)
    return (
      <div className={cx(styles.row, styles.renaming, row.child && styles.child)} data-row={row.id}>
        {logo}
        <div className={styles.renameBox}>
          <InlineRename
            value={target.name}
            maxLength={target.max}
            label={i18n.t('sidebar.renameThing', { name: row.name })}
            hint={target.kind === 'server' ? i18n.t('sidebar.renameServerHint') : undefined}
            onSave={(typed) => rename.save(target, typed)}
            onClose={rename.stop}
          />
        </div>
      </div>
    );
  const shown = rename.shown(row);
  return (
    <AppLink
      href={row.href}
      {...linkProps}
      className={cx(
        styles.row,
        row.child && styles.child,
        selected && styles.on,
        menuOpen && styles.menuOpen,
        row.tone === 'bad' || row.tone === 'warn' ? TONE_CLASS[row.tone] : null,
      )}
      aria-current={selected ? 'page' : undefined}
      aria-label={
        shown
          ? [shown, row.line, row.figure ? `processor ${row.figure}` : null].filter(Boolean).join(', ')
          : row.label
      }
      data-row={row.id}
      onContextMenu={onMenu}
      onKeyDown={
        target
          ? (event: KeyboardEvent<HTMLAnchorElement>) => {
              if (event.key === 'F2') {
                event.preventDefault();
                rename.start(row.id);
              }
            }
          : undefined
      }
    >
      {logo}
      <span className={styles.name}>
        {shown ?? row.main}
        {shown === null && row.note ? <span className={styles.note}> {row.note}</span> : null}
      </span>
      {row.figure ? <span className={styles.figure}>{row.figure}</span> : <span />}
      <span className={styles.line}>
        <StatusMark level={row.level} />
        <span className={styles.lineText}>{row.line}</span>
      </span>
    </AppLink>
  );
}
