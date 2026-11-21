import { createLink } from '@tanstack/react-router';
import {
  ApiError,
  ASKS_WORD,
  connectionPermission,
  keptSitesText,
  keptSiteUntil,
  PERMISSION_WORDS,
  type PermissionRow,
  type PermissionServer,
  permissionsText,
  serverPermission,
} from '@whombat/client';
import { useHostsChange, useHostsFleet, useHostsStatus } from '@whombat/client/hosts/react';
import { useCatalogConnections, useKeptSites, useStopKeptSite, useVault } from '@whombat/client/react';
import { catalogEntry, thingHref } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { HOST_ASKS_FIRST_WORDS, type HostAsksFirst } from '@whombat/core/domain';
import { useId, useState } from 'react';
import { Button, ButtonLink } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { SectionLabel } from '../../../components/SectionLabel';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useToast } from '../../../components/Toast';
import { AppLink } from '../../files/AppLink';
import { useBurrowViewer } from '../../runs/useBurrowViewer';
import { AgentsNetworkSection } from '../../settings/AgentsNetworkSection';
import settings from '../../settings/SettingsScreen.module.css';
import { ConfirmDialog, useChangeRunner } from '../../things/parts';
import { agentVaultEntries } from '../../vault/AgentVault';
import type { SettingsTabProps } from './AgentTab';
import { KeysSection } from './KeysSection';
import styles from './Permissions.module.css';

const RouterButtonLink = createLink(ButtonLink);

/**
 * Settings → the assistant → **What {assistant} may do** (settings-groups.md): every permission on one
 * page, by thing, in one vocabulary — Just watch · Ask me first · Go ahead. What it did first (Everything it did, with
 * Undo); then each server with its choice (changed here as on its System tab, asking before Go ahead); each connection
 * at the level it was connected with; what it can sign in to from the Vault; the local network switch (with the home
 * networks it may reach while that is off); and the keys, row by row, with the commands always allowed folded under
 * them. Most of it lists what was decided on cards (“Always allow”, “Don’t ask again”).
 */
export function PermissionsTab({
  burrow,
  profile,
  onDirtyChange,
  showKey,
}: SettingsTabProps & { showKey?: string | undefined }) {
  const name = profile.agent.name;
  const t = permissionsText(name);
  return (
    <>
      <p className={styles.intro}>{t.intro}</p>
      <Section label={t.did}>
        <div className={settings.card}>
          <div className={settings.row}>
            <span className={settings.rowMain}>
              <span className={settings.rowTitle}>{t.didTitle}</span>
              <span className={settings.rowMeta}>{t.didLine}</span>
            </span>
            <RouterButtonLink variant="secondary" size="lg" to="/done">
              {t.didButton}
            </RouterButtonLink>
          </div>
        </div>
      </Section>
      <ServersSection burrow={burrow} agent={name} />
      <ConnectionsSection burrow={burrow} agent={name} />
      <SignInSection burrow={burrow} agent={name} />
      <KeptSitesSection burrow={burrow} agent={name} />
      <AgentsNetworkSection burrow={burrow} />
      <KeysSection burrow={burrow} profile={profile} onDirtyChange={onDirtyChange} showKey={showKey} />
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section className={settings.section} aria-labelledby={id}>
      <SectionLabel as="h2" id={id}>
        {label}
      </SectionLabel>
      {children}
    </section>
  );
}

/** A row's word in plain text (a thing whose level isn't changed here): words, not a chip. */
function WordTag({ row }: { row: PermissionRow }) {
  return (
    <span className={styles.word} data-word={row.word}>
      {PERMISSION_WORDS[row.word]}
    </span>
  );
}

/** SERVERS: each with Ask me first · Go ahead; a server Whombat only watches says so. */
function ServersSection({ burrow, agent }: { burrow: string; agent: string }) {
  const t = permissionsText(agent);
  const status = useHostsStatus({ params: { burrow } }, { retry: false });
  const present = status.data?.present === true;
  const fleet = useHostsFleet(present ? { params: { burrow }, query: {} } : null, { retry: 1 });
  // A Whombat without the hosts service has no servers to list.
  if (status.data && !present) return null;
  const servers = fleet.data?.servers ?? [];
  return (
    <Section label={t.servers}>
      <div className={settings.card} data-permissions="servers">
        {!fleet.data ? (
          <p className={settings.empty}>{status.error || fleet.error ? t.serversNone : '…'}</p>
        ) : servers.length === 0 ? (
          <p className={settings.empty}>{t.serversNone}</p>
        ) : (
          servers.map((s) => <ServerRow key={s.id} burrow={burrow} server={s} agent={agent} />)
        )}
      </div>
    </Section>
  );
}

