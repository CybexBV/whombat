import { LINK_PRICE_TEXT, LINK_PRICE_YEAR_TEXT } from '@whombat/protocol';
import { describe, expect, it } from 'vitest';
import {
  ControlError,
  controlErrorCodeOf,
  createHttpControl,
  type LinkAccount,
  SUBSCRIPTION_TERMS_VERSION,
} from './control';
import {
  hostedOrgOf,
  LINK_ORG_NAME,
  linkAccountErrorText,
  linkBoxesInOrder,
  linkBoxLine,
  linkBoxOpenUrl,
  linkBoxTone,
  linkCheckoutBusyText,
  linkCheckoutInput,
  linkCheckoutInterval,
  linkCodeOf,
  linkCountryGuess,
  linkCountryOptions,
  linkCountryReady,
  linkDiscountLine,
  linkEnding,
  linkFreeTime,
  linkNeedsBox,
  linkNotice,
  linkOpenPageInterval,
  linkPagePath,
  linkPlanAction,
  linkPlanLine,
  linkPlanRuns,
  linkPlanTone,
  linkPriceLine,
  linkSubscribed,
  linkYearly,
  pollLinkCheckout,
  WHOMBAT_LINK_TEXT as T,
} from './link';

const TZ = 'Europe/Amsterdam';
/** 18 December 2026, noon UTC. */
const DEC18 = Date.UTC(2026, 11, 18, 12) / 1000;

const plan = (patch: Partial<LinkAccount['plan']> = {}): LinkAccount['plan'] => ({
  state: 'none',
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  trialAvailable: true,
  boxes: 0,
  ...patch,
});

const box = (patch: Partial<LinkAccount['boxes'][number]> = {}): LinkAccount['boxes'][number] => ({
  device: 'dev_7KQ2M4XD',
  name: 'Home',
  state: 'on',
  since: DEC18 - 86_400,
  graceEndsAt: null,
  label: null,
  host: null,
  lastSeenAt: null,
  ...patch,
});

describe('the code a /link address carries', () => {
  it('reads ?code= in any case and spacing, and refuses anything else', () => {
    expect(linkCodeOf('?code=kxqm-trvw')).toBe('KXQM-TRVW');
    expect(linkCodeOf('?code=KXQM%20TRVW')).toBe('KXQM-TRVW');
    expect(linkCodeOf('?code=KXQM-TRV0')).toBeNull();
    expect(linkCodeOf('')).toBeNull();
  });
  it('keeps the code in the sign-in link’s next', () => {
    expect(linkPagePath('KXQM-TRVW')).toBe('/link?code=KXQM-TRVW');
    expect(linkPagePath(null)).toBe('/link');
  });
});

