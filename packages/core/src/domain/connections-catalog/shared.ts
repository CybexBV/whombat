import { z } from 'zod';
import { Handle, JsonObject, JsonValue } from '../common.js';

/* ---------------------------------------------------------------------------------------------- */
/* Vocabulary                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/**
 * How Whombat talks to a service (CX-32, CX-33): a remote MCP server, a REST API, its own builtin code, or (0.97, CT-471;
 * CM-13) a WebSocket that carries JSON-RPC or ESPHome's commands (`CatalogEntry.socket`).
 */
export const CONNECTION_TRANSPORTS = ['mcp', 'rest', 'builtin', 'socket'] as const;

export const ConnectionTransport = z.enum(CONNECTION_TRANSPORTS);

export type ConnectionTransport = z.infer<typeof ConnectionTransport>;

/** The overview's tile groups (CX-70), in display order. */
export const CATALOG_CATEGORIES = [
  'accounts',
  'productivity',
  'files',
  'home',
  'business',
  'developer',
  'infrastructure',
  'custom',
] as const;

export const CatalogCategory = z.enum(CATALOG_CATEGORIES);

export type CatalogCategory = z.infer<typeof CatalogCategory>;

export const CATALOG_CATEGORY_LABELS: Record<CatalogCategory, string> = {
  accounts: 'Accounts',
  productivity: 'Productivity',
  files: 'Files',
  home: 'Home',
  business: 'Business',
  developer: 'Developer',
  infrastructure: 'Infrastructure',
  custom: 'Custom',
};

/** What a tool does to the service (CX-18): reads, or changes something. Unknown is `write`. */
export const CONNECTION_TOOL_ACCESS = ['read', 'write'] as const;

export const ConnectionToolAccess = z.enum(CONNECTION_TOOL_ACCESS);

export type ConnectionToolAccess = z.infer<typeof ConnectionToolAccess>;

/** A tool's tier on one connection (CX-18): Allowed, Asks, Off. Every tool starts Allowed since 0.57 (CT-310). */
export const CONNECTION_TOOL_TIERS = ['can', 'ask', 'off'] as const;

export const ConnectionToolTier = z.enum(CONNECTION_TOOL_TIERS);

export type ConnectionToolTier = z.infer<typeof ConnectionToolTier>;

/** The segment labels of a tool's tier (CX-72), in display order Allowed · Asks · Off. */
export const CONNECTION_TOOL_TIER_LABELS: Record<ConnectionToolTier, string> = {
  can: 'Allowed',
  ask: 'Asks',
  off: 'Off',
};

/** The mark on a tool the catalog's `sensitive` rules make ask whatever its tier (CX-31). */
export const ALWAYS_ASKS_LABEL = 'Always asks';

/** The mark on a tool whose definition is new or changed since the last check (CX-18). */
export const NEW_TOOL_LABEL = 'New';

/**
 * The default tier of a tool of this access (CX-18): Allowed. A person connected the service for agents to use it;
 * the catalog's sensitive rules (CX-31) still ask (CT-310).
 */
export function defaultToolTier(_access: ConnectionToolAccess): ConnectionToolTier {
  return 'can';
}

/* Limits (CX-05, CX-10, CX-18) ------------------------------------------------------------------- */

/** The most connections a Whombat keeps (CT-1552: one kind, the 30 shared and 20 personal of before together). */
export const CONNECTIONS_MAX = 50;

export const CONNECTION_TOOLS_MAX = 128;

export const CONNECTION_SECRET_MAX = 8000;

export const CONNECTION_LABEL_MAX = 80;

export const CONNECTION_FIELD_VALUE_MAX = 2000;

/** The guide an entry gives agents, and a Custom API's “What should agents know?” (CX-01, CX-62). */
export const CONNECTION_GUIDE_MAX = 1500;

/** What a call keeps of a service's answer (CX-32, CX-33). */
export const CONNECTION_OUTPUT_MAX = 64 * 1024;

export const CONNECTION_CALL_DEADLINE_MS = 30_000;

/** How long the overview waits between Nextcloud login polls, and how long a login flow lives (CX-11). */
export const NEXTCLOUD_POLL_MS = 2000;

export const NEXTCLOUD_LOGIN_MAX_MS = 10 * 60_000;

/**
 * Signing in on the service's own page (0.111, CT-730; Whombat connection-signin.md SG-02, SG-04): how often the form
 * polls by default (the start answers its own `pollEveryMs`), how long a flow lives at most, and the longest code a
 * device-code service asks the person to type (`StartServiceLoginResponse.userCode`).
 */
export const SERVICE_LOGIN_POLL_MS = 2000;

export const SERVICE_LOGIN_MAX_MS = 10 * 60_000;

export const SERVICE_LOGIN_USER_CODE_MAX = 32;

/** A connection's handle (CX-05): `homeassistant`, `homeassistant-2`. What agents name it by. */
export const ConnectionHandle = Handle;

export type ConnectionHandle = z.infer<typeof ConnectionHandle>;

export const ConnectionLabel = z.string().trim().min(1).max(CONNECTION_LABEL_MAX);

export const ConnectionSecret = z.string().min(1).max(CONNECTION_SECRET_MAX);

/* ---------------------------------------------------------------------------------------------- */
/* Entry schema                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export const FieldId = z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/);

export const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/** A regular expression's source, matched case-insensitively (`new RegExp(source, 'i')`). */
export const Pattern = z.string().min(1).max(500);

/** A dotted path into a JSON answer; `*` takes every element of an array (`data.*.type`). */
export const JsonPathText = z.string().regex(/^[A-Za-z_*][A-Za-z0-9_*]*(\.[A-Za-z_*][A-Za-z0-9_*]*){0,9}$/);

/** A query parameter's name. */
export const QueryName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

/** A cookie's name (`SID`, `frigate_token`). */
export const CookieName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

/**
 * How a session token goes on each request: bearer, `{token}` in a header template, a query parameter, or a named
 * cookie.
 */
export const SessionApply = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('header'), name: HeaderName, template: z.string().max(200).default('{token}') }),
  z.object({ type: z.literal('query'), name: QueryName }),
  z.object({ type: z.literal('cookie'), name: CookieName }),
]);

export type SessionApply = z.infer<typeof SessionApply>;

/** An XML element's name (0.110, CT-704): QNAP's `authSid`, `authPassed`. */
export const XmlTag = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);

/**
 * A value in a service's answer (0.110, CT-705): at a dotted path of its JSON (`error.code`) or in an XML element
 * (`authPassed`, its text trimmed, CDATA unwrapped) — exactly one of `json` and `xml` — equal to one of `values`,
 * compared as text (the JSON number 119 is `"119"`, `true` is `"true"`).
 */
export const SessionAnswerFields = {
  json: JsonPathText.optional(),
  xml: XmlTag.optional(),
  values: z.array(z.string().min(1).max(64)).min(1).max(20),
};

export const oneOfJsonXml = (m: { json?: string; xml?: string }) =>
  (m.json === undefined) !== (m.xml === undefined);

export const ONE_OF_JSON_XML = { message: 'Exactly one of json and xml.', path: ['json'] };

export const SessionAnswerMatch = z.object(SessionAnswerFields).refine(oneOfJsonXml, ONE_OF_JSON_XML);

