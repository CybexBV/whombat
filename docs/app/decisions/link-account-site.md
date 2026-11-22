# The account site under Whombat Link (AP-9700 … AP-9712, AP-9714 … AP-9723, AP-9770 … AP-9771, AP-9773)

Phase 1 of Whombat Link in the hosted app at app.whombat.com (and dev.whombat.com): Whombat
`docs/decisions/whombat-link.md` LNK-13, LNK-32 … LNK-35 and LNK-06 on the account's side. Control's routes are
`linkApi` (contracts 4.4) as control `docs/decisions/link.md` CL-173 … CL-187 answers them. Decided 2026-11-18 by
builder A of the Whombat Link build. Phase 1 is additive and reversible: screens leave the flow, their code stays and
compiles, and phase 2 deletes it.

## AP-9700 Sign-up is open and sign-in is the only door

The sign-in page always reads as open sign-up: no waitlist button, no invite-only or waitlist wording, no held invite
code sent along. `/waitlist` and `/signup` show the sign-in page signed out and Your Whombats signed in. An emailed
invitation's one-tap sign-in and a `/signup#code=` link no longer do anything; the fragment only leaves the address
bar. The magic link's e-mail is the confirmed address control needs before a box can be linked (LNK-38). Hosted
passkey sign-in stays (LNK-51).

## AP-9701 No organization to name

A new account no longer names an organization. Signed in without an organization this site opens Whombats of, the
person has Your Whombats (`/account`), `/link`, the phone's QR code (`/mobile`) and deleting the account; every other
path goes to `/account`. `CreateOrgScreen`, `WaitlistScreen`, the invitation screens and `afterCreateOrgPath` stay in
the code until phase 2.

## AP-9702 Which organization the site still opens

An account made before Link keeps its organization and the hosted list (`/appliances`) with everything behind it:
opening a Whombat over the session, pairing, the recovery kit, the box's screen sign-in, connection sign-in returns
(`/connect/<id>`), remote help's step-up, the bring-back flows. Control also lists the account's hidden Link org in the
session (CL-175), which must never become the list's organization: `hostedOrgOf` takes the first organization that
isn't it. Control marks it in the session (`ControlOrg.link`, contracts 4.5): once any organization carries the mark,
only the mark counts; an older control's list is told apart by the fixed name it gives the Link org (“Whombat Link”,
`LINK_ORG_NAME`).

## AP-9703 `/link` (LNK-13)

“Link your Whombat”: the code the box's screen shows (`ABCD-EFGH`, typed in any case and spacing and shown with its
dash, `normalizeLinkCode`), also taken from `?code=`. Signed out, the page asks for the code and an email address in one
form and sends the sign-in link with `next=/link?code=…`, so the link opens the confirm step. Signed in, a code in the
address is looked up at once (`link.lookup`), with the account's plan beside it: “Add <name> to Whombat Link?”, what
Link gives in one sentence, and under it the free month (“Your first month is free. No card needed.”) when the lookup
says the confirm starts it, otherwise the price and whether the box joins the running subscription or waits for one.
“Link it” confirms (`link.confirm`); then “<name> is linked” and what happens next (its address in a moment, its screen
shows where to open it), or that it turns on once the person subscribes. An already linked box says so. Refusals in
plain words: a wrong or expired code, another account's box, an unconfirmed e-mail, too many tries; a third box in the
free month (`link_trial_boxes`) offers Add a card.

## AP-9704 Your Whombats (LNK-35)

`/account`, and `/billing` where Stripe sends the browser back: one card for the subscription (“Whombat Link”, its line
— Not subscribed, Free month · until …, Active · renews/ends …, Payment problem, Ended, Included — and the price line
“€2.50 a month for each Whombat, VAT included.” from the one price constant) and one row per Whombat with its Link
in plain words (On with its address, Free month · until …, Ends …, Ended, Getting its address…, Off). Under them Link a
Whombat, Open a Whombat here (only with an organization the site opens), Sign out, the e-mail and Delete account.

## AP-9705 One subscription button (LNK-32, LNK-33)

The plan card has one button: Subscribe (none yet), Add a card (the free month without a card), Manage subscription
(the free month with a card on file, running or a failed payment: the Stripe portal), Subscribe again (ended), none
when Included (a comp). Whether a card is on file is `LinkPlan.cardOnFile` (contracts 4.5); an older control doesn't
say, so the free month offers Add a card. Subscribe and Add a card open Stripe Checkout through `link.checkout`; when
Checkout answers `subscription_exists` (a card was added already) the portal opens instead. The browser goes only to Stripe's hosts (AP-160). `manual_billing` says
“Payments aren’t set up here yet. Ask Whombat support.”

