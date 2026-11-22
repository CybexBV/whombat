/**
 * A Mac's Find My segment on the phone (docs/implementation/macos/findmy.md §5): the people Find My shows on the Mac,
 * read when the segment opens on an old read, every 15 minutes while it stays open and on “Read again”; the Mac's map
 * in the app's theme with each person's avatar and first name on it, ＋ and − to zoom and “Fit everyone”; and for one
 * person “Show exactly”, Find My's own map cut from the Mac's screen, in a sheet. The words are the web's
 * (`findMyView`, `FIND_MY_WORDS`); the screen's own reason comes first, as on the Screen segment.
 */
import { HUMAN_TONES, initialsFor } from '@whombat/avatars';
import {
  FIND_MY_WORDS,
  type FindMyPersonRow,
  type FindMyRegion,
  findMyCanZoom,
  findMyExactView,
  findMyMapAsk,
  findMyMapRegion,
  findMyPins,
  findMyView,
  findMyZoom,
  hostErrorInfo,
  macScreenView,
} from '@whombat/client/hosts';
import { useFindMyMap, useFindMyPicture, useFindMyTab } from '@whombat/client/hosts/react';
import type { HostFindMy, HostServerDetail } from '@whombat/core';
import { useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { HumanAvatar } from '../../avatars/Avatars';
import { useBurrowBase, useNowStore } from '../../data/BurrowProvider';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Dot, OneCard } from '../../ui/assistant';
import { Minus, Plus } from '../../ui/icons';
import { Button } from '../../ui/primitives';
import { Sheet } from '../../ui/sheet';
import { Touchable } from '../../ui/Touchable';
import { showFailure } from '../feedback';
import { CardQuiet } from '../guest/parts';

/** The map's height: room for a town without pushing the people off the screen. */
const MAP_HEIGHT = 232;

const toneOf = (p: Pick<FindMyPersonRow, 'tone'>) => HUMAN_TONES[p.tone] ?? HUMAN_TONES[0];

