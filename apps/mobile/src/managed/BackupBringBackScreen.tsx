/**
 * Bringing things back from one backup on the phone (app backup-look.md AP-6950…AP-6954; Whombat backup-look.md), from
 * a backup's page: the backup opens (a short wait that says so), WHAT’S IN IT lists its categories with how many things
 * each has, a category lists its things (searchable; when and where each was, and “Already here”), the person ticks
 * what they want, “Bring back” brings it back — only adding — and a line says how it went. Leaving closes the backup.
 * The same words and model as the web (`@whombat/client`).
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  BACKUP_LOOK_TEXT,
  lookCategoryName,
  lookCategoryRows,
  lookDoneLine,
  lookItemMeta,
  lookProblemText,
  lookStage,
  togglePick,
} from '@whombat/client/managed';
import { useBackupLook, useBackupLookItems, useBringBack } from '@whombat/client/react';
import type { BackupLookCategory, BackupLookItem } from '@whombat/protocol/session';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField } from '../ui/formField';
import { BackBar, Screen } from '../ui/headers';
import { Button, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { backupErrorText } from './BackupDestination';
import { backupTitle } from './backupOptions';
import { Card, ErrorLine, LinkRow, Note } from './ui';
import { useBackupSession } from './useBackups';

type Props = NativeStackScreenProps<RootStackParamList, 'BackupBringBack'>;

const T = BACKUP_LOOK_TEXT;

export function BackupBringBackScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const bottomRoom = useBottomRoom();
  const session = useBackupSession();
  const { checkpointId, createdAt } = route.params;
  const { look, categories, error, retry } = useBackupLook(session, checkpointId);
  const [category, setCategory] = useState<BackupLookCategory | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bring = useBringBack(session);
  const stage = lookStage(look);
  const lookId = look?.lookId ?? null;
  const items = useBackupLookItems(session, stage === 'ready' ? lookId : null, category, query);
  const finishedAt = look?.bring?.finishedAt ?? null;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (finishedAt) setShown(true);
  }, [finishedAt]);
  const done = shown && look?.bring && !bring.isPending ? lookDoneLine(look.bring) : null;
  const problem = error ? backupErrorText(error) : lookProblemText(look);
  const leave = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('WhombatBackups'));
  const bringNow = () => lookId && bring.mutate({ lookId, items: [...picked] });

  return (
    <Screen>
      <BackBar
        label={category && !done ? T.inIt : T.close}
        onPress={() => (category && !done ? setCategory(null) : leave())}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 + bottomRoom, gap: 12 }}
      >
        <View style={{ paddingHorizontal: 6, gap: 6 }}>
          <Text size={28} weight={700} tracking={-0.02} lh={1.2} accessibilityRole="header">
            {T.title}
          </Text>
          <Text size={14.5} color={theme.colors.ink2}>
            {backupTitle(createdAt)}
          </Text>
        </View>

        {problem ? (
          <View style={{ gap: 10 }}>
            <ErrorLine text={problem} />
            {look?.problem?.code !== 'not_supported' ? (
              <Button label={T.tryAgain} size="lg" onPress={retry} />
            ) : null}
            <Button label={T.close} variant="secondary" size="lg" onPress={leave} />
          </View>
        ) : stage === 'opening' ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              gap: 8,
              padding: 16,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.sf,
            }}
          >
            <Text size={15.5} weight={600}>
              {T.opening}
            </Text>
            <Text size={14} lh={1.45} color={theme.colors.ink2}>
              {T.openingLead}
            </Text>
            <SkeletonRows count={3} />
          </View>
        ) : done ? (
          <View style={{ gap: 10 }}>
            <View
              accessibilityLiveRegion="polite"
              style={{ padding: 16, borderRadius: 20, backgroundColor: theme.colors.sf2 }}
            >
              <Text size={15.5} lh={1.45}>
                {done}
              </Text>
            </View>
            <Button
              label={T.pickMore}
              variant="secondary"
              size="lg"
              onPress={() => {
                setShown(false);
                setPicked(new Set());
                setCategory(null);
                setQuery('');
              }}
            />
            <Button label={T.close} size="lg" onPress={leave} />
          </View>
        ) : category === null ? (
          <>
            <Note text={T.pickLead} />
            {categories.length === 0 ? (
              <Note text={T.empty} />
            ) : (
              <Card label={T.inIt.toUpperCase()}>
                {lookCategoryRows(categories).map((c, i) => (
                  <LinkRow
                    key={c.id}
                    first={i === 0}
                    title={c.name}
                    meta={c.count}
                    label={`${c.name}, ${c.count}`}
                    onPress={() => {
                      setCategory(c.id);
                      setQuery('');
                    }}
                  />
                ))}
              </Card>
            )}
            <Button
              label={bring.isPending ? T.bringing : T.bring(picked.size)}
              size="lg"
              disabled={picked.size === 0}
              busy={bring.isPending}
              onPress={bringNow}
            />
          </>
        ) : (
          <>
            <FormField
              label={lookCategoryName(category)}
              value={query}
              onChangeText={setQuery}
              placeholder={T.search(lookCategoryName(category))}
              accessibilityLabel={T.search(lookCategoryName(category))}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {items.loading ? (
              <SkeletonRows count={3} />
            ) : items.items.length === 0 ? (
              <Note text={query.trim() ? T.noMatch : T.empty} />
            ) : (
              <Card>
                {items.items.map((item, i) => (
                  <PickRow
                    key={item.id}
                    item={item}
                    first={i === 0}
                    checked={picked.has(item.id)}
                    onToggle={() => setPicked((p) => togglePick(p, item.id))}
                  />
                ))}
              </Card>
            )}
            {items.more ? <Button label={T.more} variant="secondary" onPress={items.more} /> : null}
            <Button
              label={bring.isPending ? T.bringing : T.bring(picked.size)}
              size="lg"
              disabled={picked.size === 0}
              busy={bring.isPending}
              onPress={bringNow}
            />
          </>
        )}
        <ErrorLine text={bring.error ? backupErrorText(bring.error) : null} />
      </ScrollView>
    </Screen>
  );
}

/** One thing of the backup: a tick box, its title, when and where it was, and whether it is here already. */
function PickRow({
  item,
  first,
  checked,
  onToggle,
}: {
  item: BackupLookItem;
  first: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  const meta = lookItemMeta(item);
  return (
    <Touchable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={[item.title, meta, item.here ? T.here : null].filter(Boolean).join('. ')}
      feedback="wash"
      onPress={onToggle}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: checked ? 0 : 1.5,
          borderColor: theme.colors.line2,
          backgroundColor: checked ? theme.colors.brand : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? (
          <Text size={14} weight={700} color={theme.colors.btnfg}>
            ✓
          </Text>
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={15} weight={500} lh={1.35}>
          {item.title}
        </Text>
        {meta ? (
          <Text size={13} lh={1.4} color={theme.colors.ink2}>
            {meta}
          </Text>
        ) : null}
      </View>
      {item.here ? (
        <Text size={12.5} color={theme.colors.ok}>
          {T.here}
        </Text>
      ) : null}
    </Touchable>
  );
}
