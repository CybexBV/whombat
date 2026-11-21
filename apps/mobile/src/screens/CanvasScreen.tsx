/**
 * A canvas, read-only (mobile-parity.md MQ-05; contracts 0.55 `canvases.content`, CT-303): its title, who started it and
 * when it last changed, and its text rendered with the message renderer (headings, lists, tables, code, images,
 * diagrams' source). Canvas links (cards, receipts, messages, `whombat://canvases/<slug>`) open it instead of the
 * browser. Editing stays on the web: “Open on the web” goes there, as it does where the Whombat can't give the text
 * yet. Pull to refresh reads it again.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { queryHook } from '@whombat/client/react';
import { api } from '@whombat/core';
import { Linking, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { CANVAS_TEXT, canvasMeta, canvasProblem, canvasReadingMarkdown } from '../data/canvas';
import { APP_ORIGINS } from '../navigation/hooks';
import { type RootStackParamList, webUrlForLink } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { MessageBody } from '../ui/chat';
import { BackBar, Screen } from '../ui/headers';
import { Button, ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';

type Props = NativeStackScreenProps<RootStackParamList, 'Canvas'>;

/** `canvases.content` (contracts 0.55): the canvas and its Markdown in one request. */
const useCanvasContent = queryHook(api.canvases.content);

export function CanvasScreen({ route, navigation }: Props) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const ctx = useViewContext();
  const query = useCanvasContent(
    { params: { burrow: slug, slug: route.params.slug } },
    {
      retry: false,
    },
  );
  const web = webUrlForLink(
    { type: 'canvas', slug: route.params.slug },
    slug,
    APP_ORIGINS[0] ?? 'https://app.whombat.com',
  );
  // The browser, not `useOpenUrl`: a Whombat link to a canvas would open this screen again.
  const openWeb = () => {
    if (web) void Linking.openURL(web).catch(() => {});
  };
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const data = query.data;
  const title = data?.canvas.title ?? route.params.title ?? route.params.slug;
  const problem = query.error ? canvasProblem(query.error) : null;

  return (
    <Screen>
      <BackBar label="Back" onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 28 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ paddingHorizontal: 22, paddingBottom: 16, gap: 6 }}>
          <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
            {CANVAS_TEXT.kicker}
          </Text>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {title}
          </Text>
          {data ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {canvasMeta(data, ctx)}
            </Text>
          ) : null}
        </View>
        {problem ? (
          <View style={{ gap: 14 }}>
            <ErrorState
              text={problem.text}
              {...(problem.retry ? { onRetry: () => void query.refetch() } : {})}
            />
            {web && problem.retry ? (
              <View style={{ paddingHorizontal: 22 }}>
                <Button label={CANVAS_TEXT.openOnWeb} variant="quiet" onPress={openWeb} />
              </View>
            ) : null}
          </View>
        ) : !data ? (
          <SkeletonRows count={6} lines={2} label="Loading the canvas" />
        ) : (
          <View style={{ paddingHorizontal: 22, gap: 18 }}>
            {data.markdown.trim() ? (
              <MessageBody text={canvasReadingMarkdown(data.markdown)} />
            ) : (
              <QuietText style={{ paddingHorizontal: 0 }}>{CANVAS_TEXT.empty}</QuietText>
            )}
            <View
              style={{
                gap: 10,
                paddingTop: 14,
                borderTopWidth: 1,
                borderTopColor: theme.colors.line,
              }}
            >
              <Text size={13} lh={1.45} color={theme.colors.mut}>
                {CANVAS_TEXT.readOnly}
              </Text>
              {web ? <Button label={CANVAS_TEXT.openOnWeb} variant="secondary" onPress={openWeb} /> : null}
            </View>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
