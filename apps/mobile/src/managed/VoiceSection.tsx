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
  type VoiceApi,
  type VoiceDutchRow,
  type VoiceModelRow,
  type VoiceSectionView,
  voiceSectionShown,
  voiceSettingErrorText,
} from '@whombat/client/voice';
import { useVoice, useVoiceActions } from '@whombat/client/voice/react';
import { type VoiceTypingPatch, voiceWords } from '@whombat/core/domain';
import { type ReactNode, useState } from 'react';
import { Alert, Linking, Switch, View } from 'react-native';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { OneSheet } from '../ui/oneSheet';
import { Button } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';
import { localizedVoiceError, localizedVoiceView } from '../voice/copy';
import { Card, dotColor } from './ui';

/** The section, or nothing (no voice typing on this Whombat). */
export function VoiceSection({ api }: { api: VoiceApi | null }) {
  const voice = useVoice(api);
  const { rawLocale } = useI18n();
  if (!api || !voiceSectionShown(voice.data)) return null;
  return <VoiceCard api={api} view={localizedVoiceView(voice.data, rawLocale)} />;
}

function useVoiceFailure() {
  const { rawLocale } = useI18n();
  const { t } = useMobileT();
  return (error: unknown) =>
    Alert.alert(
      t('managed.that-didnt-go-through'),
      localizedVoiceError(voiceSettingErrorText(error, rawLocale), rawLocale),
    );
}

function VoiceCard({ api, view }: { api: VoiceApi; view: VoiceSectionView }) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const actions = useVoiceActions(api);
  const failed = useVoiceFailure();
  const save = (patch: VoiceTypingPatch) =>
    void actions
      .update(patch)
      .then((saved) => {
        if (
          (patch.on !== undefined && saved.on !== patch.on) ||
          (patch.model !== undefined && saved.model !== patch.model) ||
          (patch.language !== undefined && saved.language !== patch.language)
        )
          Alert.alert(tMobile('managed.that-didnt-go-through'), tMobile('voice.error.notSaved'));
      })
      .catch(failed);
  return (
    <Card label={voiceWords(rawLocale).section.toUpperCase()}>
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
      {view.dutchVoice ? <DutchVoicePart api={api} row={view.dutchVoice} /> : null}
      <Part>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {view.gpu}
        </Text>
      </Part>
    </Card>
  );
}

/**
 * *Dutch voice*: off until the person agrees to Supertonic 3's Open RAIL-M use restrictions in a sheet, which records
 * the agreement and downloads the model; turning it off removes its files.
 */
function DutchVoicePart({ api, row }: { api: VoiceApi; row: VoiceDutchRow }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const actions = useVoiceActions(api);
  const failed = useVoiceFailure();
  const [askLicence, setAskLicence] = useState(false);
  const [pending, setPending] = useState(false);
  const [agreeing, setAgreeing] = useState(false);
  const showStatus = row.on || row.state === 'removing';
  const state = row.state === 'removing' ? row.status : `${row.size} · ${row.status}`;

  const toggle = (next: boolean) => {
    if (pending) return;
    if (next) {
      setAskLicence(true);
      return;
    }
    setPending(true);
    void actions
      .setDutchVoice({ on: false })
      .then((saved) => {
        if (saved.dutchVoice?.on !== false)
          Alert.alert(tMobile('managed.that-didnt-go-through'), tMobile('voice.error.notSaved'));
      })
      .catch(failed)
      .finally(() => setPending(false));
  };

  const agree = () => {
    if (agreeing) return;
    setAgreeing(true);
    void actions
      .setDutchVoice({ on: true, licenceVersion: row.licenceVersion })
      .then((saved) => {
        if (saved.dutchVoice?.on !== true) {
          Alert.alert(tMobile('managed.that-didnt-go-through'), tMobile('voice.error.notSaved'));
          return;
        }
        setAskLicence(false);
      })
      .catch(failed)
      .finally(() => setAgreeing(false));
  };

  const retry = () => {
    if (pending) return;
    setPending(true);
    void actions
      .fetchModel('supertonic')
      .catch(failed)
      .finally(() => setPending(false));
  };

  return (
    <>
      <Part>
        <Head
          title={row.title}
          meta={row.meta}
          end={
            <Switch
              value={row.on}
              disabled={pending}
              onValueChange={toggle}
              accessibilityLabel={row.title}
              accessibilityHint={row.meta}
              accessibilityRole="switch"
              {...switchColors(theme, row.on)}
              style={{ minHeight: 44 }}
            />
          }
        />
        {showStatus ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: dotColor(theme, row.tone),
              }}
            />
            <Text
              size={13}
              lh={1.4}
              color={theme.colors.mut}
              style={{ fontVariant: ['tabular-nums'], flex: 1 }}
            >
              {state}
            </Text>
            {row.retryLabel ? (
              <Button
                label={row.retryLabel}
                variant="primary"
                onPress={retry}
                busy={pending}
                style={{ paddingHorizontal: 14 }}
              />
            ) : null}
          </View>
        ) : null}
        {row.problem ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {row.problem}
          </Text>
        ) : null}
        {row.progress !== null ? (
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={row.title}
            accessibilityValue={{ min: 0, max: 100, now: Math.floor(row.progress * 100) }}
            style={{
              height: 6,
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
      <OneSheet
        visible={askLicence}
        onClose={() => {
          if (!agreeing) setAskLicence(false);
        }}
        title={row.dialog.title}
        body={row.dialog.intro}
        busy={agreeing ? 'agree' : null}
        buttons={[
          { id: 'agree', label: row.dialog.agree, variant: 'primary', onPress: agree },
          {
            id: 'cancel',
            label: row.dialog.cancel,
            variant: 'secondary',
            onPress: () => setAskLicence(false),
          },
        ]}
      >
        <View style={{ gap: 8, marginTop: 12 }}>
          {row.dialog.restrictions.map((item) => (
            <Text key={item} size={14.5} lh={1.45} color={theme.colors.ink2}>
              {`• ${item}`}
            </Text>
          ))}
          <Touchable
            onPress={() => void Linking.openURL(row.licenceUrl).catch(() => {})}
            feedback="wash"
            ringRadius={10}
            accessibilityRole="link"
            accessibilityLabel={row.dialog.licenceLink}
            style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 4 }}
          >
            <Text
              size={14.5}
              weight={500}
              color={theme.colors.ink}
              style={{ textDecorationLine: 'underline' }}
            >
              {row.dialog.licenceLink}
            </Text>
          </Touchable>
        </View>
      </OneSheet>
    </>
  );
}

/** A model: its dot, name, what it is for, its size and state, the download's bar and the one thing to do. */
function ModelPart({ api, row }: { api: VoiceApi; row: VoiceModelRow }) {
  const theme = useTheme();
  const actions = useVoiceActions(api);
  const failed = useVoiceFailure();
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
