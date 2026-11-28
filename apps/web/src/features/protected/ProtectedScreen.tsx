/**
 * What's protected (`/protected`; Whombat docs/decisions/backup-trust.md): everything that holds data in three plain
 * groups — copied to another machine, only on the same machine, not backed up that Whombat can see — each row linking
 * to its thing, the last two offering *Ask {assistant} to set up backups* in that thing's thread. Under them, Restore
 * tests: per Proxmox server the switch, which machines, the last result, the next test and *Test one now*. The words are
 * `@whombat/core`'s, so the phone and the assistant say the same.
 */

import { startedChatPath } from '@whombat/client';
import {
  useProtectedView,
  useRunRestoreTest,
  useSetRestoreTests,
  useStartChat,
  useTheAgent,
} from '@whombat/client/react';
import {
  PROTECTED_GROUPS,
  type ProtectedGroup,
  type ProtectedRow,
  type ProtectedView,
  protectedAskSubject,
  protectedAskText,
  protectedGroupWords,
  protectedOffsiteLine,
  protectedPageWords,
  protectedRowLine,
  protectedRowOld,
  protectedRowsOf,
  type RestoreTestServer,
  restoreTestLine,
  restoreTestVerdict,
  restoreTestWhen,
} from '@whombat/core';
import { Box, ChevronDown, Database, HardDrive, House, Monitor, Server } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { LoadErrorNote } from '../../app/runtime';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { ToggleRow } from '../../components/Toggle';
import { useWebI18n } from '../../i18n/provider';
import { AppLink } from '../files/AppLink';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import settings from '../settings/SettingsScreen.module.css';
import styles from './Protected.module.css';

const KIND_ICONS = {
  whombat: House,
  server: Server,
  vm: Monitor,
  container: Box,
  service: Database,
} as const;

export interface ProtectedScreenProps {
  burrow: string;
}

export function ProtectedScreen({ burrow }: ProtectedScreenProps) {
  const i18n = useWebI18n();
  const words = protectedPageWords(i18n.tag);
  const { data, error, refetch } = useProtectedView({ params: { burrow } }, { refetchInterval: 60_000 });
  return (
    <div className={settings.scroll} data-screen="protected">
      <div className={settings.page}>
        <div className={settings.header}>
          <div className={settings.heading}>
            <h1 className={settings.title}>{words.title}</h1>
            <p className={settings.subtitle}>{words.intro}</p>
          </div>
        </div>
        <div className={settings.panel}>
          {error && !data ? (
            <LoadErrorNote error={error} message={words.loadFailed} onRetry={() => void refetch()} />
          ) : !data ? (
            <SkeletonRows count={6} />
          ) : (
            <ProtectedBody burrow={burrow} view={data} />
          )}
        </div>
      </div>
    </div>
  );
}

function ProtectedBody({ burrow, view }: { burrow: string; view: ProtectedView }) {
  const i18n = useWebI18n();
  const words = protectedPageWords(i18n.tag);
  const groups = PROTECTED_GROUPS.map((group) => ({ group, rows: protectedRowsOf(view.rows, group) }));
  const count = (g: ProtectedGroup) => groups.find((x) => x.group === g)?.rows.length ?? 0;
  const counts = words.counts(count('copied'), count('local'), count('none'));
  return (
    <>
      {counts || view.unread.length || !view.rows.length ? (
        <div className={styles.summary}>
          {counts ? (
            <p className={styles.counts} data-protected-counts="">
              {counts}
            </p>
          ) : null}
          {view.unread.length ? (
            <p className={styles.unread} data-protected-unread="">
              {words.unread(view.unread.join(', '))}
            </p>
          ) : null}
          {view.rows.length ? null : <p className={styles.empty}>{words.empty}</p>}
        </div>
      ) : null}
      {groups.map(({ group, rows }) =>
        rows.length ? <Group key={group} burrow={burrow} group={group} rows={rows} /> : null,
      )}
      {view.restoreTests.length ? <RestoreTests burrow={burrow} servers={view.restoreTests} /> : null}
    </>
  );
}

