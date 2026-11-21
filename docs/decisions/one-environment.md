# One environment, Link on production (ENV-01…ENV-21)

John, 2026-11-19. Whombat Link (`whombat-link.md`, LNK-) goes to production, and production is the only environment:
the Hetzner server runs control, the relay, the door, the account site and admin. The installer asks **Easy** (Whombat
Link) or **Expert** (Tailscale or Headscale); a Whombat can switch later in Settings. Link costs “First month free, then
€2.50 a month or €25 a year”. admin.whombat.com gives free time and makes promotion codes. app.whombat.com manages the
person's Whombats and opens the one they choose. Inside a Whombat the person chooses **Beta** or **Production** updates.
DEV is retired once Home has moved. The box's own address is `own-address.md`. Shapes: contracts 4.6.0 (CT-1772…CT-1776).

The plan, its briefs and the other repositories' notes call these decisions ONE-01…ONE-19 (the same numbers); in
Whombat `ONE-` is `one-whombat.md`'s prefix, so here they are `ENV-` (decision-ids.md DID-01).

## One environment

| ID | Decision | Why |
| --- | --- | --- |
| ENV-01 | **One environment, production**: api/app/admin/relay/embed.whombat.com on the Hetzner server (whombat-prod), boxes at `<label>.box.whombat.app` through the door on that server. Retired after Home moves: dev.whombat.com, api-dev, admin-dev, relay-dev, updates-dev, embed-dev, `*.dev.whombat.app`, the DEV stack on The Falcon (`~/Services/whombat-appliance-dev`), the door tunnel to The Falcon, and the old Hetzner TUF repository at updates.whombat.com. **Stays**: `pnpm dev` (a local development box with stand-ins) and every loopback and harness test: they are tools, not an environment. | Two environments doubled the work, and production lagged behind what DEV ran. |
| ENV-02 | **One image**: environment `prod`, device env `prod`, the GitHub releases layout (`releases.whombat.com`) with channels, default Production. The installer's developer-environment option goes. Until Home has moved the image keeps the `dev` environment entry (a box whose file says `dev` keeps working); a cleanup release then removes it. The bridge that writes `dev` at boot goes now. | One image to build and test; Home must not break while it moves. |
| ENV-03 | **Channels**: on the wire and in TUF the names stay `production` and `development`; people see **Production** and **Beta**. New installs start on Production. Every candidate goes to Beta; a release reaches Production only by `promote` on John's word. | People understand “Beta”; renaming the wire names would break every box. |
| ENV-04 | **Release ids** are `whombat-YYYYMMDD.N`, one family (`compareVersions` already orders the older `whombat-dev-` ids with them). | One family, one order. |
| ENV-05 | **Keys** (John: “beide”): root rotated to three new keys, threshold 2, and top-level targets to a new key, all handed to John to keep offline (files in a 0700 folder until he confirms they are on his offline media, then deleted from disk). The **production** role key stays online with the publisher (The Falcon, `~/.config/whombat/releases-keys`, backup on The Titan) **and** has an offline copy. Development and clients stay online; snapshot and timestamp stay in the Actions secrets. A production image refuses a pinned root whose threshold is 1. | Root and top targets protect everything and are rarely used; promoting must not wait for John's media. |
| ENV-06 | **Moving a box to production** (Home): `whombat-manager environment set prod` on a box whose identity was made locally rewrites the identity's env (`local` → `prod`: self-declared, nothing signs it, so the builder checks it), resets the Link state and the own-address state when the control changes (a new label and certificate under `box.whombat.app`), and keeps the device id, its keys and all data. Remote help is granted again with the production CA. | Home keeps its data and identity; only where it reports changes. |

## Selling Link

