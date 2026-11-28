/**
 * Found on your network (Whombat connections-setup.md CS-14, CS-51…CS-53; contracts 0.61.0, CT-314, and 0.63.0, CT-316;
 * app AP-846, AP-871…; connections-redesign.md AP-1161, AP-1162), on a runtime with
 * `connections.discover`: what the last scan found and isn't connected yet — logo, name, version, what it is in a few
 * words (the entry's `tagline`, Whombat desk-found.md DF-08, AP-3802), address — with
 * Connect (the connect page with the address filled in and identified at once), or — for a computer that answers SSH
 * and for Proxmox VE, its Backup Server and Unraid — Add as a server, filled in (Whombat connect-in-chat.md). A service
 * the viewer has connected already, or a server added already, is left out (CS-52). Two views of one scan (`useFoundScan`): the full section at the top of Add a connection
 * (`FoundOnNetwork`), and the overview's one-line strip of chips with “See all” (`FoundStrip`). In the section, with
 * `connections.hide_found` each row has Hide (CS-53: for the whole burrow, kept across scans); the hidden ones are listed
 * after the others, muted and with Unhide, once the footer's “Show 2 hidden” is pressed. Opening either asks for the
 * scan (a recent one is reused, else one starts) and follows it every 1.5 s while it looks (“Looking at 312 of 1 016
 * addresses…”); Scan again starts over, “Look in another network” adds a network. A refusal (not a manager, an older
 * server) hides both. Settings' bordered-row card, the overview's connected rows.
 */
import { createLink, Link } from '@tanstack/react-router';
import { ApiError, InvalidRequestError } from '@whombat/client';
import {
  cidrProblem,
  discoveryPollDelay,
  discoveryProgressText,
  type FoundRow,
  foundEmptyText,
  foundList,
  foundSearch,
  foundServerSearch,
  groupDigits,
  hiddenToggleText,
  hideTroubleText,
  networksText,
} from '@whombat/client/connections';
import { useConnectionWrite } from '@whombat/client/react';
import { api, type ConnectionDiscovery, type DiscoverConnectionsBody } from '@whombat/core/contracts';
import { formatAgo } from '@whombat/core/text';
import { ChevronRight } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button, ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import settings from '../settings/SettingsScreen.module.css';
import k from './Catalog.module.css';
import { ProviderLogo } from './ConnectionsOverview';
import c from './Connectors.module.css';
import { matchesWords } from './catalog';

const RouterButtonLink = createLink(ButtonLink);
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** The card's one-line notes: Settings' empty line. */
const note = `${settings.empty} ${k.foundNote}`;
/** How many found services the overview's strip names before “+2 more” (AP-1161). */
const STRIP_CHIPS = 4;

type AskResult = { ok: true } | { ok: false; invalid: string | null };

/** One scan of the burrow's network, followed while it looks; what the section and the strip read (AP-1161). */
export interface FoundScan {
  burrow: string;
  /** The last answer on screen; null until the first one. */
  scan: ConnectionDiscovery | null;
  /** Not a manager, an older server, the feature off: nothing to show. */
  refused: boolean;
  /** A hiccup, in a sentence. */
  trouble: string | null;
  /** A scan request is on its way. */
  pending: boolean;
  /** Asks for the scan (`{}`: the recent one), a rescan or another network; a network's refusal comes back in words. */
  ask: (body: DiscoverConnectionsBody) => Promise<AskResult>;
  /** Starts a request that answers with the scan (a hide): its number in the shared count. */
  begin: () => number;
  /** Puts that request's answer on screen unless a newer one is there already; whether it did. */
  accept: (mine: number, data: ConnectionDiscovery) => boolean;
}

/**
 * The scan behind Found on your network: asked for on opening (a recent one is reused), then every 1.5 s while it
 * looks. Null burrow: nothing is asked (the viewer can't scan). Scans, polls and hides share one count: `latest` is the
 * newest request, `shown` the one whose answer is on screen. An answer older than the one shown is dropped, so a poll
 * that was on its way can't undo a hide (AP-873).
 */
