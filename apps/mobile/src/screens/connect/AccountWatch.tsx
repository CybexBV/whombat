/**
 * WHAT WHOMBAT WATCHES under an account's own screen when its page's Connection opened it (Google, Microsoft 365,
 * Email, GitHub, Website feedback): the page's checks with their switches and what is excepted, as a connection's
 * Connection screen lists them (`thing/WhatWhombatWatches.tsx`). A box that watches nothing on the account answers
 * 404: no section.
 */
import { useQuietActions, useThingWatch } from '@whombat/client/react';
import { View } from 'react-native';
import { useBurrow, useViewContext } from '../../data/BurrowProvider';
import { quietCopy, quietNote } from '../../data/quiet';
import { showToast } from '../../data/toast';
import { useI18n } from '../../i18n';
import { Section } from '../../ui/primitives';
import { WhatWhombatWatches } from '../thing/WhatWhombatWatches';

export function AccountWatch({
  thingId,
  title,
}: {
  thingId: string;
  title: (text: string) => React.ReactNode;
}) {
  const { rawLocale } = useI18n();
  const { slug } = useBurrow();
  const { now, timeZone } = useViewContext();
  const watch = useThingWatch({ params: { burrow: slug, thing: thingId } }, { retry: false });
  const quiet = useQuietActions(slug, thingId, { timeZone, note: quietNote(showToast) });
  const gone = !!watch.error && 'status' in watch.error && watch.error.status === 404;
  if (gone) return null;
  return (
    <View style={{ gap: 12 }}>
      {title(quietCopy(rawLocale).watchTitle.toUpperCase())}
      <Section>
        <WhatWhombatWatches
          watch={watch.data}
          pending={watch.isPending}
          failed={watch.isError}
          onRetry={() => void watch.refetch()}
          actions={quiet}
          timeZone={timeZone}
          now={now.getTime()}
          divider="bottom"
          inset={16}
        />
      </Section>
    </View>
  );
}
