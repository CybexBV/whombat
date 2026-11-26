/**
 * Guide cards (docs/decisions/assistant-guides.md AG-02, AG-03, AG-17): every block and state, read from the cached
 * message list as the DM renders them, so acting locks the card optimistically and a refusal rolls it back.
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, answeredGuideCard, type CommitResult, type GuideActInput } from '@whombat/client';
import { infiniteEndpointKey } from '@whombat/client/query';
import { useMessagesInfinite } from '@whombat/client/react';
import {
  catalogEntry,
  connectSignInCard,
  type GuideCard as GuideCardData,
  GuideVaultAsk,
  type Message,
} from '@whombat/core';
import { type AnyEndpoint, api } from '@whombat/core/contracts';
import { VAULT_ASK_TEXT, vaultAskCard } from '@whombat/core/vault';
import { describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/providers';
import type { AppServices } from '../../app/services';
import { fixtureServices } from '../../test/renderApp';
import { DESKTOP_CLIENT_ERROR } from '../connectors/copy';
import {
  guideAppForm,
  guideAppFormDone,
  guideAppStep,
  guideExpired,
  guideMulti,
  guideProvider,
  guideProviderDone,
  guideResult,
  guideWelcome,
} from './cardStates';
import { GuideCard } from './GuideCard';
import { MessageCard } from './MessageCard';

const burrow = 'burrow-hq';
const conversationId = 'cnv_dm-hazel';
const listKey = infiniteEndpointKey(api.messages.list, { params: { burrow, conversationId } });

function message(id: string, card: GuideCardData): Message {
  return {
    id,
    conversationId,
    authorId: 'prn_hazel',
    createdAt: '2026-09-26T12:00:00.000Z',
    editedAt: null,
    text: '',
    mentions: [],
    card,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
  } as Message;
}

function Dm({ onActed }: { onActed?: () => void }) {
  const history = useMessagesInfinite({ params: { burrow, conversationId } });
  const messages = history.data?.pages.flatMap((p) => p.messages) ?? [];
  return (
    <>
      {messages.map(
        (m) =>
          m.card && (
            <MessageCard
              key={m.id}
              burrow={burrow}
              card={m.card}
              messageId={m.id}
              conversationId={conversationId}
              {...(onActed ? { onGuideActed: onActed } : {})}
            />
          ),
      )}
    </>
  );
}

type Answer = (input: { params: unknown; body: unknown }) => Promise<CommitResult<unknown>>;

/**
 * The DM with these cards, and a small server behind it: `guides.act` (ok by default, else `answer`) locks the card
 * there too, and a refetch of the list reads the server's copy.
 */
function renderDm(cards: GuideCardData[], answer?: Answer, onActed?: () => void) {
  const services = fixtureServices();
  const server = cards.map((c, i) => message(`msg_guide${i}`, c));
  const page = () => ({ messages: server.map((m) => ({ ...m })), hasMore: false, before: null });
  services.queryClient.setQueryData(listKey, { pages: [page()], pageParams: [undefined] } as never);
  const calls: { params: unknown; body: unknown }[] = [];
  const original = services.client.request.bind(services.client);
  vi.spyOn(services.client, 'request').mockImplementation((async (ep: AnyEndpoint, input: never) => {
    if (ep.id === 'messages.list') return { status: 'ok', httpStatus: 200, data: page() };
    if (ep.id !== 'guides.act') return original(ep, input);
    calls.push(input);
    const result = answer
      ? await answer(input)
      : { status: 'ok' as const, httpStatus: 200, data: { ok: true } };
    const { params, body } = input as { params: { messageId: string }; body: GuideActInput };
    const at = server.findIndex((m) => m.id === params.messageId);
    const hit = server[at];
    if (result.status === 'ok' && hit?.card?.kind === 'guide') {
      const locked = answeredGuideCard(hit.card, body, '2026-09-26T12:01:00.000Z');
      const label = body.values ? 'Client ID 123-abc.apps… saved' : (locked.answer?.label ?? '');
      server[at] = { ...hit, card: { ...locked, answer: locked.answer && { ...locked.answer, label } } };
    }
    return result;
  }) as never);
  renderWith(services, <Dm onActed={onActed} />);
  return { services, calls };
}