export type SessionAnswerMatch = z.infer<typeof SessionAnswerMatch>;

/**
 * An answer that means the session ended (0.110, CT-705), as `SessionAnswerMatch`; `path` (a pattern over the request's
 * path) limits it to some calls (QNAP File Station's JSON `status` 3). Absent: every call.
 */
export const SessionStale = z
  .object({ ...SessionAnswerFields, path: Pattern.optional() })
  .refine(oneOfJsonXml, ONE_OF_JSON_XML);

export type SessionStale = z.infer<typeof SessionStale>;

/**
 * Why a service refused a session sign-in (0.110, CT-706; NS-04): the name or password (`refused`), the account is
 * switched off (`disabled`) or may not sign in there (`denied`), it asks for a two-step code (`two_step`), the service
 * blocked Whombat's address after too many tries (`locked`), the password expired (`expired`).
 */
export const SESSION_LOGIN_FAILURES = [
  'refused',
  'disabled',
  'denied',
  'two_step',
  'locked',
  'expired',
] as const;

export const SessionLoginFailureReason = z.enum(SESSION_LOGIN_FAILURES);

export type SessionLoginFailureReason = z.infer<typeof SessionLoginFailureReason>;

/** HTTP statuses a rule applies to (0.111, CT-734, CT-735): one to ten of them. */
export const HttpStatuses = z.array(z.number().int().min(100).max(599)).min(1).max(10);

/**
 * A sign-in answer that refuses: matched by JSON/XML value (`json` or `xml` with `values`) or by a case-insensitive
 * pattern on the response text (`bodyPattern`, for plain-text answers like qBittorrent's `Fails.`), optionally limited
 * to specific HTTP statuses.
 */
export const SessionFailure = z
  .object({
    json: JsonPathText.optional(),
    xml: XmlTag.optional(),
    values: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    bodyPattern: Pattern.optional(),
    status: HttpStatuses.optional(),
    reason: SessionLoginFailureReason,
    text: z.string().min(1).max(300).optional(),
  })
  .refine(
    (m) => {
      if (m.bodyPattern !== undefined)
        return m.json === undefined && m.xml === undefined && m.values === undefined;
      return oneOfJsonXml(m) && m.values !== undefined && m.values.length > 0;
    },
    { message: 'Provide either bodyPattern, or values with exactly one of json and xml.', path: ['json'] },
  );

export type SessionFailure = z.infer<typeof SessionFailure>;

/** A value a sign-in sends as it is, never a template (0.111, CT-732): Synology's `enable_device_token=yes`. */
export const SessionFixedValues = z.record(QueryName, z.string().max(200));

/**
 * How a session's service asks for a two-step code, and how Whombat is remembered so it asks once (0.111, CT-732;
 * Whombat connection-signin.md SG-09): Synology DSM. Looked at before `failures`.
 *
 * - `asked`: the sign-in answer that asks for a code (DSM's `error.code` 403). Without a code the server answers
 *   `second_factor_needed`; on a stored connection it needs a new sign-in (`again`'s words).
 * - `wrongCode`: the answer to a code that didn't work (DSM's 404), a `sign_in_refused` with reason `code`.
 * - `code.name`: where the code goes, beside the sign-in's own values (in `body`, or in `query` for a `GET` sign-in, as
 *   the login's values go): DSM's `otp_code`.
 * - `remember`: `body` is added to the sign-in that carries a code (DSM's `enable_device_token=yes`,
 *   `device_name=Whombat`); the answer holds a trusted-device token at the first of `tokenJsonPaths` that has one (DSM's
 *   `data.device_id`, `data.did` before API v7), which every later sign-in sends as `name` (`device_id`) with `with`
 *   beside it (`device_name`). The token is a credential: the server seals it, never shows it, and drops it with the
 *   connection or a new password.
 * - `again`: the person's words when a stored connection is asked for a code again (the device was removed in DSM).
 *   Absent: `sessionTwoStepAgainText`'s.
 */
export const SessionTwoStep = z.object({
  asked: SessionAnswerMatch,
  wrongCode: SessionAnswerMatch.optional(),
  code: z.object({ name: QueryName }),
  remember: z
    .object({
      body: SessionFixedValues,
      tokenJsonPaths: z.array(JsonPathText).min(1).max(3),
      name: QueryName,
      with: SessionFixedValues.optional(),
    })
    .optional(),
  again: z.string().min(1).max(300).optional(),
});

export type SessionTwoStep = z.infer<typeof SessionTwoStep>;

/**
 * How a token goes on a request (CX-10): `Authorization: Bearer …` (the default); a header whose value is a template
 * over `{secret}` and the entry's fields (`Authorization: Token {secret}`, `Authorization: PVEAPIToken={tokenId}={secret}`,
 * `x-api-key: {secret}`); basic auth with the username from a field; or a query parameter.
 */
