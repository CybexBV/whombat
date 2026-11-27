/**
 * This Whombat → Backups' answer to “am I safe?” on the phone (Whombat backup-options.md; backup-options-android.md
 * AP-6850, AP-6851; app backup-v2.md AP-6880…): the top card (`backupHero`: its title, tone and shield follow where the
 * backups stand — failing and behind say why with *Ask {assistant} to fix it* —, what the last backup left out, “Can be
 * brought back” or the passkey's one calm line, Back up now and Options, the settings as chips), NEEDS YOU (the older
 * backups still on the box with Move and Remove), BACKUPS · N grouped by day (`backupGroups`, the first 9 until Show
 * all), the quiet line about older backups on the places used before, the line about asking the assistant, and Details
 * (where, who clears, checking the newest, the paper copy). The web's page stacked, words from `BACKUP_OPTIONS_TEXT`.
 */

import {
  ACCOUNTS_TEXT,
  BACKUP_OPTIONS_TEXT,
  type BackupGroup,
  type BackupHero,
  backupGroups,
  longDate,
} from '@whombat/client/managed';
import type { BackupPasskeyTap } from '@whombat/client/managed/react';
import { useBackupLocal } from '@whombat/client/react';
import type { ApplianceSession } from '@whombat/client/session';
import { formatBytes } from '@whombat/core/text';
import type { BackupCheckpointsOutput, BackupKeep } from '@whombat/protocol/session';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { tint } from '../ui/glanceColors';
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  HardDrive,
  KeyRound,
  type LucideIcon,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldQuestionMark,
  ShieldX,
} from '../ui/icons';
import { RowChevron } from '../ui/ListRow';
import { Button, SectionLabel } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { backupErrorText } from './BackupDestination';
import { shortDate } from './backupOptions';
import { Note } from './ui';

const T = BACKUP_OPTIONS_TEXT;

/** The first rows the list shows before Show all (the web's 9). */
export const BACKUP_LIST_FIRST = 9;

