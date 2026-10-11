# PawsConnect optimization audit — 2026-10-11

Inspected the existing repository before implementation. This is an incremental change to the React/Express/Supabase application, not a replacement. Production is not a test environment. Measurements and tests below use isolated local services.

## Baseline and priorities

| Priority | Actual finding | Consequence / implementation |
| --- | --- | --- |
| P0 | `shelter_staff` grants all shelter routes; individual module assignments do not exist. SQL workflows use legacy roles. | Add database permission assignments, preserve legacy memberships and identifiers, enforce assignments in API and SQL, retain independent approval for elevated authority. |
| P0 | System and shelter administration are deliberately separate; Stripe settlement is signature verified. | Preserve these boundaries and all payment workflows. |
| P1 | Global Query defaults poll every mounted query every 30 seconds, including health and static lookups. Every successful write and notification invalidates the entire cache. | Remove blanket polling; target workflow invalidation and bound fallback refresh to visible private queries. |
| P1 | Auth, customer screens and staff screens share `Account.tsx`; sign-in loads the chart library. | Split authentication and lazily load financial reporting. Production baseline Account chunk: 428.22 kB (124.53 kB gzip); entry: 816.64 kB (248.56 kB gzip). |
| P1 | One Suspense boundary surrounds every route and its layout. | Preserve navigation shell while route content loads. |
| P1 | Authentication checks JWT, session cutoff and memberships in series on every request. | Parallelize independent post-verification database reads without caching authorization. |
| P1 | Admin list API supports status/sort but UI exposes only text search; next-page detection guesses from row length. | Connect controls to server validation, stable ordering and exact totals. |
| P1 | Many compact account components reside in one large module; sidebar groups collapse but the sidebar itself does not. | Add accessible desktop collapse and mobile drawer, consistent navigation and breadcrumbs. |
| P2 | Account and admin lists embed complete histories per page; rescuer lookups retrieve all memberships before slicing. | Bound lookups at the database; index ownership/ordering and assignment queries. Keep detail/history preservation explicit. |
| P2 | Existing aggregate endpoint mixes operational counts with finance in one response. | Separate permission-filtered operational overview from independently loaded finance. |
| P2 | Volunteer enrollment already belongs to the existing identity; UI depends on a separately assigned volunteer role. | Derive volunteer capability from approved enrollment, preserve assignments. |

## Inspected architecture and inventory

- React 19, TypeScript, Vite, React Router 7; TanStack Query 5 owns remote state. Auth, cart and synchronization use context. Hand-written CSS plus existing Lucide icons; no replacement framework needed.
- Express 5 with strict Zod schemas, service-role Supabase queries, Postgres/PostGIS, Supabase Auth/Storage/Realtime, Stripe Checkout; single Vercel function. Existing middleware includes rate limits, session revocation, maintenance, telemetry and security refusals.
- Public routes: home, catalog/product/cart/checkout/payment return, adoption listing/detail/matching, rescue, transport, donations, volunteer enrollment, contact/about/legal. Account routes: overview, records, addresses, profile, settings, volunteer tasks. Staff routes cover animals, health, adoption, rescue, transport, catalog/orders, donations, volunteers, finance and inquiries. System routes cover accounts, security, approvals, audit and IT operations.
- All route modules under `server/src/modules` and route composition in `App.tsx` were inventoried. Customer and staff records already paginate at the API and filter ownership. Workflow mutations use transactional SQL. Public data unavailable states are honest; no fixtures belong in production.
- Existing role names: buyer/adopter/donor/community_reporter, volunteer, veterinarian, rescue_personnel, shelter_driver, shelter_staff, administrator, super_administrator. They are memberships on one Auth identity, not separate authentication providers. The new primary experience should be User, Staff or Super administrator, with retained legacy memberships as compatibility assignments.
- Existing migrations through 017 include operations/session changes newer than the original project notes. Applied migrations must remain immutable. No live migration is performed here.
- High-cost libraries: charting, Leaflet and tour dependencies. Route splitting exists already, but grouped module imports pull unrelated features into each route. Build sizes are measured; bundle size alone is not evidence of improved production Core Web Vitals.
- Existing test coverage includes role boundaries, owner isolation, payment settlement, schema contracts, populated upgrades, session controls and responsive anonymous flows. Authenticated browser workflows and production p75 vitals are not established by these tests.

## Migration and release strategy

Add permissions without deleting accounts, role rows or historical data. Backfill grants from existing operational authority, leave system-only accounts without shelter grants, and treat volunteer approval as a capability. Keep legacy elevated-role approvals. Duplicate identities are a manual review task; names/emails are never a merge key.

Before release: test populated upgrades, direct RLS access, SQL workflow denial and API module denial; inspect the generated permission matrix. Apply new SQL in Supabase manually, then deploy compatible code. Rollback must retain permission restrictions once narrowed; restoring an old application that ignores them is unsafe. A schema rollback is only safe before grants are changed, or after exporting/reconciling grants and independently reviewing restored access. Never delete historical records to roll back the interface.

## Measurement limits

Local browser measurements, build sizes and query tests are repeatable laboratory evidence. A disconnected preview cannot measure production database latency, real authenticated network waterfalls, real device p75 LCP/INP/CLS, external map latency or live query plans. These remain release validation tasks, not claimed improvements.
