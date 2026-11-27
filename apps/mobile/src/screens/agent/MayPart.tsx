/**
 * Settings → the assistant → **What {assistant} may do** (the web's PermissionsTab): every permission on one page, by
 * thing, in three words — Just watch · Ask me first · Go ahead (`agentMayView`). What it did first (the Done screen),
 * then each server with its choice (changed here as on its page, asking before Go ahead), each connection at the level
 * it was connected with, what it can sign in to from the Vault, and the keys summed up by word with the way to change
 * them one by one in Advanced. Each thing's name opens its page. Pulling down reads it all again.
 */

import { ApiError, keptSitesText, keptSiteUntil } from '@whombat/client';
import { useHostsFleet, useHostsStatus } from '@whombat/client/hosts/react';
import {
  useCatalogConnections,
  useCommandAllowances,
  useHostInfo,
  useKeptSites,
  useStopKeptSite,
  useVault,
} from '@whombat/client/react';
import type { HostAsksFirst } from '@whombat/core';
import { type ReactNode, useMemo, useState } from 'react';
import { View } from 'react-native';
import { agentMayView, type MayConnectionRow, type MaySection, type MayServerRow } from '../../data/agentMay';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n } from '../../i18n';
import { useAppNavigation } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { CardLine, RowButtons } from '../../ui/facts';
import { ListRow } from '../../ui/ListRow';
import { Button, Section, SkeletonRows } from '../../ui/primitives';
import { Segmented } from '../../ui/Segmented';
import { Touchable } from '../../ui/Touchable';
import { showNotice } from '../feedback';
import { useAsksFirstChoice } from '../server/AsksFirst';
import { Note, type PartProps, PartScroll } from './parts';

