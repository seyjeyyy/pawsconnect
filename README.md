# PawsConnect

**Adopt. Shop. Rescue. Donate. Deliver.**

Pet supplies e-commerce, AI-assisted adoption matching, stray rescue reporting, shelter-managed pet transport and donations for Rowena's Paw Shelter, Bulacan, Philippines.

| Layer | Stack |
| --- | --- |
| Web (`client/`) | React 19, TypeScript, Vite, Tailwind CSS 4, React Router, TanStack Query, React Hook Form, Zod |
| API (`server/`) | Node.js, Express 5, TypeScript, Zod |
| Data (`supabase/`) | Supabase Postgres, Auth, Storage, Realtime, Row Level Security, PostGIS |
| Payments | Stripe Checkout with signature-verified webhooks |
| Maps | Leaflet with OpenStreetMap tiles; Nominatim address search and OSRM routing behind a provider interface |
| Tests (`tests/`) | Vitest (unit, API, database on in-process Postgres + PostGIS), Playwright (browser) |

## Run it

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev          # API on http://127.0.0.1:4000, web on http://localhost:5173
```

With no configuration the app still starts, but it has nothing to show: every listing, quiz and account page reports that the service is not connected. There is no built-in sample data. Connect Supabase to see it work.

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

   The administrator runs the shelter: store, animals, adoption, rescue, transport and money. Self-registration only ever grants the community roles (buyer, adopter, donor, community reporter).

6. Make an account the first super administrator the same way, with `'super_administrator'` in place of `'administrator'`. Use a separate account for it. The super administrator runs the system and nothing else: it assigns roles under **People & access**, reads the audit trail, and works the security centre (recorded refusals, alerts). It has no shelter screens, and the administrator has no system screens.

   Granting or removing administrator or super administrator access afterwards takes two super administrators: one files the request and another approves it.

## Optional integrations

Each is off until its keys are set in `server/.env`; the app reports the feature as unavailable rather than pretending.

| Integration | Variables | Without it |
| --- | --- | --- |
| Stripe (test or live) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Checkout stops with "payments are not configured". No payment is ever marked successful without a verified webhook. See **Stripe setup** below. |
| Your own map services | `NOMINATIM_URL`, `OSRM_URL` | Maps need no key. Address search and routing use the public OpenStreetMap services, which are for light use only; set these to a hosted or self-hosted instance before real traffic. |
| Resend | `RESEND_API_KEY`, `RESEND_FROM` | No transactional email. |

### Stripe setup

1. In the Stripe dashboard (test mode), copy the secret key (`sk_test_...`) into `STRIPE_SECRET_KEY`.
2. For local development, install the Stripe CLI and run `stripe listen --forward-to localhost:4000/api/webhooks/stripe`. It prints a signing secret (`whsec_...`); put that in `STRIPE_WEBHOOK_SECRET` and restart the API.
3. For a deployed API, add a webhook endpoint for `https://<your-api>/api/webhooks/stripe` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`, and use that endpoint's signing secret.
4. Pay with a Stripe test card such as `4242 4242 4242 4242`, any future expiry and any CVC.

Amounts are charged in Philippine pesos. Stripe enforces a minimum charge (roughly the equivalent of US$0.50), so very small donations will be declined by the provider.

Service zones are not pre-loaded. An administrator must add verified WGS84 boundaries (GeoJSON) under **Service zones** before any location is reported as within coverage.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web app with reload |
| `npm run build` | Production build of both workspaces |
| `npm run typecheck` | TypeScript check of both workspaces |
| `npm test` | Unit, API and database tests (no external services needed) |
| `npm run test:e2e` | Browser tests on desktop and mobile, against their own unconfigured servers. First run: `npx playwright install chromium` |
| `npm start` | Run the built API |

## How the tests check the database

`tests/helpers/db.ts` boots a real Postgres with PostGIS in-process (PGlite), adds the parts of a Supabase project the schema relies on (API roles, `auth.users`, storage tables, Supabase's default grants), and applies every migration. Tests then act as specific users with RLS enforced. This validates the SQL without Docker or a live project; it does not replace a check against the real Supabase project before launch.

## Project status

See [docs/STATUS.md](docs/STATUS.md) for what is verified, what is written but not yet verified end to end, and known gaps.

## Deployment (Vercel)

Live at https://pawsconnect-one.vercel.app. One Vercel project serves both parts: the web app as static files from `client/dist`, and the Express API as a serverless function (`api/index.ts`) that receives every `/api/*` request. Routing is in `vercel.json`.

To redeploy after changes:

```bash
npx vercel build --prod
npx vercel deploy --prebuilt --prod
```

Environment variables are set in the Vercel project (Settings → Environment Variables), not in the repository: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CLIENT_URL` (the site address, used for CORS, email links and payment redirects), `TRUST_PROXY_HOPS=1`, and for the web build `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL=/api`.

The deployed site has its own Stripe webhook endpoint (`/api/webhooks/stripe`) with its own signing secret, separate from the one `stripe listen` uses locally.

Things that differ from running locally:

- **Scheduled jobs do not run on serverless.** The in-process scheduler only runs under `npm run dev` / `npm start`. Schedule the expiry functions in the database instead (Supabase SQL editor, after enabling the `pg_cron` extension):

  ```sql
  select cron.schedule('expire-order-reservations', '* * * * *', 'select public.expire_order_reservations()');
  select cron.schedule('expire-pet-reservations', '*/5 * * * *', 'select public.expire_pet_reservations()');
  ```
- **Rate limits are per server instance**, so they are looser than on a single long-running server. Use a shared store before relying on them under real traffic.
- Add the site address to Supabase → Authentication → URL Configuration (site URL, plus `/auth/callback` and `/auth/reset` as redirect URLs), or email links will point at localhost.