## AP-9706 Back from Checkout

`?checkout=done` asks `link.boxes` every 2 s for up to a minute until the account is subscribed (`linkSubscribed`: a
running plan with `cardOnFile`), then says “You’re subscribed to Whombat Link.” and takes the query off the address;
after a minute it says it is taking longer, with Check again. The free month without a card isn't subscribed. An older
control doesn't send `cardOnFile`: there any running plan counts (trialing, active, past due, included).

## AP-9707 Removing a Whombat

Remove on a row asks first, in one line (“It keeps working at home, but you can’t open it from elsewhere without
Tailscale.”), then `link.remove`; the answer is the new list.

## AP-9708 Link ending (LNK-06)

Above the cards, one notice: in grace “Whombat Link ends on <the earliest grace end>. Subscribe to keep reaching your
Whombat from anywhere, or turn on Tailscale on your Whombat.”; ended “Whombat Link has ended. Your Whombat keeps
working at home. Subscribe again to reach it from anywhere.”; a failed payment, where to fix it. The plan's button is
then Subscribe again or Manage subscription.

## AP-9709 The business billing and the card claim leave the flow (LNK-31, LNK-35)

`/billing` is Your Whombats; the plan cards (€49/€149), the Whombats stepper, Start subscription now and Add a Whombat
are no longer shown (`BillingScreen`, `pollCheckout` stay until phase 2). The hosted list's Billing entry is Whombat
Link and its plan-first gate is gone. The claim at this site keeps only the letters of a box on this network (a box on
the release before Link still registers at control); the card's claim, the card held from `/claim#…` and the claim
refusals' ways to a plan are gone: a refusal says what it is.

## AP-9710 Link a Whombat on the hosted list

The hosted list's “Link a Whombat” opens `/link` (the box shows the code). The own-address account code (a code the
account makes and the box's page asks for, own-address.md) stays at `/appliances/link` for a box on the release before
Link, no longer offered on the list.

## AP-9711 Words and look

The pages use the sign-in frame (`AuthLayout`) with the managed screens' bordered-row cards, notices and status dots,
like the Whombats list; the words are `WHOMBAT_LINK_TEXT` (`@whombat/client/managed` `link.ts`), web only: the phone
shows no price and no sign-up (LNK-44).

## AP-9712 The fake world and the journeys

The fake control answers `linkApi` (codes a box shows, the free month, Checkout with a webhook lag, comps, grace and
ended); e2e `link.spec.ts` drives the journeys and `link-shots.spec.ts` writes review screenshots (`LINK_SHOTS`). The
other journeys start from an account with an organization from before Link (`existingOrg`); the business billing,
invite, waitlist and card claim journeys are gone with their screens.

## AP-9714 Open a Whombat from the account site (one-environment.md ENV-11)

Each Whombat whose own address works (Link on, or in its last week) has **Open**, a real link to `https://<host>/` that
opens in the same tab. The browser remembers which one was opened last (`localStorage` `whombat:link:last-opened`,
every read and write in try/catch) and lists it first; the rest keep control's order. With one Whombat the page leads
with one big “Open <name>” above the plan, and its row has no second Open. Nothing is sent to control.

## AP-9715 The plan by the month or the year, free time and codes (ENV-07, ENV-09, ENV-11)

*In part superseded by AP-9718 (the code is typed on this page, the terms go along) and AP-9719 (how free time reads).*

The plan's price line says what the subscription pays (“You pay €25 a year for each Whombat, VAT included.”), else both
ways (“€2.50 a month or €25 a year for each Whombat, VAT included.”); every price comes from the contracts' constants.
`LinkPlan.discount` reads “Free until 19 May 2027”, “Free for good”, “50% off until …” or “… for good”, with “, with
the code X” for a promotion code. Going to Checkout (Subscribe, Add a card, Subscribe again) the plan card offers
“€2.50 a month” or “€25 a year” (month first) with “Have a code? Enter it on the next page.”, and passes `interval`;
Manage subscription switches an existing one in Stripe's portal. A control before 4.6 refuses `interval` and sends no
`discount`, so the page offers the year only when the plan carries `discount` (null when none): **control on 4.6
always sends it**.

## AP-9716 The Subscription Terms are ticked where Link starts (ENV-13, contracts CT-1778)

On `/link`, when the lookup names a `termsVersion`, the confirm step shows “I agree to the Whombat Subscription Terms”
(a real checkbox linking `/legal/subscription-terms`), Link it waits for it, and the confirm sends the version this
site shows (`SUBSCRIPTION_TERMS_VERSION`). A refusal `terms_outdated` says “The Whombat Subscription Terms have
changed. Reload this page, then try again.” An older control names no version and gets no `terms`.

