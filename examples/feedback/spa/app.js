/**
 * A single-page app without a framework: links are handled with history.pushState, the back button with
 * popstate. The widget needs nothing from the app to follow along: while its panel is open it compares the
 * page address every second (and on popstate/hashchange), so “What will be sent” always shows the current
 * route — origin and path only; the query string and the fragment are never sent.
 */
const views = [
  { path: /^\/$/, title: 'Home', body: 'Pick an order or open the settings. Then press Feedback.' },
  {
    path: /^\/orders\/[^/]+$/,
    title: 'Order',
    body: 'Order numbers are identifiers: add /orders/* to the integration’s redacted paths and the report says /orders/:id.',
  },
  {
    path: /^\/settings$/,
    title: 'Settings',
    body: 'This address has ?token=… and #notifications: neither is sent.',
  },
];

function render() {
  const view = views.find((v) => v.path.test(location.pathname)) ?? {
    title: 'Not found',
    body: 'No such page.',
  };
  const main = document.getElementById('view');
  const heading = document.createElement('h1');
  heading.textContent = view.title;
  const text = document.createElement('p');
  text.textContent = view.body;
  main.replaceChildren(heading, text);
  document.title = `${view.title} · Acme Shop`;
}

document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href^="/"]') : null;
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  history.pushState(null, '', link.getAttribute('href'));
  render();
  document.getElementById('view').focus();
});
window.addEventListener('popstate', render);

// Optional: tell reports which release of the app they came from (never tokens or customer data).
function withFeedback(fn) {
  if (window.WhombatFeedback) fn(window.WhombatFeedback);
  else document.addEventListener('whombat-feedback:ready', () => fn(window.WhombatFeedback), { once: true });
}
withFeedback((feedback) => feedback.setContext({ app: { version: '1.4.2', environment: 'production' } }));

render();