export const TokenAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer') }),
  z.object({
    type: z.literal('header'),
    name: HeaderName,
    template: z.string().min(1).max(200).default('{secret}'),
  }),
  z.object({ type: z.literal('basic'), usernameField: FieldId }),
  z.object({ type: z.literal('query'), name: QueryName }),
  /**
   * A password Whombat signs in with for a session token (0.97, CT-470; CM-10, CM-11): Pi-hole's app password, Nginx
   * Proxy Manager's email and password, Synology's and QNAP's account (0.110, CT-703…CT-706; Whombat desk-found.md
   * NS-03). The secret is the password, a field may hold the account (`username`). The server signs in, keeps the
   * session sealed with its expiry, signs in again when less than a minute is left, the service answers 401/403 or an
   * answer is `stale`, and puts the session token on every request as `apply` says. `tokenCredential` answers null for
   * it: the server makes the credential (`sessionLoginRequest`, `sessionAnswerToken`, `sessionIsStale`,
   * `sessionLoginFailure`).
   */
  z
    .object({
      type: z.literal('session'),
      /**
       * The sign-in request, relative to the base: Pi-hole `POST /api/auth {"password": "{secret}"}`. Templates are over
       * `{secret}` and the fields, and since 0.110 (CT-703) `{secret:base64}` or `{field:base64}` (the value's UTF-8 in
       * standard base64: QNAP's `pwd`).
       */
      login: z.object({
        /** `GET` (0.110, CT-703): the sign-in in `query` alone, with an empty `body`. */
        method: z.enum(['POST', 'PUT', 'GET']).default('POST'),
        path: z.string().startsWith('/').max(200),
        /** A JSON object whose string values are templates over `{secret}` and the fields (`{username}`). */
        body: z.record(z.string().min(1).max(64), z.string().max(200)),
        /** Query parameters, templates as `body`'s, added to `path` (0.110, CT-703). Absent: none. */
        query: z.record(QueryName, z.string().max(200)).optional(),
        /**
         * How `body` is sent (0.110, CT-703): `json` (absent) or `form`
         * (`application/x-www-form-urlencoded`, Synology's and QNAP's CGI sign-ins).
         */
        encoding: z.enum(['json', 'form']).optional(),
      }),
      /** Where the session token is in the JSON answer (`session.sid`, `token`). */
      tokenJsonPath: JsonPathText.optional(),
      /** The XML element whose text is the session token (QNAP's `authSid`). */
      tokenXmlTag: XmlTag.optional(),
      /** The `Set-Cookie` cookie holding the session token (qBittorrent's `SID`, Frigate's `frigate_token`). */
      tokenCookie: CookieName.optional(),
      /** Where its lifetime is: a number of seconds (`session.validity`) or an ISO time (`expires`). */
      expiresJsonPath: JsonPathText.optional(),
      /** Used when the answer doesn't say; at most a day. */
      ttlSeconds: z.number().int().min(60).max(86_400).default(1800),
      /** How the session token goes on each request. */
      apply: SessionApply,
      /**
       * Signing out of a session Whombat drops (Pi-hole: `DELETE /api/auth`, so its seats don't fill up). `GET` and a
       * fixed `query` since 0.110 (CT-703: Synology's `SYNO.API.Auth` `logout`); the session goes on it as `apply` says.
       */
      logout: z
        .object({
          method: z.enum(['DELETE', 'POST', 'GET']),
          path: z.string().startsWith('/').max(200),
          query: z.record(QueryName, z.string().max(200)).optional(),
        })
        .optional(),
      /**
       * What the check says when the sign-in path isn't there (a 404): the service is older than this connection needs
       * (“This Pi-hole is older than version 6: update it, then connect it.”). Absent: the usual check failure.
       */
      missing: z.string().min(1).max(300).optional(),
      /**
       * Answers that mean the session ended although their status is 2xx (0.110, CT-705; NS-03): Synology's `error.code`
       * 106, 107 or 119, QNAP's `authPassed` 0. The server signs in again once and repeats the call, as on a 401. Absent:
       * none.
       */
      stale: z.array(SessionStale).max(4).optional(),
      /**
       * Sign-in answers that refuse it, the first that matches deciding (0.110, CT-706; NS-04): Synology's `error.code`
       * 400 (`refused`), 403 (`two_step`), 407 (`locked`) …, with the person's words. Checked before the token is read.
       * Absent: the server's own reading of the status.
       */
      failures: z.array(SessionFailure).max(12).optional(),
      /**
       * A two-step code asked once (0.111, CT-732; SG-09): what asks for one, where it goes and how Whombat is
       * remembered (`SessionTwoStep`). Absent: a code is never sent, and an answer asking for one is a `failures` rule
       * like any other.
       */
      twoStep: SessionTwoStep.optional(),
    })
    .refine(
      (a) => [a.tokenJsonPath, a.tokenXmlTag, a.tokenCookie].filter((x) => x !== undefined).length === 1,
      {
        message: 'A session reads its token from exactly one of tokenJsonPath, tokenXmlTag and tokenCookie.',
        path: ['tokenJsonPath'],
      },
    ),
]);

export type TokenAuth = z.infer<typeof TokenAuth>;

/**
 * The sign-in methods (CX-10…CX-14), `none` for a Custom MCP server that needs nothing (CX-61), `password`: sign in
 * once with the account's password, and Whombat makes its own key in the service, `client_credentials`: an OAuth
 * client's secret Whombat exchanges for short-lived tokens (Tailscale; CT-314), and `service_login` (0.111, CT-730;
 * Whombat connection-signin.md SG-01): the person signs in on the service's own page in a new tab while the form waits
 * (`connections.startServiceLogin`, `connections.pollServiceLogin`). A connection made that way is stored as the token
 * it gives (`signIn: 'token'`, CT-730), as sign in once's is: a `ConnectionView` never carries `service_login`.
 */
export const SIGN_IN_KINDS = [
  'token',
  'nextcloud_login',
  'ha_oauth',
  'mcp_oauth',
  'app_oauth',
  'none',
  'password',
  'client_credentials',
  'service_login',
] as const;

export const SignInKind = z.enum(SIGN_IN_KINDS);

export type SignInKind = z.infer<typeof SignInKind>;

/** The OAuth sign-ins (`connections.startOAuth`). */
export const OAUTH_SIGN_IN_KINDS = ['ha_oauth', 'mcp_oauth', 'app_oauth'] as const;

export const OAuthSignInKind = z.enum(OAUTH_SIGN_IN_KINDS);

export type OAuthSignInKind = z.infer<typeof OAuthSignInKind>;

/**
 * What agents may do with a connection (CT-314): look only, or manage. Sign in once asks the service for a key at that
 * level where the service can limit one; Whombat itself refuses every write on a connection that looks only, whatever
 * the key could do.
 */
export const CONNECTION_ACCESS_LEVELS = ['read', 'manage'] as const;

export const ConnectionAccessLevel = z.enum(CONNECTION_ACCESS_LEVELS);

export type ConnectionAccessLevel = z.infer<typeof ConnectionAccessLevel>;

export const CONNECTION_ACCESS_LABELS: Record<ConnectionAccessLevel, string> = {
  read: 'Look only',
  manage: 'Manage',
};

/** What each level means when an entry doesn't say (CT-314). */
export const CONNECTION_ACCESS_DEFAULTS: Record<ConnectionAccessLevel, string> = {
  read: 'The agent can see everything the account can, and change nothing.',
  manage: 'The agent can also make changes. Deleting and anything risky still asks you first.',
};

/** A value the person copies into the service while making a token (CT-314): a label and the value (a template). */
export const CatalogStepValue = z.object({
  label: z.string().min(1).max(40),
  value: z.string().min(1).max(300),
});

export type CatalogStepValue = z.infer<typeof CatalogStepValue>;

/** One numbered step of making a token by hand (CT-314), with the values to copy. Templates over the fields. */
export const CatalogStep = z.object({
  text: z.string().min(1).max(300),
  values: z.array(CatalogStepValue).max(4).default([]),
});

export type CatalogStep = z.input<typeof CatalogStep>;

/**
 * What a pasted block or a dropped file holds (CT-314): Proxmox's token dialog, OPNsense's key file. `target` is a
 * field id or `secret`; `pattern` is a regular expression's source with one capture group, matched case-insensitively
 * and per line (`m` flag).
 */
export const CatalogPaste = z.object({
  target: z.string().regex(/^(secret|[a-z][a-zA-Z0-9]{0,31})$/),
  pattern: z.string().min(1).max(300),
});

export type CatalogPaste = z.infer<typeof CatalogPaste>;

export const SignInBase = z.object({
  /** The choice's label when an entry offers several (“Access token”, “Sign in with Home Assistant”). */
  label: z.string().min(1).max(60),
  /** The transport connections made this way use, when it isn't the entry's (Notion's token: `rest`). */
  transport: ConnectionTransport.exclude(['builtin']).optional(),
});