function Group({ burrow, group, rows }: { burrow: string; group: ProtectedGroup; rows: ProtectedRow[] }) {
  const i18n = useWebI18n();
  const { title, note } = protectedGroupWords(group, i18n.tag);
  const id = useId();
  return (
    <section className={styles.group} aria-labelledby={id} data-protected-group={group}>
      <div className={styles.groupHead}>
        <SectionLabel as="h2" id={id}>
          {`${title} · ${rows.length}`}
        </SectionLabel>
        <p className={styles.groupNote}>{note}</p>
      </div>
      <div className={styles.card}>
        {rows.map((row) => (
          <Row key={row.key} burrow={burrow} row={row} ask={group !== 'copied'} />
        ))}
      </div>
    </section>
  );
}

function Row({ burrow, row, ask }: { burrow: string; row: ProtectedRow; ask: boolean }) {
  const i18n = useWebI18n();
  const { timeZone } = useBurrowContext(burrow);
  const now = new Date(useNow(60_000));
  const line = protectedRowLine(row, now, timeZone, i18n.tag);
  const tone = row.failedAt ? 'bad' : protectedRowOld(row, now) ? 'warn' : null;
  const name: ReactNode = row.href ? (
    <AppLink href={row.href} className={styles.nameLink}>
      {row.name}
    </AppLink>
  ) : (
    row.name
  );
  return (
    <div className={styles.row} data-protected-row={row.key} data-state={row.state}>
      <span className={styles.icon} aria-hidden="true">
        <Icon icon={KIND_ICONS[row.kind]} size={18} />
      </span>
      <div className={styles.main}>
        <div className={styles.nameLine}>
          <span className={styles.name}>{name}</span>
          {row.on ? <span className={styles.on}>{row.on}</span> : null}
        </div>
        <p className={cx(styles.line, tone === 'bad' && styles.bad, tone === 'warn' && styles.warn)}>
          {line}
        </p>
        {row.offsite ? (
          <p className={styles.line} data-protected-offsite="">
            <Icon icon={HardDrive} size={13} className={styles.inlineIcon} />
            {protectedOffsiteLine(row.offsite, now, timeZone, i18n.tag)}
          </p>
        ) : null}
        {row.restoreTest ? (
          <p
            className={cx(styles.line, row.restoreTest.outcome === 'failed' && styles.bad)}
            data-protected-test={row.restoreTest.outcome}
          >
            {restoreTestLine(row.restoreTest, now, timeZone, i18n.tag)}
          </p>
        ) : null}
      </div>
      {ask ? <AskSetUp burrow={burrow} row={row} /> : null}
    </div>
  );
}

/** *Ask {assistant} to set up backups*: a question about this thing, in its own thread, then that thread. */
function AskSetUp({ burrow, row }: { burrow: string; row: ProtectedRow }) {
  const i18n = useWebI18n();
  const { words } = useTheAgent(burrow);
  const start = useStartChat(burrow);
  const navigate = useNavigateHref();
  const [failed, setFailed] = useState(false);
  const ask = async () => {
    setFailed(false);
    const subject = protectedAskSubject(row);
    const result = await start
      .mutateAsync({ text: protectedAskText(row, i18n.tag), ...(subject ? { subject } : {}) })
      .catch(() => null);
    if (result?.status === 'ok') navigate(startedChatPath(result.data));
    else setFailed(true);
  };
  return (
    <div className={styles.ask}>
      <Button
        variant="secondary"
        size="sm"
        disabled={start.isPending}
        onClick={() => void ask()}
        data-protected-ask={row.key}
      >
        {protectedPageWords(i18n.tag).ask(words.name)}
      </Button>
      {failed ? (
        <span className={styles.askFailed} role="status">
          {protectedPageWords(i18n.tag).failed}
        </span>
      ) : null}
    </div>
  );
}

/* Restore tests ----------------------------------------------------------------------------------------------- */

function RestoreTests({ burrow, servers }: { burrow: string; servers: RestoreTestServer[] }) {
  const i18n = useWebI18n();
  const words = protectedPageWords(i18n.tag);
  const id = useId();
  return (
    <section className={styles.group} aria-labelledby={id} data-protected-tests="">
      <div className={styles.groupHead}>
        <SectionLabel as="h2" id={id}>
          {words.tests}
        </SectionLabel>
        <p className={styles.groupNote}>{words.testsIntro}</p>
      </div>
      {servers.map((s) => (
        <TestServer key={s.serverId} burrow={burrow} server={s} single={servers.length === 1} />
      ))}
    </section>
  );
}

