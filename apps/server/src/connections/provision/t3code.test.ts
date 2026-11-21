/**
 * Sign in once for T3 Code (docs/decisions/t3code.md T3-02, T3-03, T3-05) against a stand-in T3 Code: the descriptor
 * first, registration, the approval with the pairing code (PKCE S256, state, resource) and the token exchange as a form;
 * Look only as Read only, Manage as Full access; the token's end; the refusals in the person's words, the code never in
 * them and never sent to something that isn't T3 Code.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startT3Code, type T3CodeStub } from '../testing/t3code-stub';
import { pairingCode, provisionT3Code, T3_REDIRECT_URI } from './t3code';
import { formOf, NOW, networkInput, refusalOf, type StubServer, startStub } from './testing-network';

let t3: T3CodeStub;

beforeAll(async () => {
  t3 = await startT3Code();
});

afterAll(async () => {
  await t3.close();
});

beforeEach(() => {
  t3.seen.length = 0;
  t3.knobs.old = false;
  t3.knobs.spendsShortCode = false;
});

const input = (password: string, access: 'read' | 'manage' = 'manage') =>
  networkInput('t3code', t3, { account: '', password, access });

const sent = (path: string) => t3.seen.filter((r) => r.path === path);

describe('T3 Code’s pairing code (T3-02)', () => {
  it('signs in as T3 Code links its own computers and keeps when the sign-in ends', async () => {
    const code = t3.pairingCode();
    const made = await provisionT3Code(input(code.toLowerCase()));
    expect(made).toMatchObject({ fields: {}, limited: true, externalName: 'thetitan', note: null });
    expect(made.secret).toBe(t3.issued.at(-1)?.token);
    expect(t3.issued.at(-1)?.access).toBe('full-access');
    // 30 days from now: T3 Code has no refresh.
    expect(made.expiresAt?.getTime()).toBe(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(t3.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /.well-known/t3/environment',
      'POST /oauth/mcp/register',
      'POST /oauth/mcp/decision',
      'POST /oauth/mcp/token',
    ]);
    expect(JSON.parse(sent('/oauth/mcp/register')[0]?.body ?? '')).toEqual({
      client_name: 'Whombat',
      redirect_uris: [T3_REDIRECT_URI],
    });
    const decision = JSON.parse(sent('/oauth/mcp/decision')[0]?.body ?? '');
    expect(decision.decision).toEqual({ _tag: 'pairing-code', access: 'full-access', code });
    expect(decision.authorization).toMatchObject({
      response_type: 'code',
      redirect_uri: T3_REDIRECT_URI,
      code_challenge_method: 'S256',
      resource: `${t3.url}/mcp`,
    });
    // The verifier sent with the exchange is the one the challenge was made from.
    const form = formOf(sent('/oauth/mcp/token')[0]?.body ?? '');
    expect(sent('/oauth/mcp/token')[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(
      createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url'),
    ).toBe(decision.authorization.code_challenge);
    expect(form).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: T3_REDIRECT_URI,
      client_id: decision.authorization.client_id,
      resource: `${t3.url}/mcp`,
    });
  });

  it('asks T3 Code for Read only when the agent may only look (T3-03)', async () => {
    await provisionT3Code(input(t3.pairingCode('read'), 'read'));
    expect(JSON.parse(sent('/oauth/mcp/decision')[0]?.body ?? '').decision.access).toBe('read-only');
    expect(t3.issued.at(-1)?.access).toBe('read-only');
  });

  it('refuses a code that didn’t work, without its words or the code', async () => {
    const used = t3.pairingCode();
    await provisionT3Code(input(used));
    const again = await refusalOf(provisionT3Code(input(used)), used);
    expect(again).toMatchObject({ code: 'sign_in_refused', reason: 'password' });
    expect(again.message).toMatch(/pairing code/i);
    expect(again.message).not.toMatch(/unknown, expired/);
    const typo = await refusalOf(provisionT3Code(input('ABCD2345EFGH')), 'ABCD2345EFGH');
    expect(typo.reason).toBe('password');
  });

  it('refuses Manage with a code that can only look, as T3 Code 0.1.5 and 0.1.3 do', async () => {
    const looks = t3.pairingCode('read');
    const kept = await refusalOf(provisionT3Code(input(looks, 'manage')), looks);
    expect(kept.reason).toBe('rights');
    expect(kept.message).toMatch(/Look only/);
    // 0.1.5 kept the code: it still signs in to look.
    await expect(provisionT3Code(input(looks, 'read'))).resolves.toMatchObject({ limited: true });
    t3.knobs.spendsShortCode = true;
    const spent = await refusalOf(provisionT3Code(input(t3.pairingCode('read'), 'manage')));
    expect(spent.reason).toBe('rights');
    expect(spent.message).toMatch(/new code/);
  });

  it('refuses a T3 Code from before outside agents, before the code goes anywhere', async () => {
    t3.knobs.old = true;
    const err = await refusalOf(provisionT3Code(input(t3.pairingCode())));
    expect(err.reason).toBe('unsupported');
    expect(err.message).toMatch(/t3 update/);
    expect(sent('/oauth/mcp/decision')).toEqual([]);
  });
});

describe('what isn’t T3 Code', () => {
  let other: StubServer;
  afterAll(async () => {
    await other?.close();
  });

  it('sends the code only to something that answers as T3 Code', async () => {
    other = await startStub((req) =>
      req.path === '/.well-known/t3/environment'
        ? { status: 200, body: { version: '1.2.3', name: 'something else' } }
        : { status: 404, body: 'Not found' },
    );
    const code = 'ABCD2345EFGH';
    const err = await refusalOf(
      provisionT3Code(networkInput('t3code', other, { account: '', password: code })),
      code,
    );
    expect(err.reason).toBe('unsupported');
    expect(other.requests.map((r) => r.path)).toEqual(['/.well-known/t3/environment']);
  });

  it('stops when the approval comes back without a code or with another state', async () => {
    const answers = [
      { redirectTo: `${T3_REDIRECT_URI}?error=invalid_target&state=x` },
      { redirectTo: `${T3_REDIRECT_URI}?code=c1&state=not-ours` },
    ];
    for (const answer of answers) {
      const fake = await startStub((req) => {
        if (req.path === '/.well-known/t3/environment')
          return { status: 200, body: { orchestrationProtocolVersion: 2 } };
        if (req.path === '/oauth/mcp/register') return { status: 201, body: { client_id: 'client-1' } };
        if (req.path === '/oauth/mcp/decision') return { status: 200, body: answer };
        return { status: 500, body: 'unexpected' };
      });
      const err = await refusalOf(
        provisionT3Code(networkInput('t3code', fake, { account: '', password: 'x' })),
      );
      expect(err.reason).toBe('unsupported');
      expect(fake.to('POST', '/oauth/mcp/token')).toEqual([]);
      await fake.close();
    }
  });
});

describe('the code as pasted', () => {
  it('takes a pairing code in any case or spacing, a whole pairing link, and other credentials as they are', () => {
    expect(pairingCode(' abcd2345efgh ')).toBe('ABCD2345EFGH');
    expect(pairingCode('ABCD 2345 EFGH')).toBe('ABCD2345EFGH');
    expect(pairingCode('http://thetitan:3773/pair#token=abcd2345efgh')).toBe('ABCD2345EFGH');
    expect(pairingCode('https://app.t3.codes/pair?host=x&token=Zz-long_Token')).toBe('Zz-long_Token');
    expect(pairingCode('Zz-long_Token')).toBe('Zz-long_Token');
  });
});