describe('the plan in plain words', () => {
  it('says each state, with its day', () => {
    expect(linkPlanLine(plan(), TZ)).toBe(T.planNone);
    expect(linkPlanLine(plan({ state: 'trialing', trialEndsAt: DEC18 }), TZ)).toContain('18 December 2026');
    expect(linkPlanLine(plan({ state: 'active', currentPeriodEnd: DEC18 }), TZ)).toMatch(
      /^Active · renews 18/,
    );
    expect(
      linkPlanLine(plan({ state: 'active', currentPeriodEnd: DEC18, cancelAtPeriodEnd: true }), TZ),
    ).toBe(T.endsOn('18 December 2026'));
    expect(linkPlanLine(plan({ state: 'comp' }), TZ)).toBe('Included');
    expect(linkPlanLine(plan({ state: 'cancelled' }), TZ)).toBe('Ended');
    expect(linkPlanLine(plan({ state: 'past_due' }), TZ)).toBe(T.planPastDue);
  });
  it('a plan set to end says so first, whoever ended it, and only the portal resumes it (CL-238)', () => {
    for (const state of ['trialing', 'active', 'past_due'] as const) {
      const ending = plan({ state, currentPeriodEnd: DEC18, cancelAtPeriodEnd: true, cardOnFile: false });
      expect(linkEnding(ending)).toBe(true);
      expect(linkPlanLine(ending, TZ)).toBe(T.endsOn('18 December 2026'));
      // Even without a card said, and with no Whombat linked: the portal, never Checkout.
      expect(linkPlanAction(ending)).toBe('manage');
      expect(linkNeedsBox({ ...ending, boxes: 0 }, linkPlanAction(ending))).toBe(false);
    }
    // Free time doesn't hide it.
    const free = plan({
      state: 'trialing',
      currentPeriodEnd: DEC18,
      cancelAtPeriodEnd: true,
      discount: { percentOff: 100, endsAt: DEC18, code: null },
    });
    expect(linkPlanLine(free, TZ)).toBe(T.endsOn('18 December 2026'));
    expect(linkPlanLine(plan({ state: 'active', cancelAtPeriodEnd: true }), TZ)).toBe(T.endsSoon);
    // Not who ended it, and nothing about linking a Whombat again.
    expect(T.endsOn('x')).not.toMatch(/cancel|link a whombat|linking/i);
    expect(linkEnding(plan({ state: 'cancelled', cancelAtPeriodEnd: true }))).toBe(false);
    expect(linkEnding(plan({ state: 'comp', cancelAtPeriodEnd: true }))).toBe(false);
  });
  it('picks one button per state, none when Included', () => {
    expect(linkPlanAction(plan())).toBe('subscribe');
    expect(linkPlanAction(plan({ state: 'trialing' }))).toBe('addCard');
    expect(linkPlanAction(plan({ state: 'active' }))).toBe('manage');
    expect(linkPlanAction(plan({ state: 'past_due' }))).toBe('manage');
    expect(linkPlanAction(plan({ state: 'cancelled' }))).toBe('subscribeAgain');
    expect(linkPlanAction(plan({ state: 'comp' }))).toBeNull();
  });
  it('offers Manage subscription in the free month once a card is on file', () => {
    expect(linkPlanAction(plan({ state: 'trialing', cardOnFile: false }))).toBe('addCard');
    expect(linkPlanAction(plan({ state: 'trialing', cardOnFile: true }))).toBe('manage');
    // Only a card on file opens the portal (4.9): free time on a paid-for plan without one is Checkout.
    expect(linkPlanAction(plan({ state: 'active', cardOnFile: false }))).toBe('addCard');
    expect(linkPlanAction(plan({ state: 'past_due', cardOnFile: false }))).toBe('addCard');
    expect(linkPlanAction(plan({ state: 'active', cardOnFile: true }))).toBe('manage');
  });
  it('is subscribed only with a card on file; an older control’s running plan counts', () => {
    expect(linkSubscribed(plan({ state: 'trialing', cardOnFile: false }))).toBe(false);
    expect(linkSubscribed(plan({ state: 'trialing', cardOnFile: true }))).toBe(true);
    expect(linkSubscribed(plan({ state: 'active', cardOnFile: true }))).toBe(true);
    expect(linkSubscribed(plan({ state: 'cancelled', cardOnFile: true }))).toBe(false);
    expect(linkSubscribed(plan({ state: 'comp', cardOnFile: false }))).toBe(false);
    expect(linkSubscribed(plan({ state: 'trialing' }))).toBe(true);
    expect(linkSubscribed(plan())).toBe(false);
  });
  it('tones and runs', () => {
    expect(linkPlanTone(plan())).toBe('mut');
    expect(linkPlanTone(plan({ state: 'active', cancelAtPeriodEnd: true }))).toBe('warn');
    expect(linkPlanTone(plan({ state: 'cancelled' }))).toBe('bad');
    expect(linkPlanRuns(plan({ state: 'comp' }))).toBe(true);
    expect(linkPlanRuns(plan({ state: 'cancelled' }))).toBe(false);
  });
});

