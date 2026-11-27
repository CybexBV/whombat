/**
 * A gallery on the phone (contracts 0.121, CT-1004; Whombat service-dashboards.md SD-20…SD-32; service-dashboards.md
 * AP-4636…AP-4639): posters (2:3) in one row that scrolls sideways — Recently added, requests waiting for approval —,
 * camera snapshots (16:9) two by two, thumbnails (1:1) three by three. Under each picture its title (two lines at most),
 * `sub` (or when), a 4dp progress bar with its note, then its buttons; a badge on the picture's corner, solid so it reads
 * over any poster, with a dot in its tone; an offline camera greyed. The picture and its words are one link — a page of
 * the app, or the service's own page in the browser (a small outside mark after the title) — read as its words in
 * order; the buttons stay outside it, so TalkBack reaches both.
 */
import { type ThingGalleryPanel, thingImageInitial } from '@whombat/client';
import type { ThingImageShape, ThingTone } from '@whombat/core';
import { type ReactNode, useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { type GalleryItemView, galleryItems, galleryLayout, rowsOf } from '../../data/servicePanels';
import { useI18n } from '../../i18n';
import { Meter } from '../../managed/HostCharts';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard, toneOf } from '../../ui/assistant';
import { ArrowUpRight } from '../../ui/icons';
import { Touchable } from '../../ui/Touchable';
import type { PanelContext } from './Panels';
import { ThingPicture } from './Picture';
import { CardQuiet, PanelLink } from './parts';
import { ItemButtons, PanelButtons } from './ThingButton';

export function GalleryCard({ panel, ctx }: { panel: ThingGalleryPanel; ctx: PanelContext }) {
  const { rawLocale } = useI18n();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const items = useMemo(
    () => galleryItems(panel, now, timeZone, rawLocale),
    [panel, now, timeZone, rawLocale],
  );
  const layout = galleryLayout(panel.shape);
  return (
    <OneCard
      meta={panel.meta}
      label={panel.title}
      right={<PanelLink link={panel.link} tabs={ctx.tabs} run={ctx.run} />}
    >
      <PanelButtons buttons={panel.buttons} act={ctx.act?.buttons} />
      {items.length === 0 ? (
        <CardQuiet text={panel.empty ?? ''} first />
      ) : layout.kind === 'row' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 2, paddingBottom: 14, gap: 12 }}
        >
          {items.map((it) => (
            <View key={it.id} style={{ width: layout.width }}>
              <GalleryItem item={it} shape={panel.shape} ctx={ctx} />
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={{ paddingHorizontal: 14, paddingTop: 2, paddingBottom: 14, gap: 14 }}>
          {rowsOf(items, layout.columns).map((row) => (
            <View key={row.map((r) => r.id).join('|')} style={{ flexDirection: 'row', gap: 10 }}>
              {row.map((it) => (
                <View key={it.id} style={{ flex: 1, minWidth: 0 }}>
                  <GalleryItem item={it} shape={panel.shape} ctx={ctx} />
                </View>
              ))}
              {/* A short last row keeps its columns' widths. */}
              {Array.from({ length: layout.columns - row.length }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: empty places at the end of a row
                <View key={`gap-${i}`} style={{ flex: 1 }} />
              ))}
            </View>
          ))}
        </View>
      )}
    </OneCard>
  );
}

const TITLE_SIZE: Record<ThingImageShape, number> = { poster: 13.5, wide: 14, square: 12.5 };

function GalleryItem({
  item,
  shape,
  ctx,
}: {
  item: GalleryItemView;
  shape: ThingImageShape;
  ctx: PanelContext;
}) {
  const theme = useTheme();
  const words = item.muted ? theme.colors.mut : theme.colors.ink;
  const content: ReactNode = (
    <>
      <View>
        <ThingPicture
          thing={ctx.thing.id}
          image={item.image}
          shape={shape}
          initial={item.initial || thingImageInitial(item.title)}
          radius={shape === 'square' ? 8 : 10}
          letterSize={shape === 'square' ? 18 : 24}
          muted={item.muted}
        />
        {item.badge ? <PictureBadge text={item.badge.text} tone={item.badge.tone} /> : null}
      </View>
      <View style={{ gap: 2, marginTop: 7 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 3 }}>
          <Text
            size={TITLE_SIZE[shape]}
            weight={600}
            lh={1.3}
            color={words}
            numberOfLines={2}
            style={{ flexShrink: 1 }}
          >
            {item.title}
          </Text>
          {item.link?.kind === 'url' ? (
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ marginTop: 2 }}
            >
              <ArrowUpRight size={13} color={theme.colors.mut} strokeWidth={2} />
            </View>
          ) : null}
        </View>
        {item.sub ? (
          <Text size={12} lh={1.35} color={theme.colors.mut} numberOfLines={2}>
            {item.sub}
          </Text>
        ) : null}
      </View>
      {item.pct !== null ? (
        <View style={{ marginTop: 7 }}>
          <Meter pct={item.pct} color={theme.chart.chart1} height={4} flush />
        </View>
      ) : null}
      {item.note ? (
        <Text size={11.5} mono color={theme.colors.mut} numberOfLines={2} style={{ marginTop: 4 }}>
          {item.note}
        </Text>
      ) : null}
    </>
  );
  const link = item.link;
  return (
    <View style={{ gap: 9 }}>
      {link ? (
        <Touchable
          onPress={() => ctx.run(link)}
          feedback="fade"
          ringRadius={10}
          accessibilityRole="link"
          accessibilityLabel={item.spoken}
          {...(item.linkHint ? { accessibilityHint: item.linkHint } : {})}
        >
          {content}
        </Touchable>
      ) : (
        <View accessible accessibilityLabel={item.spoken}>
          {content}
        </View>
      )}
      <ItemButtons
        buttons={item.actions}
        act={ctx.act?.buttons}
        about={item.title}
        column={shape === 'poster'}
      />
    </View>
  );
}

/** A badge on a picture's corner (“Converting”, “Offline”): solid `sf` so it reads over any picture, a dot in its tone. */
function PictureBadge({ text, tone }: { text: string; tone: ThingTone }) {
  const theme = useTheme();
  const dot = tone === 'ok' || tone === 'warn' || tone === 'bad' ? toneOf(theme, tone) : theme.colors.mut;
  return (
    <View
      style={{
        position: 'absolute',
        top: 6,
        left: 6,
        maxWidth: '88%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 7,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
      <Text size={10.5} weight={600} color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
        {text}
      </Text>
    </View>
  );
}
