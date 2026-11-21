/**
 * Usage (the Spend report under its one name; docs/design-handoff/council-ui-2026-11/16-final/usage/,
 * docs/decisions/final-settings-vault-files-usage.md), the same on iPhone and Android and in the web's words
 * (`usageView`): what it cost and how many times the assistant worked in the chosen window, how many of those times
 * reported a cost, the window and when the report was prepared, then More — that the report combines every provider,
 * the text read and written with the missing reports, and what saved plans used. The window chooser stays while the
 * report loads, is empty or can't be read. Read again on open and on pull; nothing here is live.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { USAGE_TEXT, USAGE_WINDOWS, type UsageWindow, usageView } from '@whombat/client';
import { useSpendOverview } from '@whombat/client/react';
import { useState } from 'react';
import { Platform, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FoldText, MoreFold } from '../ui/fold';
import { BackBar, Screen } from '../ui/headers';
import { ChartNoAxesColumn } from '../ui/icons';
import { PLACE_SIDE, PlaceState, PlaceTitle } from '../ui/place';
import { PlacesButton } from '../ui/places';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';

type Props = NativeStackScreenProps<RootStackParamList, 'Spend'>;

/** Android's targets are 48dp, iPhone's 44pt. */
const TARGET = Platform.OS === 'android' ? 48 : 44;

export function SpendScreen({ navigation, route }: Props) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug } = useBurrow();
  const overview = useSpendOverview({ params: { burrow: slug } });
  const words = useAgentWords();
  const [window, setWindow] = useState<UsageWindow>('today');
  const view = overview.data ? usageView(overview.data, words.name) : null;
  const shown = view?.windows[window];
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));

  return (
    <Screen>
      <BackBar
        label={route.params?.back ?? 'Back'}
        onPress={goBack}
        right={<PlacesButton current="usage" here={USAGE_TEXT.title} />}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: PLACE_SIDE, paddingBottom: 28 + bottomRoom, gap: 18 }}
        refreshControl={
          <RefreshControl
            refreshing={overview.isRefetching}
            onRefresh={() => void overview.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <PlaceTitle title={USAGE_TEXT.title} intro={USAGE_TEXT.intro(words.name)} />
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={USAGE_TEXT.windowsLabel}
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
        >
          {USAGE_WINDOWS.map((w) => {
            const on = w === window;
            return (
              <Touchable
                key={w}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={USAGE_TEXT.windows[w]}
                feedback={on ? 'fade' : 'wash'}
                ringRadius={12}
                onPress={() => setWindow(w)}
                style={{
                  minHeight: TARGET,
                  paddingHorizontal: 14,
                  justifyContent: 'center',
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: on ? theme.colors.btn : theme.colors.line2,
                  backgroundColor: on ? theme.colors.btn : theme.colors.sf,
                }}
              >
                <Text size={15} weight={on ? 600 : 500} color={on ? theme.colors.btnfg : theme.colors.ink}>
                  {USAGE_TEXT.windows[w]}
                </Text>
              </Touchable>
            );
          })}
        </View>

        {!view || !shown ? (
          overview.error ? (
            <PlaceState
              kind="failed"
              icon={ChartNoAxesColumn}
              title={USAGE_TEXT.failedTitle}
              line={USAGE_TEXT.failedLine}
              retryLabel={USAGE_TEXT.retry}
              onRetry={() => void overview.refetch()}
            />
          ) : (
            <PlaceState kind="loading" icon={ChartNoAxesColumn} title={USAGE_TEXT.loading} />
          )
        ) : (
          <>
            <Text size={12} mono lh={1.5} color={theme.colors.ink2} style={{ marginTop: -6 }}>
              {shown.span}
            </Text>
            {shown.empty ? (
              <PlaceState
                kind="empty"
                icon={ChartNoAxesColumn}
                title={USAGE_TEXT.emptyTitle}
                line={USAGE_TEXT.emptyLine}
              />
            ) : (
              <>
                <View accessible accessibilityLabel={shown.spoken} style={{ gap: 12 }}>
                  <Tile label={USAGE_TEXT.cost} meta={shown.coverage}>
                    {shown.cost ? (
                      <View
                        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}
                      >
                        <Text size={38} weight={700} tracking={-0.03}>
                          {shown.cost}
                        </Text>
                        <Text size={13} mono color={theme.colors.ink2}>
                          {USAGE_TEXT.unit}
                        </Text>
                      </View>
                    ) : (
                      <Text size={20} weight={600}>
                        {USAGE_TEXT.noCost}
                      </Text>
                    )}
                  </Tile>
                  <Tile label={view.worked}>
                    <Text size={38} weight={700} tracking={-0.03}>
                      {String(shown.times)}
                    </Text>
                  </Tile>
                </View>
                <Text size={16} lh={1.5}>
                  {USAGE_TEXT.definition}
                </Text>
              </>
            )}
            <Text size={13.5} lh={1.5} color={theme.colors.ink2}>
              {view.prepared}
            </Text>
            <View
              style={{
                borderRadius: 18,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.sf,
                paddingHorizontal: 16,
                paddingVertical: 4,
              }}
            >
              <MoreFold label={USAGE_TEXT.more}>
                <MoreBlock title={USAGE_TEXT.coverageTitle} lines={USAGE_TEXT.coverageLines} />
                {shown.empty ? null : (
                  <MoreBlock
                    title={USAGE_TEXT.textTitle}
                    strong={shown.text}
                    lines={[USAGE_TEXT.textLine(words.name), shown.reports]}
                  />
                )}
                {view.plans.length > 0 ? (
                  <MoreBlock title={USAGE_TEXT.plansTitle} lines={[...view.plans, USAGE_TEXT.plansLine]} />
                ) : null}
              </MoreFold>
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Tile({ label, meta, children }: { label: string; meta?: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 8,
        padding: 20,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={15}>{label}</Text>
      {children}
      {meta ? (
        <Text size={12} mono lh={1.5} color={theme.colors.ink2}>
          {meta}
        </Text>
      ) : null}
    </View>
  );
}

function MoreBlock({ title, strong, lines }: { title: string; strong?: string; lines: readonly string[] }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 6, paddingVertical: 12, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
      <Text size={18} weight={700} accessibilityRole="header">
        {title}
      </Text>
      {strong ? (
        <Text size={15} weight={600}>
          {strong}
        </Text>
      ) : null}
      {lines.map((line) => (
        <FoldText key={line}>{line}</FoldText>
      ))}
    </View>
  );
}