export function useFoundScan(burrow: string | null): FoundScan {
  const discover = useConnectionWrite(api.connections.discover, burrow ?? '');
  const [scan, setScan] = useState<ConnectionDiscovery | null>(null);
  const [refused, setRefused] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const mutate = useRef(discover.mutateAsync);
  mutate.current = discover.mutateAsync;
  const latest = useRef(0);
  const shown = useRef(0);

  const ask = useCallback(
    async (body: DiscoverConnectionsBody): Promise<AskResult> => {
      if (!burrow) return { ok: false, invalid: null };
      const mine = ++latest.current;
      try {
        const result = await mutate.current({ params: { burrow }, body });
        if (result.status !== 'ok' || mine < shown.current) return { ok: false, invalid: null };
        shown.current = mine;
        setScan(result.data);
        setTrouble(null);
        return { ok: true };
      } catch (err) {
        if (mine !== latest.current) return { ok: false, invalid: null };
        if (body.networks?.length && (err instanceof InvalidRequestError || isValidation(err)))
          return { ok: false, invalid: validationText(err) ?? 'Write it like 192.168.2.0/24.' };
        // Not a manager, an older server, the feature off: there is nothing to show. A hiccup says so and stops.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) setRefused(true);
        else setTrouble('Couldn’t look at your network just now. Scan again in a moment.');
        return { ok: false, invalid: null };
      }
    },
    [burrow],
  );

  // Opening: the recent scan, or a new one (no rescan).
  useEffect(() => {
    void ask({});
  }, [ask]);

  // While it looks, ask again every 1.5 s.
  useEffect(() => {
    const delay = discoveryPollDelay(scan);
    if (delay === null) return;
    const timer = setTimeout(() => void ask({}), delay);
    return () => clearTimeout(timer);
  }, [scan, ask]);

  const begin = useCallback(() => ++latest.current, []);
  const accept = useCallback((mine: number, data: ConnectionDiscovery) => {
    if (mine < shown.current) return false;
    shown.current = mine;
    setScan(data);
    return true;
  }, []);

  return {
    burrow: burrow ?? '',
    scan,
    refused: refused || !burrow,
    trouble,
    pending: discover.isPending,
    ask,
    begin,
    accept,
  };
}

/** How many found services are new (not connected, not hidden): the Add page's “On your network 3” chip. */
export function foundCount(found: FoundScan): number {
  return found.scan ? foundList(found.scan).rows.length : 0;
}

/**
 * The overview's strip (AP-1161): “On your network”, a chip for each of the first four new ones (its connect page with
 * the address filled in), “+2 more”, and “See all” to Add a connection, where the section is. Nothing while it looks
 * the first time, when nothing new turned up, or when the viewer can't scan: the overview stays about what you have.
 */
export function FoundStrip({ found }: { found: FoundScan }) {
  if (found.refused || !found.scan) return null;
  const rows = foundList(found.scan).rows;
  if (rows.length === 0) return null;
  const more = rows.length - STRIP_CHIPS;
  return (
    <section className={k.strip} aria-labelledby="connections-found-strip">
      <h2 id="connections-found-strip" className={k.stripTitle}>
        On your network
      </h2>
      <ul className={k.stripChips} aria-label="Found on your network">
        {rows.slice(0, STRIP_CHIPS).map((row) => (
          <li key={row.key} data-found={row.catalogId}>
            {row.action === 'server' && row.serverAddress ? (
              <Link
                to="/servers"
                search={foundServerSearch(row.serverAddress) as never}
                className={k.stripChip}
                aria-label={`Add ${row.name} at ${row.serverAddress} as a server`}
                title={row.tagline ? `${row.tagline} · ${row.serverAddress}` : row.serverAddress}
              >
                <ProviderLogo provider={row.catalogId} size={20} />
                {row.name}
              </Link>
            ) : (
              <Link
                to="/settings"
                search={foundSearch(row.catalogId, row.url)}
                className={k.stripChip}
                aria-label={`Connect ${row.name} at ${row.url}`}
                title={row.tagline ? `${row.tagline} · ${row.url}` : row.url}
              >
                <ProviderLogo provider={row.catalogId} size={20} />
                {row.name}
              </Link>
            )}
          </li>
        ))}
        {more > 0 && <li className={k.stripMore}>+{more} more</li>}
      </ul>
      <Link to="/connections" search={{ connection: 'add' } as never} className={k.stripAll}>
        See all
        <Icon icon={ChevronRight} size={14} />
      </Link>
    </section>
  );
}

/**
 * The full section at the top of Add a connection (AP-1162): Scan again, Look in another network, the rows with Hide
 * and Connect, the hidden ones behind the footer's toggle. `query` narrows the rows to the names it matches; while it
 * matches none the section steps aside.
 */