## AP-9717 The legal texts sell Whombat Link to people and businesses (ENV-13)

`apps/web/src/legal/` at version `2026-11-19`: the Subscription Terms are Whombat Link's (what it gives, €2.50 a month
or €25 a year a Whombat with VAT, the free month without a card, renewal, cancelling in Manage subscription, “Within 14
days of your first payment you get your money back on request.”, the grace week, nothing deleted, Tailscale or
Headscale as the way in, the software open source and working without Link); the Terms of Service and the Appliance
Terms are for people and businesses and keep consumers' rights; the Privacy Policy says what control keeps for Link,
push through the box, the door and shared links. The business plan's terms (€49, reverse charge, the 14-day trial) are
gone. The Appliance Terms stay byte for byte the appliance's `docs/legal/appliance-terms.md` (its harness gate);
the website copies all four.

## AP-9718 The code is typed here, and the terms go along to Checkout (ENV-08, ENV-13; contracts CT-1780, CT-1781)

*In part superseded by AP-9720: the code is typed on Stripe's page again, never here.*

During a free month already in Stripe, control answers a setup-mode Checkout that takes only the card and has no code
field, so the plan card has its own optional **Promotion code** under “€2.50 a month · €25 a year”. The code goes as
`promotionCode` with `interval` (spaces trimmed; one that can't be a code is said here and nothing is sent), and
`promotion_code_invalid` says “That code doesn’t work. Check it, or leave it empty.” under the field. When control
answers `terms_required` (the account has accepted no Subscription Terms: one from before control asked), the card
shows “I agree to the Whombat Subscription Terms” and its button waits for the tick, which then goes along to Checkout
or the portal; `/link`'s Add a card sends the terms ticked at the confirm. `checkout_busy` says “Try again in a
moment.” The code field shows where the year does (a control that says `discount`).

## AP-9719 Free time reads as free; the price is what follows (ENV-09; review R1 #15)

Free time (a 100% discount) is the plan's own line: “Free until <its end>” or “Free for good”, never “Free month ·
until …” beside it, and each Whombat's line says the same. A plain free month carries no discount, so a finite 100%
discount is free time even when its end equals `trialEndsAt` (a control that stretches the Stripe trial to the
grant's end sends the same second in both; from control CL-218 `trialEndsAt` is the free month's own end). The
discount line keeps only what that doesn't say: “With the code FRIENDS”, or a part off (“50% off until …, with the
code X”). The price line never reads as charged now: with a card on file it is what follows (“Then €25 a year for each
Whombat from 19 May 2027, VAT included.”), without one what Link costs, free for good none, paid what the subscription
pays.

## AP-9720 Paying starts on Stripe's page (control CL-219…CL-222; contracts CT-1783, CT-1784)