| ID | Decision | Why |
| --- | --- | --- |
| ENV-07 | **Yearly plan**: €25 a year incl. VAT per Whombat beside €2.50 a month; chosen at checkout, switchable in Stripe's portal. One offer sentence everywhere: “First month free, then €2.50 a month or €25 a year” (`LINK_OFFER_TEXT`). | A yearly price people asked for; one sentence so no page says something else. |
| ENV-08 | **Promotion codes**: Checkout shows Stripe's code field; admin makes codes (free 3, 6 or 12 months, or a percentage; how many uses; until when). | Launch offers and partners without a code change. |
| ENV-09 | **Free time** in admin: 3 months, 6 months, 1 year or forever, with a required note; it can be stopped. During the free month it starts when the free month ends, otherwise today. Seven days before it ends, without a card on file, control mails “add a card to keep Link”. Shown on the dashboard and on the account page (“Free until 19 May 2027”). | Friends, testers and support cases, without anyone losing Link by surprise. |
| ENV-10 | **Admin changes are guarded**: passkey sign-in for panel users (a password alone is not enough in production), allowed networks, CSRF tokens on every form, every change in an audit log (who, what, why, when) shown on the account; changes go through control's normal write path. | Admin can now change what people pay. |
| ENV-13 | **Consumer terms**: Link is sold to consumers and businesses; prices incl. VAT; the free month without a card; monthly or yearly; cancel any time; “Within 14 days of your first payment you get your money back on request.” The terms of service, subscription terms and privacy are updated in Whombat `apps/web/src/legal/` and copied to the website. John checks the wording. | EU consumer rules; one simple promise instead of a withdrawal form. |
| ENV-20 | **Sold in EU countries only at launch** (`LINK_COUNTRIES`, the 27 member states). The account site asks where the person lives before the payment page opens; “Another country” gets one plain line (“Whombat Link is only sold in EU countries for now. Your Whombat keeps working at home without it.”) instead of a refused payment, and control refuses such a country itself (`link_country`). A page paid with a billing address outside the list anyway is mailed to the operator, who refunds it. Free accounts, comps, free time and the free month are untouched. Selling in more countries is that one list. | Outside the EU (the UK, Switzerland, Norway, the US …) a VAT registration can be needed from the first sale; inside it, Dutch VAT covers every consumer below €10,000 a year abroad. John's decision through the release helper, 2026-11-20. |
| ENV-21 | **A business can give its VAT number** in Stripe Checkout's own field (tax ID collection), so Stripe Tax reverse-charges a business elsewhere in the EU and its invoices show the number; the portal keeps letting it add one later. A number the EU's check doesn't confirm is mailed to the operator, who acts on it. | The terms sell Link to businesses too, and a business abroad must not be charged Dutch VAT. Same decision. |

## Where people meet it

| ID | Decision | Why |
| --- | --- | --- |
| ENV-11 | **app.whombat.com opens Whombats**: each Whombat has **Open** (its own address), the most recently opened first; with one Whombat, one big Open. The plan section says month or year, free time and a used code. | The account site is where people start from away from home. |
| ENV-12 | **Easy/Expert words** in the installer and in Settings → This Whombat → Reach, the same words (below). On iPhone the same without the price line and without anything to buy or sign up for. | One choice, said the same way everywhere; App Store rules on iPhone. |
| ENV-14 | **Website**: whombat.com says what Link and Expert are, the prices and the free month, open source, the installer download, sign in and sign up at app.whombat.com. No “invite-only”. | Anyone can now install and subscribe. |
| ENV-15 | **Installer download on R2** (a bucket John made, public through a custom domain): `installer/<release-id>/` with the ISO and its `.sha256`, plus `installer/latest.json` for the newest Production release; the website links it. | GitHub takes at most 2 GiB a file. |
| ENV-16 | **Phone apps**: one build for production (`--env prod`), TestFlight and the APK for now; the APK and `latest.json` come from production control's downloads. Store listings come later. | One app for everyone, without waiting for store review. |

## Running it

