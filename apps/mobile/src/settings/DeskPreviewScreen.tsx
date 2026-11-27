/**
 * Settings → Screen's preview (Whombat desk-display.md DK-110…DK-117, DK-123; desk-display-android.md AP-5863): the
 * box's calm glance (`DeskPreview`) drawn as the screen draws it, at the screen's 1280 × 800 design size and scaled to
 * the card's width, in the desk's dark look whatever the phone's theme — the top bar with the name and its quiet chips,
 * the clock with the sentence, the hero and what else waits or up to three things going on, and the servers' strip with
 * each one's last hour. A picture to the eye: TalkBack reads it as one line (`deskPreviewSpoken`). A look the assistant
 * looked into (Whombat look-research.md LR-09, LR-10; look-research-mobile.md AP-5924) shows its words by its face, a
 * ring before them while it works on it, green once fixed, and the screen's buttons for it (`deskHeroButtons`): the step
 * first, Open, Ignore.
 */
import { isBrandMark } from '@whombat/brand';
import { deskHeroButtons } from '@whombat/client';
import {
  type DeskCalm,
  type DeskMoment,
  type DeskPreview,
  type DeskStripServer,
  fillDeskWords,
  formatPowerLeft,
} from '@whombat/client/desk';
import type { AgentFace } from '@whombat/core';
import { deskWords } from '@whombat/core/domain';
import { formatClock, monthName, weekdayName, zonedParts } from '@whombat/core/text';
import { nativeThemes } from '@whombat/tokens';
import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { WhombatAvatar } from '../avatars/Avatars';
import { useI18n } from '../i18n';
import { Text, type TextProps } from '../theme/Text';
import { BrandMark } from '../ui/BrandMark';
import { tint } from '../ui/glanceColors';
import { deskPreviewSpoken } from './deskScreen';

/** The screen's design size (the console's page is drawn for it). */
const W = 1280;
const H = 800;
/** The desk is dark (DK-101): its tokens, whatever the phone's theme. */
const C = nativeThemes.dark.colors;

const TONE: Record<DeskCalm['headline']['tone'], string> = {
  ok: C.ok,
  busy: C.brand,
  warn: C.warn,
  bad: C.bad,
};

/** Text at the screen's size: no system font scaling, it's a drawing. */
function T({ color = C.ink, ...props }: TextProps) {
  return <Text allowFontScaling={false} color={color} numberOfLines={1} {...props} />;
}

/** A thing's mark: its brand where `@whombat/brand` has it, else its first letter on a tile. */
function Mark({ mark, name, size }: { mark?: string | undefined; name: string; size: number }) {
  if (mark && isBrandMark(mark))
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <BrandMark mark={mark} size={size} color={C.ink} />
      </View>
    );
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
      <T size={size * 0.46} weight={700} color={C.bg}>
        {name.slice(0, 1).toUpperCase()}
      </T>
    </View>
  );
}