function ServerRow({ burrow, server, agent }: { burrow: string; server: PermissionServer; agent: string }) {
  const W = HOST_ASKS_FIRST_WORDS;
  const t = permissionsText(agent);
  const row = serverPermission(server, agent);
  const update = useHostsChange(api.hosts.updateServer);
  const { run, busy } = useChangeRunner();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const save = (asksFirst: HostAsksFirst, inline = false) =>
    run(
      () => update.mutateAsync({ params: { burrow, serverId: server.id }, body: { asksFirst } }),
      W.changed(server.name, asksFirst),
      { inline },
    );
  const value: HostAsksFirst = row.word === 'ask' ? 'risky' : 'never';
  return (
    <div className={cx(settings.row, styles.serverRow)} data-server={server.id}>
      <span className={settings.rowMain}>
        <AppLink href={thingHref('server', server.id)} className={styles.thing}>
          {server.name}
        </AppLink>
        <span className={settings.rowMeta} id={hintId}>
          {row.line}
        </span>
      </span>
      {row.word === 'watch' ? (
        <WordTag row={row} />
      ) : (
        <SegmentedControl<HostAsksFirst>
          options={(['risky', 'never'] as const).map((v) => ({
            value: v,
            label: PERMISSION_WORDS[ASKS_WORD[v]],
          }))}
          value={value}
          onChange={(v) => {
            if (v === value) return;
            if (v === 'never') setConfirming(true);
            else void save(v);
          }}
          label={t.serverLabel(server.name)}
          role="radiogroup"
          describedBy={hintId}
          size="sm"
          disabled={busy}
        />
      )}
      <ConfirmDialog
        open={confirming}
        title={W.confirmTitle(server.name)}
        body={W.confirmBody(server.name)}
        confirm={W.confirm}
        busy={busy}
        error={error}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={() =>
          void (async () => {
            const out = await save('never', true);
            if (out.ok) setConfirming(false);
            else if (out.error) setError(out.message);
            else setConfirming(false);
          })()
        }
      />
    </div>
  );
}

/** CONNECTIONS: each at the level it was connected with (Look only is Just watch, Manage is Go ahead). */
function ConnectionsSection({ burrow, agent }: { burrow: string; agent: string }) {
  const t = permissionsText(agent);
  const list = useCatalogConnections({ params: { burrow } }, { retry: false });
  if (list.error && !list.data) return null;
  const connections = list.data?.connections ?? [];
  return (
    <Section label={t.connections}>
      <div className={settings.card} data-permissions="connections">
        {!list.data ? (
          <p className={settings.empty}>…</p>
        ) : connections.length === 0 ? (
          <p className={settings.empty}>{t.connectionsNone}</p>
        ) : (
          connections.map((c) => {
            const name = c.label || catalogEntry(c.catalogId)?.name || c.catalogId;
            const row = connectionPermission({ id: c.id, name, access: c.access }, agent);
            return (
              <div key={c.id} className={settings.row} data-connection={c.id}>
                <span className={settings.rowMain}>
                  <AppLink
                    href={thingHref(c.catalogId === 'device' ? 'device' : 'connection', c.id)}
                    className={styles.thing}
                  >
                    {name}
                  </AppLink>
                  <span className={settings.rowMeta}>{row.line}</span>
                </span>
                <WordTag row={row} />
              </div>
            );
          })
        )}
      </div>
      {connections.length > 0 ? <p className={settings.sectionNote}>{t.connectionsHow}</p> : null}
    </Section>
  );
}

/**
 * KEPT SIGNED IN (Whombat kept-sites.md): the websites the assistant asked to stay signed in to between chats, soonest
 * to go first, each with until when and Stop (at once, like removing an always-allowed command: it takes something
 * away). Shown only while there is one.
 */
function KeptSitesSection({ burrow, agent }: { burrow: string; agent: string }) {
  const t = keptSitesText(agent);
  const toast = useToast();
  const viewer = useBurrowViewer(burrow);
  const { data } = useKeptSites({ params: { burrow } });
  const stop = useStopKeptSite(burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const sites = data?.sites ?? [];
  if (sites.length === 0) return null;
  const now = Date.now();
  return (
    <Section label={t.title}>
      <div className={settings.card} data-permissions="kept-sites">
        {sites.map((s) => (
          <div key={s.id} className={settings.row} data-kept-site={s.site}>
            <span className={settings.rowMain}>
              <span className={settings.rowTitle}>{s.site}</span>
              <span className={settings.rowMeta}>{keptSiteUntil(s.expiresAt, now, viewer.timeZone)}</span>
            </span>
            <Button
              variant="secondary"
              size="lg"
              disabled={stop.isPending}
              aria-label={t.stopLabel(s.site)}
              onClick={async () => {
                setProblem(null);
                try {
                  await stop.mutateAsync(s.id);
                  toast.show(t.stopped(s.site));
                } catch (e) {
                  setProblem(e instanceof ApiError && e.message ? e.message : t.failed);
                }
              }}
            >
              {t.stop}
            </Button>
          </div>
        ))}
      </div>
      {problem ? (
        <p className={settings.fieldError} role="alert">
          {problem}
        </p>
      ) : null}
      <p className={settings.sectionNote}>{t.note}</p>
    </Section>
  );
}

/** WHAT {ASSISTANT} CAN SIGN IN TO: how many Vault sign-ins it may use, and the way to them. */
function SignInSection({ burrow, agent }: { burrow: string; agent: string }) {
  const t = permissionsText(agent);
  const { data } = useVault({ params: { burrow } });
  if (!data) return null;
  const mine = agentVaultEntries(data.entries);
  return (
    <Section label={t.signIn}>
      <div className={settings.card}>
        <div className={settings.row}>
          <span className={settings.rowMain}>
            <span className={settings.rowTitle}>{t.signInLine(mine.length)}</span>
            {mine.length > 0 ? (
              <span className={settings.rowMeta}>{mine.map((e) => e.name).join(' · ')}</span>
            ) : null}
          </span>
          <RouterButtonLink variant="secondary" size="lg" to="/vault">
            {t.signInButton}
          </RouterButtonLink>
        </div>
      </div>
    </Section>
  );
}