describe('the price, the year and free time (one-environment.md)', () => {
  it('a control on 4.6 says the discount, and only then takes the year', () => {
    expect(linkYearly(plan())).toBe(false);
    expect(linkYearly(plan({ discount: null }))).toBe(true);
    expect(linkCheckoutInterval(plan(), 'year')).toBeUndefined();
    expect(linkCheckoutInterval(plan({ discount: null }), 'year')).toBe('year');
  });
  it('the price line: what the subscription pays, else both ways where control takes both', () => {
    expect(linkPriceLine(plan())).toBe(T.priceMonth);
    expect(linkPriceLine(plan({ discount: null }))).toBe(T.price);
    expect(linkPriceLine(plan({ interval: 'year', discount: null }))).toBe(T.paidYear);
    expect(linkPriceLine(plan({ interval: 'month', discount: null }))).toBe(T.paidMonth);
    // Every price comes from the contracts' constants.
    expect(T.price).toContain(LINK_PRICE_TEXT);
    expect(T.price).toContain(LINK_PRICE_YEAR_TEXT);
    expect(T.paidYear).toContain(LINK_PRICE_YEAR_TEXT);
  });
  it('free time and codes in plain words; the plan line carries free time, the discount line only what it doesn’t', () => {
    const until = DEC18;
    expect(linkDiscountLine(plan({ discount: null }))).toBeNull();
    expect(
      linkDiscountLine(plan({ discount: { percentOff: 100, endsAt: until, code: null } }), TZ),
    ).toBeNull();
    expect(linkDiscountLine(plan({ discount: { percentOff: 100, endsAt: null, code: 'FRIENDS' } }))).toBe(
      T.fromCode('FRIENDS'),
    );
    expect(
      linkDiscountLine(plan({ discount: { percentOff: 50, endsAt: until, code: 'SPRING26' } }), TZ),
    ).toBe(T.withCode(T.offUntil(50, '18 December 2026'), 'SPRING26'));
    expect(linkDiscountLine(plan({ discount: { percentOff: 20, endsAt: null, code: null } }))).toBe(
      T.offForGood(20),
    );
  });
  it('free time reads as free until its end, the full price as what follows (R1 #15)', () => {
    const trialEnd = DEC18;
    const grantEnd = DEC18 + 150 * 86_400;
    const grant = { percentOff: 100, endsAt: grantEnd, code: null };
    const trialing = plan({ state: 'trialing', trialEndsAt: trialEnd, currentPeriodEnd: trialEnd });
    // The free month alone, then with free time after it: the later end counts.
    expect(linkFreeTime(trialing)).toEqual({ until: trialEnd, grant: false });
    expect(linkFreeTime({ ...trialing, discount: grant })).toEqual({ until: grantEnd, grant: true });
    expect(linkFreeTime(plan({ state: 'active', discount: grant }))).toEqual({
      until: grantEnd,
      grant: true,
    });
    expect(linkFreeTime(plan({ state: 'active', discount: { ...grant, endsAt: null } }))).toBe('forever');
    expect(linkFreeTime(plan({ state: 'active', discount: { ...grant, percentOff: 50 } }))).toBeNull();
    expect(linkFreeTime(plan({ state: 'cancelled', discount: grant }))).toBeNull();

    expect(linkPlanLine({ ...trialing, discount: grant }, TZ)).toBe(T.freeUntil('17 May 2027'));
    expect(linkPlanLine(trialing, TZ)).toBe(T.planTrial('18 December 2026'));
    expect(linkPlanLine(plan({ state: 'active', discount: { ...grant, endsAt: null } }))).toBe(T.freeForGood);
    expect(linkBoxLine(box(), { ...trialing, discount: grant }, TZ)).toBe(T.freeUntil('17 May 2027'));

    // With a card on file: what follows, from when. Without one: what Link costs (it ends unless a card is added).
    const yearly = { ...trialing, discount: grant, interval: 'year' as const, cardOnFile: true };
    expect(linkPriceLine(yearly, TZ)).toBe(T.thenFrom(LINK_PRICE_YEAR_TEXT, '17 May 2027'));
    expect(linkPriceLine({ ...yearly, cardOnFile: false }, TZ)).toBe(T.price);
    expect(linkPriceLine({ ...yearly, discount: { ...grant, endsAt: null } }, TZ)).toBeNull();
    expect(linkPriceLine(plan({ state: 'active', interval: 'year', discount: null }))).toBe(T.paidYear);
  });
  it('a grant during the free month reads as free time on control’s payload: the trial stretched to its end (R2 B4)', () => {
    // What control answers today: a six-month grant puts its end in the Stripe trial, so the two are the same second.
    const grantEnd = DEC18 + 182 * 86_400;
    const live = plan({
      state: 'trialing',
      trialEndsAt: grantEnd,
      currentPeriodEnd: grantEnd,
      cardOnFile: false,
      boxes: 1,
      discount: { percentOff: 100, endsAt: grantEnd, code: null },
    });
    expect(linkFreeTime(live)).toEqual({ until: grantEnd, grant: true });
    expect(linkPlanLine(live, TZ)).toBe(T.freeUntil('18 June 2027'));
    expect(linkBoxLine(box(), live, TZ)).toBe(T.freeUntil('18 June 2027'));
    expect(linkPlanLine(live, TZ)).not.toMatch(/Free month/);
    // What control answers from CL-218: the free month's own end in `trialEndsAt`, the grant's in the discount (and the
    // stretched Stripe trial in `currentPeriodEnd`); also once the free month itself is over.
    const split = { ...live, trialEndsAt: DEC18 };
    expect(linkPlanLine(split, TZ)).toBe(T.freeUntil('18 June 2027'));
    expect(linkBoxLine(box(), split, TZ)).toBe(T.freeUntil('18 June 2027'));
    expect(linkPriceLine({ ...split, cardOnFile: true, interval: 'year' }, TZ)).toBe(
      T.thenFrom(LINK_PRICE_YEAR_TEXT, '18 June 2027'),
    );
    expect(linkPlanLine({ ...split, trialEndsAt: DEC18 - 40 * 86_400 }, TZ)).toBe(
      T.freeUntil('18 June 2027'),
    );
    expect(linkPlanLine({ ...split, trialEndsAt: null }, TZ)).toBe(T.freeUntil('18 June 2027'));
    // The plain free month carries no discount, and still reads as the free month.
    const month = { ...live, trialEndsAt: DEC18, currentPeriodEnd: DEC18, discount: null };
    expect(linkPlanLine(month, TZ)).toBe(T.planTrial('18 December 2026'));
    expect(linkBoxLine(box(), month, TZ)).toBe(T.boxTrial('18 December 2026'));
  });
  it('control’s billing refusals in plain words', () => {
    for (const code of [
      'checkout_busy',
      'billing_provider_refused',
      'billing_provider_error',
      'manual_billing',
      'no_subscription',
      'promotion_code_on_payment_page',
    ])
      expect(linkAccountErrorText(new ControlError(code as 'checkout_busy', 'x'))).toBe(
        T.errors[code as keyof typeof T.errors],
      );
    expect(
      controlErrorCodeOf(400, {
        error: { code: 'bad_request', details: { code: 'promotion_code_on_payment_page' } },
      }),
    ).toBe('promotion_code_on_payment_page');
  });
  it('what Checkout is sent: the interval where control takes it, the terms once ticked, never a code', () => {
    const terms = { version: SUBSCRIPTION_TERMS_VERSION };
    expect(linkCheckoutInput(plan(), { interval: 'year', terms })).toEqual({ terms });
    expect(linkCheckoutInput(plan({ discount: null }), { interval: 'year' })).toEqual({ interval: 'year' });
    expect(linkCheckoutInput(plan({ discount: null }), { interval: 'month', terms })).toEqual({
      interval: 'month',
      terms,
    });
    // Where the person lives goes along when chosen (4.10).
    expect(linkCheckoutInput(plan({ discount: null }), { interval: 'month', country: 'DE' })).toEqual({
      interval: 'month',
      country: 'DE',
    });
  });
});

