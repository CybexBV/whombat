import { SETTINGS_GROUP_TEXT, type YouPart } from '@whombat/client';
import { SegmentedControl } from '../../components/SegmentedControl';
import { PromptsPart } from '../prompts/PromptsPart';
import { ManagedDevices, useApplianceStatus } from './ManagedTabs';
import { NotificationsTab } from './NotificationsTab';
import { ProfileTab } from './ProfileTab';
import { SharedLinks } from './SharedLinks';
import tw from './ThisWhombat.module.css';
import { usePartInView } from './usePartInView';
import { useYouParts } from './useYouParts';

/**
 * Settings → **You** (the default; settings-groups.md): your **Profile** (name, title, photo and how Chat
 * tidies itself), your **Notifications**, and on a box your **Devices** and passkeys (they were This Whombat's) and your
 * **Shared links** (share-links.md), and your **Prompts** where the Whombat has them (prompts-web.md). The open part is
 * at `&part=`.
 */
export function YouTab({
  burrow,
  part,
  onPartChange,
}: {
  burrow: string;
  part?: YouPart;
  onPartChange: (part: YouPart) => void;
}) {
  const parts = useYouParts(burrow);
  const current: YouPart = part && parts.includes(part) ? part : 'profile';
  usePartInView(tw.parts ?? '', current);
  return (
    <>
      <SegmentedControl
        variant="soft"
        label={SETTINGS_GROUP_TEXT.partsLabel('You')}
        className={tw.parts}
        value={current}
        onChange={(next) => onPartChange(next)}
        options={parts.map((p) => ({ value: p, label: SETTINGS_GROUP_TEXT.you[p] }))}
      />
      <div className={tw.partBody} data-you-part={current}>
        {current === 'notifications' ? (
          <NotificationsTab burrow={burrow} />
        ) : current === 'devices' ? (
          <Devices />
        ) : current === 'links' ? (
          <SharedLinks burrow={burrow} />
        ) : current === 'prompts' ? (
          <PromptsPart burrow={burrow} />
        ) : (
          <ProfileTab burrow={burrow} />
        )}
      </div>
    </>
  );
}

/** Devices and passkeys (a managed Whombat's, AP-1229): read with the box's state. */
function Devices() {
  const appliance = useApplianceStatus();
  return <ManagedDevices status={appliance.status} onChanged={appliance.reload} />;
}
