# PawsConnect repair report — 2026-10-11

Historical report for the initial 015–016 repair. A subsequent owner-requested change removes mandatory MFA in migration 017; its current rollout state and verification are in [STATUS.md](STATUS.md). MFA descriptions below record the earlier implementation, not the current requirement.

The existing application was repaired and extended in place. **These changes are local and have not been deployed.** Production data, applied migrations 001–014, provider credentials and production jobs were not changed. There is no new sample telemetry, backup history or fabricated recovery result.

The new functionality has real API/SQL implementations and isolated tests. It is not yet production-ready: migrations, real MFA acceptance testing, worker infrastructure and a hosted database-plus-Storage recovery drill remain necessary. [OPERATIONS.md](OPERATIONS.md) specifies those dependencies and release steps.

## Confirmed defects and missing controls

| Severity / area | Confirmed cause | Implemented repair / evidence |
| --- | --- | --- |
| High — privileged access | Workspace authorization previously depended on a valid ordinary sign-in and role; there was no MFA gate or application session revocation check. | AAL2 workspace enforcement, recent MFA for critical system changes, provider-session lookup and platform cutoff/suspension, plus restrictive direct-access RLS. API and database denial tests. |
| High — operations safety gap | No durable maintenance policy, incident/job history or approved worker dispatch existed. | Additive operations schema, atomic audited workflows, strict request schemas, versioned settings, lease/idempotency/approval controls. Real database tests. |
| Medium — tour layout and routing | The previous tour searched and measured targets on every animation frame, scrolled only the window and competed with layout's route scroll reset. | Observer/event-driven measurements coalesced through RAF, nested-container scrolling, route readiness, bounded missing-target recovery and viewport clamping. Browser route/scroll/resize tests. |
| Medium — tour usability | Closing marked the tour as seen without preserving a per-account step; role coverage was too broad and content remounted on each step. | Explicit role sequences, persisted pause/completed/dismissed status, resume/restart, stable content, focus containment/return, inert page and reduced motion. Unit and browser tests. |
| Medium — loading failures | General client and Supabase requests had no application timeout and many query functions discarded cancellation signals. | Bounded provider/API requests, cancellation propagation, controlled retries, error boundary and retry states. Preview unavailable-state browser tests. |
| Medium — saved address form | Account address form included `is_default`, rejected by the API's strict schema; coordinates were optional in the form but required by the schema. | Accepted the existing database field and aligned required coordinates. Type/schema inspection and full regression suite. |
| Medium — confirmation UX | Destructive/account actions used native confirm/prompt boxes with inconsistent context and validation. | Shared accessible Radix dialog, record context, reason/typed confirmation support and duplicate-submission locks for operations. Browser cancel/confirm verifies zero/one request. |
| Low — branding | Active pages, metadata and the donation checkout label retained the old shelter brand. | PawsConnect wording across active interfaces and Stripe label; source scan and browser checks on public/auth/legal pages. Historical project notes are preserved. |
| Performance | Storefront entry imported shop/adoption modules and their maps eagerly. | Shop/adoption routes now load on demand, alongside existing service/account splitting and new lazy IT Operations. Final entry JS is 813.55 kB (247.72 kB gzip), down from 997.59 kB (301.29 kB gzip) in the earlier build during this repair. |

Verification also caught issues introduced during development: a leading-slash maintenance mapping error, cross-service payment classification, non-finite MFA timestamp handling, an overly restrictive worker polling limit, and a PostgreSQL regex repetition limit in backup artifact validation. Each was corrected before the final checks. Tests were not weakened to accept faulty behavior.

## Implemented capabilities

