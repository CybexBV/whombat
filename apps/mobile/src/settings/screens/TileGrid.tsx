/**
 * The editor's grid on the phone (Whombat desk-display.md DK-145, DK-160, DK-162; desk-display-android.md
 * AP-6012…AP-6014, AP-6122): the screen's cells in its dark look, whatever the phone's theme, and each widget of the page
 * shown as a labelled tile — its mark, its name (and what it belongs to) and its size, no live drawing — in its cells; a
 * photo or a board says so with an icon (a picture, a grid of tiles), beside its size where it has a brand mark. A tile is a button that
 * opens the widget's sheet; the chosen one has the brand's outline. The tiles are placed over the cells but come in
 * reading order (row by row, left to right), so TalkBack reads them as the eye does. A grid too wide for the phone
 * scrolls sideways rather than drawing cells too small to touch.
 */
import { isBrandMark } from '@whombat/brand';
import type { DeskWidget, DeskWidgetType } from '@whombat/client/desk';
import type { Grid } from '@whombat/screen';
import { nativeThemes } from '@whombat/tokens';
import { memo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { BrandMark } from '../../ui/BrandMark';

import { Touchable } from '../../ui/Touchable';
import {
  PHONE_SCREENS_TEXT,
  TILE_SLOP,
  type TileGeometry,
  type TileLabel,
  tileFace,
  tileGeometry,
  tileRect,
  tileSpoken,
} from './tiles';
import { VIEW_ICONS, widgetIcon } from './WidgetLogo';

/** The screen is dark (DK-134): its tokens, whatever the phone's theme. */
const C = nativeThemes.dark.colors;
/** The frame around the cells, as the screen's edge. */
const FRAME = 6;

export function TileGrid({
  grid,
  widgets,
  labelOf,
  selected,
  onPress,
  empty,
}: {
  grid: Pick<Grid, 'cols' | 'rows' | 'cw' | 'ch'>;
  /** The page's widgets in reading order. */
  widgets: readonly DeskWidget[];
  labelOf: (w: DeskWidget) => TileLabel;
  selected: string | null;
  onPress: (id: string) => void;
  /** Said in the middle of an empty page. */
  empty: string;
}) {
  const [room, setRoom] = useState(0);
  const geometry = room > 0 ? tileGeometry(grid, room) : null;
  const cells = geometry ? (
    <Cells geometry={geometry}>
      {widgets.map((w) => (
        <Tile
          key={w.id}
          widget={w}
          label={labelOf(w)}
          geometry={geometry}
          chosen={selected === w.id}
          onPress={onPress}
        />
      ))}
      {widgets.length === 0 ? (
        <View
          style={{
            width: geometry.width,
            height: geometry.height,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <Text size={14} lh={1.45} color={C.mut} style={{ textAlign: 'center' }}>
            {empty}
          </Text>
        </View>
      ) : null}
    </Cells>
  ) : null;
  return (
    <View
      onLayout={(e) => setRoom(Math.max(0, e.nativeEvent.layout.width - 2 * FRAME - 2))}
      // Nearer the phone's edges than the page's other cards: the cells get the room.
      style={{
        marginHorizontal: -8,
        borderRadius: 14,
        backgroundColor: C.bg,
        padding: FRAME,
        borderWidth: 1,
        borderColor: C.line,
      }}
    >
      {geometry?.scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ paddingBottom: 6 }}>
          {cells}
        </ScrollView>
      ) : (
        cells
      )}
    </View>
  );
}

