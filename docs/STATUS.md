# Build status

Last updated 2026-10-10. "Verified" means it was run and observed working, not just written.

Current totals: 80 unit, API and database tests and 12 browser tests pass; both workspaces typecheck and build.

## The one thing that is not verified anywhere

**Nothing has been run against a live Supabase project or the PayMongo sandbox**, because no credentials were available. Database behaviour is tested on a real in-process Postgres with PostGIS, and the web app is tested in a browser in preview mode. What sits between them — the Express routes calling Supabase over HTTP, Supabase Auth, Storage uploads, and PayMongo checkout and webhooks — has been checked by reading, by type checking and by the contract test below, but never executed. Expect to find and fix issues there on first connection.

## Phase 1 — Foundation: verified

| Item | Evidence |
| --- | --- |
| API boots, serves the catalog, rejects unauthenticated and malformed requests | `tests/api/app.test.ts` |
| All routes render on desktop and mobile with no console errors or horizontal overflow | `tests/e2e/smoke.spec.ts` |
| Migrations and seed apply to an empty database; every public table has RLS enabled | `tests/database/migrations.test.ts` |
| Sign-up provisions a profile and community roles only; metadata cannot grant a role | `tests/database/foundation.test.ts` |
| Users cannot read or write each other's data; anonymous visitors see no account data | same |
| Only an administrator can change roles; changes are audited | same |
| Privileged database functions cannot be called by clients (explicit allow-list) | same |
| Every table, column and function the API names exists in the schema | `tests/database/contract.test.ts` |

## Phase 2 — E-commerce: database verified, HTTP flow not

Verified in `tests/database/commerce.test.ts`:

- Order totals are computed from database prices; prices sent by the client are ignored.
- Delivery fee comes from the PostGIS delivery zone; addresses outside every zone are refused.
- Stock is reserved at checkout; out-of-stock, unpublished and over-quantity orders are refused and reserve nothing.
- Only one of two customers can reserve the last units. (Row locking is asserted structurally; true parallel checkouts cannot run on the single-connection test database.)
- Cancelling or letting a reservation expire returns the stock.
- An order becomes paid, and stock is deducted, only on a verified payment of the exact total, bound to a recorded checkout.
- Duplicate webhooks are processed once. Failed payments change nothing. A payment arriving after expiry is flagged for staff review instead of being fulfilled.
- Order status advances one step at a time, by staff only. Paid orders cannot be cancelled by the customer, or refunded without a recorded refund.
- Reviews require a delivered purchase and can never be inserted pre-approved.
- Stock adjustments require staff, a reason, and cannot go below reserved stock.
- Customers cannot see each other's orders or payments, or modify the catalog.

Also done: checkout, account and admin forms aligned with the API; stock adjustment added to the shelter workspace; a scheduled job releases expired order and pet reservations.

Not verified: the checkout flow over HTTP with a real account, and PayMongo sandbox payment and webhook delivery.

Not built: product variants in the storefront UI (the database and checkout function support them), image upload for products (an image URL is entered), refunds UI, shipment tracking entry, the server-side cart (the cart is stored in the browser; server cart endpoints exist but are unused).

## Phases 3–6 — written and aligned, not verified

Routes, pages, tables and workflow functions exist for adoption, matchmaking, rescue, transport, donations, volunteers and the shelter workspace. The forms now send the fields the API validates (adoption application, transport and alternative transport, volunteer, contact, stray report, route preview). Compatibility scoring and service-zone checks are tested. The workflow functions themselves (adoption review and pet reservation, rescue assignment, transport quoting and handover, donation settlement) do not have behaviour tests yet.

Known gaps:

- The shelter workspace uses generic record tables and status forms. There is no map-based zone editor (zones are pasted as GeoJSON), rescue map or transport map.
- Photo upload for stray reports and adoption documents is not in the forms (the signed-upload endpoint exists).
- Notifications are stored and listed. Realtime subscription, email (Resend), SMS and push are not wired.
- Recurring donations are not offered; provider support has not been confirmed.
- Transport and driver assignment require typing record ids in the workspace.

## Phase 7 — not started

Accessibility audit, CI workflow, load testing, and production deployment.

## Security notes

- Fixed: privileged database functions were callable by any signed-in user through the REST API, including role assignment and payment settlement (`202610100006_function_privileges.sql`, with a regression test).
- Fixed: the public reviews endpoint returned unapproved reviews.
- Open, low severity: `has_role(uuid, text[])` is callable by signed-in users because several RLS policies use it directly, so a user could test whether another user id holds a role.

## Content to replace before launch

- `client/public/images/hero-dog.jpg` has no recorded source or licence.
- Sample listing photos are hot-linked from Unsplash and do not match their product names.
- Privacy and Terms pages are unreviewed drafts and say so on the page.