describe('Link is sold in EU countries only (4.10)', () => {
  it('starts on the country of the time zone when Link is sold there, else on nothing', () => {
    expect(linkCountryGuess('Europe/Amsterdam')).toBe('NL');
    expect(linkCountryGuess('Atlantic/Azores')).toBe('PT');
    expect(linkCountryGuess('Asia/Nicosia')).toBe('CY');
    for (const zone of [
      'Europe/London',
      'Europe/Zurich',
      'Europe/Oslo',
      'America/New_York',
      'Atlantic/Canary',
    ])
      expect(linkCountryGuess(zone), zone).toBe('');
    expect(linkCountryGuess(undefined)).toBe('');
  });
  it('lists the 27 countries by name, A to Z', () => {
    const names: Record<string, string> = { NL: 'Netherlands', AT: 'Austria', DE: 'Germany' };
    const options = linkCountryOptions((code) => names[code]);
    expect(options).toHaveLength(27);
    expect(options[0]?.code).toBe('AT');
    expect(options.findIndex((o) => o.code === 'DE')).toBeLessThan(options.findIndex((o) => o.code === 'NL'));
  });
  it('opens the payment page only for a country Link is sold in', () => {
    expect(linkCountryReady('NL')).toBe(true);
    expect(linkCountryReady('other')).toBe(false);
    expect(linkCountryReady('')).toBe(false);
  });
  it('sends the country, and says control’s refusal in plain words', async () => {
    const sent: unknown[] = [];
    const control = createHttpControl('https://control.example.com', {
      tokens: { get: () => 'tok', set: () => {}, remove: () => {} },
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ error: { code: 'forbidden', message: 'no', details: { code: 'link_country' } } }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const refused = await control.linkCheckout?.({ country: 'NL' }).catch((e: unknown) => e);
    expect(sent).toEqual([{ country: 'NL' }]);
    expect(linkAccountErrorText(refused)).toBe(T.errors.link_country);
  });
});

describe('paying needs a linked Whombat; an open payment page (control R4)', () => {
  it('no Subscribe without a box; the portal of a paying plan stays', () => {
    expect(linkNeedsBox(plan({ boxes: 0 }), 'subscribe')).toBe(true);
    expect(linkNeedsBox(plan({ boxes: 0 }), 'subscribeAgain')).toBe(true);
    expect(linkNeedsBox(plan({ boxes: 1 }), 'subscribe')).toBe(false);
    expect(linkNeedsBox(plan({ boxes: 0 }), 'manage')).toBe(false);
    expect(linkNeedsBox(plan({ boxes: 0 }), null)).toBe(false);
    expect(linkAccountErrorText(new ControlError('link_no_boxes', 'x'))).toBe(T.errors.link_no_boxes);
  });
  it('checkout_busy says control’s sentence when it names until when, else ours', () => {
    const open = 'A payment page is already open for your Whombat Link until 14:05 UTC. Finish it there.';
    expect(linkCheckoutBusyText(new ControlError('checkout_busy', open))).toBe(open);
    expect(linkCheckoutBusyText(new ControlError('checkout_busy', 'Busy.'))).toBe(T.errors.checkout_busy);
    expect(linkCheckoutBusyText(new Error(open))).toBe(T.errors.checkout_busy);
  });
  it('the payment page this browser opened counts for 31 minutes', () => {
    const at = 1_800_000_000_000;
    expect(linkOpenPageInterval({ interval: 'year', at }, at + 30 * 60_000)).toBe('year');
    expect(linkOpenPageInterval({ interval: 'year', at }, at + 31 * 60_000)).toBeNull();
    expect(linkOpenPageInterval({ interval: 'week', at }, at)).toBeNull();
    expect(linkOpenPageInterval(null, at)).toBeNull();
  });
});

describe('opening a Whombat from here', () => {
  it('opens at its own address while that works', () => {
    const host = 'calm-otter-reef.box.whombat.app';
    expect(linkBoxOpenUrl(box({ host }))).toBe(`https://${host}/`);
    expect(linkBoxOpenUrl(box({ host, state: 'grace' }))).toBe(`https://${host}/`);
    expect(linkBoxOpenUrl(box({ host, state: 'ended' }))).toBeNull();
    expect(linkBoxOpenUrl(box({ host: null }))).toBeNull();
  });
  it('the one this device opened last comes first, the rest in control’s order', () => {
    const boxes = [box({ device: 'a' }), box({ device: 'b' }), box({ device: 'c' })];
    expect(linkBoxesInOrder(boxes, 'c').map((b) => b.device)).toEqual(['c', 'a', 'b']);
    expect(linkBoxesInOrder(boxes, null).map((b) => b.device)).toEqual(['a', 'b', 'c']);
    expect(linkBoxesInOrder(boxes, 'gone').map((b) => b.device)).toEqual(['a', 'b', 'c']);
  });
});

describe('each Whombat’s Link', () => {
  it('on, free month, ending, ended, waiting for its address, off', () => {
    expect(linkBoxLine(box(), plan({ state: 'active' }), TZ)).toBe('On');
    expect(linkBoxLine(box(), plan({ state: 'comp' }), TZ)).toBe(T.boxIncluded);
    expect(linkBoxLine(box(), plan({ state: 'trialing', trialEndsAt: DEC18 }), TZ)).toMatch(
      /^Free month · until 18 December/,
    );
    expect(
      linkBoxLine(box(), plan({ state: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: DEC18 }), TZ),
    ).toMatch(/^Ends 18 December/);
    expect(
      linkBoxLine(box({ state: 'grace', graceEndsAt: DEC18 }), plan({ state: 'cancelled' }), TZ),
    ).toMatch(/^Ends 18 December/);
    expect(linkBoxLine(box({ state: 'ended' }), plan({ state: 'cancelled' }), TZ)).toBe('Ended');
    expect(linkBoxLine(box({ state: 'starting' }), plan({ state: 'active' }), TZ)).toBe(T.boxStarting);
    expect(linkBoxLine(box({ state: 'off' }), plan(), TZ)).toBe('Off');
    expect(linkBoxTone(box({ state: 'grace' }))).toBe('warn');
    expect(linkBoxTone(box({ state: 'ended' }))).toBe('bad');
  });
});

describe('the notice while Link ends (LNK-06)', () => {
  it('names the first grace end, then ended, then a failed payment', () => {
    const later = DEC18 + 3 * 86_400;
    const grace = linkNotice(
      {
        plan: plan({ state: 'cancelled' }),
        boxes: [box({ state: 'grace', graceEndsAt: later }), box({ state: 'grace', graceEndsAt: DEC18 })],
      },
      TZ,
    );
    expect(grace).toContain('18 December 2026');
    expect(grace).toContain('Tailscale');
    expect(linkNotice({ plan: plan({ state: 'cancelled' }), boxes: [box({ state: 'ended' })] })).toBe(
      T.endedNotice,
    );
    expect(linkNotice({ plan: plan({ state: 'past_due' }), boxes: [box()] })).toBe(T.pastDueNotice);
    expect(linkNotice({ plan: plan({ state: 'active' }), boxes: [box()] })).toBeNull();
  });
});

describe('refusals', () => {
  it('control’s reasons become ControlError codes and plain words', () => {
    const err = (status: number, code: string, reason?: string) =>
      controlErrorCodeOf(status, { error: { code, details: reason ? { code: reason } : undefined } });
    expect(err(404, 'not_found', 'link_code_invalid')).toBe('link_code_invalid');
    expect(err(409, 'conflict', 'link_other_account')).toBe('link_other_account');
    expect(err(403, 'forbidden', 'email_unconfirmed')).toBe('email_unconfirmed');
    expect(err(403, 'entitlement_withheld', 'link_trial_boxes')).toBe('link_trial_boxes');
    expect(err(403, 'entitlement_withheld', 'link_subscribe')).toBe('link_subscribe');
    expect(linkAccountErrorText(new ControlError('link_trial_boxes', 'x'))).toBe(T.errors.link_trial_boxes);
    expect(linkAccountErrorText(new ControlError('manual_billing', 'x'))).toBe(T.errors.manual_billing);
    expect(linkAccountErrorText(new Error('boom'))).toBe(T.errors.failed);
  });
});

describe('the account site’s calls', () => {
  it('go to /v1/link/… with the session and parse the contract', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const account = { plan: plan(), boxes: [box()] };
    const control = createHttpControl('https://control.example.com', {
      tokens: { get: () => 'tok', set: () => {}, remove: () => {} },
      fetch: async (url, init) => {
        calls.push({
          url,
          method: init?.method ?? 'GET',
          ...(init?.body ? { body: String(init.body) } : {}),
        });
        if (url.endsWith('/link/lookup'))
          return new Response(
            JSON.stringify({ code: 'KXQM-TRVW', name: 'Home', expiresAt: DEC18, linked: false, trial: true }),
          );
        if (url.endsWith('/link/checkout'))
          return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/1' }));
        return new Response(JSON.stringify(account));
      },
    });
    expect((await control.linkLookup?.('KXQM-TRVW'))?.trial).toBe(true);
    expect((await control.linkAccount?.())?.boxes).toHaveLength(1);
    await control.linkRemove?.('dev_7KQ2M4XD');
    expect((await control.linkCheckout?.())?.url).toBe('https://checkout.stripe.com/c/1');
    await control.linkCheckout?.({ interval: 'year' });
    await control.linkConfirm?.('KXQM-TRVW').catch(() => {});
    await control.linkConfirm?.('KXQM-TRVW', { version: SUBSCRIPTION_TERMS_VERSION }).catch(() => {});
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://control.example.com', '')}`)).toEqual([
      'POST /v1/link/lookup',
      'GET /v1/link/boxes',
      'DELETE /v1/link/boxes/dev_7KQ2M4XD',
      'POST /v1/link/checkout',
      'POST /v1/link/checkout',
      'POST /v1/link/confirm',
      'POST /v1/link/confirm',
    ]);
    const bodies = calls.map((c) => JSON.parse(c.body ?? '{}'));
    expect(bodies[0]).toEqual({ code: 'KXQM-TRVW' });
    // Monthly sends nothing an older control would refuse; the year and the terms only when asked.
    expect(bodies[3]).toEqual({});
    expect(bodies[4]).toEqual({ interval: 'year' });
    expect(bodies[5]).toEqual({ code: 'KXQM-TRVW' });
    expect(bodies[6]).toEqual({ code: 'KXQM-TRVW', terms: { version: SUBSCRIPTION_TERMS_VERSION } });
  });
  it('an answer that isn’t the contract’s is control not answering', async () => {
    const control = createHttpControl('https://control.example.com', {
      tokens: { get: () => 'tok', set: () => {}, remove: () => {} },
      fetch: async () => new Response(JSON.stringify({ plan: 'nope' })),
    });
    await expect(control.linkAccount?.()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('back from Checkout', () => {
  it('asks until the plan runs, then stops', async () => {
    const answers = [plan(), plan(), plan({ state: 'trialing' })];
    let t = 0;
    const seen: string[] = [];
    const out = await pollLinkCheckout({
      load: async () => ({ plan: answers.shift() ?? plan(), boxes: [] }),
      onAccount: (a) => seen.push(a.plan.state),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    });
    expect(out).toBe('done');
    expect(seen).toEqual(['none', 'none', 'trialing']);
  });
  it('waits past the free month without a card until the card shows', async () => {
    const answers = [
      plan({ state: 'trialing', cardOnFile: false }),
      plan({ state: 'trialing', cardOnFile: false }),
      plan({ state: 'trialing', cardOnFile: true }),
    ];
    let t = 0;
    let asked = 0;
    const out = await pollLinkCheckout({
      load: async () => {
        asked += 1;
        return { plan: answers.shift() ?? plan(), boxes: [] };
      },
      onAccount: () => {},
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    });
    expect(out).toBe('done');
    expect(asked).toBe(3);
  });
  it('gives up after a minute', async () => {
    let t = 0;
    const out = await pollLinkCheckout({
      load: async () => ({ plan: plan(), boxes: [] }),
      onAccount: () => {},
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    });
    expect(out).toBe('timeout');
  });
});

describe('which organization this site still opens', () => {
  it('skips the account’s Link org', () => {
    expect(hostedOrgOf([])).toBeNull();
    expect(hostedOrgOf([{ orgId: 'org_l', name: LINK_ORG_NAME }])).toBeNull();
    expect(hostedOrgOf([{ orgId: 'org_x', name: 'Other', link: true }])).toBeNull();
    expect(
      hostedOrgOf([
        { orgId: 'org_l', name: LINK_ORG_NAME },
        { orgId: 'org_b', name: 'Burrow HQ' },
      ])?.orgId,
    ).toBe('org_b');
  });
  it('believes the session’s mark over the name once control sends it', () => {
    const named = { orgId: 'org_n', name: LINK_ORG_NAME, link: false };
    expect(hostedOrgOf([{ orgId: 'org_l', name: 'Anything', link: true }, named])?.orgId).toBe('org_n');
  });
});
