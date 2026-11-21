/**
 * The Deploys screen's content (mobile-parity.md MQ-07, work-removal-android.md AP-858; contracts 0.55 `deployments.*`,
 * CT-296): ENVIRONMENTS — per environment its services, each with the deploy live now, a newer attempt that failed and
 * the one before (where a rollback goes) — and HISTORY, newest first, with Load more. A deploy opens a sheet with its
 * facts, its summary, the deployed site and where it was posted. Both read again on
 * `deployment.recorded` (the shared client) and on pull (the screen's `onRefresh`).
 */
import { queryHook } from '@whombat/client/react';
import { api, type Deployment } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import {
  DEPLOYS_TEXT,
  type DeployLineModel,
  type DeployServiceRow,
  deployBoard,
  deployDetail,
  deployHistory,
} from '../data/deploys';
import { useAppNavigation, useOpenUrl } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Facts, RowButtons } from '../ui/facts';
import { ListRow } from '../ui/ListRow';
import { Button, ErrorState, QuietText, Section, SkeletonRows, toneColor } from '../ui/primitives';
import { Sheet } from '../ui/sheet';

const useDeployEnvironments = queryHook(api.deployments.environments);
const useDeployments = queryHook(api.deployments.list);

/** History pages grow by this many, up to the endpoint's 200. */
const PAGE = 30;
const PAGE_MAX = 200;

/** The reads, for the screen's pull to refresh; nothing is asked while `on` is false. */
export function useDeploys() {
  const { slug } = useBurrowBase();
  const [limit, setLimit] = useState(PAGE);
  const environments = useDeployEnvironments({ params: { burrow: slug } }, { retry: false });
  const history = useDeployments(
    { params: { burrow: slug }, query: { limit } },
    {
      retry: false,
      placeholderData: (previous) => previous,
    },
  );
  return {
    environments,
    history,
    more: !!history.data?.before && limit < PAGE_MAX,
    loadMore: () => setLimit((n) => Math.min(PAGE_MAX, n + PAGE)),
    refetch: () => {
      void environments.refetch();
      void history.refetch();
    },
  };
}

export function DeploysPanel({ deploys }: { deploys: ReturnType<typeof useDeploys> }) {
  const theme = useTheme();
  const ctx = useViewContext();
  const [open, setOpen] = useState<Deployment | null>(null);
  const { environments, history } = deploys;
  const board = environments.data ? deployBoard(environments.data.environments, ctx) : null;
  const rows = history.data ? deployHistory(history.data.deployments, ctx) : null;

  if (environments.error && history.error && !board && !rows)
    return <ErrorState text={DEPLOYS_TEXT.loadFailed} onRetry={deploys.refetch} />;
  if (!board || !rows) return <SkeletonRows count={4} lines={2} label="Loading deploys" />;
  if (board.length === 0 && rows.length === 0) return <QuietText>{DEPLOYS_TEXT.empty}</QuietText>;

  /** “DEPLOYED Banjo · 2 h ago · GitHub Actions · 7be20f”: a mono label in its tone, then who, when, how, what. */
  const line = (label: string, d: DeployLineModel) => (
    <Text size={12.5} lh={1.4} color={theme.colors.ink2}>
      <Text size={11} weight={500} mono tracking={0.05} color={toneColor(theme, d.tone)}>
        {`${label} `}
      </Text>
      {d.meta}
    </Text>
  );

  const service = (s: DeployServiceRow) => {
    const shown = s.current ?? s.failed;
    return (
      <ListRow
        key={s.key}
        title={s.service}
        trailing="›"
        accessibilityLabel={s.accessibilityLabel}
        {...(shown ? { onPress: () => setOpen((s.failed ?? s.current)?.deployment ?? null) } : {})}
      >
        {s.current ? line(s.current.pill, s.current) : null}
        {s.failed ? line(DEPLOYS_TEXT.failedAttempt.toUpperCase(), s.failed) : null}
        {s.previous ? line(DEPLOYS_TEXT.before.toUpperCase(), s.previous) : null}
        {!s.current ? (
          <Text size={12.5} color={theme.colors.mut}>
            {DEPLOYS_TEXT.nothingLive}
          </Text>
        ) : null}
      </ListRow>
    );
  };

  return (
    <>
      {board.length > 0 ? (
        <View>
          {board.map((env) => (
            <Section key={env.environment} title={env.label}>
              {env.services.map(service)}
            </Section>
          ))}
        </View>
      ) : null}
      {rows.length > 0 ? (
        <Section title={DEPLOYS_TEXT.history}>
          {rows.map((r) => (
            <ListRow
              key={r.id}
              title={r.title}
              trailing={
                <Text size={11} weight={500} mono tracking={0.05} color={toneColor(theme, r.tone)}>
                  {r.pill}
                </Text>
              }
              accessibilityLabel={r.accessibilityLabel}
              onPress={() => setOpen(r.deployment)}
            >
              <Text size={11.5} mono color={theme.colors.mut}>
                {r.meta}
              </Text>
            </ListRow>
          ))}
          {deploys.more ? (
            <View style={{ padding: 12 }}>
              <Button
                label={DEPLOYS_TEXT.loadMore}
                variant="secondary"
                busy={history.isFetching}
                onPress={deploys.loadMore}
              />
            </View>
          ) : null}
        </Section>
      ) : null}
      <DeployDetailSheet deployment={open} onClose={() => setOpen(null)} />
    </>
  );
}

function DeployDetailSheet({ deployment, onClose }: { deployment: Deployment | null; onClose: () => void }) {
  const theme = useTheme();
  const ctx = useViewContext();
  const navigation = useAppNavigation();
  const openUrl = useOpenUrl();
  const detail = deployment ? deployDetail(deployment, ctx) : null;
  return (
    <Sheet visible={detail !== null} onClose={onClose} title="DEPLOY" label={detail?.title ?? 'Deploy'}>
      {detail ? (
        <View style={{ paddingHorizontal: 22, gap: 12, paddingBottom: 8 }}>
          <View style={{ gap: 4 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={toneColor(theme, detail.tone)}>
              {detail.pill}
            </Text>
            <Text size={17} weight={600} lh={1.3} accessibilityRole="header">
              {detail.title}
            </Text>
          </View>
          <Facts facts={detail.facts} />
          <View style={{ gap: 4 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              {DEPLOYS_TEXT.summary}
            </Text>
            <Text size={14.5} lh={1.45} selectable>
              {detail.summary}
            </Text>
          </View>
          <RowButtons>
            {detail.url ? (
              <Button
                label={DEPLOYS_TEXT.openSite}
                variant="secondary"
                onPress={() => openUrl(detail.url as string)}
                style={{ paddingHorizontal: 16 }}
              />
            ) : null}
            {detail.conversationId ? (
              <Button
                label={DEPLOYS_TEXT.openConversation}
                variant="secondary"
                onPress={() => {
                  onClose();
                  navigation.navigate('Conversation', { conversationId: detail.conversationId as string });
                }}
                style={{ paddingHorizontal: 16 }}
              />
            ) : null}
          </RowButtons>
        </View>
      ) : null}
    </Sheet>
  );
}
