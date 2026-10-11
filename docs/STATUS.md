# Build status

Last updated 2026-10-11. "Verified" means it was run and observed working, not just written.

Hosted-release baseline: 138 unit, API and database tests and 12 browser tests passed. Live at https://pawsconnect-one.vercel.app; the live database remains at migration 014. The newer local repair, expanded checks and deployment blockers are documented in [REPAIR_REPORT.md](REPAIR_REPORT.md) and the local operations section below.

## Where the data comes from

Every listing, record, count and figure in the application is read from the Supabase database. There is no built-in sample data in production code: with the database unreachable, pages say the service is unavailable instead of showing examples. Sample fixtures exist only under `tests/fixtures/`.

The database itself currently holds **demonstration records**, not real shelter records. See "Demo data" below.

## Verified live

Run against the connected Supabase project and Stripe test mode.

**Purchases and core access (2026-10-10).** Sign-in, profile, addresses, role gating, and a complete purchase on the deployed site: order, payment on Stripe's hosted page with the test card, settlement by signed webhook, stock deducted only on payment, no double payment.

**The operational workflows (2026-10-11, creating the demo data).** Performed through the API as the demo account for each role; all 119 steps succeeded, including five Stripe test payments.

- Store: products, stock adjustment, orders through processing, shipment and delivery, cancellation of an unpaid order, a review approved by staff.
- Adoption: application, review, meet-and-greet appointment, administrator approval, pet reservation, fee paid through Stripe, awaiting handover.
- Matching: the quiz scored real pets from profiles recorded by the veterinarian, excluded unsuitable pets, and reported an unassessed pet as needing assessment.
- Rescue: reports inside and outside coverage, an anonymous report, verification, assignment to rescue personnel and to an approved volunteer, a case marked in progress, an outside-coverage report referred.
- Transport: request, quotation, customer acceptance, payment, driver and vehicle assignment; an outside-coverage request followed by an alternative request.
- Donations and volunteers: a paid donation, an in-kind donation received, pending pledges; a volunteer approved, given tasks, and starting one.

**The database-driven pass (2026-10-11, after migrations 009 to 013).** 58 checks on the deployed site, all passing, plus every changed screen loaded in a browser as five roles with no errors.

- Catalog and pets come from the database; public responses do not include product cost or internal behaviour notes.
- Cart is stored on the server, survives a fresh request, refuses more than is in stock, and is private to its owner.
- Saved pets can be added and removed and are private to the account.
- Account totals equal the actual record counts; every account list loads; one customer's orders never appear in another's list, and opening another customer's order by id is refused.
- File upload to a private Storage bucket: the file is not publicly readable or readable by another customer; the owner and staff read it through a link that expires in two minutes; wrong types, oversized files, and customer uploads to public listings are refused.
- Workspace pickers list real people, vehicles and pets. A staff reply to an inquiry is saved.
- A refund request can be filed against one's own payment only, once, and stays pending.
- Workspace counts equal direct database counts. Revenue excludes test payments (see "Money").
- Realtime: a volunteer's task update reached their open session as a notification without a refresh.
- Security: see below.

**Not yet exercised live:** email verification and password reset links, discount codes, reservation expiry by the scheduled job, resolving a rescue, the driver's trip updates and handover, finalizing an adoption, declining or rejecting at each stage, and the upload and staff forms clicked through by hand in a browser (they were verified through the API and by loading each screen).

## Security monitoring

Verified live on 2026-10-11 with real events, not seeded ones.

- Every refusal (HTTP 403) given to a signed-in user is recorded with the account, method and route. No tokens, request bodies or query strings are stored.
- Six staff-only requests by a customer account produced six recorded events and one open alert. The alert could be resolved only by a super administrator, and only with investigation notes.
- Granting the administrator role directly is refused. An administrator files a request; the requester cannot approve it; a super administrator's rejection changed no roles; a decided request cannot be decided again.
- Administrators, staff and customers are refused the security centre.
- After the role separation: on the deployed site the super administrator was allowed all 6 system routes and none of 12 shelter routes; the administrator and shelter staff the reverse. Typing the other side's address directly returns each to their own home.

