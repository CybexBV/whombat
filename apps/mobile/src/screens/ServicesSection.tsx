/**
 * Settings → Agent → Running (Whombat one-person.md OP-19; app one-person.md AP-5655, AP-5690; one-person-android.md
 * AP-5760): RUNNING ON YOUR WHOMBAT — each website, dev server or dashboard the agent keeps up, with its dot, how it is
 * and its link, Open while it has one and Stop, asked first (it stays stopped). Stop's answer replaces the row at once
 * (`useStopService`); a refusal shows the server's sentence. Replaced the agent's computer (OP-04).
 */
import { ApiError, type CommitResult } from '@whombat/client';
import { useStopService } from '@whombat/client/react';
import type { Agent, AgentService } from '@whombat/core';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { useBurrow, useNow } from '../data/BurrowProvider';
import { serviceRows, servicesText } from '../data/services';
import { useI18n, useMobileT } from '../i18n';
import { useOpenUrl } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { CardLine, RowButtons } from '../ui/facts';
import { Button, Section, StatusDot, toneColor } from '../ui/primitives';
import { showNotice } from './feedback';

/** The server's sentence for a refusal, else “That didn’t work.” */
function refusal(failed: string, result: CommitResult<unknown> | null, error?: unknown): string {
  if (error) return error instanceof ApiError && error.message ? error.message : failed;
  return result?.status === 'blocked' ? result.message : failed;
}

export function ServicesSection({ agent, services }: { agent: Agent; services: readonly AgentService[] }) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const copy = servicesText(rawLocale);
  const theme = useTheme();
  const { slug, timeZone } = useBurrow();
  const now = useNow();
  const openUrl = useOpenUrl();
  const stop = useStopService(slug);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = serviceRows(services, { now, timeZone, locale: rawLocale });

  const stopNow = (id: string, name: string) => {
    setProblem(null);
    stop.mutate(
      { id },
      {
        onSuccess: (result) =>
          result.status === 'ok' ? showNotice(copy.stopped(name)) : setProblem(refusal(copy.failed, result)),
        onError: (error) => setProblem(refusal(copy.failed, null, error)),
      },
    );
  };
  // Asked first, as on the web: it stays stopped, also after a restart.
  const press = (id: string, name: string) =>
    Alert.alert(copy.stopTitle(name), copy.stopBody(agent.name), [
      { text: copy.cancel, style: 'cancel' },
      { text: copy.stop, style: 'destructive', onPress: () => stopNow(id, name) },
    ]);

  return (
    <Section title={copy.title}>
      <CardLine text={rows.length === 0 ? copy.empty(agent.name) : copy.intro(agent.name)} />
      {rows.map((row) => (
        <View
          key={row.id}
          style={{
            gap: 10,
            paddingVertical: 14,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.line,
          }}
        >
          <View accessible accessibilityLabel={row.accessibilityLabel} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <StatusDot color={toneColor(theme, row.tone)} label={row.stateLabel} />
              <Text size={15.5} weight={600} style={{ flex: 1 }} numberOfLines={2}>
                {row.name}
              </Text>
            </View>
            <Text size={12} mono color={theme.colors.mut}>
              {row.line}
            </Text>
            {row.url ? (
              <Text size={13} mono color={theme.colors.mut} selectable numberOfLines={1}>
                {row.url}
              </Text>
            ) : null}
          </View>
          {row.url || row.canStop ? (
            <RowButtons>
              {row.url ? (
                <Button
                  label={copy.open}
                  variant="secondary"
                  accessibilityHint={tMobile('screens2.common.opensUrl', { url: row.url ?? '' })}
                  onPress={() => openUrl(row.url as string)}
                  style={{ paddingHorizontal: 18 }}
                />
              ) : null}
              {row.canStop ? (
                <Button
                  label={copy.stop}
                  variant="secondary"
                  disabled={stop.isPending}
                  busy={stop.isPending && stop.variables?.id === row.id}
                  accessibilityHint={row.stopLabel}
                  onPress={() => press(row.id, row.name)}
                  style={{ paddingHorizontal: 18 }}
                />
              ) : null}
            </RowButtons>
          ) : null}
        </View>
      ))}
      <CardLine text={problem} tone="bad" />
    </Section>
  );
}
