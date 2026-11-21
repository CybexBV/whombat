/**
 * VOICE TYPING on This Whombat (docs/decisions/dictation.md DT-03…DT-06), the web's section on a phone, right after
 * SCREEN and in its parts: the *Voice typing* switch; *Speech model* (Automatic · Fast · Most accurate) with what
 * Automatic uses now and the slow warning for Most accurate without a graphics chip; *Language* (Automatic · English ·
 * Nederlands); the two models, each with its dot, name, what it is for, its size and state, the download's bar, and
 * Download, Remove or Try again; and the graphics chip line. Hidden where the box has no speech service. The rows and
 * words are the shared `voiceSectionView` and `VOICE_TEXT`; a choice is saved at once and put back when refused. Every
 * target 44dp.
 */
import {
  VOICE_TEXT,
  type VoiceApi,
  type VoiceModelRow,
  type VoiceSectionView,
  voiceSectionShown,
  voiceSectionView,
  voiceSettingErrorText,
} from '@whombat/client/voice';
import { useVoice, useVoiceActions } from '@whombat/client/voice/react';
import type { VoiceTypingPatch } from '@whombat/core/domain';
import { type ReactNode, useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { switchColors } from '../ui/switchColors';
import { Card, dotColor } from './ui';

/** The section, or nothing (no voice typing on this Whombat). */
export function VoiceSection({ api }: { api: VoiceApi | null }) {
  const voice = useVoice(api);
  if (!api || !voiceSectionShown(voice.data)) return null;
  return <VoiceCard api={api} view={voiceSectionView(voice.data)} />;
}

const failed = (error: unknown) => Alert.alert('That didn’t go through', voiceSettingErrorText(error));

function VoiceCard({ api, view }: { api: VoiceApi; view: VoiceSectionView }) {
  const theme = useTheme();
  const actions = useVoiceActions(api);
  const save = (patch: VoiceTypingPatch) => void actions.update(patch).catch(failed);
  return (
    <Card label={VOICE_TEXT.sectionLabel}>
      <Part first>
        <Head
          title={view.on.title}
          meta={view.on.meta}
          end={
            <Switch
              value={view.on.on}
              onValueChange={(on) => save({ on })}
              accessibilityLabel={view.on.title}
              accessibilityHint={view.on.meta}
              accessibilityRole="switch"
              {...switchColors(theme, view.on.on)}
              style={{ minHeight: 44 }}
            />
          }
        />
      </Part>
      <Part>
        <Head title={view.model.title} />
        <Segmented
          options={view.model.options}
          value={view.model.value}
          onChange={(model) => save({ model })}
          label={view.model.title}
          lines={2}
        />
        {view.model.uses ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {view.model.uses}
          </Text>
        ) : null}
        {view.model.warning ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {view.model.warning}
          </Text>
        ) : null}
      </Part>
      <Part>
        <Head title={view.language.title} />
        <Segmented
          options={view.language.options}
          value={view.language.value}
          onChange={(language) => save({ language })}
          label={view.language.title}
        />
      </Part>
      {view.models.rows.map((row) => (
        <ModelPart key={row.id} api={api} row={row} />
      ))}
      <Part>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {view.gpu}
        </Text>
      </Part>
    </Card>
  );
}

/** A model: its dot, name, what it is for, its size and state, the download's bar and the one thing to do. */
function ModelPart({ api, row }: { api: VoiceApi; row: VoiceModelRow }) {
  const theme = useTheme();
  const actions = useVoiceActions(api);
  const [pending, setPending] = useState(false);
  const act = () => {
    if (!row.action || pending) return;
    const run = row.action.kind === 'remove' ? actions.removeModel : actions.fetchModel;
    setPending(true);
    void run(row.id)
      .catch(failed)
      .finally(() => setPending(false));
  };
  const state = `${row.size} · ${row.status}`;
  return (
    <Part>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          accessible
          accessibilityLabel={`${row.name}. ${row.about} ${state}${row.problem ? `. ${row.problem}` : ''}`}
          style={{ flex: 1, minWidth: 0, flexDirection: 'row', gap: 10 }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              marginTop: 7,
              borderRadius: 4,
              backgroundColor: dotColor(theme, row.tone),
            }}
          />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text size={15} weight={500} lh={1.35}>
              {row.name}
            </Text>
            <Text size={13} lh={1.4} color={theme.colors.mut}>
              {row.about}
            </Text>
            <Text size={13} lh={1.4} color={theme.colors.mut} style={{ fontVariant: ['tabular-nums'] }}>
              {state}
            </Text>
            {row.problem ? (
              <Text size={13} lh={1.4} color={theme.colors.mut}>
                {row.problem}
              </Text>
            ) : null}
          </View>
        </View>
        {row.action ? (
          <Button
            label={row.action.label}
            variant={row.action.kind === 'retry' ? 'primary' : 'secondary'}
            onPress={act}
            busy={pending}
            style={{ paddingHorizontal: 14 }}
          />
        ) : null}
      </View>
      {row.progress !== null ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={row.name}
          accessibilityValue={{ min: 0, max: 100, now: Math.floor(row.progress * 100) }}
          style={{
            height: 6,
            marginLeft: 18,
            borderRadius: 3,
            backgroundColor: theme.colors.sf2,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.floor(row.progress * 100)}%`,
              height: '100%',
              borderRadius: 3,
              backgroundColor: theme.colors.progress,
            }}
          />
        </View>
      ) : null}
    </Part>
  );
}

/** One part of the card: 16dp in, a hairline above all but the first (SCREEN's parts). */
function Part({ first = false, children }: { first?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 10,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {children}
    </View>
  );
}

/** A part's title (15/500) over its sentence (13 `mut`), and what sits at its end (a switch). */
function Head({ title, meta, end }: { title: string; meta?: string | null; end?: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text size={15} weight={500} lh={1.35}>
          {title}
        </Text>
        {meta ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {meta}
          </Text>
        ) : null}
      </View>
      {end}
    </View>
  );
}
