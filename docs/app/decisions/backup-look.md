# Bringing things back from a backup in the apps (AP-6940…AP-6955)

John, 2026-11-04: get back one thing from a backup's page (Whombat [backup-look.md](../../decisions/backup-look.md)
BKO-40…BKO-49). No mock: the flow follows the backup's page it starts from (app [backup-options.md](backup-options.md)
AP-6804, phone AP-6856). Words and the view model are `@whombat/client/managed` backup-look (`BACKUP_LOOK_TEXT`,
`lookStage`, `lookCategoryRows`, `lookItemMeta`, `lookDoneLine`, `togglePick`); the hooks are `@whombat/client/react`
backupLook (`useBackupLook`, `useBackupLookItems`, `useBringBack`).

| ID | Decision | Why |
|---|---|---|
| AP-6940 | **One entry on a backup's page:** the primary “Bring things back from this backup” below Check this backup now (web `BackupDetail`, phone `BackupDetailScreen`), where the backup's page leaves room for it. The flow is its own Modal over the page on the web (`BringBack.tsx`) and its own screen on the phone (`BackupBringBack`, never restored after a restart). | The backup's page is where the person already is when they look for something old; the rest of the Backups pages stay as they are. |
| AP-6941 | **The flow:** the backup opening, which says so (“Opening this backup…”, it takes a minute, nothing here changes) → WHAT’S IN IT, the categories with how many things each has, each a row button → a category: a search field, its things as tick rows (the title; “Yesterday · In Chat · 4 replies”; “Already here” in ok) and Show more → “Bring back N things” (disabled with nothing ticked; “Bringing them back…” while it runs) → the done line (“3 things are back. 1 was already here.”) with Bring back more and Close. | The spec's steps, each one screenful. |
| AP-6942 | **Ticks stay across categories** (a chat and its file together); Bring back more starts again at WHAT’S IN IT with nothing ticked. | One bring-back can hold things of several kinds. |
| AP-6943 | **When it can't open**, the box's sentence (no room with the sizes, busy, not yet on this Whombat, not there) with Try again (not when this Whombat can't do it yet) and Close. | The box words its refusals (BKO-48). |
| AP-6944 | **The backup opens when the flow starts and closes when it ends** (`useBackupLook`: `backup.look` once, then `backup.lookContents` every 1.5 s while it opens or brings something back; `backup.lookClose` when the flow is left). | A backup open for reading takes room on the box: it closes as soon as nobody looks. |
| AP-6945 | **Accessibility:** categories are buttons, things are real checkboxes (web `<label>`s; phone `accessibilityRole="checkbox"` with its state and one label of title, when and “Already here”), rows 56dp and buttons 52dp on the phone, the opening and done lines live regions. | The repository's rules: real controls, labels, 44px targets. |
| AP-6946 | **The fake** (`createFakeBackupLook`, `@whombat/client/fake`) is shared by the web's fixture mode, its fake managed world and the phone's demo: a backup that opens after a moment and holds three chats (one about the roof that isn't here), a file and an automation; what is picked comes back, and what is here is said so. | Screens and tests drive the same world on both apps. |
| AP-6950 | **The phone's screen** follows the backup's page: the back bar says where it goes (WHAT’S IN IT from a category, else Close), the categories are a Card of LinkRows, the things a Card of tick rows, the search the forms' field. | The phone's own components, the web's words. |
