/**
 * Found on your network on the phone's Add a connection (phone-connect.md PC-08, AP-2913; Whombat connections-setup.md
 * CS-14, CS-51…CS-53): for people who manage the burrow, where the runtime has `connections.discover`. What the last
 * scan found that isn't connected yet — logo, name, version, what it is in a few words (the entry's `tagline`, Whombat
 * desk-found.md DF-08, AP-3803), the address in mono — with Add as a server for a computer that answers SSH and for
 * Proxmox VE, its Backup Server and Unraid (Whombat connect-in-chat.md), else Connect (Connect {Name} with the
 * address filled in and identified at once) and, with `connections.hide_found`, Hide (for the whole burrow); the hidden
 * ones after the others behind “Show 2 hidden”, with Unhide. Opening asks for the scan (a recent one is reused, else one
 * starts) and follows it every 1.5 s while it looks; Scan again starts over; Look in another network adds one. A refusal
 * (an older server) leaves the section out. The web's words and rules (`@whombat/client/connections`).
 */

import { ApiError, InvalidRequestError } from '@whombat/client';
import {
  cidrProblem,
  discoveryPollDelay,
  discoveryProgressText,
  type FoundRow,
  foundEmptyText,
  foundList,
  groupDigits,
  hiddenToggleText,
  hideTroubleText,
  networksText,
} from '@whombat/client/connections';
import { useConnectionWrite } from '@whombat/client/react';
import { api, type ConnectionDiscovery, type DiscoverConnectionsBody } from '@whombat/core/contracts';
import { formatAgo } from '@whombat/core/text';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useViewContext } from '../../data/BurrowProvider';
import { connectionLogo } from '../../data/connections';
import { mobileTranslator, useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ConnectionLogo } from '../../ui/ConnectionLogo';
import { FormField } from '../../ui/formField';
import { Button, Section } from '../../ui/primitives';
import { Busy, Note, PLAIN_INPUT, TextLink } from './parts';

export function foundText(locale?: string | null) {
  const tr = mobileTranslator(locale);
  return {
    title: tr.t('screens2.found.title'),
    scanAgain: tr.t('screens2.found.scanAgain'),
    lookElsewhere: tr.t('screens2.found.lookElsewhere'),
    network: tr.t('screens2.found.network'),
    lookThere: tr.t('screens2.found.lookThere'),
    networkHint: tr.t('screens2.found.networkHint', { count: groupDigits(1024) }),
    looking: tr.t('screens2.found.looking'),
    idle: tr.t('screens2.found.idle'),
    trouble: tr.t('screens2.found.trouble'),
    connect: tr.t('screens2.found.connect'),
    addServer: tr.t('screens2.found.addServer'),
    hide: tr.t('screens2.found.hide'),
    unhide: tr.t('screens2.found.unhide'),
    writeLike: tr.t('screens2.found.writeLike'),
  };
}

type AskResult = { ok: true } | { ok: false; invalid: string | null };

/** The scan, asked for on opening and followed every 1.5 s while it looks; an older answer never replaces a newer one. */
function useFoundScan(burrow: string | null) {
  const { rawLocale } = useI18n();
  const foundTextHere = foundText(rawLocale);
  const discover = useConnectionWrite(api.connections.discover, burrow ?? '');
  const [scan, setScan] = useState<ConnectionDiscovery | null>(null);
  const [refused, setRefused] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const mutate = useRef(discover.mutateAsync);
  mutate.current = discover.mutateAsync;
  const latest = useRef(0);
  const shown = useRef(0);

  const ask = useCallback(
    async (body: DiscoverConnectionsBody): Promise<AskResult> => {
      if (!burrow) return { ok: false, invalid: null };
      const mine = ++latest.current;
      try {
        const result = await mutate.current({ params: { burrow }, body });
        if (result.status !== 'ok' || mine < shown.current) return { ok: false, invalid: null };
        shown.current = mine;
        setScan(result.data);
        setTrouble(null);
        return { ok: true };
      } catch (err) {
        if (mine !== latest.current) return { ok: false, invalid: null };
        if (body.networks?.length && (err instanceof InvalidRequestError || isValidation(err)))
          return { ok: false, invalid: validationText(err) ?? foundTextHere.writeLike };
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) setRefused(true);
        else setTrouble(foundTextHere.trouble);
        return { ok: false, invalid: null };
      }
    },
    [burrow, foundTextHere.writeLike, foundTextHere.trouble],
  );

  useEffect(() => {
    void ask({});
  }, [ask]);

  useEffect(() => {
    const delay = discoveryPollDelay(scan);
    if (delay === null) return;
    const timer = setTimeout(() => void ask({}), delay);
    return () => clearTimeout(timer);
  }, [scan, ask]);

  const begin = useCallback(() => ++latest.current, []);
  const accept = useCallback((mine: number, data: ConnectionDiscovery) => {
    if (mine < shown.current) return false;
    shown.current = mine;
    setScan(data);
    return true;
  }, []);

  return { scan, refused: refused || !burrow, trouble, pending: discover.isPending, ask, begin, accept };
}