export const CatalogSignIn = z.discriminatedUnion('kind', [
  SignInBase.extend({
    kind: z.literal('token'),
    auth: TokenAuth,
    /** The token field's label and placeholder (“Long-lived access token”). */
    secretLabel: z.string().min(1).max(60),
    secretPlaceholder: z.string().max(80).optional(),
    /** Where to make it, in words, under the field (“Create one in Todoist → Settings → Integrations → Developer.”). */
    secretHelp: z.string().max(300),
    /** Making the token by hand, step by step, with the values to copy (CT-314). Empty: `secretHelp` alone. */
    steps: z.array(CatalogStep).max(8).default([]),
    /** What the person may paste or drop instead of typing each field (CT-314). */
    paste: z.array(CatalogPaste).max(6).default([]),
    /**
     * Where the token is made, per access level, when the service fills its form from the link (Cloudflare's
     * permissions, GitLab's scopes; CT-314). Templates over the fields; absent: the entry's `tokenUrl`.
     */
    links: z.object({ read: z.string().max(1500), manage: z.string().max(1500) }).optional(),
    /**
     * Only how another sign-in's result is kept (Whombat t3code.md T3-02: the token T3 Code gives for a pairing code):
     * the connect form doesn't offer it, and a connection kept this way signs in again with the sign-in that made it.
     */
    storedOnly: z.boolean().optional(),
  }),
  SignInBase.extend({
    kind: z.literal('nextcloud_login'),
    /** `POST <url><startPath>` begins Login Flow v2. */
    startPath: z.literal('/index.php/login/v2'),
  }),
  SignInBase.extend({
    kind: z.literal('ha_oauth'),
    authorizePath: z.literal('/auth/authorize'),
    tokenPath: z.literal('/auth/token'),
  }),
  SignInBase.extend({
    kind: z.literal('mcp_oauth'),
    /** A fixed MCP server (Notion's); absent: the `url` field (Custom MCP). */
    mcpUrl: z.string().url().optional(),
    /**
     * What the sign-in asks for besides what the server itself requires, for a server whose consent page would
     * otherwise offer only its own presets (Cloudflare's Minimal, Read only and Full access): the person sees exactly
     * this list, and Whombat never asks for what it shouldn't have (selling domains, members, tokens). Absent: only the
     * server's own.
     */
    scopes: z.array(z.string().min(1).max(200)).max(60).optional(),
    /**
     * What Whombat never asks for, even when the server asks for more in the middle of a task (step-up): the person
     * does that in the service itself. Cloudflare's registrar, members, API tokens and account settings.
     */
    scopesNever: z.array(z.string().min(1).max(200)).max(40).optional(),
  }),
  SignInBase.extend({
    kind: z.literal('app_oauth'),
    authorizeUrl: z.string().url(),
    tokenUrl: z.string().url(),
    revokeUrl: z.string().url().optional(),
    scopes: z.array(z.string().min(1).max(200)).max(40),
    /** Extra authorize parameters (`token_access_type=offline`). */
    authorizeParams: z.record(z.string(), z.string()).default({}),
    /** The provider takes a PKCE public client: the client secret may stay empty (CX-14). */
    clientSecretOptional: z.boolean(),
    /** Where the app is registered (CX-14, guided like Google). */
    consoleUrl: z.string().url(),
  }),
  SignInBase.extend({ kind: z.literal('none') }),
  SignInBase.extend({
    kind: z.literal('password'),
    /**
     * The account field (CT-314): its label (“Username”, “Email”), placeholder and help; `fixed` when the service only
     * signs in one account (Unraid's `root`), which the form fills and doesn't ask. Null (Whombat t3code.md T3-02): there
     * is no account, the secret alone signs in (T3 Code's pairing code), and a connection made this way signs in again
     * the same way with a new one (`connections.setSecret` runs the sign-in again, T3-03).
     */
    account: z
      .object({
        label: z.string().min(1).max(40),
        placeholder: z.string().max(80).default(''),
        help: z.string().max(300).default(''),
        fixed: z.string().max(80).optional(),
      })
      .nullable(),
    /**
     * The secret's words when it isn't a password (Whombat t3code.md T3-02: “Pairing code”): its label, placeholder and
     * help under the field, and the steps to make one. Absent: the form's own “Password”.
     */
    secret: z
      .object({
        label: z.string().min(1).max(60),
        placeholder: z.string().max(80).optional(),
        help: z.string().max(300),
        steps: z.array(CatalogStep).max(8).default([]),
      })
      .optional(),
    /**
     * A second factor (TOTP): `asked` — the server answers `second_factor_needed` and the form asks for the code then;
     * `optional` — the form offers the code field from the start (the service can't tell a missing code from a wrong
     * password); `never`.
     */
    secondFactor: z.enum(['never', 'asked', 'optional']),
    /** What Whombat makes in the service, in a sentence (“An API token named whombat on your account …”). */
    creates: z.string().min(1).max(300),
    /** The entry's `token` sign-in (by its index among them) the made key is stored as. */
    tokenMethod: z.number().int().min(0).max(3).default(0),
    /** The service limits the key to the level chosen itself (`true`), or only Whombat does (`false`). */
    serviceLimits: z.boolean(),
  }),
  SignInBase.extend({
    kind: z.literal('client_credentials'),
    /** Where the secret is exchanged (`grant_type=client_credentials`) for a short-lived bearer token. */
    tokenUrl: z.string().url(),
    /** The scopes asked per access level. */
    scopes: z.object({
      read: z.array(z.string().min(1).max(100)).max(20),
      manage: z.array(z.string().min(1).max(100)).max(20),
    }),
    /** The secret field's label, placeholder and help (as a token's). */
    secretLabel: z.string().min(1).max(60),
    secretPlaceholder: z.string().max(80).optional(),
    secretHelp: z.string().max(300),
    steps: z.array(CatalogStep).max(8).default([]),
    paste: z.array(CatalogPaste).max(6).default([]),
  }),
  /**
   * Sign in on the service's own page (0.111, CT-730; SG-01…SG-03): Plex's PIN page. The person opens `loginUrl` in a
   * new tab, signs in there however their account does (two-step, Google, Apple, a passkey) and allows Whombat; the
   * form polls until Whombat holds the token. The server has one adapter per catalog id. The result is stored as the
   * entry's `token` sign-in at `tokenMethod` (by its index among them), with `signIn: 'token'`.
   */
  SignInBase.extend({
    kind: z.literal('service_login'),
    /** The radio card's sentence (“Sign in to Plex in a new tab and allow Whombat.”). */
    note: z.string().min(1).max(200),
    /** The entry's `token` sign-in (by its index among them) the result is stored as. */
    tokenMethod: z.number().int().min(0).max(3).default(0),
  }),
]);

export type CatalogSignIn = z.infer<typeof CatalogSignIn>;

export const CATALOG_FIELD_KINDS = ['url', 'text', 'select'] as const;

export const CatalogFieldKind = z.enum(CATALOG_FIELD_KINDS);

export type CatalogFieldKind = z.infer<typeof CatalogFieldKind>;

/** What the person fills in (CX-01). Values are not secret: they are stored and shown. */
export const CatalogField = z.object({
  id: FieldId,
  label: z.string().min(1).max(60),
  placeholder: z.string().max(120).default(''),
  help: z.string().max(300).default(''),
  kind: CatalogFieldKind,
  required: z.boolean(),
  /** Prefilled (GitLab's `https://gitlab.com`). */
  default: z.string().max(CONNECTION_FIELD_VALUE_MAX).optional(),
  /**
   * The value must match (a regular expression's source, whole value), with the message when it doesn't: a `text`
   * field, and since 0.97 (CT-474) a `url` field too, after it is a usable address (TrueNAS's `https://` only).
   */
  validation: z.object({ pattern: Pattern, message: z.string().min(1).max(200) }).optional(),
  /**
   * A `select`'s choices come from the service once the token is checked (Moneybird's administrations): the server
   * picks the only one, or refuses with `field_choice_needed` and the choices (CT-268).
   */
  fromService: z.boolean().optional(),
  /** Only asked with these sign-in methods (Nextcloud's username: only with an app password). Absent: always. */
  methods: z.array(SignInKind).optional(),
  /** A `text` field that becomes the connection's guide for agents (Custom API, CX-62). */
  guide: z.boolean().optional(),
  /**
   * Filled from the check's JSON answer at this path after every check that passes (0.111, CT-737; Whombat
   * connection-signin.md SG-15a: Nextcloud's user id at `ocs.data.id`, which isn't always the login name), never asked:
   * `fieldsFor` leaves it out, so forms hide it and nobody is asked for it (`fieldsFromCheck` reads it). Stored and shown
   * like any field; a value a client sends is kept until the next check replaces it. Not `required`.
   */
  fromCheck: JsonPathText.optional(),
});

