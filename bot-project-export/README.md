# WNM Roblox Access Ranking Bot

Node.js 18.17+ · discord.js v14 · SQLite (better-sqlite3) · Express dashboard.

## Setup
1. `npm install`, copy `.env.example` to `.env`, fill it in.
2. Discord Developer Portal → Bot → enable **Server Members** and **Message Content** intents.
3. Invite the bot with **Manage Roles**. In Server Settings → Roles, drag the bot's role **above all five access roles**.
4. Dashboard login: add `DASHBOARD_URL/callback` as an OAuth2 redirect in the Developer Portal.
5. Roblox rank changes: create an Open Cloud API key (create.roblox.com → Credentials) with **group membership write** access to group 921240375. The key owner must hold a group rank above the five access roles. Without a key, everything else works and rank changes are reported as unavailable.
6. `npm start`. Mount a persistent volume at `DATA_DIR` when hosting (the database and backups live there).

## Permission levels
Staff (`STAFF_ROLE_IDS`) → Admin (`ADMIN_ROLE_IDS` or Discord Administrator) → Owner (`OWNER_IDS`). Checked before any command runs. Dashboard owner actions also need `OWNER_PIN`.

## Behavior notes
- Shirt-based checks inspect every configured access shirt; API failures abort those checks without role or rank changes. Staff-approved manual access can still sync when inventory is unavailable.
- Highest tier wins; only the configured access roles are ever added/removed.
- Group rank is never changed for members whose current group role is ranked above your highest access role (protects staff/owner ranks), and only after Roblox confirms.
- "No shirts" policy (`.setpolicy`, default `keep`): keep or remove existing access. Staff-approved access is kept regardless.
- Audit table is append-only (database triggers block UPDATE/DELETE). Backups every 6 hours, last 14 kept.

## Roblox profile commands
- `.info <Roblox username or user ID>` shows the Roblox profile, group rank, currently worn classic pants/shirt/T-shirt, and ownership of each configured access shirt. It is read-only; an unavailable/private inventory is reported as unavailable rather than shown as unowned.
- `.mverify <@Discord user or ID> <Roblox username>` manually links an account for staff. It requires the configured staff permission, refuses accounts that are already linked, records the staff action in the audit log, and runs the normal access sync. This is a manual association and does **not** prove the Discord member owns the Roblox account; use `.verify` for ownership proof.
- `.rank <@Discord user or ID> <tier> [reason]` lets staff grant a linked member a staff-approved tier without shirt ownership. `.rank <@Discord user>` still performs a normal recheck. Manual grants sync the configured Discord role and, when the Open Cloud key is configured, the Roblox group rank; they are recorded in the audit log.

## Pre-launch tests (spec §15) — run these on your server
- Test accounts owning: nothing, Bronze only, Silver+Gold (expect Gold only), all five (expect Elite only).
- **Private-inventory account**: confirm `.rank` reports an error and changes nothing. If Roblox ever answers "false" for a private inventory, that would look like "owns nothing" — this is the one behavior to verify with a real account.
- Confirm the Open Cloud rank change works for each of the five group role IDs.
- Restart the bot and confirm tiers/links persist; try staff commands as a normal member.
