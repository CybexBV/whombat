# The account site's home and the box's Whombats menu (AP-9774 … AP-9782)

app.whombat.com was hard to read: an account with an organization from before Whombat Link landed on that
organization's list ("Pick a Whombat"), empty for someone whose Whombats are all Link boxes, beside "Claim a Whombat",
"Link a Whombat" and "Whombat Link", while those Whombats were on another page. Decided 2026-11-23 by John, from the
mockups of that day: one home with every Whombat, one way to add one, the account on its own page, and a menu under the
box's name that goes back to it. Partly supersedes [link-account-site.md](link-account-site.md) AP-9701, AP-9703,
AP-9704, AP-9707 and AP-9714 (each says so there).

## AP-9774 One home at `/`

Signed in, `/` is the home: the person's Whombats in one list (their Link boxes, and an older organization's Whombats
where the account has one), the one this browser opened last first, each with **Open** at its own address in the same
tab (an older organization's opens on this site, as its list does). One Whombat leads with one big “Open <name>”; none
shows the three steps (install it, choose Easy, enter the code) with the code field on the page. Under the list: “Add a
Whombat”, then the plan in one line (“Whombat Link · Free for good · 3 Whombats”) and “Account and billing”. A sign-in
link without a `next` lands here; `/appliances` of an account without an older organization goes here too. An older
organization's own list stays at `/appliances` with everything behind it.

## AP-9775 One way to add a Whombat: `/add`

“Claim a Whombat”, “Link a Whombat” and “Whombat Link” as an action become **Add a Whombat**, `/add`; “Whombat Link”
is only the subscription's name. `/link` (what a box's screen shows) is the same page. The confirm asks “Add <name>?”
(or “Add this Whombat?” with the code it shows), lists what it gives (open it from anywhere, its notifications on your
phone, its own web address), then the free month and the terms; the button is “Add it”. The sign-in page has “New to
Whombat? Add your Whombat”, which starts there signed out.

## AP-9776 The account at `/account`

`/account` (and `/billing`, where Stripe comes back) holds the subscription card as before, then You: the email, the
phone app and signing out. Deleting the account sits apart at the bottom, never beside signing out.

## AP-9777 The account's menu

The top bar has the logo (back to the home) and the account: its initial and email, opening Account and billing, Phone
app and Sign out. On a phone only the initial shows.

## AP-9778 A Whombat's line says nothing it can't know

Control hears from a Link box about once an hour, so the home never says “Online” for one: a box on Link shows its
address; one control hasn't heard from for over three hours says “Not heard from since …” and keeps Open (it may be
back). Getting its address, Link off and ended say so and have no Open; in its last week it says until when.
Removing a Whombat from Link is behind ⋯ on its row and asks first.

## AP-9779 The menu under the box's name

On a box's own page with Whombat Link (any state but off) the name at the top of the sidebar opens YOUR WHOMBATS: this
one ticked, the account's other Whombats (each a link to its own address, in this tab), then “All Whombats” and “Add a
Whombat” on the account site (`https://app.whombat.com/`, `/add`). Without Link it stays the name: there is no account
to go back to. The hosted app's organization menu ([whombat-switcher.md](whombat-switcher.md)) is unchanged.

## AP-9780 The other Whombats come through the box (contracts 4.14)

The page has no account session, so the box asks: the session op `link.whombats` (any of the person's devices) → the
manager's `/v1/link/whombats` → the device op `link.whombats`, which control answers with the other boxes of the account
this box is linked to (device, name, Link state, address, last heard from; never itself, never a claim link; control
CL-256). The runtime asks at most once a minute and answers an empty list whenever it can't tell (Link not running, an
older manager or control, control away), so the menu then shows only the ways to the account site. The names are the
account holder's; one person per Whombat makes them the same person in nearly every case.

## AP-9781 Words

`HOME_TEXT`, `ACCOUNT_TEXT`, `ADD_TEXT`, `BOX_MENU_TEXT` and `SIGN_IN_NEW_TEXT` (`@whombat/client/managed` `home.ts`);
the box setup's first step reads “Add your Whombat · To your account”.

## AP-9782 Checks

`linkAccount.test.tsx` covers the home (one, many, none, quiet, an older organization's, ⋯, the menu) and the account's
plan; the server's `link.test.ts` the runtime's answer; control's `link.int.test.ts` who sees whom. The managed
journeys (`signin.spec.ts`, `link.spec.ts`) start from the home.