export function MayPart({ profile }: PartProps) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const navigation = useAppNavigation();
  const { slug } = useBurrowBase();
  const name = profile.agent.name;
  const status = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const present = status.data?.present;
  const fleet = useHostsFleet(present ? { params: { burrow: slug } } : null, { retry: false });
  const connections = useCatalogConnections({ params: { burrow: slug } }, { retry: false });
  const vault = useVault({ params: { burrow: slug } }, { retry: false });
  const host = useHostInfo({ params: { burrow: slug } }, { retry: false });
  const allowances = useCommandAllowances({ params: { burrow: slug } }, { retry: false });

  const view = useMemo(
    () =>
      agentMayView({
        agent: name,
        // A Whombat whose servers can't be asked about says it has none rather than waiting.
        serversPresent: status.error ? true : present,
        servers: fleet.data?.servers ?? (fleet.error || status.error ? null : undefined),
        connections: connections.data?.connections ?? (connections.error ? null : undefined),
        vault: vault.data?.entries ?? (vault.error ? null : undefined),
        grants: profile.grants,
        deployWorkflow: host.data?.deployWorkflow,
        commands: allowances.data?.allowances.length ?? (allowances.error ? null : undefined),
        locale: rawLocale,
      }),
    [
      name,
      status.error,
      present,
      fleet.data,
      fleet.error,
      connections.data,
      connections.error,
      vault.data,
      vault.error,
      profile.grants,
      host.data,
      allowances.data,
      allowances.error,
      rawLocale,
    ],
  );
  const refreshing = fleet.isRefetching || connections.isRefetching || vault.isRefetching;
  const refresh = () => {
    void status.refetch();
    if (present) void fleet.refetch();
    void connections.refetch();
    void vault.refetch();
    void allowances.refetch();
  };
  const openThing = (thing: string, title: string) =>
    navigation.navigate('Thing', { thingId: thing, title, back: name });

  return (
    <PartScroll refreshing={refreshing} onRefresh={refresh}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 14 }}>
        <Text size={15} lh={1.5} color={theme.colors.ink2}>
          {view.intro}
        </Text>
      </View>

      <Section title={view.did.label}>
        <ListRow
          title={view.did.title}
          body={view.did.line}
          trailing="›"
          onPress={() => navigation.navigate('Done')}
          accessibilityLabel={`${view.did.title}. ${view.did.line}`}
        />
      </Section>

      {view.servers ? (
        <ListSection
          section={view.servers}
          render={(row) => (
            <ServerRow key={row.key} row={row} onOpen={() => openThing(row.thing, row.title)} />
          )}
        />
      ) : null}

      {view.connections ? (
        <>
          <ListSection
            section={view.connections}
            render={(row) => (
              <ConnectionRow key={row.key} row={row} onOpen={() => openThing(row.thing, row.title)} />
            )}
          />
          {view.connections.how ? (
            <View style={{ paddingHorizontal: 22, paddingBottom: 14, marginTop: -6 }}>
              <Text size={13} lh={1.45} color={theme.colors.mut}>
                {view.connections.how}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      {view.signIn ? (
        <Section title={view.signIn.label}>
          <ListRow
            title={view.signIn.title}
            body={view.signIn.names}
            trailing="›"
            onPress={() => navigation.navigate('Vault')}
            accessibilityLabel={[view.signIn.title, view.signIn.names, view.signIn.button]
              .filter(Boolean)
              .join('. ')}
          />
        </Section>
      ) : null}

      <KeptSitesSection agent={name} />

      <Section title={view.keys.label}>
        {view.keys.words.map((w) => (
          <ListRow
            key={w.word}
            title={w.title}
            body={w.labels}
            accessibilityLabel={`${w.title} ${w.labels}`}
          />
        ))}
        <ListRow
          title={view.keys.commands ?? '…'}
          trailing={view.keys.change}
          onPress={() => navigation.navigate('SettingsAdvancedPart', { part: 'keys' })}
          accessibilityLabel={[view.keys.commands, view.keys.change].filter(Boolean).join('. ')}
        />
      </Section>
    </PartScroll>
  );
}

/**
 * KEPT SIGNED IN (Whombat kept-sites.md): the websites the assistant asked to stay signed in to between chats, soonest
 * to go first, each with until when and Stop (at once: it takes something away). Shown only while there is one.
 */
function KeptSitesSection({ agent }: { agent: string }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { slug, timeZone, clock } = useBurrowBase();
  const list = useKeptSites({ params: { burrow: slug } }, { retry: false });
  const stop = useStopKeptSite(slug);
  const [problem, setProblem] = useState<string | null>(null);
  const t = keptSitesText(agent, rawLocale);
  const sites = list.data?.sites ?? [];
  if (sites.length === 0) return null;
  const now = clock();
  return (
    <>
      <Section title={t.title}>
        <CardLine text={problem} tone="bad" />
        {sites.map((s) => {
          const until = keptSiteUntil(s.expiresAt, now, timeZone, rawLocale);
          return (
            <View
              key={s.id}
              style={{
                gap: 6,
                paddingVertical: 14,
                paddingHorizontal: 16,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.line,
              }}
            >
              <View accessible accessibilityLabel={`${s.site}, ${until}`} style={{ gap: 4 }}>
                <Text size={15} weight={600}>
                  {s.site}
                </Text>
                <Text size={13} color={theme.colors.mut}>
                  {until}
                </Text>
              </View>
              <RowButtons>
                <Button
                  label={t.stop}
                  variant="secondary"
                  disabled={stop.isPending}
                  accessibilityLabel={t.stopLabel(s.site)}
                  onPress={() => {
                    setProblem(null);
                    stop.mutate(s.id, {
                      onSuccess: () => showNotice(t.stopped(s.site)),
                      onError: (e) => setProblem(e instanceof ApiError && e.message ? e.message : t.failed),
                    });
                  }}
                  style={{ paddingHorizontal: 18 }}
                />
              </RowButtons>
            </View>
          );
        })}
      </Section>
      <View style={{ paddingHorizontal: 22, paddingBottom: 14, marginTop: -6 }}>
        <Text size={13} lh={1.45} color={theme.colors.mut}>
          {t.note}
        </Text>
      </View>
    </>
  );
}

/** A section of things: its rows, a quiet line when there are none, skeletons while they load. */
function ListSection<R>({ section, render }: { section: MaySection<R>; render: (row: R) => ReactNode }) {
  return (
    <Section title={section.label}>
      {section.loading ? (
        <SkeletonRows count={2} lines={1} label={section.label} />
      ) : section.empty ? (
        <Note>{section.empty}</Note>
      ) : (
        section.rows.map(render)
      )}
    </Section>
  );
}

/**
 * A server: its name (opening its page) over what its word means here, and the choice under it — Ask me first · Go
 * ahead, asking before Go ahead — or, on a server Whombat only watches, the word.
 */
function ServerRow({ row, onOpen }: { row: MayServerRow; onOpen: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.line }}>
      <ThingHead
        title={row.title}
        line={row.line}
        word={row.choice ? null : row.wordText}
        label={row.accessibilityLabel}
        onOpen={onOpen}
        tight={!!row.choice}
      />
      {row.choice ? <ServerChoice row={row} choice={row.choice} /> : null}
    </View>
  );
}

function ServerChoice({ row, choice }: { row: MayServerRow; choice: NonNullable<MayServerRow['choice']> }) {
  const { value, choose } = useAsksFirstChoice(row.serverId, row.title, choice.value);
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
      <Segmented<HostAsksFirst>
        label={choice.label}
        value={value}
        onChange={choose}
        options={choice.options}
      />
    </View>
  );
}

/** A connection: its name (opening its page), what its level means, and its word. */
function ConnectionRow({ row, onOpen }: { row: MayConnectionRow; onOpen: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.line }}>
      <ThingHead
        title={row.title}
        line={row.line}
        word={row.wordText}
        label={row.accessibilityLabel}
        onOpen={onOpen}
      />
    </View>
  );
}

/** A thing's name and line as one button to its page, its word at the end when nothing changes it here. */
function ThingHead({
  title,
  line,
  word,
  label,
  onOpen,
  tight = false,
}: {
  title: string;
  line: string;
  word: string | null;
  label: string;
  onOpen: () => void;
  tight?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      feedback="wash"
      onPress={onOpen}
      style={{ paddingTop: 14, paddingBottom: tight ? 10 : 14, paddingHorizontal: 16, gap: 4, minHeight: 44 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text size={15.5} weight={600} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
          {title}
        </Text>
        {word ? (
          <Text size={12.5} weight={500} color={theme.colors.ink2}>
            {word}
          </Text>
        ) : null}
      </View>
      <Text size={13.5} lh={1.4} color={theme.colors.mut}>
        {line}
      </Text>
    </Touchable>
  );
}