/** The cells, faint, under the tiles. */
function Cells({ geometry, children }: { geometry: TileGeometry; children: React.ReactNode }) {
  const empty = [];
  for (let y = 0; y < geometry.rows; y++)
    for (let x = 0; x < geometry.cols; x++) {
      const r = tileRect(geometry, { x, y, w: 1, h: 1 });
      empty.push(
        <View
          key={`${x},${y}`}
          style={{
            position: 'absolute',
            ...r,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: C.line,
            borderStyle: 'dashed',
          }}
        />,
      );
    }
  return (
    <View style={{ width: geometry.width, height: geometry.height }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {empty}
      </View>
      {children}
    </View>
  );
}

const Tile = memo(function Tile({
  widget,
  label,
  geometry,
  chosen,
  onPress,
}: {
  widget: DeskWidget;
  label: TileLabel;
  geometry: TileGeometry;
  chosen: boolean;
  onPress: (id: string) => void;
}) {
  const { rawLocale } = useI18n();
  const r = tileRect(geometry, widget);
  const face = tileFace(r);
  // What it draws, beside its size, where its brand mark doesn't say it's a photo or a board.
  const Drawn = label.view && label.mark && isBrandMark(label.mark) ? VIEW_ICONS[label.view] : undefined;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={tileSpoken(label, widget, rawLocale)}
      accessibilityHint={PHONE_SCREENS_TEXT.tapHint}
      accessibilityState={{ selected: chosen }}
      onPress={() => onPress(widget.id)}
      feedback="fade"
      ringRadius={8}
      hitSlop={{ top: TILE_SLOP, bottom: TILE_SLOP, left: TILE_SLOP, right: TILE_SLOP }}
      style={{
        position: 'absolute',
        ...r,
        borderRadius: 8,
        borderWidth: chosen ? 2 : 1,
        borderColor: chosen ? C.brand : C.line2,
        backgroundColor: chosen ? C.sf2 : C.sf,
        padding: face === 'mark' ? 0 : 7,
        alignItems: face === 'mark' ? 'center' : 'stretch',
        justifyContent: face === 'mark' ? 'center' : 'flex-start',
        overflow: 'hidden',
      }}
    >
      {face === 'mark' ? (
        <Mark
          type={widget.type}
          view={label.view}
          mark={label.mark}
          name={label.of ?? label.name}
          size={16}
        />
      ) : (
        <>
          {/* A full tile has its mark over its name, so the name has the tile's width (“Internet” in 2 × 2). */}
          <View style={face === 'full' ? { gap: 4 } : { flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Mark
              type={widget.type}
              view={label.view}
              mark={label.mark}
              name={label.of ?? label.name}
              size={face === 'full' ? 16 : 14}
            />
            <Text
              size={12}
              weight={600}
              lh={1.25}
              color={C.ink}
              numberOfLines={face === 'full' ? 2 : 1}
              allowFontScaling={false}
              style={face === 'full' ? undefined : { flex: 1 }}
            >
              {label.name}
            </Text>
          </View>
          {face === 'full' ? (
            <>
              {label.of ? (
                <Text size={11} lh={1.3} color={C.mut} numberOfLines={1} allowFontScaling={false}>
                  {label.of}
                </Text>
              ) : null}
              <View style={{ flex: 1 }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                {Drawn ? <Drawn size={12} color={C.mut} strokeWidth={1.75} /> : null}
                <Text size={11} color={C.mut} allowFontScaling={false}>
                  {`${widget.w} × ${widget.h}`}
                </Text>
              </View>
            </>
          ) : null}
        </>
      )}
    </Touchable>
  );
});

/**
 * A widget's mark: its brand's where `@whombat/brand` has one; a photo's or a board's icon; its type's icon for
 * Whombat's own; else a letter.
 */
function Mark({
  type,
  view,
  mark,
  name,
  size,
}: {
  type: DeskWidgetType;
  view?: string | null | undefined;
  mark: string | null;
  name: string;
  size: number;
}) {
  if (mark && isBrandMark(mark)) return <BrandMark mark={mark} size={size} color={C.ink} />;
  if (!mark || type === 'server' || (view && VIEW_ICONS[view])) {
    const Icon = widgetIcon(type, view);
    return <Icon size={size} color={C.ink2} strokeWidth={1.75} />;
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.27,
        backgroundColor: C.brand,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text size={size * 0.6} weight={700} color={C.bg} allowFontScaling={false}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}