- **IT Operations:** eleven routes for overview, HTTP monitoring/signals, incidents, database/server diagnostics, recorded jobs, integration status, backups, staging recovery, maintenance, releases and operational settings. Every view has loading/error/empty handling; lists are paginated and layouts checked on three viewport classes.
- **Monitoring:** measured database diagnostics, privacy-limited HTTP aggregates, safe operational error codes, untrusted browser error signals, acknowledge/assign/resolve actions and existing authorization-refusal monitoring. No uptime percentage or provider health is invented.
- **Incidents:** classification, severity, responder, investigation timeline, resolution and postmortem, with audit history committed atomically.
- **Maintenance:** scheduled read-only/partial/full/lockdown, public notice, feature write flags, per-request API enforcement and direct-write guards. Settlement and expiry remain available. This does not freeze external services or in-flight writes.
- **Jobs:** allow-listed reservation expiry and retention wrappers with real outcomes and locks. Manual execution works through the authenticated API; live cron must be repointed to the wrapper to populate its history.
- **Backup/release integration:** optional real Supabase inventory reader; authenticated external-worker claim/completion endpoints; immutable request fields, exact idempotency, independent approvals, leases and evidence validation. The external executor is not installed. Backup success is a trusted worker report backed by required evidence fields, not independent artifact verification by the API.
- **Recovery controls:** verified recovery-point prerequisites, staging-only dispatch, no automatic replay of uncertain outcomes and blocking of conflicting target operations. Production restore is disabled in API capabilities and SQL dispatch until coordination can survive restoration of the application database.
- **Security:** authenticator enrollment/challenge UI, AAL2 workspace checks, ten-minute recent verification, account suspension/reinstatement/session cutoff, direct-access RLS, no browser access to worker lease capabilities, and explicit function privilege revocations.
- **Tours:** role-safe routes, local and server progress, resume/restart, missing-target fallback, navigation timeout, visual viewport bounds, short-screen scrolling, keyboard navigation/Escape, focus containment, stable content and reduced-motion styling.
- **Reliability:** bounded requests, cancellation, error recovery, shared confirmations, constrained sidebar scrolling, route chunking and isolated CI/test startup.

## Database changes

| Migration | Contents |
| --- | --- |
| `202610110015_operations_center.sql` | Operations config, incidents/timeline, telemetry/signals, jobs, requests/leases and tour progress; RLS and explicit service-only functions; audited transitions, maintenance triggers, measured diagnostics and fixed job wrappers. |
| `202610110016_session_and_alert_controls.sql` | Account suspension/session cutoffs, service-only session checks, authenticated current-session helper, restrictive public/Storage policies, signal review and schema version 016. |

The populated-upgrade test applies 015–016 over a database at 014 and compares existing profiles, roles, addresses and audit rows. The previous upgrade test still applies all subsequent migrations over populated 008 commerce/adoption records. A paste-ready transactional bundle is generated by `scripts/prepare-operations-migrations.mjs`; it is ignored by Git and has not been executed against Supabase.

## Verification

| Check | Result |
| --- | --- |
| Baseline `npm test` before changes | 138 tests passed. |
| Final `npm test` | **172 passed, 14 files** (79.64 seconds in the last full run). Credentials forced blank. |
| Final targeted telemetry checks | **2 passed**, covering nested-router service labels, sensitive-data exclusion and telemetry failure behavior. Total verified unit/API/database cases: **174**; the full run preceded this final two-test addition. |
| `npm run typecheck` | Passed for client and server. |
| Final `npm run build` | Passed for client and server. Route chunks generated successfully. |
| Isolated archive recovery drill | Passed: exported an actual PGlite/PostGIS database, closed it, restored into a new instance, validated records, RLS ownership and reservation expiry. |
| Browser suite | **42 passed** in 1.8 minutes, desktop/tablet/mobile, zero retries. Includes all IT routes, confirmation cancellation/single submission, role redirects, tours, unavailable states and branding. |
| Visual review | Reviewed desktop/mobile tour captures and the tablet operations page; controls fit their viewport and unconfigured services are clearly marked. Screenshots are in git-ignored `test-results/`. |
| Active branding source scan | No old-brand match in `client/src`, `client/index.html` or `server/src`. |
| Lint | No lint script/configuration exists; no lint pass is claimed. |
| GitHub CI | Workflow added; not pushed or run remotely. |

One recorded isolated drill exported **70,563,840 bytes**, with SHA-256 `ff6d30b4168c8db73e09417935afb6d1452346d1a6645152bdf80bda94531d7c`, and took **3,964 ms** to reload and validate. These measurements describe that small local fixture archive, not production RTO or hosted recovery. The final full suite repeated the drill successfully after the last SQL correction.

The build still reports a large entry chunk above its 700 kB warning threshold and two third-party Zod annotation warnings. They do not fail the build; further bundle profiling and production performance testing remain appropriate. No load-test result is claimed.

An earlier simultaneous database/browser run exhausted local resources and timed out. Vitest is now limited to two database workers; browser workers are also two. Suites were rerun sequentially. The eleven-route browser check has a 60-second budget, matching its multiple full navigations; assertions and zero-retry policy remain intact.

## Changed files

