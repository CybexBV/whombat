# Agent outcomes — app 0.34.0

- Settings → About you shows preference confidence, confirmation and expiry. The owner can correct, confirm, expire or delete entries. Expiry dates use the viewer’s local day.
- Settings → Connections adds Microsoft 365 app setup and personal consent, reconnect, service checks and disconnect. State stays on the chosen provider through the managed OAuth callback. Native Word/Excel editing and Microsoft-wide consent revocation are not advertised.
- Skill rows show declared prerequisites and reported outcomes, keeping them distinct from independent verification.
- These extensions have no dedicated HTML mock; use the existing Settings cards, tokens, inputs and provider page structure in both themes.
