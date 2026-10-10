# Build status

Last updated 2026-10-10. "Verified" means it was run and observed working, not just written.

Current totals: 80 unit, API and database tests and 12 browser tests pass; both workspaces typecheck and build.

## Verified live

Run on 2026-10-10 against the connected Supabase project and Stripe test mode, with temporary data that was removed afterwards:

- Sign-in, profile, addresses, every account list, role gating and the shelter workspace reads.
- A complete purchase: staff create a delivery zone and a product through the admin API; a buyer saves an address, gets a quote (2 x P250 + P80 delivery = P580), places an order and pays on Stripe's hosted page with the test card.
- Stock is reserved at order time and deducted only when the signed Stripe webhook arrives. The redirect back to the site does not mark anything paid.
- The payment is recorded with Stripe's payment id, the buyer is notified, the sale appears in workspace analytics, a paid order cannot be paid twice, and staff can advance it to processing.

Not yet exercised live: email verification and password reset links, Storage uploads, discount codes, cancellation and expiry over HTTP, refunds, and the adoption, rescue, transport and donation workflows. Those are covered by database tests where noted below, not by a live run.

Stripe is in test mode. The connected Stripe account is not activated for real charges.

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

The checkout flow over HTTP with a Stripe test payment and webhook delivery was verified live (see above).

Not built: product variants in the storefront UI (the database and checkout function support them), image upload for products (an image URL is entered), refunds UI, shipment tracking entry, the server-side cart (the cart is stored in the browser; server cart endpoints exist but are unused).

## Maps: verified

The location picker uses Leaflet with OpenStreetMap tiles and needs no key. Verified in a browser against the live services: tiles load, clicking or dragging sets the coordinates, typed coordinates move the pin, address search (Nominatim) and driving distance (OSRM) return real results. The public OpenStreetMap endpoints are for light use; address search is throttled to one request per second and rate-limited per visitor. The route preview shows distance and time; it does not draw the route on a map yet.

## Phases 3–6 — written and aligned, not verified

Routes, pages, tables and workflow functions exist for adoption, matchmaking, rescue, transport, donations, volunteers and the shelter workspace. The forms now send the fields the API validates (adoption application, transport and alternative transport, volunteer, contact, stray report, route preview). Compatibility scoring and service-zone checks are tested. The workflow functions themselves (adoption review and pet reservation, rescue assignment, transport quoting and handover, donation settlement) do not have behaviour tests yet.

Known gaps:

- The shelter workspace uses generic record tables and status forms. There is no map-based zone editor (zones are pasted as GeoJSON), rescue map or transport map. Leaflet is now in place to build these on.
- The browser tests assume preview mode and fail on a machine with Supabase configured; they need their own preview-mode server.
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
