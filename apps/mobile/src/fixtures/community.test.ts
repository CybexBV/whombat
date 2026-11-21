/**
 * The demo's community box (AP-5478) over a real secure session: a phone is added with the fixtures' device link and
 * comes back on the app channel as Mara, with `welcome.edition` community; its device links, mail and Tailscale answer
 * as a community box's do.
 */
import { createClient, mailApi, tailscaleApi } from '@whombat/client';
import { joinWithLink, readLocalLink } from '@whombat/client/managed';
import { type ApplianceSession, createSecureSession, sessionOps } from '@whombat/client/session';
import { DEVICE_LINK } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { ApplianceStatusOutput } from '@whombat/protocol/session';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createClock } from '../lib/time';
import { minutesAfterSeed } from '../test/world';
import { COMMUNITY_PERSON, communityStatus, createCommunityBox } from './community';
import { createFixtureServer } from './fixture-server';

const KEY = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const ENDPOINT = { label: 'Pixel 7 · Android app', platform: 'android' } as const;

function box() {
  const now = createClock(minutesAfterSeed(0), Date.now());
  const server = createFixtureServer({ inner: createFixtureFetch(), now, setTimer: () => {} });
  return createCommunityBox({ rest: server.fetch as never, origin: FIXTURE_ORIGIN });
}

const open: ApplianceSession[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function session(b: ReturnType<typeof box>, channel: 'app' | 'enroll') {
  const s = createSecureSession({
    connector: b.connectorFor(KEY, channel),
    expect: 'any',
    raceAfterMs: 0,
    stallMs: 0,
  });
  open.push(s);
  s.connect();
  return s;
}

async function opened(s: ApplianceSession) {
  for (let i = 0; i < 200 && s.state().status !== 'open'; i++) await new Promise((r) => setTimeout(r, 5));
  const st = s.state();
  if (st.status !== 'open') throw new Error(`not open: ${st.status}`);
  return st.info;
}

describe('the community demo box', () => {
  it('lets a phone in with the device link, then welcomes it as Mara on a community box', async () => {
    const b = box();
    const enroll = session(b, 'enroll');
    expect((await opened(enroll)).channel).toBe('enroll');
    const link = readLocalLink(DEVICE_LINK.link);
    if (!link) throw new Error('fixture link');
    const joined = await joinWithLink(enroll, link, ENDPOINT);
    expect(joined.accountId).toBe(COMMUNITY_PERSON.id);
    const app = session(b, 'app');
    const info = await opened(app);
    expect(info).toMatchObject({
      channel: 'app',
      edition: 'community',
      account: { id: COMMUNITY_PERSON.id },
    });
    expect(info.direct?.routes.length).toBeGreaterThan(0);
    // The burrow app finds its burrow (`me.get`), and the rest is the demo world's.
    const me = await createClient({ session: app }).me.get({});
    expect(me.memberships[0]?.burrowSlug).toBeTruthy();
  });

  it('makes device links on its own ways, and keeps mail and Tailscale’s login server', async () => {
    const b = box();
    b.joined.set(KEY, COMMUNITY_PERSON);
    const app = session(b, 'app');
    await opened(app);
    expect(readLocalLink((await sessionOps.linkCreate(app)).link)?.kind).toBe('device');
    const mail = mailApi(app);
    expect((await mail.get()).mail).toBeNull();
    await mail.set({
      host: 'smtp.lumio.example.org',
      port: 587,
      security: 'starttls',
      username: 'w@lumio.example.org',
      password: 'p',
      from: 'w@lumio.example.org',
    });
    expect((await mail.test()).test).toMatchObject({ state: 'sent', to: 'mara@lumio.example.org' });
    const ts = tailscaleApi(app);
    expect((await ts.on('https://hs.lumio.example.org')).tailscale.loginServer).toBe(
      'https://hs.lumio.example.org',
    );
    await ts.state();
    expect((await ts.state()).tailscale).toMatchObject({
      state: 'on',
      loginServer: 'https://hs.lumio.example.org',
    });
  });

  it('reports a status the app can read, without a licence', () => {
    const parsed = ApplianceStatusOutput.safeParse(communityStatus());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.licence).toBeUndefined();
  });
});
