# Whombat Feedback examples

Three small websites that embed the Whombat Feedback widget, framework-free. The operator guide is
[docs/feedback.md](../../docs/feedback.md).

Use one installation method from Settings → Connections → Website feedback. The default is one floating **Feedback** button with
bug and idea choices inside the form. For your own button, replace the widget script with the custom-mode
snippet and add `data-whombat-feedback` to your existing control; add the example button only if there isn't
already one. Don't append a second script or button. In floating mode the widget hides its own launcher while
a visible, enabled declarative control is present, and restores it when that control is removed or hidden.
It never removes or changes the site's own controls. Intentional `bug` / `feature` preselection and API menu
actions remain supported, as the Lumio example demonstrates.

| Example | Shows |
|---|---|
| `plain-html/` | The one-line installation: the snippet from Settings → Connections → Website feedback, pasted as it is, under a strict Content-Security-Policy. |
| `spa/` | A single-page app with `history.pushState` routes: the widget follows navigation on its own; `setContext` adds the app version. |
| `lumio/` | No floating button: the app's own “Feedback” button (`data-whombat-feedback`) and a menu item (`WhombatFeedback.open({ type: 'feature' })`) open it; `setContext` sends the app version and environment, a page name from a fixed list and the last request id — never tokens, organization/user ids or customer records. |

## Run one

1. In Whombat, Settings → Connections → Website feedback → New integration. Allowed origins: `http://localhost:8080` (http is accepted
   for localhost only). For `spa/` also add `/orders/*` under redacted paths; for `lumio/` add `page` under
   context keys.
2. Copy the site id (`fbs_…`) from the integration and start the example with your Whombat's address:

   ```
   node examples/feedback/serve.mjs plain-html --whombat https://whombat.example.org --site fbs_… --port 8080
   ```

3. Open `http://localhost:8080` and press Feedback. The report appears as a thread in your Feedback room.

`serve.mjs` (Node 20+, no dependencies) replaces the placeholders `https://whombat.example.com` and
`fbs_REPLACEwithYourSiteId000` while serving; to use an example elsewhere, replace them in the files. The same
pages are loaded by the widget's end-to-end suite against a real Whombat (`pnpm --filter @whombat/widget e2e:real`),
and `apps/widget/src/examples.test.ts` checks that their snippets are exactly what Whombat generates.