function Panel({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 20,
        borderWidth: 1,
        borderColor: warn ? theme.colors.warn : theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

/** The top card's shield follows where the backups stand. */
const HERO_ICONS: Record<BackupHero['state'], LucideIcon> = {
  ok: ShieldCheck,
  justNow: ShieldCheck,
  running: ShieldEllipsis,
  behind: ShieldAlert,
  failing: ShieldX,
  none: Shield,
  unknown: ShieldQuestionMark,
};

function IconBox({ icon: Icon, tone }: { icon: LucideIcon; tone: 'ok' | 'warn' | 'bad' | 'mut' }) {
  const theme = useTheme();
  const color =
    tone === 'ok'
      ? theme.colors.ok
      : tone === 'bad'
        ? theme.colors.bad
        : tone === 'warn'
          ? theme.colors.warn
          : theme.colors.ink2;
  return (
    <View
      style={{
        width: 40,
        height: 40,
        borderRadius: tone === 'mut' ? 11 : 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tone === 'mut' ? theme.colors.sf2 : tint(color, 0.14),
      }}
    >
      <Icon size={20} color={color} strokeWidth={1.8} />
    </View>
  );
}

/** The shared setup action in the top card; a phone that cannot use passkeys explains where to finish. */
export interface HeroPasskey {
  /** The touch, or null where this phone can't (no PRF): the line says where to do it. */
  tap: BackupPasskeyTap | null;
  onArmed: () => void;
}

/** The top card: the answer (its shield, tone and words), the two buttons, then the way back and the chips. */
export function BackupHeroCard({
  hero,
  busy,
  note,
  onBackUpNow,
  onOptions,
  askFix,
  passkey,
}: {
  hero: BackupHero;
  busy: boolean;
  note: string | null;
  onBackUpNow: () => void;
  /** Options, once the options were read (null while the backup service isn't answering). */
  onOptions: (() => void) | null;
  /** *Ask {assistant} to fix it* (failing, behind, or the backup service not answering): its label and what it does. */
  askFix?: { label: string; busy: boolean; onPress: () => void } | null;
  passkey?: HeroPasskey | null;
}) {
  const theme = useTheme();
  const problemColor = hero.tone === 'bad' ? theme.colors.bad : theme.colors.ink;
  return (
    <Panel>
      <View style={{ padding: 16, gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <IconBox icon={HERO_ICONS[hero.state]} tone={hero.tone} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text size={18} weight={600} lh={1.3} accessibilityRole="header">
              {hero.title}
            </Text>
            {hero.problem ? (
              <Text size={13.5} lh={1.45} color={problemColor}>
                {hero.problem}
              </Text>
            ) : null}
            {hero.sub ? (
              <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
                {hero.sub}
              </Text>
            ) : null}
          </View>
        </View>
        {hero.askFix && askFix ? (
          <Button label={askFix.label} busy={askFix.busy} onPress={askFix.onPress} />
        ) : null}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button
            label={busy ? T.backingUp : T.backUpNow}
            variant="secondary"
            busy={busy}
            onPress={onBackUpNow}
            style={{ flex: 1 }}
          />
          {onOptions ? (
            <Button label={T.options} variant="secondary" onPress={onOptions} style={{ flex: 1 }} />
          ) : null}
        </View>
        {note ? <Note text={note} /> : null}
        {hero.leftOut ? (
          <MarkLine icon={CircleAlert} color={theme.colors.warn} text={`${T.leftOut} ${hero.leftOut}`} />
        ) : null}
        {hero.wayBack ? (
          <MarkLine
            icon={hero.wayBackReady ? Check : KeyRound}
            color={hero.wayBackReady ? theme.colors.ok : theme.colors.mut}
            text={hero.wayBack}
          />
        ) : null}
        {hero.askPasskey && passkey ? <PasskeyLine passkey={passkey} /> : null}
        {hero.chips.length > 0 ? (
          <View
            accessible
            accessibilityLabel={`${T.chipsLabel}: ${hero.chips.map((c) => c.text).join(', ')}`}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}
          >
            {hero.chips.map((c) => (
              <View
                key={c.text}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingVertical: 5,
                  paddingHorizontal: 10,
                  borderRadius: 999,
                  backgroundColor: theme.colors.sf2,
                }}
              >
                {c.dot ? (
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: c.dot === 'ok' ? theme.colors.ok : theme.colors.bad,
                    }}
                  />
                ) : null}
                <Text size={12.5} color={theme.colors.ink2}>
                  {c.text}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Panel>
  );
}

/** One line with its mark (what the last backup left out, “Can be brought back …”). */
function MarkLine({ icon: Icon, color, text }: { icon: LucideIcon; color: string; text: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
      <Icon size={16} color={color} strokeWidth={2} style={{ marginTop: 2 }} />
      <Text size={13.5} lh={1.45} color={theme.colors.ink} style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

/** Keep setup status and progress together beneath the backup summary. */
function PasskeyLine({ passkey }: { passkey: HeroPasskey }) {
  const theme = useTheme();
  const W = T.wayBack;
  const busy = passkey.tap?.busy ?? false;
  const said = passkey.tap?.note ?? null;
  const use = async () => {
    if (!passkey.tap) return;
    await passkey.tap();
    passkey.onArmed();
  };
  return (
    <View style={{ gap: 10, paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        <IconBox icon={KeyRound} tone="mut" />
        <View style={{ flex: 1, gap: 3 }}>
          <Text size={15} weight={600} lh={1.35}>
            {passkey.tap?.view?.title ?? W.ask}
          </Text>
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {passkey.tap ? (passkey.tap.view?.meta ?? W.askMeta) : W.elsewhere}
          </Text>
        </View>
      </View>
      {passkey.tap ? (
        <Button
          label={passkey.tap.label}
          variant="secondary"
          busy={busy}
          disabled={!passkey.tap.view && !passkey.tap.loadError}
          onPress={() => void use()}
        />
      ) : null}
      {said ? <Note text={said} /> : null}
    </View>
  );
}

/** One NEEDS YOU row: an icon, what and why, its buttons under it. */
function NeedRow({
  icon,
  title,
  meta,
  warn,
  children,
}: {
  icon: LucideIcon;
  title: string;
  meta: string;
  warn?: boolean;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Panel {...(warn && { warn })}>
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <IconBox icon={icon} tone="mut" />
          <View style={{ flex: 1, gap: 3 }}>
            <Text size={15} weight={600} lh={1.35}>
              {title}
            </Text>
            <Text size={13} lh={1.45} color={theme.colors.mut}>
              {meta}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>{children}</View>
      </View>
    </Panel>
  );
}

/** NEEDS YOU: only the rows that apply; nothing at all when none does. */
export function BackupNeedsYou({
  session,
  local,
  placeName,
}: {
  session: ApplianceSession;
  local: BackupCheckpointsOutput['local'];
  placeName: string | null;
}) {
  const { rawLocale } = useI18n();

  const { move, remove } = useBackupLocal(session);
  const [note, setNote] = useState<string | null>(null);
  const hasLocal = !!local && local.count > 0;
  if (!hasLocal && !note) return null;
  const size = local ? formatBytes(local.bytes, rawLocale) : '';
  const range =
    local?.oldest && local.newest ? `${shortDate(local.oldest)} – ${shortDate(local.newest)}` : '';
  const confirmRemove = () =>
    Alert.alert(T.local.removeTitle, T.local.removeLead(size), [
      { text: ACCOUNTS_TEXT.cancel, style: 'cancel' },
      {
        text: T.local.removeConfirm,
        style: 'destructive',
        onPress: () => {
          setNote(null);
          remove.mutate(undefined, { onError: (e) => setNote(backupErrorText(e)) });
        },
      },
    ]);
  return (
    <View style={{ gap: 10 }}>
      <SectionLabel>{T.needsYou.toUpperCase()}</SectionLabel>
      {hasLocal && local ? (
        <NeedRow
          icon={HardDrive}
          title={T.local.title(local.count)}
          meta={T.local.meta(range, size, placeName)}
        >
          <Button
            label={move.isPending ? T.local.moving : T.local.move(placeName)}
            variant="secondary"
            busy={move.isPending}
            disabled={remove.isPending}
            onPress={() => {
              setNote(null);
              move.mutate(undefined, {
                onSuccess: (r) => setNote(T.local.moved(r.copied)),
                onError: (e) => setNote(backupErrorText(e)),
              });
            }}
          />
          <Button
            label={T.local.remove}
            variant="quiet"
            busy={remove.isPending}
            disabled={move.isPending}
            onPress={confirmRemove}
            style={{ borderWidth: 0 }}
          />
        </NeedRow>
      ) : null}
      {note ? <Note text={note} /> : null}
    </View>
  );
}

/** BACKUPS · N, newest first, grouped by day; a row opens the backup. */
export function BackupList({
  list,
  keep,
  onOpen,
}: {
  list: BackupCheckpointsOutput;
  keep: BackupKeep | null;
  onOpen: (checkpointId: string) => void;
}) {
  const theme = useTheme();
  const [all, setAll] = useState(false);
  const total = list.checkpoints.length;
  const groups: BackupGroup[] = backupGroups(list, keep, all ? {} : { limit: BACKUP_LIST_FIRST });
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <SectionLabel>{T.list.label(total).toUpperCase()}</SectionLabel>
        {total > 0 ? (
          <Text
            size={11}
            weight={500}
            mono
            tracking={0.05}
            color={theme.colors.mut}
            style={{ paddingVertical: 8, paddingHorizontal: 6 }}
          >
            {T.list.newestFirst.toUpperCase()}
          </Text>
        ) : null}
      </View>
      <Panel>
        {total === 0 ? (
          <Text size={14} color={theme.colors.mut} style={{ padding: 16 }}>
            {T.list.empty}
          </Text>
        ) : null}
        {groups.map((g) => (
          <View key={g.key}>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                gap: 8,
                paddingTop: 14,
                paddingBottom: 6,
                paddingHorizontal: 16,
              }}
            >
              <Text
                size={11}
                weight={500}
                mono
                tracking={0.05}
                color={theme.colors.mut}
                accessibilityRole="header"
              >
                {g.label}
              </Text>
              {g.note ? (
                <Text size={12.5} color={theme.colors.mut} style={{ flexShrink: 1 }}>
                  {g.note}
                </Text>
              ) : null}
            </View>
            {g.rows.map((r, i) => (
              <Touchable
                key={r.id}
                feedback="wash"
                accessibilityRole="button"
                accessibilityLabel={[
                  r.time,
                  r.label,
                  r.check === 'ok' ? T.list.checkedOk : null,
                  r.leftOut ? T.list.leftOut : null,
                  r.size,
                ]
                  .filter(Boolean)
                  .join(', ')}
                onPress={() => onOpen(r.id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 48,
                  paddingVertical: 10,
                  paddingHorizontal: 16,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: theme.colors.line,
                }}
              >
                <Text size={13} mono color={theme.colors.ink2} style={{ width: 86 }} numberOfLines={2}>
                  {r.time}
                </Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text size={15} lh={1.35}>
                    {r.label}
                  </Text>
                  {r.check ? (
                    <Text size={12.5} color={r.check === 'ok' ? theme.colors.ok : theme.colors.bad}>
                      {r.check === 'ok' ? `✓ ${T.list.checkedOk}` : T.list.checkedBad}
                    </Text>
                  ) : null}
                  {r.leftOut ? (
                    <Text size={12.5} color={theme.colors.warn}>
                      {T.list.leftOut}
                    </Text>
                  ) : null}
                </View>
                <Text size={12.5} mono color={theme.colors.mut}>
                  {r.size}
                </Text>
                <RowChevron />
              </Touchable>
            ))}
          </View>
        ))}
        {!all && total > BACKUP_LIST_FIRST ? (
          <Touchable
            feedback="wash"
            accessibilityRole="button"
            onPress={() => setAll(true)}
            style={{
              minHeight: 48,
              justifyContent: 'center',
              paddingHorizontal: 16,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <Text size={14.5} weight={500} color={theme.colors.brand}>
              {T.list.showAll}
            </Text>
          </Touchable>
        ) : null}
      </Panel>
    </View>
  );
}

/** The quiet line under the list: older backups stay on the places used before (`earlierPlacesLine`). */
export function BackupEarlierLine({ text }: { text: string | null }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
      {text}
    </Text>
  );
}

/** “You can also tell Dusty …”. */
export function BackupDustyLine({ agent }: { agent: string }) {
  const theme = useTheme();
  return (
    <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
      {T.dusty(agent)}
    </Text>
  );
}

/**
 * Details, folded (app backup-v2.md): where the backups are kept, who clears old ones, that they can't be deleted from
 * here, checking the newest now, and the optional paper copy (printed or saved through the share sheet).
 */
export function BackupDetailsCard({
  lines,
  onCheckNewest,
  checking,
  checkNote,
  paper,
}: {
  lines: readonly string[];
  onCheckNewest: (() => void) | null;
  checking: boolean;
  checkNote: string | null;
  /** The paper copy: when one was saved, and the two ways (null where there's none: the demo world). */
  paper: {
    paperAt: string | null;
    busy: boolean;
    error: string | null;
    onPrint: () => void;
    onFile: () => void;
  } | null;
}) {
  const theme = useTheme();
  const D = T.details;
  const P = T.paper;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 10 }}>
      <Touchable
        feedback="wash"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 6 }}
      >
        <Text size={14.5} weight={600} color={theme.colors.ink2}>
          {open ? D.hide : D.show}
        </Text>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <ChevronDown size={16} color={theme.colors.ink2} strokeWidth={2} />
        </View>
      </Touchable>
      {open ? (
        <Panel>
          {lines.length ? (
            <View style={{ padding: 16, gap: 6 }}>
              {lines.map((line) => (
                <Text key={line} size={14} lh={1.5} color={theme.colors.ink2}>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}
          {onCheckNewest ? (
            <View
              style={{
                padding: 16,
                gap: 10,
                borderTopWidth: lines.length ? 1 : 0,
                borderTopColor: theme.colors.line,
              }}
            >
              <Button
                label={checking ? T.detail.checking : D.checkNewest}
                variant="secondary"
                busy={checking}
                onPress={onCheckNewest}
              />
              {checkNote ? <Note text={checkNote} /> : null}
            </View>
          ) : null}
          {paper ? (
            <View style={{ padding: 16, gap: 12, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
                <IconBox icon={FileText} tone="mut" />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text size={15} weight={600} lh={1.35}>
                    {P.title}
                  </Text>
                  <Text size={13} lh={1.45} color={theme.colors.mut}>
                    {paper.paperAt ? P.saved(longDate(paper.paperAt)) : P.meta}
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button
                  label={paper.busy ? P.making : P.print}
                  variant="secondary"
                  busy={paper.busy}
                  onPress={paper.onPrint}
                  style={{ flex: 1 }}
                />
                <Button
                  label={P.file}
                  variant="secondary"
                  disabled={paper.busy}
                  onPress={paper.onFile}
                  style={{ flex: 1 }}
                />
              </View>
              {paper.error ? <Note text={paper.error} /> : null}
            </View>
          ) : null}
        </Panel>
      ) : null}
    </View>
  );
}

/** The green mono tag (“RECOMMENDED”). */
export function Tag({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 999,
        paddingVertical: 2,
        paddingHorizontal: 8,
        backgroundColor: tint(theme.colors.ok, 0.14),
      }}
    >
      <Text size={10.5} weight={500} mono tracking={0.05} color={theme.colors.ok}>
        {text}
      </Text>
    </View>
  );
}
