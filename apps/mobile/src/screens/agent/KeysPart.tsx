/**
 * Settings → Agent → Keys (Whombat one-agent.md OA-05, OA-09; one-agent.md AP-4926, AP-4969; was the agent's settings
 * screen, AP-713, and the agent screen's KEYS): KEYS as the web sets them — the six rows by risk as Off · Ask · On,
 * then All keys, collapsed — a draft saved with Save (only what changed, applied to what the agent holds now), and
 * leaving with unsaved changes asks first. Then Always allowed commands, folded with how many until opened, each with
 * Remove (the command asks again next time; one-person-android.md AP-5761: commands run on your Whombat, so the list is
 * always here).
 * `showKey` (`?key=`, a skill's “Turn on …” link) opens All keys when it is there and scrolls to the row, marked.
 */

import { ApiError, permissionsText } from '@whombat/client';
import {
  useCommandAllowances,
  useHostInfo,
  useRemoveCommandAllowance,
  useSetAgentKeys,
} from '@whombat/client/react';
import { COMMAND_ALLOWANCES_COPY } from '@whombat/core';
import type { KeyId, Tier } from '@whombat/core/keys';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type ScrollView, View } from 'react-native';
import { allowanceRows } from '../../data/agentParity';
import {
  type AccessDraft,
  ALL_KEYS_LABEL,
  accessChanges,
  accessDraft,
  accessOptions,
  accessView,
  allKeysHint,
  isTierSwitch,
  keyTarget,
  sameAccess,
  settingsRefusal,
  settingsSavedText,
} from '../../data/agentSettings';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { CardLine, RowButtons } from '../../ui/facts';
import { tint } from '../../ui/glanceColors';
import { KeySwitchRow, TierSegmentRow } from '../../ui/keyRows';
import { ListRow } from '../../ui/ListRow';
import { Button, Section } from '../../ui/primitives';
import { errorText, showNotice } from '../feedback';
import { Note, type PartProps, PartScroll, SaveBar } from './parts';

/** A refusal without the server's sentence. */
const KEYS_FAILED = 'That didn’t work. Try again in a moment.';

/** How long a row a link pointed at stays marked. */
const MARK_MS = 2400;

/** A key's row a link points at: it scrolls into view and is marked for a moment. */
function useKeyMark(showKey: string | undefined, scroll: React.RefObject<ScrollView | null>) {
  const spots = useRef(new Map<string, number>());
  const [marked, setMarked] = useState<string | null>(null);
  const done = useRef<string | null>(null);
  const reveal = (keyId: string) => {
    const y = spots.current.get(keyId);
    if (y === undefined || done.current === showKey) return;
    done.current = showKey ?? null;
    scroll.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
    setMarked(keyId);
  };
  useEffect(() => {
    if (!marked) return;
    const t = setTimeout(() => setMarked(null), MARK_MS);
    return () => clearTimeout(t);
  }, [marked]);
  return {
    marked,
    /** The wrapper's layout: where the row is in the scroll (a row's parents start at the scroll's top). */
    onLayout: (keyId: string, y: number) => spots.current.set(keyId, y),
    reveal,
  };
}