Nothing is in Stripe before the person pays: the free month and free time are control's own. So Subscribe and Add a
card, during the free month, free time or after it ended, are always `link.checkout`, by the month or the year chosen
on the card (“Have a code? Enter it on the payment page.”, where Stripe's own field takes it); the site has no code
field and never sends `promotionCode` (an old tab's gets “Enter the code on the payment page: it has a field for it.”).
**Manage subscription** (the portal) shows only when `plan.cardOnFile` is true, and changes after subscribing are the
portal's; its `no_subscription` says “There’s no subscription to manage yet.” and the card offers Subscribe instead.
Checkout's `subscription_exists` opens the portal, `checkout_busy` says “Try again in a moment.”, `manual_billing` (a
free account) “Your Whombat Link is free: there’s nothing to pay.” (Included shows no button), and the 502s
`billing_provider_error` / `billing_provider_refused` say to try again later. Free time reads as AP-9719 says.

## AP-9721 A payment page needs a linked Whombat, and one open page at a time (control CL-223, CL-226)

Link is paid for each Whombat linked, so with none the plan card has no Subscribe and no month-or-year choice, only one
line: “Link a Whombat to start your free month.” (or, after a free month, “Link a Whombat first, then subscribe.”).
Control's `link_no_boxes` says the same. The free month starts when the first Whombat is linked (`link.confirm`), never
with Subscribe. Control answers the one open payment page again for the same interval and `checkout_busy` for another,
with until when (HH:MM UTC): the card shows control's sentence, starts on the interval of the page this browser opened
(`localStorage` `whombat:link:payment-page`, 31 minutes, in try/catch) and offers “Back to the payment page (…)” for
that interval only.

## AP-9722 A plan set to end says until when; only the portal resumes it (control CL-238)

Whenever `LinkPlan.cancelAtPeriodEnd` is true on a running plan, the plan card's line is “Your Whombat Link ends on
<currentPeriodEnd>. Resume it in Manage subscription.” (“… is set to end. …” without a date), before any free-time or
renewal line, and its button is Manage subscription (`link.portal`), with or without a Whombat linked and whatever
`cardOnFile` says. It doesn't say who ended it: cancelled in the portal, or ended by control with no Whombat billed.
Control never resumes a subscription by itself, and linking a Whombat again doesn't either; no words on the site say
otherwise.

## AP-9723 Where you live, before the payment page (one-environment.md ENV-20, ENV-21; contracts CT-1785)

Wherever a button opens Checkout (Subscribe, Add a card, Subscribe again on Your Whombats, and Add a card on `/link`),
a row asks “Where you live”: the 27 countries of `LINK_COUNTRIES` by the browser's own English names, A to Z, then
“Another country”. It starts on the country of the device's time zone when Link is sold there, else on “Choose your
country”, and the button stays off until a country Link is sold in is chosen. “Another country” says “Whombat Link is
only sold in EU countries for now. Your Whombat keeps working at home without it.” in the row, and nothing opens.
Otherwise the row's hint says “Buying for a business? Add your VAT number on the payment page.” The chosen country goes
to `link.checkout` as `country`; control's `link_country` gets the same words. Manage subscription asks nothing. Not in
the mocks: the plan card's row with the label beside a native select, like Quiet hours' times.

## AP-9770 After linking, `/link` waits for the Whombat's page and opens it (2026-11-22; the Easy-path install test)

*In part amended by AP-9773: control now gives the claim link, and Claim it now opens it.*

The Easy path asked for two codes on two sites: the link code here, then, a minute or two later, the long address and
four letters from the box's screen. Now “… is linked” waits for that Whombat's own address: it asks control's
`link.boxes` every 5 s (`pollLinkAddress`) and says “Getting your Whombat’s web address… this usually takes a minute or
two.”; after 5 minutes it says it is taking longer than usual, with Check again; it stops asking when the page closes.
Once the Whombat has its address (`linkBoxOpenUrl`), a Whombat without a name (nobody set it up yet: an Easy box links
before its setup asks for one) gets **Claim it now**, which opens `https://<host>/` in this tab, and one with a name
gets Open it. Your Whombats is a link beside it. A line under the button says to try again in a minute if the page
doesn't open yet.

What it can't do with what control gives today: open the claim itself. The claim at the address needs the claim link
(`/c/<6 letters>`, own-address.md OWA-12, OWA-36), which only the box holds, in memory, and shows on its screen; control
doesn't have it. So the page at the address asks for the six letters after `/c/` (own-address.md AP-9772 in the apps),
then the four letters. Control also doesn't say whether the box serves its page yet (its certificate comes a minute or
so after its address), hence the line under the button. Both would need a box and contracts change.

## AP-9771 The claim takes the account's name and email along, in the fragment

Claim it now carries the signed-in account's name and email in the URL fragment (`#name=…&email=…`,
`ownClaimPrefillHash`), which never reaches a server: not control, not the relay's door, not the box. The box's page reads
it once on its root or its claim link (`readOwnClaimPrefill`), takes it out of the address at once, and fills Who are
you? with it; the person can change both. Open on Your Whombats carries nothing.

## AP-9773 Claim it now opens the claim link control gives (2026-11-22; John; own-address.md OWA-39, LNK-79)

*In part superseded by whombat-link.md LNK-80…LNK-83: the page opens the claim link by itself (the button only if it didn't go), waits three minutes for it, shows the wait step by step and counts “STEP 1 OF 4”.*

Control now answers a Whombat nobody claimed yet with its claim link (`LinkedBox.claimUrl`, contracts 4.13), only to
the account it is linked to. After the confirm, `pollLinkAddress` returns that link as soon as control has it, and
Claim it now opens `https://<host>/c/<six letters>#name=…&email=…`: the box's page reads the fragment on its claim link
as on its root (AP-9771), and the person types only the four letters on the screen. The box reports the link once its
page works, which takes its certificate, so once the address is there the wait goes on for at most 90 s more
(`LINK_CLAIM_URL_GRACE_MS`) for a Whombat without a name; the words stay “Getting your Whombat’s web address…”. A box
or control that never sends the link gets today's button after that wait: the box's root, which asks for the six
letters too. `linkBoxClaimUrl` takes the link only on the Whombat's own host and while its address works. A Whombat
with a name opens its page at once, as before.