export function FoundOnNetwork({
  burrow,
  query,
  onConnect,
}: {
  /** Null: this Whombat can't scan (the runtime has no `connections.discover`). */
  burrow: string | null;
  /** What the search box says: the rows are narrowed to the names it matches. */
  query: string;
  onConnect: (row: FoundRow) => void;
}) {
  const { rawLocale } = useI18n();
  const foundTextHere = foundText(rawLocale);

  const theme = useTheme();
  const { now, timeZone } = useViewContext();
  const found = useFoundScan(burrow);
  const hideFound = useConnectionWrite(api.connections.hideFound, burrow ?? '');
  const [hideTrouble, setHideTrouble] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [other, setOther] = useState(false);
  const [cidr, setCidr] = useState('');
  const [cidrError, setCidrError] = useState<string | null>(null);
  const { scan, trouble } = found;
  const list = scan ? foundList(scan, rawLocale) : null;
  const hiddenCount = list?.hidden.length ?? 0;

  useEffect(() => {
    if (hiddenCount === 0) setShowHidden(false);
  }, [hiddenCount]);

  async function changeHidden(row: FoundRow, hidden: boolean) {
    if (!burrow) return;
    const mine = found.begin();
    const done = (b: ReadonlySet<string>) => {
      const next = new Set(b);
      next.delete(row.key);
      return next;
    };
    setBusy((b) => new Set(b).add(row.key));
    setHideTrouble(null);
    try {
      const result = await hideFound.mutateAsync({
        params: { burrow },
        body: { catalogId: row.catalogId, url: row.url, hidden },
      });
      if (result.status !== 'ok') return setHideTrouble(hideTroubleText(hidden, rawLocale));
      found.accept(mine, result.data);
    } catch {
      setHideTrouble(hideTroubleText(hidden, rawLocale));
    } finally {
      setBusy(done);
    }
  }

  async function lookIn() {
    const problem = cidrProblem(cidr, rawLocale);
    if (problem) return setCidrError(problem);
    setCidrError(null);
    const answer = await found.ask({ networks: [cidr.trim()], rescan: true });
    if (answer.ok) {
      setCidr('');
      setOther(false);
    } else if (answer.invalid) setCidrError(answer.invalid);
  }

  if (found.refused) return null;
  const searching = query.trim() !== '';
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const named = (row: FoundRow) => words.every((w) => row.name.toLowerCase().includes(w));
  const scanning = scan?.state === 'scanning';
  const open = showHidden && hiddenCount > 0;
  const all = list ? (open ? [...list.rows, ...list.hidden] : list.rows) : [];
  const rows = searching ? all.filter(named) : all;
  if (searching && rows.length === 0) return null;
  const empty = scan?.state === 'done' && list && !searching ? foundEmptyText(list, rawLocale) : null;
  const looked = scan?.state === 'done' ? networksText(scan.networks, rawLocale) : null;

  return (
    <Section title={foundTextHere.title}>
      <View style={{ padding: 14, gap: 12 }}>
        {!scan && !trouble ? <Busy text={foundTextHere.looking} /> : null}
        {scanning && scan ? <Busy text={discoveryProgressText(scan, rawLocale)} /> : null}
        {trouble ? <Note>{trouble}</Note> : null}
        {hideTrouble ? <Note tone="bad">{hideTrouble}</Note> : null}
        {empty ? <Note>{empty}</Note> : null}
        {scan?.state === 'idle' && !trouble ? <Note>{foundTextHere.idle}</Note> : null}
        {rows.map((row) => (
          <View key={row.key} style={{ gap: 10, opacity: row.hidden ? 0.6 : 1 }} accessible={false}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <ConnectionLogo logo={connectionLogo(row.catalogId, row.name)} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text size={15} weight={600} numberOfLines={1}>
                  {row.version ? `${row.name}  ` : row.name}
                  {row.version ? (
                    <Text size={13} weight={400} color={theme.colors.mut}>
                      {row.version}
                    </Text>
                  ) : null}
                </Text>
                {row.tagline ? (
                  <Text size={13} color={theme.colors.ink2} numberOfLines={1}>
                    {row.tagline}
                  </Text>
                ) : null}
                <Text size={12} mono color={theme.colors.mut} numberOfLines={1}>
                  {row.where}
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {row.hidden ? (
                <Button
                  label={foundTextHere.unhide}
                  variant="secondary"
                  disabled={busy.has(row.key)}
                  accessibilityHint={`${row.name} at ${row.url}`}
                  onPress={() => void changeHidden(row, false)}
                  style={{ flex: 1 }}
                />
              ) : (
                <>
                  <Button
                    label={foundTextHere.hide}
                    variant="secondary"
                    disabled={busy.has(row.key)}
                    accessibilityHint={`${row.name} at ${row.url}`}
                    onPress={() => void changeHidden(row, true)}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label={row.action === 'server' ? foundTextHere.addServer : foundTextHere.connect}
                    accessibilityHint={`${row.name} at ${row.where}`}
                    onPress={() => onConnect(row)}
                    style={{ flex: 2 }}
                  />
                </>
              )}
            </View>
          </View>
        ))}
        {looked || hiddenCount > 0 ? (
          <View style={{ gap: 2 }}>
            {looked && scan ? (
              <Text size={12.5} color={theme.colors.mut}>
                {`${looked}${scan.finishedAt ? ` · ${formatAgo(scan.finishedAt, now, timeZone, rawLocale)}` : ''}`}
              </Text>
            ) : null}
            {hiddenCount > 0 ? (
              <TextLink
                label={hiddenToggleText(hiddenCount, open, rawLocale)}
                onPress={() => setShowHidden((v) => !v)}
              />
            ) : null}
          </View>
        ) : null}
        <Button
          label={foundTextHere.scanAgain}
          variant="secondary"
          disabled={scanning || found.pending}
          onPress={() => void found.ask({ rescan: true })}
        />
        <TextLink
          label={foundTextHere.lookElsewhere}
          onPress={() => {
            setOther((o) => !o);
            setCidrError(null);
          }}
        />
        {other ? (
          <View style={{ gap: 8 }}>
            <FormField
              label={foundTextHere.network}
              value={cidr}
              onChangeText={(v) => {
                setCidr(v);
                setCidrError(null);
              }}
              placeholder="192.168.2.0/24"
              hint={cidrError ? null : foundTextHere.networkHint}
              error={cidrError}
              mono
              keyboardType="numbers-and-punctuation"
              returnKeyType="go"
              onSubmitEditing={() => void lookIn()}
              {...PLAIN_INPUT}
            />
            <Button label={foundTextHere.lookThere} disabled={found.pending} onPress={() => void lookIn()} />
          </View>
        ) : null}
      </View>
    </Section>
  );
}

function isValidation(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'validation_failed';
}

function validationText(err: unknown): string | null {
  if (err instanceof InvalidRequestError || err instanceof ApiError) {
    const first = Object.values(err.fields)[0]?.[0];
    if (first) return first;
  }
  return err instanceof ApiError && err.message ? err.message : null;
}