export type CatalogField = z.input<typeof CatalogField>;

/** A check's `okJsonPath` (CT-313): a dotted path without `*`. */
export const CheckJsonPath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,9}$/);

/**
 * An answer to a check that says what went wrong (0.111, CT-735; Whombat connection-signin.md SG-11): one of `status`,
 * the body matching `bodyPattern` (case-insensitively; absent: any body), whether it means the credential was refused
 * (`refused`: the connection is marked as needing a new one) or something else is in the way (`false`: the address,
 * the network, the plan), and the person's words. Matched in order, before the server's own reading of the answer
 * (`checkFailure`).
 */
export const CheckFailure = z.object({
  status: HttpStatuses,
  bodyPattern: Pattern.optional(),
  refused: z.boolean(),
  text: z.string().min(1).max(300),
});

export type CheckFailure = z.infer<typeof CheckFailure>;

/**
 * Another request that is the check when the secret matches `pattern` (0.111, CT-736; SG-12; case-insensitively, the
 * first that matches): Mollie's `access_…` tokens are checked with `GET /v2/permissions`, its API keys with the
 * check's own `GET /v2/methods`. `headers` absent: the check's own; `okJsonPath` and `okAnswer` are this request's
 * (absent: not looked at). The check's `failures` still apply (`catalogCheckFor`).
 */
export const CheckForSecret = z.object({
  pattern: Pattern,
  method: z.string().regex(/^[A-Z]{3,10}$/),
  path: z.string().startsWith('/').max(500),
  headers: z.record(z.string(), z.string()).optional(),
  okJsonPath: CheckJsonPath.optional(),
  okAnswer: SessionAnswerMatch.optional(),
});

export type CheckForSecret = z.infer<typeof CheckForSecret>;

/**
 * The one cheap read that proves a credential works (CX-01): a request relative to the base URL (any 2xx is fine
 * unless `okStatus` says otherwise; with `okJsonPath` the answer must also hold that value), MCP `initialize` + `tools/list`, or `reach` (any answer but 401/403/5xx: a Custom
 * API whose root may 404).
 */
export const CatalogCheck = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    method: z.string().regex(/^[A-Z]{3,10}$/),
    path: z.string().startsWith('/').max(500),
    body: z.string().max(2000).optional(),
    headers: z.record(z.string(), z.string()).default({}),
    okStatus: z.array(z.number().int().min(200).max(399)).optional(),
    /**
     * The answer must also hold a value at this dotted path of its JSON (`data.me.name`), or the token was refused:
     * a GraphQL API (Unraid) answers a wrong key 200 with `errors` (CT-313).
     */
    okJsonPath: CheckJsonPath.optional(),
    /**
     * The answer must hold one of these values at a JSON path or in an XML element (0.110, CT-709;
     * `SessionAnswerMatch`): QNAP File Station's `check_sid` answers `{"status": 1}` for a working session and 3 for an
     * ended one, so a value's presence (`okJsonPath`) can't tell. Absent: not looked at.
     */
    okAnswer: SessionAnswerMatch.optional(),
    /**
     * Answers that say what went wrong, in the person's words (0.111, CT-735; SG-11): SABnzbd's plain-text 403s, an
     * NZBHydra2 that answers a wrong key with an empty 404, Plausible's 402. Absent: the server's own reading.
     */
    failures: z.array(CheckFailure).max(8).optional(),
    /** Another request for secrets of another shape (0.111, CT-736; SG-12): Mollie's access tokens. */
    forSecret: z.array(CheckForSecret).max(4).optional(),
  }),
  z.object({ kind: z.literal('mcp') }),
  z.object({ kind: z.literal('reach') }),
  /** A report tracker's check: its driver asks the tracker whether the token works (report-trackers.md). */
  z.object({ kind: z.literal('driver') }),
  /**
   * A socket connection's check (0.97, CT-471; CM-13, CM-17): signs in on the socket, then calls `method` with `params`
   * (absent: none). `version` is where the result holds the service's version for the check line (TrueNAS
   * `system.info` → `version`); absent: a string result, else `result.version`, else what the dialect's first message
   * says (ESPHome's `esphome_version`).
   */
  z.object({
    kind: z.literal('socket'),
    method: z.string().min(1).max(100),
    params: z.union([z.array(JsonValue).max(20), JsonObject]).optional(),
    version: JsonPathText.optional(),
  }),
]);

export type CatalogCheck = z.input<typeof CatalogCheck>;

/** Every value at a dotted path of a JSON answer, `*` taking each element of an array (`data.*.type`; CT-314). */
export function jsonPathValues(json: unknown, path: string): unknown[] {
  let values: unknown[] = [json];
  for (const key of path.split('.')) {
    const next: unknown[] = [];
    for (const v of values) {
      if (key === '*') {
        if (Array.isArray(v)) next.push(...v);
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        const child = (v as Record<string, unknown>)[key];
        if (child !== undefined) next.push(child);
      }
    }
    values = next;
  }
  return values;
}

/** The value at a dotted path of a JSON answer (`data.me.name`), or undefined: a check's `okJsonPath` (CT-313). */
export function jsonPathValue(json: unknown, path: string): unknown {
  let value: unknown = json;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * What a check's answer means in the entry's words (0.111, CT-735; SG-11): the first of the check's `failures` for this
 * status whose `bodyPattern` (if any) the body matches, or null (the server reads the answer as before). `refused`: the
 * credential was refused (the connection needs a new one); false: something else is in the way, the credential is
 * kept.
 */
export function checkFailure(
  check: CatalogCheck | null,
  status: number,
  body: string,
): { refused: boolean; text: string } | null {
  if (check?.kind !== 'request') return null;
  for (const f of check.failures ?? [])
    if (f.status.includes(status) && (!f.bodyPattern || new RegExp(f.bodyPattern, 'i').test(body)))
      return { refused: f.refused, text: f.text };
  return null;
}

/**
 * The check to run for this secret (0.111, CT-736; SG-12): the entry's, or the first of its `forSecret` requests whose
 * pattern the secret matches — that request's method, path and `okJsonPath`/`okAnswer`, its headers or else the check's,
 * the check's `failures`, no body and no `okStatus` (any 2xx). Null for an entry without a check.
 */
export function catalogCheckFor(entry: Pick<CatalogEntry, 'check'>, secret: string): CatalogEntry['check'] {
  const check = entry.check;
  if (check?.kind !== 'request' || !check.forSecret?.length || secret === '') return check;
  const alt = check.forSecret.find((f) => new RegExp(f.pattern, 'i').test(secret));
  if (!alt) return check;
  return {
    kind: 'request',
    method: alt.method,
    path: alt.path,
    headers: alt.headers ?? check.headers,
    ...(alt.okJsonPath !== undefined ? { okJsonPath: alt.okJsonPath } : {}),
    ...(alt.okAnswer !== undefined ? { okAnswer: alt.okAnswer } : {}),
    ...(check.failures !== undefined ? { failures: check.failures } : {}),
  };
}

/** A typed tool a server adapter provides (CX-33, CX-34). `inputSchema` is JSON Schema (an object). */
export const ConnectionToolDef = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  access: ConnectionToolAccess,
  /** Always asks (CX-31), whatever the tiers. */
  sensitive: z.boolean().optional(),
  inputSchema: JsonObject,
});