Limits: there is one detection rule (five or more refusals within ten minutes). Sign-in attempts are not imported from Supabase Auth, so failed logins do not appear. The security centre says this on screen.

The log currently holds 42 refusals and five resolved alerts. All of them came from the verification runs, in which demo accounts were deliberately pointed at routes they may not open. The resolution notes say so.

## Money

Reports count **live-mode payments only**. Each payment records whether it was made with a live or a test Stripe key, and test payments are excluded from store revenue, transport and adoption fee receipts, donations and gross receipts. They are counted separately as test payments.

Stripe is in test mode and the connected account is not activated for real charges. So every revenue figure is currently zero, with six test payments shown separately. That is the correct reading, not a fault.

## Demo data

The database holds demonstration records created on 2026-10-11 through the application itself: 10 products, 6 pets, 3 service zones, 5 orders, 3 adoption applications, 5 stray reports, 2 transport requests, 4 donations, a volunteer with tasks, expenses, and eleven demo accounts (one per role, `<role>@pawsconnect.test`).

- Products and pets say "Demo listing" or "Demo profile" in their descriptions.
- The three service zones are a plain rectangle around Malolos named "Demo ... zone". They are not verified service boundaries.
- Payments are Stripe test-mode payments. No money moved.
- From the verification run there is also one pending refund request, one rejected elevated-access request, and one inquiry reply.

None of it has been deleted or altered by the migrations. Removing it before real use needs a deliberate cleanup, with a backup first and the owner's confirmation, because orders, payments and the audit trail reference each other.

## Roles

Each account lands on, and can only reach, what its role is for. The API enforces this, with tests per role.

System administration and shelter operations are separate lines of authority; neither role implies the other. The API enforces the split, and migration 014 (applied) enforces the same split for anyone using the database directly with their own sign-in. Checked on the live database: the super administrator reads the audit trail and all role assignments but no orders or customer addresses; the administrator reads orders and addresses but not the audit trail or other accounts' roles. Role assignment was re-checked on the live site afterwards: refused for the administrator, working for the super administrator, and granting administrator access still requires a request and a second approver.

| Role | Home | Reach |
| --- | --- | --- |
| Super administrator | Security overview | System only: accounts and access (assigning roles), audit trail, security events and alerts, elevated-access requests. No shelter screens. |
| Administrator | Workspace overview | Shelter only: store, animals, adoption, rescue, transport, donations, expenses. No accounts, audit trail or security. Decides adoptions and manages service zones, which staff cannot. |
| Shelter staff | Workspace overview | Shelter operations |
| Veterinarian | Animals in care | Animals and health records |
| Rescue personnel | My rescue assignments | Reports assigned to them |
| Shelter driver | My transport jobs | Trips assigned to them |
| Volunteer | Customer dashboard | Customer pages, volunteer tasks, rescues assigned to them |
| Buyer, adopter, donor, reporter | Customer dashboard | Their own orders, applications, reports and donations |

## Automated test coverage

| Area | Evidence |
| --- | --- |
| API boots, refuses unauthenticated and malformed requests, reports an unconfigured database honestly | `tests/api/app.test.ts` |
| Workspace access per role | `tests/api/workspace-access.test.ts` |
| Account lists, saved pets, uploads and security routes require the right account | `tests/api/connected-access.test.ts` |
| Migrations and seed apply to an empty database; every public table has RLS enabled | `tests/database/migrations.test.ts` |
| Migrations 009 to 013 apply on top of a populated database without losing or misclassifying records | `tests/database/upgrade.test.ts` |
| Sign-up roles, data isolation, role administration, privileged functions closed to clients, service-zone checks | `tests/database/foundation.test.ts` |
| Orders, stock, payment settlement, order status, reviews, inventory | `tests/database/commerce.test.ts` |
| Cart, saved pets, refunds, security events and alerts, elevated-access approval, atomic submissions | `tests/database/connected-workflows.test.ts` |
| Every table, column, function and relationship the API names exists in the schema | `tests/database/contract.test.ts` |
| Compatibility scoring, including profiles as stored in the database | `tests/unit/matchmaking.test.ts` |
| Stripe webhook signature checks; reservation maintenance function | `tests/api/app.test.ts`, `tests/unit/maintenance.test.ts` |
| The app stays honest with no database: no invented listings or match results | `tests/e2e/smoke.spec.ts` |

