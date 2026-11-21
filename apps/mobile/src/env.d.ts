/** Metro embeds the browser runtime as a data URL for the confined WebView. */
declare module 'mermaid/dist/mermaid.min.js' {
  const url: string;
  export default url;
}

/** The page set viewer's script, a data URL the same way (preview-runtime.cjs). */
declare module '@whombat/client/pages/pages-runtime.js' {
  const url: string;
  export default url;
}

// Expo inlines `process.env.EXPO_PUBLIC_*` at build time.
declare namespace NodeJS {
  interface ProcessEnv {
    /** Debug builds: run the on-device secure-session harness against this host (AP-25). */
    EXPO_PUBLIC_WHOMBAT_HARNESS_URL?: string;
    /** `fixtures`: a demo build, the demo world on an in-memory box (screenshots without a Whombat). */
    EXPO_PUBLIC_WHOMBAT_MODE?: string;
    /** `1`: the demo world also has the agent's rich messages in PR #482's room (`fixtures/rich.ts`). */
    EXPO_PUBLIC_WHOMBAT_RICH?: string;
    /** `1`: the demo world also has the settled-cards thread in #incidents (`fixtures/settle.ts`, AP-730…AP-735). */
    EXPO_PUBLIC_WHOMBAT_SETTLE?: string;
    /** `1`: the demo world's Chat also has tonight's server work with its task cards (`fixtures/chatChannel.ts`, AP-4306). */
    EXPO_PUBLIC_WHOMBAT_TASKS?: string;
    /** `1`: the demo world's Chat also has councils Neo leads, live and finished (`fixtures/council.ts`, council.md). */
    EXPO_PUBLIC_WHOMBAT_COUNCIL?: string;
    /**
     * `1`: the demo world's Chat also has software work in its threads, one in each state of a row's work line, with
     * T3 Code's jobs; `jobs` adds a job in every state of the thread's job view (`fixtures/code.ts`).
     */
    EXPO_PUBLIC_WHOMBAT_CODE?: string;
    /**
     * `offer`, `working` or `done`: the demo world's Chat also has a delegation Neo offers, at that stage — the checklist
     * waiting, the tasks at work in T3 Code, or ended (`fixtures/delegation.ts`, delegate.md).
     */
    EXPO_PUBLIC_WHOMBAT_DELEGATION?: string;
    /**
     * Settings → Neo → Council in the demo world (`fixtures/councilSetups.ts`): `none` starts with no council set,
     * `not_connected` or `unreachable` without T3 Code's choices; unset, Mara's council with the choices.
     */
    EXPO_PUBLIC_WHOMBAT_COUNCIL_SETUPS?: string;
    /**
     * `1`: the demo world's Chat also has the sign-in cards (prod-1's three ways, github.com's code) and its Vault the
     * login with its authenticator key and prod-1's kept password (`fixtures/chatChannel.ts`, AP-6680).
     */
    EXPO_PUBLIC_WHOMBAT_SIGNIN?: string;
    /**
     * `1`: the demo world lists the service pages (Plex, Seerr, SABnzbd, Protect, Pi-hole) on Home and Connections
     * (`fixtures/thingPages.ts`, service-dashboards.md AP-4660); their pages open by address either way.
     */
    EXPO_PUBLIC_WHOMBAT_SERVICES?: string;
    /**
     * `1`: the demo world's burrow has a model on its network, Llama on the NAS (`fixtures/localModel.ts`,
     * hermes-engine-app.md AP-5126): Settings → AI's section, Local in Model and AI and the Chat picker.
     */
    EXPO_PUBLIC_WHOMBAT_LOCAL_MODEL?: string;
    /**
     * `1`: the demo world's burrow has web search with a Brave Search key (`fixtures/webSearch.ts`, Whombat
     * web-search.md): Settings → AI's Web search section is on.
     */
    EXPO_PUBLIC_WHOMBAT_WEB_SEARCH?: string;
    /** `1` lets release builds talk plain HTTP (local servers). */
    EXPO_PUBLIC_ALLOW_INSECURE_HTTP?: string;
    /** control's origin (default `https://api.whombat.com`). */
    EXPO_PUBLIC_WHOMBAT_CONTROL_URL?: string;
    /**
     * The hosted UI's origin(s), comma-separated — magic links `<ui>/auth/verify#token=…` open the app
     * (default `https://app.whombat.com`). Also read by app.config.cjs for the Android intent filter.
     */
    EXPO_PUBLIC_WHOMBAT_UI_URL?: string;
    /**
     * Test builds only: without Firebase, register a `dev-relay:` FCM token and accept pushes injected with adb
     * (`scripts/push.mjs`). Never set for a shipped build.
     */
    EXPO_PUBLIC_WHOMBAT_PUSH_RELAY?: string;
  }
}

/** The avatars' SVG files: their markup, verbatim (metro-svg-transformer.cjs, FA-09). */
declare module '@whombat/avatars/svg/*' {
  const xml: string;
  export default xml;
}
