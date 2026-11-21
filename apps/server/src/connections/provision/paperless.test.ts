import { afterEach, describe, expect, it } from 'vitest';
import { AUTHENTICATOR_CODE } from './home-common';
import { PAPERLESS_SHARED_NOTE, provisionPaperless } from './paperless';
import {
  expectStop,
  type Stub,
  type StubReply,
  type StubRequest,
  startStub,
  stubInput,
  TEST_PASSWORD,
} from './testing-home';

/** A Paperless-ngx as CS-24 reads it: `POST /api/token/` (Django REST framework's validation errors). */
interface PaperlessWorld {
  mfaCode?: string;
  throttled?: boolean;
}

const TOKEN = '3f7a9c2e1b8d4f6a0c5e7b9d2f4a6c8e0b1d3f5a';

function fakePaperless(world: PaperlessWorld) {
  return (req: StubRequest): StubReply => {
    if (req.method !== 'POST' || req.path !== '/api/token/') return { status: 404, body: '' };
    if (world.throttled) return { status: 429, json: { detail: 'Request was throttled.' } };
    const body = req.json();
    if (body.username !== 'mara' || body.password !== TEST_PASSWORD) {
      return { status: 400, json: { non_field_errors: ['Unable to log in with provided credentials.'] } };
    }
    if (world.mfaCode) {
      if (!body.code) return { status: 400, json: { non_field_errors: ['MFA code is required'] } };
      if (body.code !== world.mfaCode)
        return { status: 400, json: { non_field_errors: ['Invalid MFA code'] } };
    }
    return { json: { token: TOKEN } };
  };
}

let stub: Stub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

describe('Paperless-ngx (CS-24)', () => {
  it('answers the account’s token at either level, with the note that it is shared', async () => {
    stub = await startStub(fakePaperless({}));
    for (const access of ['read', 'manage'] as const) {
      const made = await provisionPaperless(stubInput(stub, 'paperless', { access }));
      expect(made).toEqual({
        fields: {},
        secret: TOKEN,
        limited: false,
        externalName: null,
        note: PAPERLESS_SHARED_NOTE,
      });
    }
    expect(stub.calls('POST /api/token/').map((r) => r.json())).toEqual([
      { username: 'mara', password: TEST_PASSWORD },
      { username: 'mara', password: TEST_PASSWORD },
    ]);
    expect(stub.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('asks for the code, then sends it along', async () => {
    stub = await startStub(fakePaperless({ mfaCode: '424242' }));
    const stop = await expectStop(provisionPaperless(stubInput(stub, 'paperless')), 'second_factor_needed');
    expect(stop.message).toBe(AUTHENTICATOR_CODE);

    const made = await provisionPaperless(stubInput(stub, 'paperless', { code: ' 424 242 ' }));
    expect(made.secret).toBe(TOKEN);
    expect(stub.calls('POST /api/token/')[1]?.json()).toEqual({
      username: 'mara',
      password: TEST_PASSWORD,
      code: '424242',
    });
  });

  it('refuses a wrong code and a wrong password', async () => {
    stub = await startStub(fakePaperless({ mfaCode: '424242' }));
    await expectStop(provisionPaperless(stubInput(stub, 'paperless', { code: '000000' })), 'code');
    const stop = await expectStop(
      provisionPaperless(stubInput(stub, 'paperless', { password: 'wrong' })),
      'password',
      'wrong',
    );
    // A single sign-on account gets the same answer: the way out is a token (SG-13).
    expect(stop.message).toMatch(/^Wrong username or password\./);
    expect(stop.message).toContain('through another service');
    expect(stop.method).toBe('token');
  });

  it('says when Paperless pauses sign-ins', async () => {
    stub = await startStub(fakePaperless({ throttled: true }));
    await expectStop(provisionPaperless(stubInput(stub, 'paperless')), 'locked');
  });
});