| Area | Files |
| --- | --- |
| App/bootstrap/layout | `client/index.html`, `client/src/App.tsx`, `client/src/main.tsx`, `client/src/styles.css`, `client/src/components/layout/Layout.tsx`, `client/src/pages/features.css` |
| New shared UI | `client/src/components/Confirm.tsx`, `ErrorBoundary.tsx`, `MaintenanceNotice.tsx`, `MfaSettings.tsx`; updated `RecordActions.tsx` |
| Tours | `client/src/components/tour/Tour.tsx`, `steps.ts`, `tour.css` |
| Operations UI | `client/src/pages/Operations.tsx`, `operations.css` |
| Existing pages | `client/src/pages/Account.tsx`, `Adoption.tsx`, `Catalogs.tsx`, `Home.tsx`, `Info.tsx`, `Services.tsx`, `Shop.tsx` |
| Client data | `client/src/lib/api.ts`, `supabase.ts`, `client/src/contexts/CartContext.tsx`, `SyncContext.tsx` |
| Server config/entry | `server/.env.example`, `server/src/app.ts`, `server/src/config/env.ts`, `supabase.ts` |
| Auth/monitoring | `server/src/middleware/auth.ts`, `mfa.ts`, `rateLimit.ts`, `security.ts`; `server/src/modules/analytics/admin.ts` |
| Operations backend | `server/src/modules/operations/routes.ts`, `maintenance.ts`, `telemetry.ts`; `server/src/jobs/scheduler.ts` |
| Existing contracts/brand | `server/src/utils/validation.ts`, `server/src/integrations/stripe.ts` |
| Database | The two new migrations listed above; no applied migration edited. |
| Tests | `tests/unit/operations.test.ts`, `tests/database/operations.test.ts`, `recovery-drill.test.ts`, `foundation.test.ts`, `upgrade.test.ts`; `tests/api/connected-access.test.ts`, `telemetry.test.ts`; `tests/e2e/operations.spec.ts`, `tour.spec.ts`; `tests/helpers/db.ts`, `start-e2e.mjs`; `vitest.config.ts`, `playwright.config.ts` |
| Delivery/docs | `.github/workflows/ci.yml`, `scripts/prepare-operations-migrations.mjs`, `README.md`, `docs/STATUS.md`, `OPERATIONS.md`, `REPAIR_REPORT.md` |

## Remaining blockers and limits

1. **Hosted rollout:** a person must review/apply 015–016, then authorize the new deployment. The live site still runs the earlier release. Local build success is not live acceptance.
2. **Real authentication checks:** verify TOTP enrollment/challenge/recovery and the Supabase `auth.sessions`/Storage policies in a separate staging project. Browser role tests use intercepted fixtures; they do not exercise a hosted identity provider. Only one demo super administrator exists.
3. **Backup executor and offsite storage:** implement/provision the external worker, encrypted artifact storage, keys, manifests, retention and external journal. An optional scoped Management token connects inventory only. Provider database backups alone exclude Storage objects; see [Supabase's backup documentation](https://supabase.com/docs/guides/platform/backups).
4. **Hosted recovery:** perform a database-plus-Storage staging drill including Auth, RLS, user workflows and payment reconciliation. Production execution requires an external durable recovery coordinator/write fence and is unavailable until then. API maintenance expires and cannot be used as that fence.
5. **Release executor:** configure a trusted runner with fixed project mappings, immutable commits, schema-compatibility checks and post-deployment validation. No Vercel release or rollback was attempted.
6. **Observability:** external uptime/log drains, provider resource telemetry, failed-login ingestion, notification/email/SMS delivery and paging remain unconfigured/unimplemented. Per-instance rate limits need a shared store for production scale.
7. **Existing product gaps:** refunds still stop at requests; no storefront variants, map-based zone editor, rescue/transport map or recurring donations. Existing uploaded staff forms still need manual authenticated browser acceptance. Hero-image licensing remains unverified. These gaps are retained in `STATUS.md`.
8. **Performance/accessibility:** targeted responsive, tour and keyboard checks are included; comprehensive accessibility, low-end-device profiling and load testing remain outstanding.

Existing signature-verified Stripe settlement, centavo amounts, atomic business SQL, geofencing and role separation were preserved. Test-mode payments remain excluded from live revenue. Rollback must retain the new access controls or use an external traffic fence; an older API release can otherwise bypass controls added here. See [the deployment and rollback procedure](OPERATIONS.md).
