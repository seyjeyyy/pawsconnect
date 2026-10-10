# PawsConnect

**Adopt. Shop. Rescue. Donate. Deliver.**

Pet supplies e-commerce, AI-assisted adoption matching, stray rescue reporting, shelter-managed pet transport and donations for Rowena's Paw Shelter, Bulacan, Philippines.

| Layer | Stack |
| --- | --- |
| Web (`client/`) | React 19, TypeScript, Vite, Tailwind CSS 4, React Router, TanStack Query, React Hook Form, Zod |
| API (`server/`) | Node.js, Express 5, TypeScript, Zod |
| Data (`supabase/`) | Supabase Postgres, Auth, Storage, Realtime, Row Level Security, PostGIS |
| Tests (`tests/`) | Vitest (unit, API, database on in-process Postgres + PostGIS), Playwright (browser) |

## Run it

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev          # API on http://127.0.0.1:4000, web on http://localhost:5173
```

With no configuration the app starts in **preview mode**: the storefront, pet listings and matchmaking quiz work against clearly labelled sample data, and anything that needs an account says it is not connected. Nothing is purchasable and no data is saved.

## Connect Supabase

1. Create a project at supabase.com.
2. Apply the schema. Either install the Supabase CLI and run `supabase link` then `supabase db push`, or paste each file in `supabase/migrations/` into the SQL editor **in filename order**. Then run `supabase/seed.sql` (product categories only).
3. Copy `server/.env.example` to `server/.env` and `client/.env.example` to `client/.env`, and fill in:

   | File | Variable | Value |
   | --- | --- | --- |
   | `server/.env` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API |
   | `client/.env` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Same URL and anon key |

   The service role key bypasses Row Level Security. It belongs only in `server/.env` and must never be given a `VITE_` name.
4. In Supabase → Authentication → URL Configuration, set the site URL to your web origin and allow `/auth/callback` and `/auth/reset` as redirect URLs.
5. Register an account in the app, then make it the first administrator in the SQL editor:

   ```sql
   insert into public.user_roles (user_id, role_name)
   select id, 'administrator' from auth.users where email = 'you@example.com';
   ```

   After that, administrators assign roles from **Shelter workspace → People & access**. Self-registration only ever grants the community roles (buyer, adopter, donor, community reporter).

## Optional integrations

Each is off until its keys are set in `server/.env`; the app reports the feature as unavailable rather than pretending.

| Integration | Variables | Without it |
| --- | --- | --- |
| PayMongo (sandbox or live) | `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `PAYMONGO_LIVE_MODE`, `PAYMONGO_PAYMENT_METHODS` | Checkout stops with "payments are not configured". No payment is ever marked successful without a verified webhook. Register the webhook at `POST /api/webhooks/paymongo`. |
| Google Maps | `GOOGLE_MAPS_SERVER_KEY` (server), `VITE_GOOGLE_MAPS_API_KEY` (client) | Address search and the interactive map are hidden; coordinates can be typed manually. |
| Resend | `RESEND_API_KEY`, `RESEND_FROM` | No transactional email. |

Service zones are not pre-loaded. An administrator must add verified WGS84 boundaries (GeoJSON) under **Service zones** before any location is reported as within coverage.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web app with reload |
| `npm run build` | Production build of both workspaces |
| `npm run typecheck` | TypeScript check of both workspaces |
| `npm test` | Unit, API and database tests (no external services needed) |
| `npm run test:e2e` | Browser tests on desktop and mobile. First run: `npx playwright install chromium` |
| `npm start` | Run the built API |

## How the tests check the database

`tests/helpers/db.ts` boots a real Postgres with PostGIS in-process (PGlite), adds the parts of a Supabase project the schema relies on (API roles, `auth.users`, storage tables, Supabase's default grants), and applies every migration. Tests then act as specific users with RLS enforced. This validates the SQL without Docker or a live project; it does not replace a check against the real Supabase project before launch.

## Project status

See [docs/STATUS.md](docs/STATUS.md) for what is verified, what is written but not yet verified end to end, and known gaps.

## Deployment outline

- **Web:** Vercel, root `client/`, build `npm run build`, output `dist`. Set the `VITE_` variables and point `VITE_API_URL` at the API.
- **API:** any Node host. `npm run build -w server` then `npm start`. Set `CLIENT_URL` to the web origin (used for CORS and email links) and `TRUST_PROXY_HOPS` to the number of proxies in front of it.
- **Database:** managed Supabase project with the migrations applied.