export function KeysPart({
  profile,
  refetch,
  onDirtyChange,
  showKey,
}: PartProps & { showKey?: string | undefined }) {
  const { rawLocale, tClient } = useI18n();

  const theme = useTheme();
  const { slug } = useBurrowBase();
  const host = useHostInfo({ params: { burrow: slug } }, { retry: false });
  const setKeys = useSetAgentKeys(slug);
  const allowances = useCommandAllowances({ params: { burrow: slug } }, { retry: false });
  const removeAllowance = useRemoveCommandAllowance(slug);
  const agent = profile.agent;
  const opts = useMemo(() => accessOptions(), []);
  const [base, setBase] = useState<AccessDraft | null>(null);
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [allowanceProblem, setAllowanceProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scroll = useRef<ScrollView>(null);
  // Where KEYS starts in the scroll: a row's own place is within its section.
  const sectionY = useRef(0);
  const mark = useKeyMark(showKey, scroll);
  const target = keyTarget(showKey, opts);
  const dirty = !!base && !!draft && !sameAccess(base, draft);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // The draft follows the agent as fetched while nothing is changed (a refresh, another device's change).
  useEffect(() => {
    if (dirtyRef.current) return;
    const now = accessDraft(profile.grants, opts);
    setBase(now);
    setDraft(now);
  }, [profile.grants, opts]);
  // A link's key under All keys opens it.
  useEffect(() => {
    if (target?.place === 'all') setAllOpen(true);
  }, [target?.place]);

  const commands = allowances.data ? allowanceRows(allowances.data.allowances) : null;
  const removeRow = (allowanceId: string) => {
    setAllowanceProblem(null);
    removeAllowance.mutate(
      { allowanceId },
      {
        onSuccess: (result) =>
          result.status === 'ok'
            ? showNotice(COMMAND_ALLOWANCES_COPY.removed)
            : setAllowanceProblem(result.status === 'blocked' ? result.message : KEYS_FAILED),
        onError: (error) =>
          setAllowanceProblem(error instanceof ApiError && error.message ? error.message : KEYS_FAILED),
      },
    );
  };
  const words = permissionsText(agent.name, rawLocale);
  const commandsCount = commands ? words.commandsCount(commands.length) : '…';
  // What was allowed for good on a command card: rarely looked at, so folded under the keys until opened.
  const commandsFold = (
    <ListRow
      title={words.commandsFold}
      meta={commandsCount}
      trailing={commandsOpen ? '⌃' : '⌄'}
      onPress={() => setCommandsOpen((o) => !o)}
      accessibilityLabel={`${words.commandsFold}, ${commandsCount}, ${commandsOpen ? 'shown' : 'hidden'}`}
    />
  );
  const commandsList = commands ? (
    <>
      <CardLine text={allowanceProblem} tone="bad" />
      {commands.length === 0 ? (
        <Note>{COMMAND_ALLOWANCES_COPY.empty}</Note>
      ) : (
        commands.map((row) => (
          <View
            key={row.id}
            style={{
              gap: 6,
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.line,
            }}
          >
            <View accessible accessibilityLabel={`${row.command}, ${row.line}`} style={{ gap: 4 }}>
              <Text size={13.5} lh={1.45} mono selectable>
                {row.command}
              </Text>
              <Text size={12} mono color={theme.colors.mut}>
                {row.line}
              </Text>
            </View>
            <RowButtons>
              <Button
                label={COMMAND_ALLOWANCES_COPY.remove}
                variant="secondary"
                disabled={removeAllowance.isPending}
                accessibilityHint={row.removeLabel}
                onPress={() => removeRow(row.id)}
                style={{ paddingHorizontal: 18 }}
              />
            </RowButtons>
          </View>
        ))
      )}
    </>
  ) : null;
  const refresh = () => {
    refetch();
    void allowances.refetch();
  };

  if (!draft || !base) return null;
  const view = accessView(draft, opts, { deployWorkflow: host.data?.deployWorkflow });
  const edit = (next: (d: AccessDraft) => AccessDraft) => setDraft((d) => (d ? next(d) : d));
  const setTier = (keyId: KeyId, tier: Tier) => edit((d) => ({ ...d, tiers: { ...d.tiers, [keyId]: tier } }));
  const setKey = (keyId: KeyId, on: boolean) => edit((d) => ({ ...d, keys: { ...d.keys, [keyId]: on } }));
  const markStyle = (keyId: string) =>
    mark.marked === keyId ? { backgroundColor: tint(theme.colors.warn, 0.14) } : null;
  const spot = (keyId: string, y: number, offset = 0) => {
    mark.onLayout(keyId, y + offset);
    if (target?.keyId === keyId) mark.reveal(keyId);
  };

  const save = async () => {
    setNotice(null);
    const grants = accessChanges(profile.grants, base, draft, opts);
    if (!grants) return setBase(draft);
    setSaving(true);
    try {
      const result = await setKeys.mutateAsync({ params: { burrow: slug }, body: { grants } });
      const refused = settingsRefusal(result);
      if (refused) return setNotice(refused);
      setBase(draft);
      showNotice(settingsSavedText(agent.name, 'keys'));
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PartScroll refreshing={false} onRefresh={refresh} scrollRef={scroll}>
        <View onLayout={(e) => (sectionY.current = e.nativeEvent.layout.y)}>
          <Section title={tClient('permissions.keys')}>
            {view.rows.map((r) => (
              <View
                key={r.row}
                style={markStyle(r.row)}
                onLayout={(e) => spot(r.row, e.nativeEvent.layout.y, sectionY.current)}
              >
                <TierSegmentRow
                  label={r.label}
                  description={r.description}
                  hint={r.hint}
                  tier={r.tier}
                  onChange={(tier) => setTier(r.row, tier)}
                />
              </View>
            ))}
            <ListRow
              title={ALL_KEYS_LABEL}
              meta={view.allCount}
              trailing={allOpen ? '⌃' : '⌄'}
              onPress={() => setAllOpen((o) => !o)}
              accessibilityLabel={`${ALL_KEYS_LABEL}, ${view.allCount}, ${allOpen ? 'shown' : 'hidden'}`}
            />
            {allOpen ? (
              <>
                <Note>{allKeysHint(agent.name)}</Note>
                {view.all.map((r) => (
                  <View
                    key={r.keyId}
                    style={markStyle(r.keyId)}
                    onLayout={(e) => spot(r.keyId, e.nativeEvent.layout.y, sectionY.current)}
                  >
                    {isTierSwitch(r) ? (
                      <TierSegmentRow
                        label={r.label}
                        tier={r.tier}
                        onChange={(tier) => setTier(r.keyId, tier)}
                      />
                    ) : (
                      <KeySwitchRow
                        label={r.label}
                        on={r.on}
                        note={r.note}
                        locked={r.locked}
                        onChange={(on) => setKey(r.keyId, on)}
                      />
                    )}
                  </View>
                ))}
              </>
            ) : null}
            {commandsFold}
            {commandsOpen ? commandsList : null}
          </Section>
        </View>
      </PartScroll>
      <SaveBar
        dirty={dirty}
        saving={saving}
        notice={notice}
        onSave={() => void save()}
        onDiscard={() => {
          setNotice(null);
          setDraft(base);
        }}
      />
    </>
  );
}
