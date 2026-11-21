import { useDecideDeviceSkill, useDeclineDeviceSkill } from '@whombat/client/react';
import type { DeviceActionChoice, DeviceSkillCard as DeviceSkillCardData } from '@whombat/core';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { DeviceSkillCard, initialChoices } from './DeviceSkillCard';

const SOMETHING_WENT_WRONG = 'That didn’t work. Try again in a moment.';

/**
 * The device skill card in a conversation (one-whombat-shell.md AP-1274): your choices kept here until **Switch on**
 * sends them (`deviceSkills.decide`, contracts CT-340); “Not now” declines (`deviceSkills.decline`).
 */
export function DeviceSkillCardContainer({ burrow, card }: { burrow: string; card: DeviceSkillCardData }) {
  const toast = useToast();
  const decide = useDecideDeviceSkill(burrow);
  const decline = useDeclineDeviceSkill(burrow);
  const [choices, setChoices] = useState<Record<string, DeviceActionChoice>>(() => initialChoices(card));
  const busy = decide.isPending || decline.isPending;
  return (
    <DeviceSkillCard
      card={card}
      choices={choices}
      onChoice={(key, choice) => setChoices((c) => ({ ...c, [key]: choice }))}
      busy={busy}
      onSwitchOn={() =>
        decide.mutate(
          { proposalId: card.proposalId, actions: choices, switchOn: true },
          {
            onSuccess: (r) =>
              toast.show(
                r.status === 'ok'
                  ? `${card.name} is on. I change only what you allowed.`
                  : SOMETHING_WENT_WRONG,
              ),
            onError: () => toast.show(SOMETHING_WENT_WRONG),
          },
        )
      }
      onDecline={() =>
        decline.mutate(card.proposalId, {
          onSuccess: (r) =>
            toast.show(r.status === 'ok' ? 'Not now, then. Nothing was made.' : SOMETHING_WENT_WRONG),
          onError: () => toast.show(SOMETHING_WENT_WRONG),
        })
      }
    />
  );
}