function renderWith(services: AppServices, ui: React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: [`/dm/hazel`] }),
    notFoundMode: 'root',
  });
  render(
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const cardNamed = (title: string) => screen.findByRole('region', { name: title });

/** A refusal as the client throws it (CT-81: a generic code with `details.code`). */
function refusal(status: number, generic: string, code: string, message: string, fields = {}) {
  return new ApiError(
    status,
    generic as never,
    message,
    { error: { code: generic, message, details: { code }, fields } },
    'guides.act',
    fields,
  );
}

describe('GuideCard', () => {
  it('shows the label row, the body and the choices; a tap acts at once and locks the card', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const { calls } = renderDm([guideWelcome], () => {
      return new Promise((resolve) => {
        release = () => resolve({ status: 'ok', httpStatus: 200, data: { ok: true } });
      });
    });
    const card = await cardNamed('Hi Mara, I’m Neo, your agent.');
    expect(within(card).getByText('SET UP')).toBeTruthy();
    expect(within(card).getByText('You can also just type what you need.')).toBeTruthy();
    const group = within(card).getByRole('group');
    expect(within(group).getAllByRole('button')).toHaveLength(3);

    await user.click(within(card).getByRole('button', { name: /^Email/ }));
    expect(calls).toEqual([
      { params: { burrow, messageId: 'msg_guide0' }, body: { actionId: 'topic', optionIds: ['email'] } },
    ]);
    // Locked before the server answers: the choice is marked, nothing acts any more.
    expect(await within(card).findByText('You chose Email')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Maybe later/ })).toBeNull();
    expect(within(card).getByText('(your choice)', { exact: false })).toBeTruthy();
    expect(card.getAttribute('data-state')).toBe('done');
    await act(async () => release());
  });

  it('tells the room once an answer went through, so it opens the card’s thread', async () => {
    const user = userEvent.setup();
    const onActed = vi.fn();
    renderDm([guideWelcome], undefined, onActed);
    const card = await cardNamed('Hi Mara, I’m Neo, your agent.');
    await user.click(within(card).getByRole('button', { name: /^Email/ }));
    await waitFor(() => expect(onActed).toHaveBeenCalledTimes(1));
  });

  it('opens no thread when the answer is refused', async () => {
    const user = userEvent.setup();
    const onActed = vi.fn();
    renderDm(
      [guideWelcome],
      () => Promise.reject(refusal(409, 'conflict', 'guide_closed', 'This was answered already.')),
      onActed,
    );
    const card = await cardNamed('Hi Mara, I’m Neo, your agent.');
    await user.click(within(card).getByRole('button', { name: /^Email/ }));
    await waitFor(() => expect(card.getAttribute('data-state')).toBe('open'));
    expect(onActed).not.toHaveBeenCalled();
  });

  it('draws the providers’ logos and keeps “Coming soon” options out of reach', async () => {
    renderDm([guideProvider]);
    const card = await cardNamed('Which email do you use?');
    expect(card.querySelector('[data-mark="google"]')).toBeTruthy();
    expect(card.querySelector('[data-mark="microsoft"]')?.getAttribute('aria-hidden')).toBe('true');
    const microsoft = within(card).getByRole('button', { name: /Microsoft 365/ }) as HTMLButtonElement;
    expect(microsoft.disabled).toBe(true);
    expect(microsoft.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(card).getAllByText('Coming soon')).toHaveLength(2);
    expect((within(card).getByRole('button', { name: /^Google/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('ticks several options, then sends them with the submit label', async () => {
    const user = userEvent.setup();
    const { calls } = renderDm([guideMulti]);
    const card = await cardNamed('What should I keep an eye on?');
    const save = within(card).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(within(card).getByRole('button', { name: /Today’s meetings/ }));
    await user.click(within(card).getByRole('button', { name: /New mail/ }));
    expect(
      within(card)
        .getByRole('button', { name: /New mail/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(within(card).getByRole('button', { name: /Today’s meetings/ }));
    await user.click(within(card).getByRole('button', { name: /Today’s meetings/ }));
    await user.click(save);
    expect(calls[0]?.body).toEqual({ actionId: 'contents', optionIds: ['mail', 'calendar'] });
    expect(await within(card).findByText('You chose New mail, Today’s meetings')).toBeTruthy();
  });

  it('copies values and opens links out in a new tab', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderDm([guideAppStep]);
    const card = await cardNamed('Create the OAuth client');
    expect(within(card).getByText('SET UP · GOOGLE · STEP 4 OF 6')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Copy Redirect URI' }));
    expect(writeText).toHaveBeenCalledWith('https://app.whombat.com/connect/google');
    expect(await screen.findByText('Redirect URI copied.')).toBeTruthy();
    const link = within(card).getByRole('link', { name: /Create the client/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows status rows with named dots and the server’s link', async () => {
    renderDm([guideResult]);
    const card = await cardNamed('Google connected · mara@example.com');
    expect(within(card).getAllByRole('img', { name: 'Working' })).toHaveLength(2);
    expect(within(card).getByRole('img', { name: 'Needs attention' })).toBeTruthy();
    expect(within(card).getByRole('img', { name: 'Not checked' })).toBeTruthy();
    const turnOn = within(card).getByRole('link', { name: /Turn it on/ });
    expect(turnOn.getAttribute('href')).toContain('drive.googleapis.com');
    expect(turnOn.getAttribute('target')).toBe('_blank');
  });

  it('shows locked cards quietly: the answer, dimmed options, nothing that acts', async () => {
    renderDm([guideProviderDone, guideAppFormDone, guideExpired]);
    const provider = await cardNamed('Which email do you use?');
    expect(within(provider).getByText('You chose Google')).toBeTruthy();
    expect(within(provider).queryAllByRole('button')).toHaveLength(0);
    const chosen = within(provider).getByText('(your choice)', { exact: false }).closest('li');
    expect(chosen?.hasAttribute('data-selected')).toBe(true);

    const form = await cardNamed('Paste the Client ID and secret');
    expect(within(form).getByText('Client ID 1234567890ab… saved')).toBeTruthy();
    expect(within(form).queryByRole('textbox')).toBeNull();

    const expired = await cardNamed('Quick idea');
    expect(expired.getAttribute('data-state')).toBe('expired');
    expect(within(expired).getByText('This expired. Ask me any time.')).toBeTruthy();
    expect(within(expired).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('GuideCard keyboard', () => {
  it('keeps the focus on the card when acting takes the button away, and when a refusal reopens it', async () => {
    const user = userEvent.setup();
    let answer: () => void = () => {};
    renderDm([guideWelcome], () => {
      return new Promise((_resolve, reject) => {
        answer = () => reject(refusal(403, 'forbidden', 'not_yours', 'Only Mara can answer this.'));
      });
    });
    const card = await cardNamed('Hi Mara, I’m Neo, your agent.');
    within(card)
      .getByRole('button', { name: /^Email/ })
      .focus();
    await user.keyboard('{Enter}');
    const row = await within(card).findByText('You chose Email');
    await waitFor(() => expect(document.activeElement).toBe(row.closest('p')));
    await act(async () => answer());
    await waitFor(() => expect(card.getAttribute('data-state')).toBe('open'));
    expect(document.activeElement).toBe(card);
  });

  it('two presses before the card re-renders send one act', async () => {
    const { calls } = renderDm([guideWelcome]);
    const card = await cardNamed('Hi Mara, I’m Neo, your agent.');
    const later = within(card).getByRole('button', { name: /Maybe later/ });
    fireEvent.click(later);
    fireEvent.click(later);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {});
    expect(calls).toHaveLength(1);
  });
});

describe('GuideCard form', () => {
  it('asks for what is missing and sends nothing', async () => {
    const user = userEvent.setup();
    const { calls } = renderDm([guideAppForm]);
    const card = await cardNamed('Paste the Client ID and secret');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(within(card).getAllByText('Fill this in.')).toHaveLength(2);
    expect(
      within(card)
        .getByLabelText(/Client ID/)
        .getAttribute('aria-invalid'),
    ).toBe('true');
    expect(calls).toEqual([]);
  });

  it('masks the secret, sends the values once and forgets them', async () => {
    const user = userEvent.setup();
    const { calls } = renderDm([guideAppForm]);
    const card = await cardNamed('Paste the Client ID and secret');
    const secret = within(card).getByLabelText(/Client secret/) as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.autocomplete).toBe('off');
    await user.type(within(card).getByLabelText(/Client ID/), ' 123-abc.apps.googleusercontent.com ');
    await user.type(secret, 'GOCSPX-secret');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(calls[0]?.body).toEqual({
      actionId: 'client',
      values: { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' },
    });
    await waitFor(() => expect(card.getAttribute('data-state')).toBe('done'));
    expect(await within(card).findByText('Client ID 123-abc.apps… saved')).toBeTruthy();
    expect(card.querySelector('input')).toBeNull();
  });

  it('rolls back on invalid_values and puts the server’s words under the fields, keeping what was typed', async () => {
    const user = userEvent.setup();
    renderDm([guideAppForm], async () => {
      throw refusal(422, 'validation_failed', 'invalid_values', 'Check the Client ID.', {
        'values.clientId': ['That isn’t a Google Client ID.'],
      });
    });
    const card = await cardNamed('Paste the Client ID and secret');
    await user.type(within(card).getByLabelText(/Client ID/), 'nope');
    await user.type(within(card).getByLabelText(/Client secret/), 'GOCSPX-x');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText('That isn’t a Google Client ID.')).toBeTruthy();
    expect(card.getAttribute('data-state')).toBe('open');
    expect((within(card).getByLabelText(/Client ID/) as HTMLInputElement).value).toBe('nope');
  });

  it('reads the client JSON in the browser: a Desktop client is refused, a web client fills the form', async () => {
    const user = userEvent.setup();
    const { calls } = renderDm([guideAppForm]);
    const card = await cardNamed('Paste the Client ID and secret');
    const file = card.querySelector('input[type="file"]') as HTMLInputElement;
    const desktop = JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } });
    fireEvent.change(file, { target: { files: [new File([desktop], 'client_secret_1.json')] } });
    expect(await within(card).findByText(DESKTOP_CLIENT_ERROR)).toBeTruthy();

    const web = JSON.stringify({
      web: { client_id: '42-web.apps.googleusercontent.com', client_secret: 'GOCSPX-web', redirect_uris: [] },
    });
    fireEvent.change(file, { target: { files: [new File([web], 'client_secret_2.json')] } });
    expect(await within(card).findByText('client_secret_2.json')).toBeTruthy();
    expect((within(card).getByLabelText(/Client ID/) as HTMLInputElement).value).toBe(
      '42-web.apps.googleusercontent.com',
    );
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(calls[0]?.body).toEqual({
      actionId: 'client',
      values: { clientId: '42-web.apps.googleusercontent.com', clientSecret: 'GOCSPX-web', file: web },
    });
  });
  it('refuses a file too big to be the client JSON without reading it, and one that can’t be read', async () => {
    renderDm([guideAppForm]);
    const card = await cardNamed('Paste the Client ID and secret');
    const file = card.querySelector('input[type="file"]') as HTMLInputElement;
    const huge = new File(['{}'], 'huge.json');
    Object.defineProperty(huge, 'size', { value: 50 * 1024 * 1024 });
    const read = vi.spyOn(huge, 'text');
    fireEvent.change(file, { target: { files: [huge] } });
    expect(await within(card).findByText('That file is too big.')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();

    const broken = new File(['{}'], 'gone.json');
    vi.spyOn(broken, 'text').mockRejectedValue(new DOMException('gone', 'NotReadableError'));
    fireEvent.change(file, { target: { files: [broken] } });
    expect(await within(card).findByText('That file couldn’t be read. Try again.')).toBeTruthy();
  });
});

describe('GuideCard refusals', () => {
  it('says nothing when another tab answered first, and asks the server again', async () => {
    const user = userEvent.setup();
    const { services } = renderDm([guideWelcome], async () => {
      throw refusal(409, 'conflict', 'guide_closed', 'This step is done.');
    });
    const refetch = vi.spyOn(services.queryClient, 'invalidateQueries');
    const card = await cardNamed('Hi Mara, I’m Neo, your agent.');
    await user.click(within(card).getByRole('button', { name: /^Files/ }));
    await waitFor(() => expect(refetch).toHaveBeenCalledWith(expect.objectContaining({ queryKey: listKey })));
    expect(screen.queryByText('This step is done.')).toBeNull();
  });

  it('says Whombat wasn’t reached when the request never got there', async () => {
    const user = userEvent.setup();
    renderDm([guideWelcome], async () => {
      throw new TypeError('offline');
    });
    const card = await cardNamed('Hi Mara, I’m Neo, your agent.');
    await user.click(within(card).getByRole('button', { name: /^Email/ }));
    expect(await screen.findByText('Couldn’t reach Whombat. Nothing changed, try again.')).toBeTruthy();
  });
});

describe('the sign-in card', () => {
  const server = vaultAskCard(
    'Neo',
    GuideVaultAsk.parse({
      kind: 'server',
      name: 'prod-1',
      username: 'deploy',
      server: { host: '192.168.1.30', port: 22, reason: 'key_refused' },
    }),
    null,
  );
  const title = 'Neo couldn’t sign in to prod-1 with its key';

  it('offers the three ways, the key put on first, and sends the way with only its fields', async () => {
    const user = userEvent.setup();
    const { calls } = renderDm([server]);
    const card = await cardNamed(title);
    const ways = within(card).getAllByRole('radio') as HTMLInputElement[];
    expect(ways.map((w) => w.value)).toEqual(['key_once', 'keep_password', 'own_key']);
    expect(ways[0]?.checked).toBe(true);
    const password = within(card).getByLabelText(/^Password/) as HTMLInputElement;
    expect(password.type).toBe('password');
    await user.type(password, 'hunter2');
    await user.click(within(card).getByRole('radio', { name: /Keep the password/ }));
    await user.click(within(card).getByRole('button', { name: 'Sign in' }));
    expect(calls[0]?.body).toEqual({
      actionId: 'save',
      values: { password: 'hunter2', way: 'keep_password' },
    });
  });

  it('takes a private key by paste, never shows it, and leaves the password out', async () => {
    const user = userEvent.setup();
    const { calls } = renderDm([server]);
    const card = await cardNamed(title);
    await user.click(within(card).getByRole('radio', { name: /own private key/ }));
    await user.click(within(card).getByRole('button', { name: 'Sign in' }));
    expect(await within(card).findByText(VAULT_ASK_TEXT.empty.privateKey)).toBeTruthy();
    expect(calls).toEqual([]);
    const paste = within(card).getByLabelText(/^Private key/);
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';
    fireEvent.paste(paste, { clipboardData: { getData: () => key } });
    expect(await within(card).findByText('Private key pasted')).toBeTruthy();
    expect(card.textContent).not.toContain('BEGIN OPENSSH');
    await user.click(within(card).getByRole('button', { name: 'Sign in' }));
    expect(calls[0]?.body).toEqual({ actionId: 'save', values: { private_key: key, way: 'own_key' } });
  });

  it('shows a wrong password on its field, keeps the card open and drops what was typed', async () => {
    const user = userEvent.setup();
    renderDm([server], async () => {
      throw refusal(422, 'validation_failed', 'invalid_values', 'That password didn’t work. Try again.', {
        'values.password': ['That password didn’t work. Try again.'],
      });
    });
    const card = await cardNamed(title);
    await user.type(within(card).getByLabelText(/^Password/), 'wrong');
    await user.click(within(card).getByRole('button', { name: 'Sign in' }));
    expect(await within(card).findByText('That password didn’t work. Try again.')).toBeTruthy();
    expect(card.getAttribute('data-state')).toBe('open');
    expect((within(card).getByLabelText(/^Password/) as HTMLInputElement).value).toBe('');
  });

  it('asks for a code with Send and says it isn’t kept', async () => {
    const user = userEvent.setup();
    const code = vaultAskCard('Neo', GuideVaultAsk.parse({ kind: 'code', name: 'github.com' }), null);
    const { calls } = renderDm([code]);
    const card = await cardNamed('Type the code github.com sent you');
    expect(within(card).getByText(VAULT_ASK_TEXT.underCode)).toBeTruthy();
    const field = within(card).getByLabelText(/^Code/) as HTMLInputElement;
    expect(field.autocomplete).toBe('one-time-code');
    await user.type(field, ' 123456 ');
    await user.click(within(card).getByRole('button', { name: 'Send' }));
    expect(calls[0]?.body).toEqual({ actionId: 'save', values: { code: '123456' } });
  });

  it('checks a login’s authenticator key before sending', async () => {
    const user = userEvent.setup();
    const login = vaultAskCard(
      'Neo',
      GuideVaultAsk.parse({ kind: 'login', name: 'github.com', url: 'https://github.com', username: 'mara' }),
      null,
    );
    const { calls } = renderDm([login]);
    const card = await cardNamed('Neo needs the password for github.com');
    await user.type(within(card).getByLabelText(/^Password/), 'p');
    await user.type(within(card).getByLabelText(/^Authenticator key/), 'not a key!');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(calls).toEqual([]);
    expect(
      within(card)
        .getByLabelText(/^Authenticator key/)
        .getAttribute('aria-invalid'),
    ).toBe('true');
  });
});

describe('OAuth connect cards', () => {
  const mcp = catalogEntry('custom_mcp');
  if (!mcp) throw new Error('custom_mcp');
  const returnTo = '/burrow-hq/chat?thread=msg_root&guide=msg_card';
  const oauthCard = connectSignInCard(
    mcp,
    { label: 'Gehoord', url: 'https://gehoord.example/api/mcp', access: 'read', returnTo },
    'Dusty',
  );

  it('starts OAuth directly from the card with its access and returnTo', async () => {
    const user = userEvent.setup();
    const services = fixtureServices();
    const starts: unknown[] = [];
    const leave = vi.fn();
    const original = services.client.request.bind(services.client);
    vi.spyOn(services.client, 'request').mockImplementation((async (ep: AnyEndpoint, input: never) => {
      if (ep.id === 'connections.startOAuth') {
        starts.push((input as { body: unknown }).body);
        return {
          status: 'ok',
          httpStatus: 200,
          data: { authorizeUrl: 'https://auth.gehoord.example/authorize?state=1' },
        };
      }
      return original(ep, input);
    }) as never);

    renderWith(
      services,
      <GuideCard burrow={burrow} card={oauthCard} onAct={async () => true} navigate={leave} />,
    );
    const card = await cardNamed('Sign in to Gehoord');
    await user.click(within(card).getByRole('button', { name: 'Sign in…' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith('https://auth.gehoord.example/authorize?state=1'));
    expect(starts).toEqual([
      {
        catalogId: 'custom_mcp',
        method: 'mcp_oauth',
        label: 'Gehoord',
        fields: { url: 'https://gehoord.example/api/mcp' },
        access: 'read',
        returnTo,
      },
    ]);
  });

  it('hides the sign-in action once an add_connection card is locked with an answer', async () => {
    const locked: GuideCardData = {
      ...oauthCard,
      state: 'done',
      answer: {
        actionId: 'connect',
        optionIds: null,
        label: 'Connected · Gehoord',
        at: '2026-11-26T11:33:00.000Z',
        connectionId: 'con_gehoord',
      },
    };
    renderDm([locked]);
    const card = await cardNamed('Sign in to Gehoord');
    expect(within(card).getByText('Connected · Gehoord')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Sign in…' })).toBeNull();
    expect(within(card).queryByRole('link', { name: 'Sign in…' })).toBeNull();
  });
});
