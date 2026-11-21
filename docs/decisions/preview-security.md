# Preview isolation and browser sign-out

Security review, 2026-11-01.

| # | Decision | Why |
|---|---|---|
| PRS-01 | **Preview resources are embedded or bundled.** `PAGE_POLICY` permits inline scripts and styles, data URLs, blob images and media, and the web's own runtime scripts. It permits no remote scripts, styles, fonts, images or media. The web parent's `frame-src 'self'` also prevents external frame navigation; the phone refuses navigation after loading its HTML string. `page_preview` intercepts requests offline even when the agent may browse. Agents receive these constraints in `PAGE_GUIDE`. | `connect-src 'none'` alone does not prevent a page from sending its contents out in an image or script URL. Inline interactive pages still work; remote assets must be embedded. |
| PRS-02 | **The phone bundles Mermaid as a data URL.** Metro turns the installed runtime into a string module; only the confined WebView executes it. Supersedes VR-08's CDN runtime and VR-09's online page check. | Diagrams keep drawing without allowing arbitrary HTTPS scripts or requiring internet access. |
| PRS-03 | **The box's web sign-out deletes this origin's personal endpoint key before reopening enrollment.** It marks its appliance records unenrolled, unmounts the active session, and broadcasts deletion so other box tabs close their sessions too. Failed deletion shows an explicit retry screen. The screen endpoint key and the pinned box identity stay. New-key creation is transactional across tabs. | An unenrolled registry flag alone left a usable credential in IndexedDB. This is local credential removal; it preserves the server's last-device enrollment safeguard and does not revoke another device. |