The adoption, rescue, transport, donation and volunteer workflows have been run live but have no automated tests of their own yet.

## Local operations repair (not deployed)

The hosted checks above describe the earlier release through migration 014. The current working tree adds migrations **015–016**, which have only been exercised in isolated tests. No production data or deployment was changed by this repair.

- Added the super-administrator IT Operations routes, real SQL-backed configuration, maintenance restrictions, HTTP aggregates, incident timelines, job history and a protected external worker protocol.
- Added workspace MFA, recent verification for critical system changes, account suspension/session cutoffs and restrictive direct-access policies.
- Rebuilt role-specific tours with observer-driven positioning, bounded target discovery, keyboard/focus handling, reduced motion, and resumable local/server progress. Added shared confirmation dialogs, bounded requests, error recovery and PawsConnect-only active branding.
- Added desktop/tablet/mobile browser checks, populated 014 upgrade coverage, an actual isolated database archive restore, and a CI workflow. See [the repair report](REPAIR_REPORT.md) for final results and limitations.
- Backup/release execution needs an external worker. Managed backup inventory needs a scoped token. Production restore is deliberately unavailable until an external recovery coordinator exists. A hosted Supabase plus Storage staging drill has not been performed.

Setup, migration order, controls and rollback limitations are in [OPERATIONS.md](OPERATIONS.md).

## Not built

- Refunds stop at the request. A customer can ask and staff can see it; nothing calls Stripe to refund, and there is no approve or decline action.
- Store: product variants in the storefront (the database and checkout support them), shipment tracking entry.
- Workspace: no map-based zone editor (zones are pasted as GeoJSON), no rescue or transport map.
- Notifications reach open pages over Realtime. Email (Resend), SMS and push are not wired.
- The route preview shows distance and time but does not draw the route.
- Recurring donations: not offered.
- Full accessibility audit and load testing. Targeted tour/focus/responsive checks and a local CI workflow are now included; the workflow has not yet run on GitHub.

## Needs credentials or outside setup

| Item | State |
| --- | --- |
| Stripe live payments | Needs an activated Stripe account and live keys. Test mode works. |
| Email notifications | Needs a Resend API key and sender address; not wired in code yet either. |
| Supabase Auth email links | The site URL and redirect URLs must point at the deployed domain in the Supabase dashboard. Not confirmed done. |
| Reservation expiry | Runs in the database through `pg_cron`, confirmed active. The Edge Function in `supabase/functions/maintenance` is an alternative and is not deployed. |
| Real service zones | Needs verified boundaries for Bulacan from the shelter; the current ones are a demo rectangle. |
| Maps at scale | The public OpenStreetMap services are for light use; a hosted geocoder and router are needed for real traffic. |

## Operating notes

- Apply database migrations before deploying code that depends on them.
- Rate limits are counted per server instance on Vercel, so they are looser than on a single server.
- Local development uses the same database as the live site.

## Security notes

- Fixed: privileged database functions were callable by any signed-in user through the REST API, including role assignment and payment settlement.
- Fixed: the public reviews endpoint returned unapproved reviews.
- Fixed: field roles could open the workspace screen but were refused all data; access is now defined per role.
- Fixed: signed-in staff could write catalog, pet and zone rows directly through Supabase, bypassing validation and the audit trail; those writes now go only through the API.
- Fixed: public reads exposed product cost and internal behaviour notes.
- Open, low severity: `has_role(uuid, text[])` is callable by signed-in users because several RLS policies use it directly, so a user could test whether another user id holds a role.
- Elevated-access changes need two super administrators (one requests, another approves). The demo has one, so that flow cannot be completed in the demo without a second.
- The eleven demo accounts share one simple password, and two of them are administrators. Change those passwords or remove the accounts before real use.

## Content to replace before launch

- `client/public/images/hero-dog.jpg` has no recorded source or licence.
- Product and pet photos are hot-linked from Unsplash and were not checked against their listings.
- Privacy and Terms pages are unreviewed drafts and say so on the page.
