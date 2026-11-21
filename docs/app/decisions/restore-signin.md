# Back in after a restore (AP-6278)

A Whombat restored from a backup onto a reinstalled or new machine has a new identity, while its database knows the
person's devices. The devices know only the old identity, so each needs one trusted party to name the new one: the
claim (the device that claimed the new box), the box's screen (Whombat `docs/decisions/signin-at-box.md` BX-S09) or a
link from a device that is in. Passkeys and an old recovery kit name the old identity and don't help.

| # | Decision | Reason |
|---|---|---|
| AP-6278 | **Pinned and in already: no pairing.** `letInAlready(state)` (`@whombat/client/managed` `pairing.ts`) reads the enrollment session's welcome: on the `app` channel the box says this device is in. The web's and the phone's pair flows (`useOpenWhenLetIn`) then open the Whombat as if a pairing were approved, with the welcome's account; the phone's QR sign-in from a computer (`runPhoneHandoff`, dep `letIn`) does the same after it pinned the link's identity, reporting `signed_in` instead of a pairing code. | A device with a link from a device that is in has pinned the new identity; asking the box to pair a key it already knows only failed. |
