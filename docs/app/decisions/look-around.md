# Look around without a Whombat (AP-9724 … AP-9728)

Decided 2026-11-20 for John by the launch helper (release prep): a person without a Whombat, Apple's TestFlight
reviewer among them, can see the apps. The demo world already existed (the one the screenshots, the visual suite and
the phone's demo build use); only the way into it from the apps everyone installs is new.

## AP-9724 One button on the first screen

The phone's first screen (Join a Whombat, LNK-44) and the hosted app's sign-in page each end with a quiet button,
“Look around without a Whombat” (`COPY.lookAround.open`). It opens the demo world: Burrow HQ on an in-memory box, signed
in as Mara, the mock world fixture mode serves. Nothing asks for an account, an address or a code first. Nothing on the
iPhone sells anything (LNK-44): the demo world has no Link, price or sign-up.

## AP-9725 It says it is a demo, and the way back is one tap

Every screen of the demo carries one line above it: “This is a demo Whombat. Nothing you do here is real.” with
**Leave the demo** (on the phone the strip under the status bar, `ScreenStripContext`, with “Leave”; on the web the
shell's notice slot, `DemoNotice`, first of its lines). Leave goes back to the first screen and forgets what was done:
the demo starts afresh each time. Settings → This Whombat already says “Demo”.

## AP-9726 Nothing real is touched

The demo world answers inside the app (`createFakeSession` over the fixture world, as the demo build and the tests do):
no request reaches control, the relay or a Whombat, and nothing is kept. On the web the address bar stays where it was
(a memory history), so a reload is the sign-in page again; the demo has no account menu to sign out of.

## AP-9727 It loads only when opened

The phone keeps the demo world behind a `require` that runs when the button is pressed (`demo/LookAround.tsx`): the
app's start (AP-920) doesn't load it, and every build now carries it. This replaces “the managed app never the demo
world” of hermes-engine-app.md AP-5370; the demo build (`EXPO_PUBLIC_WHOMBAT_MODE=fixtures`) stays as it is. On the web,
fixture mode's door (`fixtureMode.ts`) stays null in production (web-efficiency.md WE-02), and the hosted app's demo
imports the world itself (`fixtureWorld.ts`) through a lazy `DemoWorld`: the build refuses the mock world in any chunk
the page loads by itself (`noFixtureMode({ lazyDemo })`, `fixture-chunks.ts`), and the box's own page has none at all.

## AP-9728 The privacy policy inside the phone app

App Review asks for the privacy policy to be easy to reach inside the app (Guideline 5.1.1(i)), and the phone linked
only the Appliance Terms. The VERSION card (the bottom of Settings, also in the demo, and This Whombat → About) ends
with a Privacy row, “How Whombat handles your data”, whose Read opens the site's `/legal/privacy`.

