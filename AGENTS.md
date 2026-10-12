# Notes for coding agents working on PawsConnect

Read this before changing anything. It records what was done to this codebase after its first draft, what is true about it now, and the mistakes that have already been made once.

Current state and what is verified: [docs/STATUS.md](docs/STATUS.md). Setup and deployment: [README.md](README.md).

## What this is

A pet shelter platform for Rowena's Paw Shelter (Bulacan, Philippines): pet supplies store, adoption with compatibility matching, stray rescue reporting, shelter pet transport, donations, volunteers, and a staff workspace.

- `client/` React 19, TypeScript, Vite, hand-written CSS classes (Tailwind 4 is loaded but used only by `components/ui`).
- `server/` Express 5, TypeScript ES modules, Zod. Talks to Supabase with the service role.
- `supabase/migrations/` Postgres schema, RLS, and workflow functions. PostGIS for service zones.
- `api/index.ts` wraps the Express app as one Vercel function.
- `tests/` Vitest (unit, API, database on in-process Postgres) and Playwright.

Live at https://pawsconnect-one.vercel.app. Repository: https://github.com/seyjeyyy/pawsconnect.

## History you need to know

The first draft was written quickly, with client, server and SQL produced separately and never run together. A second pass wired it up, ran it, and fixed what broke. The lessons from that pass are the most useful thing in this file:

1. **The client and the API disagreed on field names in many places.** Checkout, adoption, transport, volunteer and contact forms all sent fields the API's strict Zod schemas rejected. When you add or change a form, read the route's schema and send exactly those keys.
2. **The API named database things that did not exist or were ambiguous.** A missing function (`adjust_inventory`), a wrong column (`customer_reviews.comment`, it is `body`), and embeds that fail at runtime because two foreign keys link the tables (`profiles` to `user_roles`, `volunteer_profiles` to `profiles`). `tests/database/contract.test.ts` now checks every table, column, function and embedded relationship the server names against the migrated schema. Keep it passing; when it fails it is telling you about a real runtime error.
3. **Privileged SQL functions were callable by any signed-in user.** Supabase grants `EXECUTE` on new functions in `public` to `anon` and `authenticated` by name, so revoking from `PUBLIC` is not enough. Migration `202610100006` revokes it properly. Any new function must be closed to clients unless it is deliberately public; `tests/database/foundation.test.ts` holds the allow-list.
4. **The matching engine and the database used different field names** for behaviour profiles. `behaviorFromRow` in `server/src/modules/matchmaking/engine.ts` translates. Store profiles in the database's terms.
5. **`queryClient.clear()` on mount left every page stuck loading.** `AuthContext` now resets queries only when the signed-in user changes.

## What was changed after the first draft

In rough order:

- Added the server entry points, `App.tsx`, the entire stylesheet (`client/src/styles.css`, `client/src/pages/features.css`), and the pages the footer linked to.
- Fixed the items in the list above, plus corrupted characters in `Services.tsx`, broken JSX in `Adoption.tsx`, a quiz that submitted on step 3, and public exposure of unapproved reviews.
- Added migrations 6 (function privileges), 7 (`adjust_inventory`) and 8 (Stripe provider label).
- **Payments: PayMongo replaced by Stripe Checkout.** `server/src/integrations/stripe.ts`, webhook at `POST /api/webhooks/stripe`. An order, donation, transport fee or adoption fee is marked paid only by a signature-verified webhook, after re-reading the session from Stripe. Never mark anything paid from a redirect or from request data.
- **Maps: Google Maps replaced by Leaflet and OpenStreetMap.** `client/src/components/LocationPicker.tsx`; server-side Nominatim (address search) and OSRM (routing) behind `MapProvider` in `server/src/integrations/maps.ts`. No API key. The public services are for light use, so geocoding is throttled and rate-limited.
- Deployed to Vercel as a single project (`vercel.json`, `api/`).
- A scheduled job (`server/src/jobs/scheduler.ts`) releases expired reservations when the API runs as a long-lived process. On Vercel that role is filled by `pg_cron` in the database.
- Guided tour (`client/src/components/tour/`), show-password toggles.
- **Role-based dashboards and API access** (next section).
- Sidebar menus grouped by category (`client/src/components/GroupedNav.tsx`).
- Demo data added to the live database (see "Live data").

### Second pass: everything from the database (2026-10-11)

Migrations 009 to 013, applied to the live database and verified there.