export function DeskPreviewScreen({
  preview,
  assistant,
  face,
  timeZone,
  now,
}: {
  preview: DeskPreview;
  assistant: string;
  /** The assistant's face, by what it says about a look it looked into. */
  face?: AgentFace;
  timeZone: string;
  now: number;
}) {
  const { rawLocale } = useI18n();
  const [width, setWidth] = useState(0);
  const scale = width / W;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={deskPreviewSpoken(preview, rawLocale)}
      style={{ borderRadius: 10, padding: 6, backgroundColor: C.code }}
    >
      {/* The screen inside its bezel: the drawing scales to this width, not the bezel's. */}
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{
          width: '100%',
          aspectRatio: W / H,
          borderRadius: 5,
          overflow: 'hidden',
          backgroundColor: C.bg,
        }}
      >
        {width > 0 ? (
          <View
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            style={{
              width: W,
              height: H,
              transform: [{ scale }],
              transformOrigin: 'top left',
            }}
          >
            <Glance
              calm={preview.calm}
              name={preview.name}
              assistant={assistant}
              face={face}
              timeZone={timeZone}
              now={now}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The hero's research as the screen draws it: none for a question, without one, or once it failed (as before). */
function heroResearch(hero: DeskCalm['hero']) {
  return hero?.kind === 'look' && hero.research !== 'failed' ? hero.research : undefined;
}

/** The hero's colour: red for a problem, amber for a look, green once the assistant fixed it. */
function heroTone(hero: NonNullable<DeskCalm['hero']>): string {
  if (heroResearch(hero) === 'fixed') return C.ok;
  return hero.tone === 'bad' ? C.bad : C.warn;
}

function Glance({
  calm,
  name,
  assistant,
  face,
  timeZone,
  now,
}: {
  calm: DeskCalm;
  name: string;
  assistant: string;
  face: AgentFace | undefined;
  timeZone: string;
  now: number;
}) {
  const { rawLocale } = useI18n();
  const small = calm.clock === 'small' || calm.hero !== undefined;
  const tone = TONE[calm.headline.tone];
  const p = zonedParts(now, timeZone);
  const date = `${weekdayName(p.weekday, rawLocale)} ${p.day} ${monthName(p.month, rawLocale)}`;
  return (
    <View style={{ width: W, height: H, backgroundColor: C.bg }}>
      {calm.hero ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: 5,
            backgroundColor: heroTone(calm.hero),
          }}
        />
      ) : null}
      <TopBar calm={calm} name={name} />
      {small ? (
        <>
          <T size={96} weight={700} tracking={-0.045} style={{ position: 'absolute', left: 52, top: 82 }}>
            {formatClock(now, timeZone)}
          </T>
          <T size={26} color={C.mut} style={{ position: 'absolute', left: 330, top: 120 }}>
            {date}
          </T>
          <View
            style={{
              position: 'absolute',
              right: 56,
              top: 112,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: tone }} />
            <T size={38} weight={700} tracking={-0.02}>
              {calm.headline.text}
            </T>
          </View>
        </>
      ) : (
        <>
          <T size={210} weight={700} tracking={-0.045} style={{ position: 'absolute', left: 48, top: 70 }}>
            {formatClock(now, timeZone)}
          </T>
          <T size={28} color={C.mut} style={{ position: 'absolute', left: 58, top: 300 }}>
            {date}
          </T>
          <View style={{ position: 'absolute', right: 56, top: 118, width: 640, alignItems: 'flex-end' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: tone }} />
              <T size={50} weight={700} tracking={-0.02}>
                {calm.headline.text}
              </T>
            </View>
            {calm.headline.more ? (
              <T
                size={24}
                lh={1.35}
                color={C.mut}
                numberOfLines={2}
                style={{ marginTop: 10, textAlign: 'right' }}
              >
                {calm.headline.more}
              </T>
            ) : null}
          </View>
        </>
      )}
      {calm.hero ? (
        <Hero calm={calm} assistant={assistant} face={face} timeZone={timeZone} now={now} />
      ) : (
        <Moments calm={calm} assistant={assistant} />
      )}
      <Strip calm={calm} />
    </View>
  );
}