export function MacFindMyPart({
  serverId,
  serverName,
  detail,
  now,
}: {
  serverId: string;
  serverName: string;
  detail: HostServerDetail;
  now: number;
}) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const clock = useNowStore();
  // The person may change their own servers; the server's switches decide the rest.
  const screen = macScreenView(detail, { name: serverName, owner: true, now })?.screen ?? null;
  // The app's clock, which is the demo world's own in the demo.
  const tab = useFindMyTab({
    burrow: slug,
    serverId,
    canRead: !!screen?.can,
    clock: () => clock.get().getTime(),
  });
  const [exactFor, setExactFor] = useState<FindMyPersonRow | null>(null);
  if (!screen) return null;
  const view = findMyView(tab.state, { name: serverName, now, screen });
  const status =
    tab.error && !tab.state ? { tone: 'bad' as const, text: hostErrorInfo(tab.error).message } : view.status;

  return (
    <>
      <OneCard label={FIND_MY_WORDS.title} meta={view.readLine}>
        {status ? (
          <View
            accessible
            accessibilityLiveRegion="polite"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 14,
              paddingBottom: 12,
            }}
          >
            {status.tone === 'mut' ? (
              <ActivityIndicator size="small" color={theme.colors.mut} />
            ) : (
              <Dot tone={status.tone === 'ok' ? 'ok' : status.tone} />
            )}
            <Text size={14} lh={1.45} color={theme.colors.mut} style={{ flex: 1 }}>
              {status.text}
            </Text>
          </View>
        ) : null}
        {view.anyLocated ? (
          <FindMyMap
            slug={slug}
            serverId={serverId}
            name={serverName}
            state={tab.state}
            people={view.people}
          />
        ) : null}
        {view.anyLocated ? <CardQuiet>{FIND_MY_WORDS.note}</CardQuiet> : null}
        <View style={{ flexDirection: 'row', padding: 14, paddingTop: view.anyLocated ? 0 : 4 }}>
          <Button
            label={FIND_MY_WORDS.readAgain}
            variant="secondary"
            disabled={!view.canRead}
            busy={tab.asking}
            onPress={() =>
              void tab.readNow().then((problem) => {
                if (problem) showFailure(problem);
              })
            }
            style={{ flexGrow: 1 }}
          />
        </View>
      </OneCard>

      {view.people.length > 0 || view.empty ? (
        <OneCard label={FIND_MY_WORDS.people}>
          {view.empty ? (
            <CardQuiet>{view.empty}</CardQuiet>
          ) : (
            view.people.map((p, i) => (
              <PersonRow
                key={p.id}
                person={p}
                first={i === 0}
                canShow={screen.can}
                onShow={() => {
                  setExactFor(p);
                  void tab.showExactly(p.id).then((problem) => {
                    if (problem) {
                      setExactFor(null);
                      showFailure(problem);
                    }
                  });
                }}
              />
            ))
          )}
        </OneCard>
      ) : null}

      <Sheet
        visible={!!exactFor}
        onClose={() => setExactFor(null)}
        label={exactFor ? FIND_MY_WORDS.exactTitle(exactFor.name) : FIND_MY_WORDS.showExactly}
        surface="sf"
      >
        {exactFor ? (
          <ExactPicture
            slug={slug}
            serverId={serverId}
            server={serverName}
            person={exactFor}
            state={tab.state}
            now={now}
            onClose={() => setExactFor(null)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

/** One person: their avatar, name and “Home · Now”, “Nearby” when Find My says so, and Show exactly. */
function PersonRow({
  person: p,
  first,
  canShow,
  onShow,
}: {
  person: FindMyPersonRow;
  first: boolean;
  canShow: boolean;
  onShow: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 11,
        paddingHorizontal: 14,
        minHeight: 52,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessible
        accessibilityLabel={[p.name, p.line, p.nearby ? FIND_MY_WORDS.nearby : null]
          .filter(Boolean)
          .join(', ')}
        style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <HumanAvatar initials={initialsFor(p.name)} tone={toneOf(p)} size={36} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text size={15} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
              {p.name}
            </Text>
            {p.nearby ? (
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 1,
                  borderRadius: 999,
                  backgroundColor: theme.colors.sf2,
                }}
              >
                <Text size={11.5} weight={500} color={theme.colors.ok}>
                  {FIND_MY_WORDS.nearby}
                </Text>
              </View>
            ) : null}
          </View>
          <Text size={13} color={theme.colors.mut} numberOfLines={2}>
            {p.line}
          </Text>
        </View>
      </View>
      {p.placed ? (
        <Button
          label={FIND_MY_WORDS.showExactly}
          variant="secondary"
          disabled={!canShow}
          onPress={onShow}
          accessibilityLabel={FIND_MY_WORDS.showExactlyLabel(p.name)}
        />
      ) : null}
    </View>
  );
}

/** The Mac's map at the card's width, each person with a spot as an avatar and first name, with ＋, − and Fit everyone. */
function FindMyMap({
  slug,
  serverId,
  name,
  state,
  people,
}: {
  slug: string;
  serverId: string;
  name: string;
  state: HostFindMy | undefined;
  people: readonly FindMyPersonRow[];
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const box = { w: width, h: MAP_HEIGHT };
  const [region, setRegion] = useState<FindMyRegion | null>(null);
  const ask = findMyMapAsk(box);
  const map = useFindMyMap({
    burrow: slug,
    serverId,
    ask,
    dark: theme.dark,
    region,
    enabled: !!state?.readAt,
  });
  const shown = map.shown;
  const drawn = shown ? findMyMapRegion(shown.map) : null;
  // From the region drawn last, so a zoom while one is drawn goes on from what the person sees.
  const zoom = (dir: 'in' | 'out') => drawn && setRegion(findMyZoom(drawn, dir));
  const byId = new Map(people.map((p) => [p.id, p]));
  const pins = shown ? findMyPins(shown.map.points, shown.ask, box) : [];
  const control = {
    width: 44,
    height: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  return (
    <View
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      style={{
        height: MAP_HEIGHT,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf2,
        marginBottom: 10,
      }}
    >
      {shown ? (
        <Image
          source={{ uri: `data:image/${shown.map.format};base64,${shown.map.imageB64}` }}
          resizeMode="cover"
          accessible
          accessibilityLabel={FIND_MY_WORDS.mapAlt(name)}
          style={{ width: '100%', height: '100%', opacity: map.drawing ? 0.75 : 1 }}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {map.error ? null : <ActivityIndicator color={theme.colors.mut} />}
        </View>
      )}
      <View
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
          overflow: 'hidden',
        }}
      >
        <Touchable
          feedback="wash"
          ringRadius={12}
          accessibilityLabel={FIND_MY_WORDS.zoomIn}
          disabled={!drawn || !findMyCanZoom(drawn, 'in')}
          onPress={() => zoom('in')}
          style={control}
        >
          <Plus size={18} color={theme.colors.ink} strokeWidth={2} />
        </Touchable>
        <View style={{ height: 1, backgroundColor: theme.colors.line }} />
        <Touchable
          feedback="wash"
          ringRadius={12}
          accessibilityLabel={FIND_MY_WORDS.zoomOut}
          disabled={!drawn || !findMyCanZoom(drawn, 'out')}
          onPress={() => zoom('out')}
          style={control}
        >
          <Minus size={18} color={theme.colors.ink} strokeWidth={2} />
        </Touchable>
      </View>
      {region ? (
        <Touchable
          feedback="wash"
          ringRadius={999}
          accessibilityLabel={FIND_MY_WORDS.fit}
          onPress={() => setRegion(null)}
          hitSlop={6}
          style={{
            position: 'absolute',
            right: 10,
            bottom: 10,
            minHeight: 36,
            paddingHorizontal: 12,
            justifyContent: 'center',
            borderRadius: 999,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
          }}
        >
          <Text size={13} weight={500}>
            {FIND_MY_WORDS.fit}
          </Text>
        </Touchable>
      ) : null}
      {/* Drawn last, over the zoom buttons, so nobody hides behind them (they let touches through). */}
      {pins.map((pin) => {
        const p = byId.get(pin.person);
        if (!p) return null;
        const label = (
          <View
            style={{
              paddingHorizontal: 7,
              paddingVertical: 1,
              borderRadius: 999,
              backgroundColor: theme.colors.sf,
              boxShadow: theme.shadows.toast.boxShadow,
            }}
          >
            <Text size={11.5} weight={600} numberOfLines={1}>
              {p.firstName}
            </Text>
          </View>
        );
        return (
          <View
            key={pin.person}
            pointerEvents="none"
            accessible
            accessibilityLabel={p.name}
            style={{
              position: 'absolute',
              left: pin.x - 50,
              top: pin.above ? pin.y - 15 - 23 : pin.y - 15,
              width: 100,
              alignItems: 'center',
              gap: 3,
            }}
          >
            {pin.above ? label : null}
            <View style={{ borderRadius: 17, borderWidth: 2, borderColor: theme.colors.sf }}>
              <HumanAvatar initials={initialsFor(p.name)} tone={toneOf(p)} size={30} />
            </View>
            {pin.above ? null : label}
          </View>
        );
      })}
    </View>
  );
}

/** “Exactly where Ilse de Wit is”: Find My's own map of one person, taken when asked and shown once it is ready. */
function ExactPicture({
  slug,
  serverId,
  server,
  person,
  state,
  now,
  onClose,
}: {
  slug: string;
  serverId: string;
  server: string;
  person: FindMyPersonRow;
  state: HostFindMy | undefined;
  now: number;
  onClose: () => void;
}) {
  const theme = useTheme();
  const view = findMyExactView(state, person.id, server, now);
  const picture = useFindMyPicture({ burrow: slug, serverId, state, person: person.id });
  const shot = view.kind === 'ready' ? picture.data : undefined;
  const problem =
    view.kind === 'failed'
      ? view.text
      : view.kind === 'ready' && picture.error
        ? hostErrorInfo(picture.error).message
        : null;
  return (
    <View style={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}>
      <View style={{ gap: 4 }}>
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          {FIND_MY_WORDS.exactTitle(person.name)}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.mut} accessibilityLiveRegion="polite">
          {problem ?? view.text}
        </Text>
      </View>
      <View
        style={{
          width: '100%',
          aspectRatio: shot && shot.w > 0 && shot.h > 0 ? shot.w / shot.h : 16 / 10,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf2,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {shot ? (
          <Image
            source={{ uri: `data:image/${shot.format};base64,${shot.imageB64}` }}
            resizeMode="cover"
            accessible
            accessibilityLabel={FIND_MY_WORDS.exactAlt(person.name, server)}
            style={{ width: '100%', height: '100%' }}
          />
        ) : problem ? null : (
          <ActivityIndicator color={theme.colors.mut} />
        )}
      </View>
      <Button label={FIND_MY_WORDS.close} variant="secondary" onPress={onClose} />
    </View>
  );
}