- **No sample data in production paths.** The built-in sample catalog and matchmaking fallback are gone. Without Supabase the API answers "unavailable" and the pages say so. Sample fixtures live only under `tests/fixtures/`.
- **Persisted customer state:** server-side cart, saved pets (`favorite_pets`), inquiries with staff replies, refund requests. `GET /api/account/summary` and `GET /api/account/records/:kind` (`server/src/modules/users/connected.ts`) serve every account list, always filtered by the signed-in user.
- **Uploads:** `client/src/components/UploadField.tsx` with signed upload and read URLs. The `rescue-evidence` and `adoption-documents` buckets are private; only the owner and staff get a short-lived link.
- **Workspace pickers:** `GET /api/admin/lookups/:kind` supplies people, vehicles and pets, so forms no longer need pasted ids. Staff forms for interviews, rescue assignment, behaviour assessments and volunteer tasks.
- **Realtime:** `client/src/contexts/SyncContext.tsx` subscribes to the user's own `notifications` rows and refetches open queries; polling every 30 seconds is the fallback. Workflow functions and triggers write the notification; row payloads of other tables are never broadcast.
- **Super administrator and security monitoring:** see "Roles" and "Security events" below.
- **Direct staff writes are closed.** `authenticated` can no longer insert, update or delete catalog, pet or zone rows through Supabase directly; every change goes through the API. Public reads no longer expose `cost_centavos` or behaviour-profile notes.
- **Money is reported from live-mode payments only.** `payment_transactions.livemode` is set from the Stripe key in use. `admin_metrics` excludes test payments from every revenue figure and counts them separately as `test_payments`. With a test key, revenue is correctly zero.
- Browser tests start their own preview-mode servers (`tests/helpers/start-e2e.mjs`) and never touch a configured database.
- `tests/database/upgrade.test.ts` applies new migrations on top of a populated database at the previous version. Extend it when you add a migration that touches existing rows.

## Roles

Every registered account holds the four community roles (buyer, adopter, donor, community_reporter). Privileged roles are granted only by an administrator through `assign_user_role`.

| Role | Lands on | Can reach |
| --- | --- | --- |
| super_administrator | `/admin/security` | System administration only: accounts and access, audit trail, security events and alerts, elevated-access requests. No shelter routes. |
| administrator | `/admin/overview` | Shelter operations only. No accounts, audit trail or security. Has a few approvals staff lack (adoption decisions, service zones). |
| shelter_staff | `/admin/overview` | Shelter operations |
| veterinarian | `/admin/pets` | Pets, health records |
| rescue_personnel | `/admin/rescue` | Rescue reports assigned to them |
| shelter_driver | `/admin/transport` | Transport requests assigned to them |
| volunteer | `/account` | Customer pages, volunteer tasks, rescues assigned to them |
| community roles | `/account` | Their own records |

Two places define this and they must agree:

- `client/src/lib/roles.ts` decides which screens and menu items appear.
- `workspaceAccess` in `server/src/modules/analytics/admin.ts` decides what the API allows. It is the one that matters for security. `tests/api/workspace-access.test.ts` covers each role.

The server uses the service role, which bypasses RLS. Every query for a user's own data must filter by the actor's id in code; RLS is a second line of defence, not the first.

**System administration and shelter operations are separate, and neither role implies the other** (migration 014). `has_role` means exactly the roles asked for; `authorize` has no implication; `isStaff` is administrator and shelter staff only; `isSystemAdministrator` is the super administrator. In `workspaceAccess`, the `systemAccess` list is reachable only by the super administrator and is all the super administrator can reach. Do not reintroduce "the super administrator can do everything": it was removed on purpose.

Roles are assigned only by the super administrator. Granting or removing `administrator` or `super_administrator` cannot be done directly even by them: one super administrator files a request (`critical_approvals`) and a different super administrator decides it, so it needs two. The first administrator and the first super administrator are granted by inserting into `user_roles` in SQL.

## Security events

`server/src/middleware/security.ts` records every 403 given to a signed-in user as a row in `security_events` (method and route only: no tokens, bodies or query strings). Five or more within ten minutes for one account raises one open row in `security_alerts`, which a super administrator resolves with notes. These tables hold only what actually happened. Never insert example events or alerts, and note that probing refused routes in a test against the live site will raise a real alert that then needs resolving.

## Conventions

