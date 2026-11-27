/**
 * The device skill card in a chat (mock 3 at phone width; Whombat one-whombat.md ONE-18; one-whombat-mobile.md
 * AP-1368…AP-1371): the device and “New skill · reads only, until you allow more” with “Tested on your unit”, the values
 * the agent read from the real unit, then WHAT I MAY CHANGE — each action with its limit (or what it does) and Off · Ask
 * me · Allowed under it (the phone is too narrow to set them beside) — and Not now · Switch on. Nothing changes on the
 * device until you press Switch on; the limits are the agent's proposal, kept as they are (the web edits them).
 * Once decided the card says so and shows each action's tier.
 */

import { useDecideDeviceSkill, useDeclineDeviceSkill } from '@whombat/client/react';
import { type DeviceSkillCard, deviceSkillCopy } from '@whombat/core';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import {
  DEVICE_TIERS,
  type DeviceTier,
  decideBody,
  deviceCardCopy,
  deviceSkillView,
  initialTiers,
  tierLabel,
} from '../data/deviceSkill';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import { showNotice, useDecisionFeedback } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { MonoLabel, ToneBadge } from './assistant';
import { tint } from './glanceColors';
import { Thermometer } from './icons';
import { Button } from './primitives';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

export function DeviceSkillCardView({ card }: { card: DeviceSkillCard }) {
  const { rawLocale } = useI18n();
  const deviceSkillCopyHere = deviceSkillCopy(rawLocale);
  const deviceCardCopyHere = deviceCardCopy(rawLocale);

  const theme = useTheme();
  const { slug } = useBurrowBase();
  const decide = useDecideDeviceSkill(slug);
  const decline = useDeclineDeviceSkill(slug);
  const feedback = useDecisionFeedback();
  const assistant = useAgentWords();
  const view = useMemo(() => deviceSkillView(card, rawLocale), [card, rawLocale]);
  const [tiers, setTiers] = useState(() => initialTiers(card));
  const [busy, setBusy] = useState<'on' | 'decline' | null>(null);
  // The server's answer (or another device's decision) is the truth once it comes.
  useEffect(() => setTiers(initialTiers(card)), [card]);

  const switchOn = () => {
    setBusy('on');
    decide
      .mutateAsync({ proposalId: card.proposalId, ...decideBody(card, tiers, true) })
      .then((result) => {
        if (result.status !== 'ok') return feedback.onResult(result);
        showNotice(`${deviceSkillCopyHere.on}: ${card.name}.`);
      }, feedback.onError)
      .finally(() => setBusy(null));
  };
  const notNow = () => {
    setBusy('decline');
    decline
      .mutateAsync(card.proposalId)
      .then((result) => {
        if (result.status !== 'ok') feedback.onResult(result);
      }, feedback.onError)
      .finally(() => setBusy(null));
  };

  return (
    <View
      style={{
        marginTop: 8,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      <View
        accessible
        accessibilityLabel={view.label}
        style={{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, paddingBottom: 10 }}
      >
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tint(theme.colors.brand, 0.14),
          }}
        >
          <Thermometer size={20} color={theme.colors.brand} strokeWidth={1.7} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text size={17} weight={700} numberOfLines={2}>
            {view.title}
          </Text>
          <Text size={13.5} color={view.status === 'on' ? theme.colors.ok : theme.colors.mut}>
            {view.sub}
          </Text>
        </View>
      </View>
      {view.badge ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          <ToneBadge text={view.badge} tone="ok" />
        </View>
      ) : null}
      {view.readings.length ? (
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}
        >
          {view.readings.map((r) => (
            <View
              key={r.key}
              accessible
              accessibilityLabel={`${r.label}: ${r.value}`}
              style={{
                borderRadius: 10,
                paddingVertical: 6,
                paddingHorizontal: 12,
                backgroundColor: theme.colors.sf2,
              }}
            >
              <Text size={13} color={theme.colors.mut}>
                {r.label}
              </Text>
              <Text size={15.5} weight={600}>
                {r.value}
              </Text>
            </View>
          ))}
          {view.more ? (
            <View
              style={{
                borderRadius: 10,
                paddingVertical: 6,
                paddingHorizontal: 12,
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: theme.colors.line,
              }}
            >
              <Text size={14} color={theme.colors.mut}>
                {view.more}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {view.actions.length ? (
        <>
          <View style={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: 8 }}>
            <MonoLabel>{deviceCardCopyHere.mayChange}</MonoLabel>
          </View>
          {view.actions.map((a) => {
            const tier = tiers[a.key] ?? 'off';
            return (
              <View
                key={a.key}
                style={{ borderTopWidth: 1, borderTopColor: theme.colors.line, padding: 14, gap: 10 }}
              >
                {/* The setting's name with what it is set to, so a screen reader hears both together. */}
                <View
                  accessible
                  accessibilityLabel={`${a.label}, ${tierLabel(tier, rawLocale)}. ${a.sub}`}
                  style={{ gap: 2 }}
                >
                  <Text size={15} weight={500}>
                    {a.label}
                  </Text>
                  <Text size={13} color={theme.colors.mut}>
                    {a.sub}
                  </Text>
                </View>
                {view.open ? (
                  <Tiers
                    name={a.label}
                    label={deviceCardCopyHere.tiersLabel(a.label, assistant)}
                    value={tier}
                    disabled={busy !== null}
                    onChange={(next) => setTiers((t) => ({ ...t, [a.key]: next }))}
                  />
                ) : (
                  <Text size={13} weight={500} mono color={theme.colors.ink2}>
                    {tierLabel(tier, rawLocale)}
                  </Text>
                )}
              </View>
            );
          })}
        </>
      ) : null}
      {view.open ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.line, padding: 14, gap: 12 }}>
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {deviceSkillCopyHere.nothingChanges}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button
              label={deviceSkillCopyHere.decline}
              variant="secondary"
              onPress={notNow}
              busy={busy === 'decline'}
              disabled={busy === 'on'}
              style={{ flex: 1 }}
            />
            <Button
              label={deviceSkillCopyHere.switchOn}
              onPress={switchOn}
              busy={busy === 'on'}
              disabled={busy === 'decline'}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Off · Ask me · Allowed (mock `.seg`): `sf2` track, the chosen one raised on `sf` in `ink`, the others `mut`. In dark
 * `sf` on `sf2` barely shows, so the chosen one is filled `btn` with `btnfg` words there. Each option says which setting
 * it belongs to, and the group what it is set to.
 */
function Tiers({
  name,
  label,
  value,
  onChange,
  disabled,
}: {
  /** The setting's name (“Room temperature”). */
  name: string;
  label: string;
  value: DeviceTier;
  onChange: (tier: DeviceTier) => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={`${label}: ${tierLabel(value, rawLocale)}`}
      style={{
        flexDirection: 'row',
        gap: 2,
        padding: 3,
        borderRadius: 11,
        backgroundColor: theme.colors.sf2,
      }}
    >
      {DEVICE_TIERS.map((tier) => {
        const selected = tier === value;
        return (
          <Touchable
            key={tier}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={`${name}: ${tierLabel(tier, rawLocale)}`}
            disabled={disabled}
            onPress={() => onChange(tier)}
            feedback={selected ? 'none' : 'wash'}
            ringRadius={9}
            hitSlop={hitSlopFor(38)}
            style={{
              flex: 1,
              minHeight: 38,
              borderRadius: 9,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? (theme.dark ? theme.colors.btn : theme.colors.sf) : 'transparent',
            }}
          >
            <Text
              size={13}
              weight={selected ? 600 : 500}
              color={selected ? (theme.dark ? theme.colors.btnfg : theme.colors.ink) : theme.colors.mut}
            >
              {tierLabel(tier, rawLocale)}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}
