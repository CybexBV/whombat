/**
 * Whombat Feedback in a Lumio-style app: the app's own buttons open the widget, and the app tells reports where
 * the visitor was in its own words — never anything that identifies or authorizes someone.
 *
 * Sent (all of it is shown to the visitor under “What will be sent”):
 * - app version and environment;
 * - `page`: a name from a fixed list (`computers`), not the route — the integration must list `page` under
 *   “Context keys” in Settings → Connections → Website feedback, or it is dropped;
 * - the id of the last API request, as a diagnostic reference.
 * Whombat adds the page address (path only: UUIDs and long numbers become `:id`, the query and fragment are
 * never sent), the coarse browser name, language, window size and time zone.
 *
 * Never sent: session or API tokens, organization, user or customer ids, device or computer ids, customer
 * records, breadcrumbs, form contents, local storage. Resource ids in the route stay out on purpose.
 */

/** The fixed allowlist: route prefix → page name. Anything else is reported as `other`. */
const PAGE_NAMES = [
  ['/computers', 'computers'],
  ['/policies', 'policies'],
  ['/settings', 'settings'],
];

function pageName(pathname) {
  for (const [prefix, name] of PAGE_NAMES)
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return name;
  return 'other';
}

/** Set by the app's API client from the X-Request-Id of the last response (simulated below). */
let lastRequestId = null;

function withFeedback(fn) {
  if (window.WhombatFeedback) fn(window.WhombatFeedback);
  else document.addEventListener('whombat-feedback:ready', () => fn(window.WhombatFeedback), { once: true });
}

function updateFeedbackContext() {
  const root = document.documentElement;
  withFeedback((feedback) =>
    feedback.setContext({
      app: { version: root.dataset.appVersion, environment: root.dataset.appEnvironment },
      custom: { page: pageName(location.pathname) },
      references: lastRequestId ? [lastRequestId] : [],
    }),
  );
}

// A second way in: a menu item that opens the form as a feature request.
document.getElementById('suggest').addEventListener('click', () => {
  withFeedback((feedback) => feedback.open({ type: 'feature' }));
});

// --- The rest stands in for the app itself: a router and an API client. ---------------------------------

const COMPUTER = '3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60718';

function render() {
  const main = document.getElementById('view');
  const heading = document.createElement('h1');
  const text = document.createElement('p');
  if (location.pathname.startsWith('/computers/')) {
    heading.textContent = 'Computer';
    text.textContent = 'A computer’s page. Its id is in the address, and reports get :id instead.';
  } else if (location.pathname.startsWith('/policies')) {
    heading.textContent = 'Policies';
    text.textContent = 'Policies of your organization.';
  } else {
    heading.textContent = 'Computers';
    const link = document.createElement('a');
    link.href = `/computers/${COMPUTER}`;
    link.textContent = 'WS-0142 (Windows 11)';
    text.append('Managed computers: ', link);
  }
  main.replaceChildren(heading, text);
  updateFeedbackContext();
}

document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href^="/"]') : null;
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  history.pushState(null, '', link.getAttribute('href'));
  render();
});
window.addEventListener('popstate', render);

document.getElementById('refresh').addEventListener('click', () => {
  // What the API client would do with a response's X-Request-Id.
  lastRequestId = `req_${Math.random().toString(36).slice(2, 10)}`;
  updateFeedbackContext();
});

render();
