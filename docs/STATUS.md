# Build status

Last updated 2026-10-11. "Verified" means it was run and observed working, not just written.

Current totals: 95 unit, API and database tests pass; both workspaces typecheck and build. Live at https://pawsconnect-one.vercel.app.

## Verified live

Run against the connected Supabase project and Stripe test mode.

**2026-10-10, with temporary data that was removed afterwards**

- Sign-in, profile, addresses, every account list, role gating and the shelter workspace reads.
- A complete purchase, locally and on the deployed site: order, payment on Stripe's hosted page with the test card, settlement by signed webhook, stock deducted only on payment, no double payment.

**2026-10-11, creating the demo data that is now in the database**

Every action was performed through the API as the demo account for that role. All 119 steps succeeded, including five Stripe test payments.

- Store: staff add products, adjust stock, and move orders through processing, shipment and delivery. A buyer cancels an unpaid order, and reviews a delivered item; staff approve the review.
- Adoption: application, staff review, meet-and-greet appointment, administrator approval, pet reservation, adoption fee paid through Stripe, and the move to awaiting handover.
- Matching: the quiz scored real pets from profiles recorded by the veterinarian (for example 100% and 92%, with two pets correctly excluded for an apartment household with a child, and one unassessed pet shown as needing assessment).
- Veterinarian: verified behaviour profiles and health records.
- Rescue: reports inside and outside coverage, an anonymous report, staff verification, assignment to rescue personnel and to an approved volunteer, the rescuer marking a case in progress, and referral of the outside-coverage report.
- Transport: request, staff quotation, customer acceptance, payment through Stripe, and assignment of a registered driver and vehicle. A request with a destination outside coverage, followed by an alternative transport request.
- Donations: a monetary donation paid through Stripe, an in-kind donation confirmed as received, and unpaid and unconfirmed pledges left pending.
- Volunteers: application, approval, task assignment, and the volunteer starting a task.
- Each role then saw the right data on the deployed site, and the field roles were refused everything outside their job.
- Workspace analytics reconciled with the orders placed (store revenue P2,742.00 from three paid orders).

Not yet exercised live: email verification and password reset links, Storage uploads, discount codes, reservation expiry by the scheduled job, refunds, resolving a rescue, the driver's trip updates and handover, finalizing an adoption, and declining or rejecting at each stage.

Stripe is in test mode. The connected Stripe account is not activated for real charges.

## Demo data in the live database

The database holds demonstration data, not real shelter records: 10 products, 6 pets, 3 service zones, orders, applications, reports, donations and so on, spread across ten demo accounts (one per role, `<role>@pawsconnect.test`).

- Products and pets say "Demo listing" or "Demo profile" in their descriptions.
- The three service zones are a plain rectangle around Malolos, named "Demo ... zone". They are not verified service boundaries and must be replaced before real operation.
- The payments are real Stripe test-mode payments. No money moved.

Remove all of it before real use.

## Roles

Each account lands on, and can only reach, what its role is for. The API enforces this, with tests per role (`tests/api/workspace-access.test.ts`).

| Role | Home | Reach |
| --- | --- | --- |
| Administrator | Workspace overview | Everything, including people and the audit trail |
| Shelter staff | Workspace overview | Everything except people and the audit trail |
| Veterinarian | Animals in care | Animals and health records |
| Rescue personnel | My rescue assignments | Reports assigned to them |
| Shelter driver | My transport jobs | Trips assigned to them |
| Volunteer | Customer dashboard | Customer pages, volunteer tasks, rescues assigned to them |
| Buyer, adopter, donor, reporter | Customer dashboard | Their own orders, applications, reports and donations |

## Automated test coverage

| Area | Evidence |
| --- | --- |
| API boots, serves the catalog, rejects unauthenticated and malformed requests | `tests/api/app.test.ts` |
| Workspace access per role | `tests/api/workspace-access.test.ts` |
| Migrations and seed apply to an empty database; every public table has RLS enabled | `tests/database/migrations.test.ts` |
| Sign-up roles, data isolation between users, role administration, privileged functions closed to clients, service-zone checks | `tests/database/foundation.test.ts` |
| Orders, stock, payment settlement, order status, reviews, inventory | `tests/database/commerce.test.ts` |
| Every table, column, function and relationship the API names exists in the schema | `tests/database/contract.test.ts` |
| Compatibility scoring, including profiles as stored in the database | `tests/unit/matchmaking.test.ts` |
| Stripe webhook signature checks | `tests/api/app.test.ts` |

The adoption, rescue, transport, donation and volunteer workflows have been run live (above) but have no automated tests of their own yet. The browser tests (`tests/e2e/`) assume preview mode and fail on a machine with Supabase configured; they need their own preview-mode server.

## Not built

- Store: product variants in the storefront (the database and checkout support them), product image upload (an image URL is entered), refunds screen, shipment tracking entry. The cart is kept in the browser; the server cart endpoints are unused.
- Workspace: generic record tables and status forms. No map-based zone editor (zones are pasted as GeoJSON), rescue map or transport map. Assigning a driver, vehicle or rescuer, and adding a health record, means pasting record ids. The veterinarian has no form for behaviour profiles (the API accepts them).
- Photo upload for stray reports and adoption documents (the signed-upload endpoint exists).
- Notifications are stored and listed. Realtime, email (Resend), SMS and push are not wired.
- The route preview shows distance and time but does not draw the route.
- Recurring donations: not offered.
- Accessibility audit, CI workflow, load testing.

## Operating notes

- Scheduled jobs: reservation expiry runs in the database through `pg_cron` (every minute for orders, every five for pets), because nothing runs in the background on Vercel.
- Maps use the public OpenStreetMap services, which are for light use. Address search is throttled to one request per second and rate-limited per visitor.
- Rate limits are counted per server instance on Vercel, so they are looser than on a single server.

## Security notes

- Fixed: privileged database functions were callable by any signed-in user through the REST API, including role assignment and payment settlement (`202610100006_function_privileges.sql`, with a regression test).
- Fixed: the public reviews endpoint returned unapproved reviews.
- Fixed: field roles could open the workspace screen but were refused all data; access is now defined per role.
- Open, low severity: `has_role(uuid, text[])` is callable by signed-in users because several RLS policies use it directly, so a user could test whether another user id holds a role.
- The ten demo accounts share one simple password, and one of them is an administrator. Change those passwords or remove the accounts before real use.

## Content to replace before launch

- `client/public/images/hero-dog.jpg` has no recorded source or licence.
- Product and pet photos are hot-linked from Unsplash and were not checked against their listings.
- Privacy and Terms pages are unreviewed drafts and say so on the page.