function TestServer({
  burrow,
  server,
  single,
}: {
  burrow: string;
  server: RestoreTestServer;
  single: boolean;
}) {
  const i18n = useWebI18n();
  const words = protectedPageWords(i18n.tag);
  const { timeZone } = useBurrowContext(burrow);
  const now = new Date(useNow(60_000));
  const set = useSetRestoreTests(burrow);
  const run = useRunRestoreTest(burrow);
  const [choosing, setChoosing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chooserId = useId();
  const chosen = server.guests.length ? words.testsSome(server.guests.length) : words.testsAll;
  const busy = set.isPending || run.isPending;
  const save = (on: boolean, guests?: string[]) => {
    setNote(null);
    set.mutate(
      { serverId: server.serverId, on, ...(guests ? { guests } : {}) },
      {
        onSuccess: (r) => setNote(r.status === 'blocked' ? r.message : null),
        onError: () => setNote(words.failed),
      },
    );
  };
  const testNow = () => {
    setNote(null);
    run.mutate(
      { serverId: server.serverId },
      {
        onSuccess: (r) => setNote(r.status === 'blocked' ? r.message : null),
        onError: () => setNote(words.failed),
      },
    );
  };
  const toggle = (guest: string) => {
    const all = server.eligible.map((g) => g.id);
    const current = server.guests.length ? server.guests : all;
    const next = current.includes(guest) ? current.filter((g) => g !== guest) : [...current, guest];
    // Every machine ticked is the same as none chosen: all of them, new ones too.
    save(server.on, next.length === all.length ? [] : next);
  };
  return (
    <div className={styles.card} data-test-server={server.serverId}>
      <div className={styles.testHead}>
        {single ? null : <span className={styles.serverName}>{server.serverName}</span>}
        <ToggleRow
          className={styles.testSwitch}
          label={words.testsSwitch}
          hint={server.blocked ? words.blocked(server.blocked) : chosen}
          checked={server.on}
          onCheckedChange={(on) => save(on)}
        />
      </div>
      <div className={styles.testBody}>
        {server.running ? (
          <p className={styles.line} data-test-running="">
            {words.testsRunning(server.running.guestName)}
          </p>
        ) : null}
        <p className={cx(styles.line, server.last?.outcome === 'failed' && styles.bad)} data-test-last="">
          {server.last
            ? `${server.last.guestName}: ${restoreTestVerdict(server.last, now, timeZone, i18n.tag)}`
            : words.testsNone}
        </p>
        {server.on && server.next && !server.running ? (
          <p className={styles.line} data-test-next="">
            {words.testsNext(restoreTestWhen(server.next, now, timeZone, i18n.tag))}
          </p>
        ) : null}
        <div className={styles.testActions}>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !!server.running || !!server.blocked}
            onClick={testNow}
            data-test-run=""
          >
            {words.testsRun}
          </Button>
          {server.eligible.length > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={choosing}
              aria-controls={chooserId}
              onClick={() => setChoosing((c) => !c)}
              iconEnd={<Icon icon={ChevronDown} size={14} className={cx(choosing && styles.flipped)} />}
            >
              {`${words.testsChoose} · ${chosen}`}
            </Button>
          ) : null}
        </div>
        {note ? (
          <p className={cx(styles.line, styles.bad)} role="status">
            {note}
          </p>
        ) : null}
        {choosing ? (
          <fieldset id={chooserId} className={styles.chooser} disabled={busy}>
            <legend className={styles.srOnly}>{words.testsChoose}</legend>
            {server.eligible.map((g) => (
              <label key={g.id} className={styles.choice}>
                <input
                  type="checkbox"
                  checked={!server.guests.length || server.guests.includes(g.id)}
                  // The last one ticked stays: none ticked would mean all of them again.
                  disabled={server.guests.length === 1 && server.guests[0] === g.id}
                  onChange={() => toggle(g.id)}
                />
                <span>{g.name}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>
    </div>
  );
}