export type ConnectionToolDef = z.infer<typeof ConnectionToolDef>;

/**
 * A request that reads although its method isn't `GET`/`HEAD` (Notion's `POST /v1/search`). `graphql` (0.91, CT-405): a
 * GraphQL endpoint, where the path alone can't tell: the call reads only when its body is GraphQL queries
 * (`graphqlReadsOnly`), never a mutation or subscription.
 */
export const ReadPath = z.object({
  method: z.string().regex(/^[A-Z]{3,10}$/),
  path: Pattern,
  graphql: z.boolean().optional(),
});

export type ReadPath = z.infer<typeof ReadPath>;

/** Query values (CT-473): a parameter's name and the values that count. Values are compared exactly. */
export const QueryValues = z.object({
  name: QueryName,
  values: z.array(z.string().min(1).max(64)).min(1).max(60),
});

/**
 * A query parameter that decides whether a `request` call reads (0.97, CT-473; CM-18): SABnzbd's `mode` reads with
 * `queue`, `history`, `version` …, unless `writes` holds — another parameter with a value that makes it a write whatever
 * `mode` says (`name=delete`, compared without case).
 */
export const QueryRead = QueryValues.extend({
  writes: z.array(QueryValues).max(4).default([]),
});

export type QueryRead = z.input<typeof QueryRead>;

/**
 * What the generic `request` tool may do (CX-33): paths under the base URL starting with one of `prefixes` (templates
 * over the fields, Moneybird's `/{administration}/`), the methods it takes, which are reads (`readMethods`, default
 * `GET`, `HEAD`; plus `readPaths`), headers Whombat always adds (`Notion-Version`), headers the agent may set besides the
 * Vault's allowlist, and other bases by name (Dropbox's `content`). `alongsideMcp`: offered next to an MCP server's
 * tools (Home Assistant).
 */
