/**
 * The 1Password connection's own part on the phone (Whombat onepassword-sync.md; app
 * onepassword-sync.md), the web's KEPT IN STEP at phone width: the vault's name over how many entries are kept in step,
 * the waiting, failing or read-only line, the last check with Sync now, “1Password says 4 items are gone” with their
 * names and the two answers, and NOT IN YOUR VAULT with each item's reason. It reads what the last pass stored
 * (`connections.onePassword`), and reads again every few seconds while a pass runs. Built from the connection screen's
 * own rows, notes and buttons (each at least 44dp).
 */
import {
  onePasswordAnsweredText,
  onePasswordAppText,
  onePasswordPage,
  onePasswordSetChanged,
} from '@whombat/client';
import { connectProblem } from '@whombat/client/connections';
import { useOnePassword, useOnePasswordWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { type OnePasswordRemovalAnswer, onePasswordWords } from '@whombat/core/vault';
import { useState } from 'react';
import { View } from 'react-native';
import { useViewContext } from '../../data/BurrowProvider';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { FormMessage } from '../../ui/formField';
import { ListRow } from '../../ui/ListRow';
import { Button, ErrorState, Section, SkeletonRows } from '../../ui/primitives';
import { showNotice } from '../feedback';
import { Note } from './parts';

/** How often the screen reads again while a pass runs: the pass's end sends nothing when it changed nothing. */
const SYNCING_POLL_MS = 3000;

export function OnePasswordSections({ slug, connectionId }: { slug: string; connectionId: string }) {
  const { rawLocale } = useI18n();
  const onepasswordAppTextHere = onePasswordAppText(rawLocale);
  const onepasswordWordsHere = onePasswordWords(rawLocale);
  const theme = useTheme();
  const { now, timeZone } = useViewContext();
  const params = { burrow: slug, connectionId };
  const query = useOnePassword(
    { params },
    { retry: false, refetchInterval: (q) => (q.state.data?.syncing ? SYNCING_POLL_MS : false) },
  );
  const sync = useOnePasswordWrite(api.connections.onePasswordSync, slug);
  const answer = useOnePasswordWrite(api.connections.onePasswordRemovals, slug);
  const [problem, setProblem] = useState<string | null>(null);

  if (!query.data)
    return (
      <Section title={onepasswordAppTextHere.section}>
        {query.error ? (
          <ErrorState text={onepasswordAppTextHere.failed} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonRows count={2} lines={2} label={onepasswordAppTextHere.section} />
        )}
      </Section>
    );
  const page = onePasswordPage(query.data, now, timeZone, rawLocale);

  async function syncNow() {
    setProblem(null);
    try {
      await sync.mutateAsync({ params, body: {} });
    } catch (err) {
      setProblem(connectProblem(err, undefined, undefined, rawLocale).message);
    }
  }

  async function answerRemovals(choice: OnePasswordRemovalAnswer, token: string) {
    setProblem(null);
    try {
      const result = await answer.mutateAsync({ params, body: { answer: choice, token } });
      if (result.status === 'ok') showNotice(onePasswordAnsweredText(choice, rawLocale));
      else if (result.status === 'blocked') setProblem(result.message);
    } catch (err) {
      // The set changed since it was shown: the screen reads it again, nothing was removed.
      setProblem(
        onePasswordSetChanged(err)
          ? onepasswordAppTextHere.changed
          : connectProblem(err, undefined, undefined, rawLocale).message,
      );
    }
  }

  return (
    <>
      <Section title={onepasswordAppTextHere.section}>
        <ListRow
          title={page.vault}
          meta={onepasswordAppTextHere.vaultLabel}
          body={page.kept}
          accessibilityLabel={[page.vault, page.kept, ...page.status.map((l) => l.text)].join('. ')}
        >
          {page.status.map((line) => (
            <Note key={line.text} tone={line.tone === 'plain' ? undefined : line.tone}>
              {line.text}
            </Note>
          ))}
        </ListRow>
        {page.removals ? (
          <View style={{ padding: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.line }}>
            <Text size={15} weight={600}>
              {page.removals.title}
            </Text>
            <View accessible accessibilityLabel={page.removals.names.join(', ')} style={{ gap: 2 }}>
              {page.removals.names.map((name, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two entries may share a name; the server's order
                <Text key={`${i}-${name}`} size={14} lh={1.45} color={theme.colors.ink2}>
                  {name}
                </Text>
              ))}
            </View>
            {/* Stacked: neither answer fits half a card at large text. */}
            <Button
              label={onepasswordWordsHere.removeHere}
              variant="secondary"
              busy={answer.isPending && answer.variables?.body.answer === 'remove'}
              disabled={answer.isPending}
              onPress={() => page.removals && void answerRemovals('remove', page.removals.token)}
            />
            <Button
              label={onepasswordWordsHere.keepHere}
              variant="secondary"
              busy={answer.isPending && answer.variables?.body.answer === 'keep'}
              disabled={answer.isPending}
              onPress={() => page.removals && void answerRemovals('keep', page.removals.token)}
            />
          </View>
        ) : null}
        <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text size={13} color={theme.colors.mut} style={{ flex: 1 }} accessibilityLiveRegion="polite">
              {page.checked}
            </Text>
            <Button
              label={onepasswordWordsHere.syncNow}
              variant="secondary"
              disabled={page.syncing || sync.isPending}
              onPress={() => void syncNow()}
            />
          </View>
          <FormMessage text={problem} />
        </View>
      </Section>
      {page.notInVault.length > 0 ? (
        <Section title={onepasswordWordsHere.notInVault.toUpperCase()}>
          {page.notInVault.map((item) => (
            <ListRow
              key={item.id}
              title={item.title}
              body={item.reason}
              accessibilityLabel={`${item.title}, ${item.reason}`}
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}