| ID | Decision | Why |
| --- | --- | --- |
| ENV-17 | **Remote help on production**: the support CA key lives on the Hetzner host; its public half is in the image (`manifest/prod/support-ca.pub`); `support` talks to production by default. | Remote help follows the one environment. |
| ENV-18 | **Control and relay changes go live at once**: every deploy dumps the database first and keeps the previous build ready to switch back to. | There is no DEV in front of production any more. |
| ENV-19 | **Shipping**: `candidate` builds, publishes to Beta, and deploys control, relay and web to Hetzner when they changed; Home takes Beta within the hour. `promote <release-id>` moves a release to Production on John's word. Phone apps publish with `--env prod`. | Fast for John, deliberate for customers. |

## Words (ENV-12)

The installer's step and Settings → This Whombat → Reach use the same words:

- Title “How will you reach this Whombat?” · sub “You can change this later in Settings.”
- **Easy** · “Whombat Link” · tag “Recommended” · “First month free, then €2.50 a month or €25 a year”
  - Open your Whombat from anywhere, without port forwarding
  - Its own secure web address
  - Notifications on your iPhone and Android phone
  - The Whombat apps away from home
  - Sign-ins like Google work
  - Supports Whombat’s open-source work
- **Expert** · “Tailscale or Headscale” · tag “Free” · “You set up Tailscale on each of your devices.”
  - No notifications on your phone while the app is closed
  - Some sign-ins, like Google, aren’t available
- On iPhone: the same without the price line and without anything to buy or sign up for.

## Contracts 4.6.0

Additive, no session major (`docs/contracts/decisions/contracts.md` CT-1772…CT-1776):

- `@whombat/protocol`: `LINK_PRICE_YEAR_CENTS` 2500, `LINK_PRICE_YEAR_TEXT` “€25 a year”, and `LINK_OFFER_TEXT`, built
  from `LINK_TRIAL_TEXT`, `LINK_PRICE_TEXT` and `LINK_PRICE_YEAR_TEXT`. TypeScript only, like the monthly price.
- `@whombat/control-contracts`: `LinkInterval` (`month`, `year`; the same values as the new `PlanInterval`, which a
  plan's `interval` now uses), `LinkPlan.interval`, `LinkPlan.discount` (`LinkDiscount {percentOff, endsAt, code}`,
  `LinkPromotionCode`), and `LinkCheckoutBody {interval?}` for `link.checkout` (absent = `month`).

## Contracts 4.7.0: the terms

The legal texts at `/legal/…` (`apps/web/src/legal/`) sell Whombat Link to people and businesses (ENV-13), and both
terms versions are `2026-11-19` (`docs/contracts/decisions/contracts.md` CT-1777…CT-1779). `link.confirm`, where Link
starts, now asks for the Subscription Terms: `LinkLookup.termsVersion` names the version, `LinkConfirmBody.terms`
carries the tick. Control takes 4.7.0 and ships with the account site and the phone apps that send the new versions;
the appliance's copy of the Appliance Terms (`docs/legal/appliance-terms.md`) must equal the app's byte for byte.

## Contracts 4.8.0: a code and the terms at checkout

During a free month already in Stripe the page Checkout opens takes only the card, so the account site has its own
“Promotion code” field: `link.checkout` takes `promotionCode` and `terms`, `link.portal` takes `terms`, and the
reasons `terms_required`, `promotion_code_invalid` and `checkout_busy` are in the catalogue
(`docs/contracts/decisions/contracts.md` CT-1780…CT-1782).

## Contracts 4.9.0: paying starts on Stripe's page

Nothing is in Stripe before the person pays: `link.checkout` always opens a subscription-mode Checkout with Stripe's
own code field, the account site no longer has one, and the portal is only for a subscription Stripe has
(`docs/contracts/decisions/contracts.md` CT-1783…CT-1784).

## Contracts 4.10.0: where the person lives

`link.checkout` takes `country` (an ISO 3166-1 code) and refuses one outside `LINK_COUNTRIES` with `link_country`
(403), before any payment page; the page has Stripe's VAT number field (ENV-20, ENV-21;
`docs/contracts/decisions/contracts.md` CT-1785…CT-1786).