export function FoundOnNetwork({ found, query = '' }: { found: FoundScan; query?: string }) {
  const ids = useId();
  const { burrow, scan, trouble } = found;
  const hideFound = useConnectionWrite(api.connections.hideFound, burrow);
  const [hideTrouble, setHideTrouble] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  /** The rows whose Hide or Unhide is on its way. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [other, setOther] = useState(false);
  const [cidr, setCidr] = useState('');
  const [cidrError, setCidrError] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const mutateHide = useRef(hideFound.mutateAsync);
  mutateHide.current = hideFound.mutateAsync;

  /**
   * Hide a found service for the whole burrow, or show it again (CS-53). Its button waits for the answer; the answer is
   * the scan as it is now. Focus that the vanished button had goes to “Show 1 hidden”, or to the row's Hide again.
   */
  async function changeHidden(row: FoundRow, hidden: boolean) {
    const mine = found.begin();
    const done = (b: ReadonlySet<string>) => {
      const next = new Set(b);
      next.delete(row.key);
      return next;
    };
    setBusy((b) => new Set(b).add(row.key));
    setHideTrouble(null);
    try {
      const result = await mutateHide.current({
        params: { burrow },
        body: { catalogId: row.catalogId, url: row.url, hidden },
      });
      if (result.status !== 'ok') {
        setHideTrouble(hideTroubleText(hidden));
        return;
      }
      let accepted = false;
      flushSync(() => {
        accepted = found.accept(mine, result.data);
        setBusy(done);
      });
      if (!accepted) return;
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) focusAfter(section.current, hidden ? null : row.key);
    } catch {
      setHideTrouble(hideTroubleText(hidden));
    } finally {
      setBusy(done);
    }
  }

  const list = scan ? foundList(scan) : null;
  const hiddenCount = list?.hidden.length ?? 0;
  // The last hidden one shown again: the toggle goes, and the list closes with it.
  useEffect(() => {
    if (hiddenCount === 0) setShowHidden(false);
  }, [hiddenCount]);

  async function lookIn(e: FormEvent) {
    e.preventDefault();
    const problem = cidrProblem(cidr);
    if (problem) {
      setCidrError(problem);
      return;
    }
    setCidrError(null);
    const answer = await found.ask({ networks: [cidr.trim()], rescan: true });
    if (answer.ok) {
      setCidr('');
      setOther(false);
    } else if (answer.invalid) setCidrError(answer.invalid);
  }

  if (found.refused) return null;
  const searching = query.trim() !== '';
  const named = (row: FoundRow) => matchesWords(row.name, query);
  const scanning = scan?.state === 'scanning';
  const open = showHidden && hiddenCount > 0;
  const all = list ? (open ? [...list.rows, ...list.hidden] : list.rows) : [];
  const rows = searching ? all.filter(named) : all;
  if (searching && rows.length === 0) return null;
  const empty = scan?.state === 'done' && list && !searching ? foundEmptyText(list) : null;
  const looked = scan?.state === 'done' ? networksText(scan.networks) : null;
  return (
    <section ref={section} className={settings.section} aria-labelledby="connections-found">
      <div className={settings.sectionHead}>
        <SectionLabel as="h2" id="connections-found">
          ON YOUR NETWORK
        </SectionLabel>
        <span className={c.actions}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={other}
            aria-controls={`${ids}-other`}
            onClick={() => {
              setOther((o) => !o);
              setCidrError(null);
            }}
          >
            Look in another network
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={scanning || found.pending}
            onClick={() => void found.ask({ rescan: true })}
          >
            Scan again
          </Button>
        </span>
      </div>
      {other && (
        <form id={`${ids}-other`} className={k.lookIn} onSubmit={lookIn} noValidate>
          <label className={c.fieldLabel} htmlFor={`${ids}-cidr`}>
            NETWORK
          </label>
          <div className={k.inputRow}>
            <Input
              id={`${ids}-cidr`}
              size="md"
              spellCheck={false}
              autoComplete="off"
              inputMode="decimal"
              placeholder="192.168.2.0/24"
              value={cidr}
              onChange={(e) => {
                setCidr(e.target.value);
                setCidrError(null);
              }}
              invalid={cidrError !== null}
            />
            <Button type="submit" variant="primary" size="md" disabled={found.pending}>
              Look there
            </Button>
          </div>
          {cidrError ? (
            <p className={c.error} role="alert">
              {cidrError}
            </p>
          ) : (
            <p className={c.hint}>
              A network on your side of the router, of at most {groupDigits(1024)} addresses.
            </p>
          )}
        </form>
      )}
      <div className={settings.card}>
        {!scan && !trouble ? (
          <div className={k.foundProgress} role="status">
            <span className={k.spinner} aria-hidden="true" />
            <span className={c.meta}>Looking around your network…</span>
          </div>
        ) : null}
        {scanning && (
          <div className={k.foundProgress} role="status" aria-live="polite">
            <span className={k.spinner} aria-hidden="true" />
            <span className={c.meta}>{discoveryProgressText(scan)}</span>
          </div>
        )}
        {trouble && <p className={note}>{trouble}</p>}
        {hideTrouble && (
          <p className={note} role="alert">
            {hideTrouble}
          </p>
        )}
        {empty && <p className={note}>{empty}</p>}
        {scan?.state === 'idle' && !trouble && (
          <p className={note}>Whombat hasn’t looked yet. Scan to find what runs on your network.</p>
        )}
        {rows.length > 0 && (
          <ul
            id={`${ids}-found`}
            className={`${c.connectedList} ${k.foundList}`}
            aria-label="Found on your network"
          >
            {rows.map((row) => (
              <FoundItem
                key={row.key}
                row={row}
                busy={busy.has(row.key)}
                onHidden={(hidden) => void changeHidden(row, hidden)}
              />
            ))}
          </ul>
        )}
        {(looked || hiddenCount > 0) && (
          <div className={`${c.footer} ${k.foundFoot}`}>
            {looked && scan && (
              <span className={c.meta}>
                {looked}
                {scan.finishedAt ? ` · ${formatAgo(scan.finishedAt, new Date(), LOCAL_TZ)}` : ''}
              </span>
            )}
            {hiddenCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className={k.foundToggle}
                data-found-toggle=""
                aria-expanded={open}
                aria-controls={`${ids}-found`}
                onClick={() => setShowHidden((v) => !v)}
              >
                {hiddenToggleText(hiddenCount, open)}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function FoundItem({
  row,
  busy,
  onHidden,
}: {
  row: FoundRow;
  /** Its Hide or Unhide is on its way. */
  busy: boolean;
  onHidden: (hidden: boolean) => void;
}) {
  return (
    <li
      className={k.foundRow}
      data-found={row.catalogId}
      data-found-key={row.key}
      data-hidden={row.hidden ? '' : undefined}
    >
      <ProviderLogo provider={row.catalogId} />
      <span className={c.main}>
        <span className={c.nameLine}>
          <span className={`${c.name} ${k.foundName}`}>{row.name}</span>
          {row.version && <span className={c.meta}>{row.version}</span>}
        </span>
        <span className={k.foundWhere}>
          {row.tagline && (
            <>
              <span className={k.foundTagline}>{row.tagline}</span>
              <span className={k.foundDot} aria-hidden="true">
                ·
              </span>
            </>
          )}
          <span className={k.foundUrl}>{row.where}</span>
        </span>
      </span>
      {row.hidden ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-label={`Unhide ${row.name} at ${row.url}`}
          onClick={() => onHidden(false)}
        >
          Unhide
        </Button>
      ) : (
        <span className={k.foundActions}>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Hide ${row.name} at ${row.url}`}
            onClick={() => onHidden(true)}
          >
            Hide
          </Button>
          {row.action === 'server' && row.serverAddress ? (
            <RouterButtonLink
              variant="primary"
              size="sm"
              to="/servers"
              search={foundServerSearch(row.serverAddress) as never}
              aria-label={`Add ${row.name} at ${row.serverAddress} as a server`}
            >
              Add as a server
            </RouterButtonLink>
          ) : (
            <RouterButtonLink
              variant="primary"
              size="sm"
              to="/settings"
              search={foundSearch(row.catalogId, row.url)}
              aria-label={`Connect ${row.name} at ${row.url}`}
            >
              Connect
            </RouterButtonLink>
          )}
        </span>
      )}
    </li>
  );
}

/** After a hide, “Show 1 hidden”; after Unhide, that row's first button (Hide, or Connect without it). */
function focusAfter(section: HTMLElement | null, key: string | null) {
  if (!section) return;
  const target =
    key === null
      ? section.querySelector<HTMLElement>('[data-found-toggle]')
      : Array.from(section.querySelectorAll<HTMLElement>('[data-found-key]'))
          .find((li) => li.dataset.foundKey === key)
          ?.querySelector<HTMLElement>('button, a');
  target?.focus();
}

function isValidation(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'validation_failed';
}

function validationText(err: unknown): string | null {
  if (err instanceof InvalidRequestError || err instanceof ApiError) {
    const first = Object.values(err.fields)[0]?.[0];
    if (first) return first;
  }
  return err instanceof ApiError && err.message ? err.message : null;
}