/** The top bar (DK-110): the name on the left, the chips the choices keep on the right, quiet and grey. */
function TopBar({ calm, name }: { calm: DeskCalm; name: string }) {
  const { rawLocale } = useI18n();
  const CW = deskWords(rawLocale).calm;
  const chips = [
    calm.bar.network === 'always' ? CW.bar.cable : null,
    calm.bar.internet === 'always' ? CW.bar.online : null,
    calm.update && calm.bar.updates !== 'off' ? CW.bar.updates[calm.update] : null,
  ].filter((c): c is string => c !== null);
  return (
    <View
      style={{
        position: 'absolute',
        left: 56,
        right: 56,
        top: 30,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <T size={22} weight={600}>
        {name}
      </T>
      <View style={{ flexDirection: 'row', gap: 22 }}>
        {chips.map((c) => (
          <T key={c} size={18} color={C.mut}>
            {c}
          </T>
        ))}
      </View>
    </View>
  );
}

/**
 * The hero and what else waits (DK-113, DK-114). A look the assistant looked into says so by its face, its title a
 * size down so the assistant's longer one stays on its line and its words on two lines at most.
 */
function Hero({
  calm,
  assistant,
  face,
  timeZone,
  now,
}: {
  calm: DeskCalm;
  assistant: string;
  face: AgentFace | undefined;
  timeZone: string;
  now: number;
}) {
  const { rawLocale } = useI18n();
  const CW = deskWords(rawLocale).calm;
  const hero = calm.hero;
  if (!hero) return null;
  const tone = heroTone(hero);
  const research = heroResearch(hero);
  const busy = research === 'looking' || research === 'fixing';
  const since = hero.since
    ? fillDeskWords(CW.since, {
        clock: formatClock(hero.since, timeZone),
        ago: formatPowerLeft((now - Date.parse(hero.since)) / 60_000, rawLocale),
      })
    : null;
  // The hero names a server by its hosts id; the button by the name the strip shows.
  const server = hero.server ? (calm.strip.find((s) => s.id === hero.server)?.name ?? hero.server) : null;
  const buttons = deskHeroButtons(hero, { assistant, server });
  return (
    <>
      <View
        style={{
          position: 'absolute',
          left: 56,
          right: 56,
          top: 214,
          height: 300,
          borderRadius: 28,
          paddingVertical: 38,
          paddingHorizontal: 44,
          borderWidth: 1.5,
          borderColor: tint(tone, 0.53),
          backgroundColor: tint(tone, 0.08),
        }}
      >
        {since ? (
          <T size={18} mono tracking={0.06} color={tone} uppercase>
            {since}
          </T>
        ) : null}
        <T size={research ? 46 : 64} weight={700} tracking={-0.02} style={{ marginTop: 14 }}>
          {hero.title}
        </T>
        {hero.detail && research ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14, marginTop: 10 }}>
            <WhombatAvatar face={face} size={40} crop="head" />
            {busy ? (
              <View
                style={{
                  width: 22,
                  height: 22,
                  marginTop: 5,
                  borderRadius: 11,
                  borderWidth: 3,
                  borderColor: C.line2,
                  borderTopColor: C.brand,
                }}
              />
            ) : null}
            <T size={24} lh={1.3} color={C.ink2} numberOfLines={2} style={{ flex: 1 }}>
              {hero.detail}
            </T>
          </View>
        ) : hero.detail ? (
          <T size={26} color={C.mut} style={{ marginTop: 12 }}>
            {hero.detail}
          </T>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 'auto' }}>
          {buttons.map((b) => (
            <View
              key={b.label}
              style={{
                paddingVertical: 14,
                paddingHorizontal: b.look === 'quiet' ? 8 : 28,
                borderRadius: 999,
                borderWidth: b.look === 'outline' ? 1.5 : 0,
                borderColor: C.line2,
                backgroundColor: b.look === 'primary' ? C.brand : 'transparent',
              }}
            >
              <T
                size={24}
                weight={600}
                color={b.look === 'primary' ? C.bg : b.look === 'quiet' ? C.mut : C.ink}
              >
                {b.label}
              </T>
            </View>
          ))}
        </View>
      </View>
      <View style={{ position: 'absolute', left: 60, right: 56, top: 540, gap: 6 }}>
        {calm.also.map((a) => (
          <View
            key={`${a.name}${a.text}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 14, height: 40 }}
          >
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: a.tone === 'bad' ? C.bad : C.warn,
              }}
            />
            <T size={23}>{a.name}</T>
            <T size={23} color={C.mut} style={{ flex: 1 }}>
              {a.text}
            </T>
            <T size={20} color={C.brand}>{`${CW.look} ›`}</T>
          </View>
        ))}
        {calm.moreNeeds > 0 ? (
          <T size={20} color={C.mut}>
            {fillDeskWords(CW.moreNeeds, { n: calm.moreNeeds })}
          </T>
        ) : null}
      </View>
    </>
  );
}

/** Up to three things going on (DK-115), with *Done today* at the label's right (DK-109). */
function Moments({ calm, assistant }: { calm: DeskCalm; assistant: string }) {
  const { rawLocale } = useI18n();
  const CW = deskWords(rawLocale).calm;
  if (calm.moments.length === 0) return null;
  const done =
    calm.doneCount !== undefined && calm.doneCount > 0
      ? fillDeskWords(calm.doneCount === 1 ? CW.doneOne : CW.doneMany, { assistant, n: calm.doneCount })
      : null;
  return (
    <View style={{ position: 'absolute', left: 56, right: 56, top: 392 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T size={16} tracking={0.14} color={C.mut} uppercase>
          {CW.now}
        </T>
        {done ? <T size={19} color={C.mut}>{`${done} ›`}</T> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 14 }}>
        {calm.moments.map((m) => (
          <MomentCard key={m.key} moment={m} wide={m.kind === 'work' && calm.moments.length > 1} />
        ))}
      </View>
    </View>
  );
}

function MomentCard({ moment: m, wide }: { moment: DeskMoment; wide: boolean }) {
  return (
    <View
      style={{
        flex: wide ? 2 : 1,
        minWidth: 0,
        height: 160,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: C.line2,
        backgroundColor: C.sf,
        paddingVertical: 22,
        paddingHorizontal: 24,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Mark mark={m.mark} name={m.name} size={26} />
        <T size={19} color={C.mut} style={{ flexShrink: 1 }}>
          {m.name}
        </T>
      </View>
      <T size={36} weight={700} tracking={-0.01} style={{ marginTop: 12 }}>
        {m.value}
      </T>
      {m.progress !== undefined ? (
        <View
          style={{ height: 8, borderRadius: 4, backgroundColor: C.sf2, marginTop: 16, overflow: 'hidden' }}
        >
          <View
            style={{
              width: `${m.progress}%`,
              height: '100%',
              borderRadius: 4,
              backgroundColor: m.kind === 'work' ? C.brand : C.ok,
            }}
          />
        </View>
      ) : m.detail ? (
        <T size={19} color={C.mut} style={{ marginTop: 8 }}>
          {m.detail}
        </T>
      ) : null}
    </View>
  );
}

/** The servers along the bottom (DK-116, DK-117). */
function Strip({ calm }: { calm: DeskCalm }) {
  const { rawLocale } = useI18n();
  const CW = deskWords(rawLocale).calm;
  return (
    <View style={{ position: 'absolute', left: 56, right: 56, bottom: 44, flexDirection: 'row', gap: 10 }}>
      {calm.strip.map((s) => (
        <StripChip key={s.id ?? s.name} server={s} />
      ))}
      {calm.moreStrip > 0 ? (
        <View style={{ width: 80, height: 100, alignItems: 'center', justifyContent: 'center' }}>
          <T size={22} color={C.mut}>
            {fillDeskWords(CW.strip.more, { n: calm.moreStrip })}
          </T>
        </View>
      ) : null}
    </View>
  );
}

function StripChip({ server: s }: { server: DeskStripServer }) {
  const { rawLocale } = useI18n();
  const { done, updating, next } = deskWords(rawLocale).calm.strip;
  const work = { done, now: updating, next };
  const edge = s.state === 'bad' ? C.bad : s.state === 'warn' ? C.warn : s.work === 'now' ? C.brand : null;
  const sayColor =
    s.work === 'done' ? C.ok : s.work === 'next' ? C.mut : s.work === 'now' ? C.brand : (edge ?? C.mut);
  // Work through the strip says where it is (DK-117) when the server has nothing else to say.
  const say = s.say ?? (s.work ? work[s.work] : undefined);
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        height: 100,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: edge ? tint(edge, 0.6) : C.line2,
        backgroundColor: edge && s.state !== 'ok' ? tint(edge, 0.08) : C.sf,
        paddingTop: 14,
        paddingHorizontal: 12,
        opacity: s.state === 'off' ? 0.42 : 1,
        overflow: 'hidden',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Mark mark={s.mark} name={s.name} size={18} />
        <T size={14} mono style={{ flexShrink: 1 }}>
          {s.name}
        </T>
      </View>
      {say ? (
        <T size={17} color={sayColor} adjustsFontSizeToFit minimumFontScale={0.8} style={{ marginTop: 16 }}>
          {say}
        </T>
      ) : s.spark && s.spark.length > 1 ? (
        <Spark points={s.spark} />
      ) : null}
      {s.work === 'now' && s.progress !== undefined ? (
        <View
          style={{ height: 6, borderRadius: 3, backgroundColor: C.sf2, marginTop: 8, overflow: 'hidden' }}
        >
          <View style={{ width: `${s.progress}%`, height: '100%', backgroundColor: C.brand }} />
        </View>
      ) : null}
    </View>
  );
}

/** A server's last hour of processor, a thin green line (whole percent, oldest first). */
function Spark({ points }: { points: readonly number[] }) {
  const top = Math.max(30, ...points);
  const step = 112 / (points.length - 1);
  const line = points.map((v, i) => `${(i * step).toFixed(1)},${(30 - (v / top) * 27).toFixed(1)}`).join(' ');
  return (
    <Svg width="100%" height={30} viewBox="0 0 112 30" preserveAspectRatio="none" style={{ marginTop: 14 }}>
      <Polyline
        points={line}
        fill="none"
        stroke={C.ok}
        strokeOpacity={0.75}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
