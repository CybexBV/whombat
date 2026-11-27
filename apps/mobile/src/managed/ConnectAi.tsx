/**
 * Connect your AI on the phone, the claim's third step (Whombat first-day.md): the AI sign-in a phone couldn't do
 * before (“…which you add on the web”). The same two flows as the web's Settings → AI, over the session: ChatGPT's
 * device code (copy the code, open OpenAI's page in the in-app browser, sign in there) and Claude Code's own sign-in
 * (open claude.ai in the in-app browser, approve, copy the code it shows, paste it here). Asked only while nothing is
 * ready; Skip for now opens the Whombat, where the line that the assistant can't work yet shows as before.
 */

import { agentWords, createClient, theAgentOf } from '@whombat/client';
import { CONNECT_AI_PROVIDERS, connectAiStep, connectAiText, readyProviders } from '@whombat/client/managed';
import type { ApplianceSession } from '@whombat/client/session';
import {
  type ClientsList,
  clientInstalled,
  clientOf,
  needsClient,
  type SignInsList,
} from '@whombat/client/signins';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { Button, Loading } from '../ui/primitives';
import { AiSignInCard } from './AiSignIn';
import { Frame, Note } from './ui';

/** How often the lists are read while the step is open (a sign-in finishing, Claude Code installing). */
const LIST_POLL_MS = 3_000;

export function ConnectAiScreen({ session, onDone }: { session: ApplianceSession; onDone: () => void }) {
  const { rawLocale } = useI18n();
  const T = connectAiText(rawLocale);

  const client = useMemo(() => createClient({ session }), [session]);
  const [signIns, setSignIns] = useState<SignInsList>();
  const [clients, setClients] = useState<ClientsList>();
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(false);
  const [name, setName] = useState<string | null>(null);

  // Whether a read has ever worked: a blip during the poll mustn't skip the step while the person is still signing in.
  const loaded = useRef(false);
  const read = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([client.signins.list({}), client.clients.list({})]);
      loaded.current = true;
      setFailed(false);
      setSignIns(s);
      setClients(c);
    } catch {
      if (!loaded.current) setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void read();
    const t = setInterval(() => void read(), LIST_POLL_MS);
    return () => clearInterval(t);
  }, [read]);

  // The assistant's name for the words (“Dusty works on…”); “Your agent” until it is read.
  useEffect(() => {
    let live = true;
    void (async () => {
      const me = await client.me.get({});
      const burrow = me.memberships[0]?.burrowSlug;
      if (!burrow) return;
      const boot = await client.conversations.bootstrap({ params: { burrow } });
      if (live) setName(theAgentOf(boot.principals)?.name ?? null);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [client]);

  const step = connectAiStep({ signIns, clients, failed, asked });
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (step === 'ask') setAsked(true);
    if (step === 'go_on') done.current();
  }, [step]);

  const words = agentWords(name, rawLocale);
  if (step === 'go_on' || step === 'checking')
    return (
      <Frame kicker={T.kicker} title={T.title} sub={T.sub(words.Name)} tip={T.tip}>
        <Loading label={T.checking} />
      </Frame>
    );
  const ready = readyProviders(clients, signIns);
  return (
    <Frame kicker={T.kicker} title={T.title} sub={T.sub(words.Name)} tip={T.tip}>
      {CONNECT_AI_PROVIDERS.map((p) => (
        <AiSignInCard
          key={p}
          provider={p}
          client={client}
          ready={ready.includes(p)}
          installed={!needsClient(p) || clientInstalled(clientOf(clients, p))}
          installing={clientOf(clients, p)?.state === 'installing'}
          onChanged={() => void read()}
        />
      ))}
      {step === 'done' ? (
        <>
          <Note text={T.ready(ready, words.Name)} />
          <Button label={T.continue} size="lg" onPress={onDone} />
        </>
      ) : (
        <Button label={T.later} variant="secondary" size="lg" onPress={onDone} />
      )}
    </Frame>
  );
}