export const RequestSpec = z.object({
  prefixes: z.array(z.string().startsWith('/').max(200)).min(1).max(10),
  methods: z
    .array(z.string().regex(/^[A-Z]{3,10}$/))
    .default(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
  readMethods: z.array(z.string().regex(/^[A-Z]{3,10}$/)).default(['GET', 'HEAD']),
  readPaths: z.array(ReadPath).default([]),
  /**
   * Reads by a query parameter (0.97, CT-473; CM-18): SABnzbd and NZBHydra2 do everything with `GET /api?mode=…`.
   * A call that carries one of these parameters reads only when its value is one of `values` and no `writes` parameter
   * of that rule holds one of its values; method and read paths don't decide such a call. Without any of them the
   * method rule decides.
   */
  queryReads: z.array(QueryRead).max(4).default([]),
  headers: z.record(z.string(), z.string()).default({}),
  allowedHeaders: z.array(HeaderName).default([]),
  bases: z.record(z.string().regex(/^[a-z]{1,20}$/), z.string().url()).default({}),
  alongsideMcp: z.boolean().default(false),
});

export type RequestSpec = z.input<typeof RequestSpec>;

/**
 * A rule that makes a call ask whatever the tiers (CX-31). Every condition present must hold: `tools` (globs over the
 * tool's name; `request` for the generic tool, `call` for a socket's), `methods`, `path` and `body` (the `request`
 * tool's method, path and JSON body),
 * `argValue` (a pattern matched against every string anywhere in the arguments, or only in the argument `arg` names).
 * `reason` is the tool's note.
 */
export const SensitiveRule = z.object({
  tools: z.array(z.string().min(1).max(80)).optional(),
  /** A regular expression over the tool's name (`new RegExp(name, 'i')`; CT-311): a server's scripts named for a door. */
  name: Pattern.optional(),
  methods: z.array(z.string().regex(/^[A-Z]{3,10}$/)).optional(),
  path: Pattern.optional(),
  argValue: Pattern.optional(),
  /**
   * The one argument `argValue` tests (0.81, CT-354): a top-level argument's name (`action`), every string inside it.
   * Absent: every string anywhere in the arguments.
   */
  arg: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
    .optional(),
  /**
   * A value in the `request` call's JSON body (0.97, CT-475): at this dotted path, equal to `equals` (a string compared
   * without case, a number, a boolean, null), or any value at all without `equals`. Pi-hole's `{"blocking": false}`,
   * a config change that touches `config.webserver.api`.
   */
  body: z
    .object({
      path: JsonPathText,
      equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    })
    .optional(),
  /**
   * An `argValue` rule that asks even when the call only reads (0.97, CT-476): ESPHome reading `secrets.yaml` with the
   * read `devices/get_config`. Without it a read skips the rules on its arguments (CT-311).
   */
  onReads: z.boolean().optional(),
  reason: z.string().min(1).max(160),
});

export type SensitiveRule = z.infer<typeof SensitiveRule>;

/**
 * One unauthenticated request that recognises a service on the home network (CT-314): the request, and what its answer
 * must show — any of the statuses, a header matching, the body matching (all that are given). `version` says where its
 * version is.
 */
export const DiscoveryProbe = z.object({
  method: z.enum(['GET', 'POST']).default('GET'),
  path: z.string().startsWith('/').max(300),
  body: z.string().max(500).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  status: z.array(z.number().int().min(100).max(599)).optional(),
  header: z.object({ name: HeaderName, pattern: Pattern }).optional(),
  bodyPattern: Pattern.optional(),
  version: z
    .object({ json: JsonPathText.optional(), header: HeaderName.optional(), pattern: Pattern.optional() })
    .optional(),
});

export type DiscoveryProbe = z.input<typeof DiscoveryProbe>;

/**
 * How Whombat finds the service on the home network (CT-314): the ports and the scheme each speaks, and the probes
 * that must all match (the second only where the first leaves it open: UniFi Protect on a UniFi console). A found
 * service's address is `{scheme}://{host}:{port}`, the port left out when it is the scheme's own.
 */
export const CatalogDiscovery = z.object({
  targets: z
    .array(z.object({ port: z.number().int().min(1).max(65535), scheme: z.enum(['https', 'http']) }))
    .min(1)
    .max(6),
  probes: z.array(DiscoveryProbe).min(1).max(2),
});

export type CatalogDiscovery = z.input<typeof CatalogDiscovery>;

/**
 * How a socket connection talks (0.97, CT-471; CM-13…CM-16). One socket per call: open, sign in, send, read, close.
 * `jsonrpc`: JSON-RPC 2.0 (TrueNAS: `{"jsonrpc": "2.0", "id", "method", "params"}` → `result` or `error`); `esphome`:
 * ESPHome Device Builder's commands (`{command, message_id, args}` → `result`, `event`s, `error_code`), whose first
 * message is the server's info.
 */
export const SocketSpec = z.object({
  dialect: z.enum(['jsonrpc', 'esphome']),
  /** The socket's path from the base (`/api/current`, `/ws`); `ws:` from `http:`, `wss:` from `https:`. */
  path: z.string().startsWith('/').max(200),
  /**
   * Signing in on the socket once it opens: the method and its params (templates over `{secret}` and the fields, inside
   * strings of an array or object). `asked`: only when the server's first message asks (ESPHome's `requires_auth`);
   * `always`: right away (TrueNAS). Null: never (a `none` sign-in skips it too).
   */
  login: z
    .object({ method: z.string().min(1).max(100), params: JsonValue, when: z.enum(['always', 'asked']) })
    .nullable(),
  /** Methods that read (patterns over the method's whole name, without case). Anything else is a write. */
  reads: z.array(Pattern).max(40),
  /** Methods that stream events until their result (ESPHome's `devices/logs`): bounded by the call's `seconds`. */
  streams: z.array(Pattern).max(20).default([]),
  /** Methods never sent, whatever the tiers (signing in again, subscriptions that never end, internals). */
  refused: z.array(Pattern).max(20).default([]),
  /**
   * What the check says when the socket isn't there (a 404 or a refused upgrade at `path`): the service is older than
   * this connection needs (“This TrueNAS is older than 25.04: update it, then connect it.”).
   */
  missing: z.string().min(1).max(300),
});

export type SocketSpec = z.input<typeof SocketSpec>;

/**
 * Who uses an entry's connections (0.69, CT-325; Whombat report-trackers.md TA-02): agents, only automations, or (0.76, CT-332; Whombat ai-gateway.md AIG-01) the Claude Code and ChatGPT turns themselves: a
 * `gateway` entry (Fusebox, another AI gateway) carries their traffic while it is switched on.
 */
export const CATALOG_USES = ['agents', 'automations', 'gateway'] as const;

export const CatalogUse = z.enum(CATALOG_USES);

export type CatalogUse = z.infer<typeof CatalogUse>;

/** A tagline's length (0.110, CT-702; DF-08). */
export const CATALOG_TAGLINE_MAX = 40;

export const CatalogEntry = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  name: z.string().min(1).max(40),
  category: CatalogCategory,
  /** One line, the tile's. */
  description: z.string().min(1).max(140),
  /**
   * What it is to a person, in at most 40 characters and no full stop (0.110, CT-702; Whombat desk-found.md DF-08):
   * “Lights, heating and sensors”. Shown on the desk's found panel and the website's Found on your network; every entry
   * with `discovery` has one.
   */
  tagline: z
    .string()
    .min(1)
    .max(CATALOG_TAGLINE_MAX)
    .regex(/^[^\n]*[^.\s]$/)
    .optional(),
  /**
   * Who uses its connections (0.69, CT-325, TA-02); absent: `agents`. An `automations` entry (a tracker's token writes
   * what customers are emailed about) is never listed or callable through `connection_tools` / `connection_call`, never
   * one of an agent's connections (`DispatchConnection`) and looked after by nobody: automations read it, and the
   * connection page says “Used by automations” instead of the agents' access lines (`isAgentConnection`). A `gateway`
   * entry (0.76, AIG-01) is the same to agents; its page shows the burrow's switches (`Burrow.aiGateway`) instead, and a
   * burrow has at most one gateway connection (`isGatewayConnection`).
   */
  use: CatalogUse.optional(),
  /** In the order the form offers them; the first is the default. Empty for builtins. */
  signIn: z.array(CatalogSignIn).max(4),
  fields: z.array(CatalogField).max(8),
  transport: ConnectionTransport,
  /** The API's base, a template over the fields (`{url}`) or fixed. Null for builtins. */
  baseUrl: z.string().max(300).nullable(),
  /** Where the MCP server is, relative to the base (`/api/mcp`, `''` for the base itself). */
  mcpPath: z.string().max(200).nullable(),
  /** When the MCP server isn't there (404), what the check says; the connection still works through `request`. */
  mcpMissingHint: z.string().max(300).nullable(),
  /**
   * How Whombat turns a missing MCP server on itself (CX-54a, CT-310), as the connection, before falling back to
   * `mcpMissingHint`: `ha_config_flow` adds the Home Assistant integration `handler` through its config flow API
   * (`POST /api/config/config_entries/flow`; an administrator's token). Null: Whombat doesn't.
   */
  mcpSetup: z
    .object({ kind: z.literal('ha_config_flow'), handler: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) })
    .nullable()
    .default(null),
  /** What the check says when the MCP server answers (CX-54a): what agents see through it. Null: “Working”. */
  mcpReadyNote: z.string().max(300).nullable().default(null),
  /**
   * How Whombat serves the MCP server's tools where the server's own list says too little (Whombat t3code.md T3-04):
   * `hidden`, tools never served (whole names, or patterns over them: T3 Code's tools that only work inside its own
   * threads); `reads`, tools that read although the server doesn't mark them `readOnlyHint` — every call (`arg`
   * absent: T3's `t3_thread_read`), or only a call whose argument `arg` is one of `values` (`t3_pending_request` with
   * `action` `list` or `read`; `callAccess`). Null: the server's list as it is.
   */
  mcpTools: z
    .object({
      hidden: z.array(Pattern).max(40).default([]),
      reads: z
        .array(
          z.object({
            name: Pattern,
            arg: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
              .optional(),
            values: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
          }),
        )
        .max(20)
        .default([]),
    })
    .nullable()
    .default(null),
  check: CatalogCheck.nullable(),
  /** At most 64 (0.83, CT-366: the Servers connection has 50 since 0.84; 48 since 0.81, CT-355). */
  tools: z.array(ConnectionToolDef).max(64),
  request: RequestSpec.nullable(),
  /** A socket connection's spec (0.97, CT-471; CM-13): `transport: 'socket'` entries, with `request: null`. */
  socket: SocketSpec.nullable().default(null),
  /** Notes for agents (≤ 1 500 characters): what the API is and how to use it. */
  guide: z.string().max(CONNECTION_GUIDE_MAX),
  sensitive: z.array(SensitiveRule).max(20),
  /**
   * Changes where one wrong value can cut the person off — DNS, DHCP, firewalls, networks, where a site points — in the
   * same shape as `sensitive`. An outsiders' run (an automation started by an email) can never propose them; the
   * person's own calls run at the tool's setting as before.
   */
  cutsOff: z.array(SensitiveRule).max(20).default([]),
  docsUrl: z.string().url().nullable(),
  /** Where a person makes a token (a template over the fields for self-hosted services), or null. */
  tokenUrl: z.string().max(300).nullable(),
  /** The short handle agents use (CX-05), before `-2`, `-3`. */
  handle: ConnectionHandle,
  /** What Look only and Manage mean for this service (CT-314); null: `CONNECTION_ACCESS_DEFAULTS`. */
  access: z
    .object({ read: z.string().max(300), manage: z.string().max(300) })
    .nullable()
    .default(null),
  /** How to find it on the home network (CT-314); null for cloud services. */
  discovery: CatalogDiscovery.nullable().default(null),
  /**
   * A machine Whombat looks after best as a server (Whombat connect-in-chat.md): its helper on it sees everything the
   * API shows and more, without a sign-in key. Found on your network and the connect page offer “Add as a server” first;
   * connecting it here stays possible.
   */
  asServer: z.boolean().default(false),
});