- API responses are `{ data, meta? }` on success and `{ error: { code, message, details? } }` on failure. Use `assertDb` for Supabase results; it maps database error codes to HTTP statuses.
- Money is integer centavos everywhere. Format with `money()` in `client/src/lib/api.ts`.
- Business rules that must be atomic live in SQL functions (`reserve_order`, `settle_payment`, `transition_*`, `reserve_pet`, `assign_rescue`). They take the acting user's id and check its role themselves. Call them through `db().rpc(...)`; do not reimplement them in route handlers.
- Routes validate input with strict Zod objects. Unknown keys are rejected on purpose.
- Schema changes are new numbered files in `supabase/migrations/`. Never edit an applied migration. The live database is changed only by a person pasting the new file into the Supabase SQL editor; there is no CLI access to it from here.
- Sample or demo content must say so. Do not present invented statistics, payments, locations or match scores as real.

## Running, testing, deploying

```bash
npm install
npm run dev          # API on :4000, web on :5173
npm run typecheck
npm test             # unit, API, database
npm run build
```

- `npm test` is forced into preview mode by `vitest.config.ts` (blank Supabase and Stripe variables), so it never touches live services even when `server/.env` exists. Keep it that way. Database tests run the real migrations on PGlite with PostGIS; `tests/helpers/db.ts` adds the pieces of Supabase the schema depends on.
- `npm run test:e2e` starts its own preview-mode API and web server on separate ports, so it is safe on a configured machine. It checks that the app is honest when the database is unavailable; it does not exercise signed-in flows.
- Applying a migration to the live database: a person pastes it into the Supabase SQL editor. For several at once, concatenate them inside `begin; ... commit;` into `supabase/APPLY_<range>.sql` (git-ignored) so it is one paste and one transaction. Apply migrations before deploying code that needs them.
- Deploy: `npm run deploy` (builds, deploys the prebuilt output, and records the commit, branch, date and notes shown under IT Operations → Deployments; it refuses to run with uncommitted changes). Pushing to GitHub does not deploy; the two are not linked.
- Local Stripe webhooks: `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed --forward-to localhost:4000/api/webhooks/stripe`.

## Live data

The production database holds **demo data**, created through the API as each demo account: 10 products, 6 pets, 3 service zones, and orders, applications, reports, transport requests, donations and volunteer tasks. Payments in it are Stripe test-mode payments.

- Eleven demo accounts exist, one per role including `super.administrator` (only one, so an elevated-access request cannot be approved in the demo without creating a second), as `<role>@pawsconnect.test` (dots for underscores). Ask the project owner for the password; it is not in the repository.
- The security log holds 42 refusals and five resolved alerts from the verification runs on 2026-10-11, and there is one rejected elevated-access request and one pending refund request from the same runs. They are real records of that run, not seeded examples.
- The three service zones are a plain rectangle around Malolos named "Demo ... zone". They are not real boundaries.
- Local development uses the same database as the live site. Anything you create or delete locally is created or deleted in production. There is no separate development database.

## Do not

- Commit `.env` files, keys, passwords, or `.vercel/`. The repository is public.
- Put the Supabase service role key anywhere a `VITE_` variable or client code can reach.
- Run two agents in this folder at the same time. It happened once and produced two conflicting implementations.
- Edit code containing backticks, `$` or backslashes through inline shell commands (`node -e`, heredocs). Shell quoting has silently corrupted files here several times. Use a file-editing tool or a script file.
- Weaken a test to make it pass. Several of them exist because the bug they guard already happened.

## Known gaps

See "Not built" in [docs/STATUS.md](docs/STATUS.md). The ones most likely to matter next:

- Refunds stop at the request: a customer can ask and staff can see it, but nothing calls Stripe to refund, and there is no approve or decline action.
- Security monitoring has one rule (repeated refusals). Sign-in attempts are not imported from Supabase Auth, so failed logins are not visible.
- No map-based zone editor (zones are pasted as GeoJSON), no rescue or transport map.
- The upload and staff forms added in the second pass were verified through the API and by loading each screen; they have not each been clicked through by hand in a browser.
- Notifications reach open pages over Realtime; there is no email or SMS.
- No product variants in the storefront.
- The Edge Function in `supabase/functions/maintenance` is not deployed and not needed while `pg_cron` runs the expiry jobs.
- `client/public/images/hero-dog.jpg` has no recorded source or licence.
