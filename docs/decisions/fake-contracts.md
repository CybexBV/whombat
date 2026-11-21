# Fakes keep to the contract (FKC-01…FKC-02)

The web and phone apps are tested against stand-ins for the box: the fixture world over the REST contract
(`apps/web/src/app/fixtureFetch.ts`, `@whombat/fixtures`) and the fake appliance over the session protocol
(`@whombat/client/fake`). The architecture council review of 2026-11-09 asked whether they drift from the contract.
They mostly can't: the fake appliance runs every message through the protocol's codec and schemas, and the client
decodes every answer with the endpoint's schema, throwing in development and tests (`validateResponses`). What could
still drift quietly is what the client's tolerant decoding forgives: a list item of a kind the contract doesn't have is
left out with a console warning, and a security view that doesn't match shows “needs a newer version”, without the
test failing.

| ID | Decision | Reason |
|---|---|---|
| FKC-01 | **A test fails when the app left something out of a fake's answer** (`@whombat/client/testing/contract-tripwire` `failOnLeftOut`, registered by the web and phone test setups): after each test, any left-out item or unreadable security view fails it. A test about what the app shows then calls `expectLeftOut()`. | What the client forgives a newer box must not hide a fake that no longer matches. None of the 3,180 web and phone tests tripped it when it was added. |
| FKC-02 | **No schema wrapper around each fake.** | The client's decoding already checks every answer against its schema on the way in; a second check in each fake would repeat it. |