export type CatalogEntry = z.output<typeof CatalogEntry>;

export type CatalogEntryInput = z.input<typeof CatalogEntry>;

/* ---------------------------------------------------------------------------------------------- */
/* Neutral typed tools (CX-34)                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export const str = (description: string, extra: Record<string, JsonValue> = {}): JsonObject => ({
  type: 'string',
  description,
  ...extra,
});

export const obj = (properties: Record<string, JsonValue>, required: string[] = []): JsonObject => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** `files_*` (Dropbox, Nextcloud): paths start with `/`, from the root of the account's files. */
export const FILES_TOOLS: readonly ConnectionToolDef[] = [
  {
    name: 'files_list',
    title: 'List a folder',
    description: 'List the files and folders in a folder (name, path, folder or file, size, modified).',
    access: 'read',
    inputSchema: obj({ path: str('The folder, from the root: / or /Documents/Invoices', { default: '/' }) }),
  },
  {
    name: 'files_search',
    title: 'Search files',
    description: 'Find files and folders whose name (and, where the service can, content) matches the words.',
    access: 'read',
    inputSchema: obj({ query: str('Words to look for'), path: str('Only inside this folder (optional)') }, [
      'query',
    ]),
  },
  {
    name: 'files_read',
    title: 'Read a file',
    description:
      'Read a text file (at most 64 KB). A binary file (a PDF, an image) answers its type and size instead.',
    access: 'read',
    inputSchema: obj({ path: str('The file, from the root: /Notes/todo.md') }, ['path']),
  },
  {
    name: 'files_write',
    title: 'Write a file',
    description: 'Create a text file, or replace it when overwrite is true. Folders on the way are made.',
    access: 'write',
    inputSchema: obj(
      {
        path: str('The file, from the root: /Notes/todo.md'),
        content: str('The text to write'),
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing file (default false)',
          default: false,
        },
      },
      ['path', 'content'],
    ),
  },
  {
    name: 'files_move',
    title: 'Move or rename',
    description: 'Move or rename a file or folder.',
    access: 'write',
    inputSchema: obj({ from: str('Where it is now'), to: str('Where it goes, with its name') }, [
      'from',
      'to',
    ]),
  },
  {
    name: 'files_delete',
    title: 'Delete',
    description:
      'Delete a file or folder (the service may keep it in its trash for a while). Always asks a person.',
    access: 'write',
    sensitive: true,
    inputSchema: obj({ path: str('The file or folder') }, ['path']),
  },
];

export const int = (description: string, extra: Record<string, JsonValue> = {}): JsonObject => ({
  type: 'integer',
  description,
  ...extra,
});

/** The generic tool of every entry with a `request` spec (CX-33). */
export const REQUEST_TOOL_NAME = 'request';

/**
 * The one tool of every socket connection (0.97, CT-472; CM-14), like `request` for REST: `{method, params?, seconds?}`
 * (`params` positional for JSON-RPC, ESPHome's args object; `seconds` only for a streaming method).
 */
export const SOCKET_TOOL_NAME = 'call';

/** How long a streaming socket method is read when the call doesn't say, and at most (CM-14). */
export const SOCKET_STREAM_SECONDS_DEFAULT = 10;

export const SOCKET_STREAM_SECONDS_MAX = 25;

/** How long opening a socket may take (CM-15); the whole call has `CONNECTION_CALL_DEADLINE_MS`. */
export const SOCKET_CONNECT_DEADLINE_MS = 10_000;

/* ---------------------------------------------------------------------------------------------- */
/* The catalog (CX-50…CX-62)                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export const BEARER = { type: 'bearer' } as const;

export const DELETES_ASK: SensitiveRule = { methods: ['DELETE'], reason: 'Deletes something' };

export const urlField = (
  placeholder: string,
  help: string,
  extra: Partial<CatalogField> = {},
): CatalogField => ({
  id: 'url',
  label: 'Address',
  placeholder,
  help,
  kind: 'url',
  required: true,
  ...extra,
});

/**
 * A self-signed certificate on the home network, pinned by its SHA-256 fingerprint (CX-60; `id` is what the server
 * pins). Left empty, a check that meets an unverifiable certificate answers the one the server presents (CT-313).
 */
export const certificateField = (where: string): CatalogField => ({
  id: 'fingerprint',
  label: 'Certificate fingerprint',
  placeholder: 'AB:CD:…',
  kind: 'text',
  required: false,
  help: `For a self-signed certificate on your network: its SHA-256 fingerprint (${where}). Left empty, Whombat trusts the one it finds on your network.`,
  validation: {
    pattern: '^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$',
    message: 'Paste the SHA-256 fingerprint: 32 pairs like AB:CD separated by colons.',
  },
});

export const builtin = (
  id: string,
  name: string,
  category: CatalogCategory,
  description: string,
  docsUrl: string | null,
): CatalogEntryInput => ({
  id,
  name,
  category,
  description,
  signIn: [],
  fields: [],
  transport: 'builtin',
  baseUrl: null,
  mcpPath: null,
  mcpMissingHint: null,
  check: null,
  tools: [],
  request: null,
  guide: '',
  sensitive: [],
  docsUrl,
  tokenUrl: null,
  handle: id,
});

/**
 * What asks a person on Sonarr and Radarr (0.121, CT-1009; Whombat service-dashboards.md SD-S07): deleting anything,
 * changing settings (indexers, download clients, profiles, root folders, lists, notifications), reading the security
 * settings (they hold the API key), resetting the key, installing an update, restarting, shutting down or restoring a
 * backup. Commands (`POST /api/v3/command`: searches, refreshes, RSS sync) don't.
 */
export const arrSensitive = (app: string): SensitiveRule[] => [
  DELETES_ASK,
  {
    tools: [REQUEST_TOOL_NAME],
    methods: ['POST', 'PUT', 'PATCH'],
    path: '^/api/v3/(config|indexer|downloadclient|notification|importlist|importlistexclusion|rootfolder|qualityprofile|qualitydefinition|delayprofile|releaseprofile|restriction|customformat|remotepathmapping|metadata|autotagging|languageprofile|tag)(/|$)',
    reason: `Changes ${app}’s settings`,
  },
  {
    tools: [REQUEST_TOOL_NAME],
    path: '^/api/v3/config/host(/|$)',
    reason: `Reads ${app}’s security settings, which hold its API key`,
  },
  {
    tools: [REQUEST_TOOL_NAME],
    methods: ['POST', 'PUT'],
    path: '^/api/v3/system/(restart|shutdown|backup/restore)',
    reason: `Restarts ${app}, shuts it down or restores a backup`,
  },
  {
    tools: [REQUEST_TOOL_NAME],
    methods: ['POST'],
    path: '^/api/v3/command/?$',
    body: { path: 'name', equals: 'ApplicationUpdate' },
    reason: `Installs an update, which restarts ${app}`,
  },
  {
    tools: [REQUEST_TOOL_NAME],
    methods: ['POST'],
    path: '^/api/v3/command/?$',
    body: { path: 'name', equals: 'ResetApiKey' },
    reason: 'Makes a new API key, which stops this connection',
  },
];
