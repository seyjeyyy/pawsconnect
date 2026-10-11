# PawsConnect operations guide

This guide describes the local operations implementation in migrations **015 and 016**. They have not been applied to the hosted database. No deployment, production write, credential rotation or hosted recovery was performed during this repair.

## Setup and release order

**Account page showing a database error after deployment:** run `npm run check:deployment`. Codes `PGRST202` (required function missing) or `PGRST205` (required table missing) mean the API cannot see the expected schema. If migrations 015–016 have not been applied, generate the bundle below and paste it into the SQL editor once. If they have already been applied successfully, do not rerun their `CREATE` statements: run `NOTIFY pgrst, 'reload schema';` and recheck instead. See [PostgREST's schema cache documentation](https://docs.postgrest.org/en/stable/references/schema_cache.html). If the check still fails, verify that the API and SQL editor target the same project. Never bypass the session check to make sign-in appear to work.

1. Use a separate staging Supabase project and Vercel environment. Local `server/.env` currently points at production; ordinary `npm run dev` is not an isolated test environment.
2. Review migrations 015 and 016. Run `node scripts/prepare-operations-migrations.mjs` to generate the git-ignored `supabase/APPLY_015_TO_016.sql`. A person must paste it into the Supabase SQL editor. It wraps both files in one transaction. Apply to staging first; preserve a verified database **and Storage** backup before a production change.
3. Configure Supabase TOTP enrollment. Verify a real account can enroll, challenge, sign out, sign in again and reach its allowed workspace. Keep separate system and shelter administrator accounts. Test a second super administrator for independent approvals. There is only one demo super administrator today.
4. Configure optional integrations from the table below. Leave worker capabilities empty until a separate worker has passed the required staging checks. No worker executable or external runner is included in this repository.
5. Run `npm run typecheck`, `npm test`, `npm run build`, then `npm run test:e2e` sequentially. Tests blank provider credentials. Browser tests start their own isolated servers; intercepted signed-in fixtures do not alter production auth.
6. After staging acceptance and authorization, apply the migrations to production **before** deploying the corresponding API. Run `npm run check:deployment` with the target project's environment and require an exit code of zero. Build with `npx vercel build --prod`, then deploy with `npx vercel deploy --prebuilt --prod`. These commands were not run during this repair.
7. Replace the existing expiry cron commands with the instrumented wrapper below. Verify actual history, maintenance restrictions, upload access and MFA against staging before normal production traffic.

Both migrations are additive: they preserve existing business rows and roles. They add restrictive access policies, so a coordinated rollout and MFA enrollment are necessary. Never edit migrations after they have been applied.

## Access and session controls

`/admin/operations` is for `super_administrator` only. All workspace API routes require a Supabase-verified AAL2 session. System writes involving settings, roles, account restrictions, jobs, recovery and release requests also require a numeric MFA authentication-method timestamp within ten minutes. Renew it under **Account & MFA settings**.

Every signed-in API request checks the validated JWT's `session_id` against `auth.sessions` and platform account restrictions. Direct database and Storage access has an additional restrictive RLS policy. Privileged direct database access also requires AAL2. New privileged SQL functions are explicitly revoked from `PUBLIC`, `anon` and `authenticated`; only the no-argument `current_session_allowed()` helper is deliberately exposed to authenticated clients.

In **People & access**, account protection actions suspend, reinstate or revoke sessions with a reason and audit record. They preserve user records. Session revocation advances a cutoff against the provider session's original creation time, so refreshing an old token cannot regain access. Reinstatement still requires a new sign-in. Elevated role holders first require the existing independent role-removal approval; self-restriction is refused.

These are platform access controls, not Supabase Auth bans or provider-wide global sign-out. Provider inactivity and maximum-session settings remain managed in Supabase. Previously issued signed download URLs remain usable for their short lifetime (the API issues them for 120 seconds); previously issued upload tokens are provider capabilities and are not recalled by this change. Static/public assets remain public. The provider links JWT session IDs to `auth.sessions`; see [Supabase session behavior](https://supabase.com/docs/guides/auth/sessions).

## Maintenance

Choose normal, read-only, partial, full or lockdown; supply a reason, public notice, start and end. Times in the UI are Manila time. Non-normal schedules must end in the future and last at most 24 hours. Settings use an atomic version check: a stale draft cannot overwrite another operator's change.

| Mode | Enforced behavior |
| --- | --- |
| Normal | Normal service; independently disabled features still reject new writes. |
| Read-only | Reject ordinary API writes and direct browser writes. |
| Partial | Reject reads and writes for selected API services; reject corresponding direct browser writes. |
| Full / lockdown | Reject ordinary business API traffic and direct browser writes. Lockdown has the same traffic restrictions as full; it records the emergency intent. |

Auth, operations status, the protected IT API, signature-verified payment webhooks and expiry jobs remain available. Payment creation checks the actual resource's service (shop, donation, adoption or transport). API settings are read per request. Direct-write triggers cover browser-writable business tables and Storage objects. An unavailable configuration fails API business traffic closed.

Maintenance does **not** cancel in-flight operations, recall signed URLs, stop Supabase Auth or `pg_cron`, freeze service-role writes, or stop direct public reads. Scheduled windows expire automatically. It is suitable for application maintenance, **not** a production database recovery fence. A production recovery requires an independent ingress/write fence that cannot be rolled back with the database.

## Monitoring and incident records

The API stores hourly counts by fixed service and HTTP status class, cumulative duration and slow-request counts. It awaits a bounded telemetry write before ending a serverless response. This can add up to 1.5 seconds if telemetry storage is unhealthy; request duration measures application handling before that write. This is neither synthetic uptime nor percentile tracing. The operations public endpoints are excluded. Database round-trip time, size, connection count, current long-running query count and Storage object count are live diagnostic queries.

Signals contain fixed codes and sources, never bearer tokens, request bodies, query strings or raw exceptions. Browser reports are explicitly untrusted and rate-limited. Operators can acknowledge, assign and resolve a signal with investigation notes. Incidents have severity, affected service, classification, responder, timeline, resolution and postmortem. State changes and timeline/audit records commit together. No operational history is seeded.

Provider CPU/memory, storage bytes/growth, query samples, index advice, external uptime, login failures, email delivery and notification delivery acknowledgments are unavailable unless another integration is built. “Configured” means credentials exist, not that a provider passed a probe. Existing authorization-denial alerts remain separate from operational signals.

## Recorded jobs and retention

The three allowed jobs are `expire_order_reservations`, `expire_pet_reservations`, and `retention`. The wrapper records actual success/failure, affected rows, timestamps and safe error codes. Transaction locks prevent overlapping execution of the same kind. Manual execution requires fresh MFA and confirmation. No arbitrary SQL can be submitted.

After migrations, replace the existing named pg_cron schedules in the SQL editor (review them first):

```sql
select cron.schedule('expire-order-reservations', '* * * * *',
  $$select public.run_operations_job('expire_order_reservations', null)$$);
select cron.schedule('expire-pet-reservations', '*/5 * * * *',
  $$select public.run_operations_job('expire_pet_reservations', null)$$);
select cron.schedule('operations-retention', '15 2 * * *',
  $$select public.run_operations_job('retention', null)$$);
```

The in-process scheduler already uses the wrapper. It is not started by the Vercel entry point. Old cron executions are not backfilled. Retention deletes HTTP aggregates older than 30 days and unlinked signals older than 90 days; audit records and incident history are preserved. The backup `retention_days` setting is a separate policy passed to the external worker. Actual offsite deletion and retained-artifact inventory still need that worker and provider.

## Integration configuration

All secrets are server/worker environment variables, never `VITE_` variables or browser form fields.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_MANAGEMENT_TOKEN` | Optional project-scoped read-only backup inventory credential, with `backups_read`. |
| `SUPABASE_PROJECT_REF` | Exact project reference for that inventory. |
| `OPERATIONS_WORKER_SECRET` | At least 32 random characters shared by API and a trusted external worker. Keep it outside the recoverable database; rotate through the deployment secret manager. |
| `OPERATIONS_WORKER_KINDS` | Explicit comma-separated capabilities: `backup,restore_drill,deployment,rollback`. Enable only independently verified implementations. `restore_production` is ignored. |
| `RELEASE_COMMIT` | Full immutable release commit; falls back to Vercel's commit metadata if present. |
| `RELEASE_DATE`, `RELEASE_NOTES` | Actual build information. Missing values are displayed as not recorded. |

Managed inventory calls the [Supabase backup-list endpoint](https://supabase.com/docs/reference/api/v1-list-all-backups) with an eight-second timeout and validates the response. It does not create an export or certify integrity. Supabase database backups exclude Storage file contents; separate object backup is necessary. See [Supabase backup coverage](https://supabase.com/docs/guides/platform/backups).

## External worker contract

This repository implements authenticated dispatch, durable records and result validation. Provisioning and implementing the provider-specific worker remains required. Setting an environment variable alone does not make backup or release execution operational.

The worker uses TLS and a fixed API origin, with `Authorization: Bearer <OPERATIONS_WORKER_SECRET>` and JSON. Poll `POST /api/operations/worker/claim` with `{}` every 30 seconds, with jitter/backoff on failure. The worker limit is 20 requests/minute per instance/IP; ordinary API limits also apply. A response has `data: null` or an operation containing its ID, fixed kind and target, immutable requested release/recovery point, a lease token/deadline, recovery-point evidence, and the requested retention/RPO/RTO policy. Secrets are never included in browser records.

Dispatch is serialized. Backups may be queued by an approved interval while a worker polls. Other enabled operations require a different super administrator's decision, expiring after 30 minutes. Requester and approver roles are rechecked at dispatch. Idempotency binds the complete request. A worker lease lasts 30 minutes and cannot currently be renewed. Do not enable an operation that cannot safely finish and validate within this limit.

The external implementation must:

1. Maintain a durable external execution journal, keyed by operation ID. Verify source/target project IDs against fixed allow-lists; a staging alias must never resolve to production. Do not accept URLs, SQL or shell commands from request fields. Refuse changed environment mappings until reviewed.
2. For backup, export all required database schemas/roles and separately copy Storage file bytes plus manifests. Include Auth/application metadata appropriate to the restore method; do not assume a public-schema dump is enough. Encrypt offsite with separately held keys. Use immutable artifact identifiers, validate checksums and manifest completeness after upload, and enforce approved retention without deleting the last verified recovery point or a point referenced by an active recovery.
3. For staging recovery, download the approved artifact, compare its SHA-256 and manifest, restore into a dedicated disposable staging project, then verify schema, row counts, RLS, sessions, ownership, Storage bytes and business workflows. Measure RPO and full RTO. Disable real payments, messaging, cron and outbound actions in staging.
4. For deployment/rollback, fetch the exact approved full commit, build/test it, check migration compatibility, deploy through the provider and run health/smoke checks before reporting success. Rolling back application code does not roll back the database.
5. Post the actual outcome to `POST /api/operations/worker/:id/complete`. Use `{lease_token, succeeded, report, failure_code}`. A successful backup requires `integrity_verified`, `database_covered`, `storage_covered`, `encrypted_offsite` all true, lowercase 64-character `sha256`, nonempty immutable `artifact_ref`, and positive `bytes`. A restore requires `validation_passed: true`; report measured `rpo_seconds`/`rto_seconds`. A release requires `validation_passed: true` and the exact approved `release_ref`. These are trusted-worker attestations; the API does not independently download artifacts. Store no secret URLs or credentials in reports.

Wrong/stale leases, duplicate completions and incomplete evidence are rejected. A running lease that expires becomes `unknown` on the next poll and emits a signal. It is never automatically replayed. **Lease expiry is not worker cancellation.** Unknown/running disruptive outcomes block further disruptive work against that target, even through a new request ID.

There is no automatic unknown-outcome reconciliation button. An operator must stop/fence the external worker, inspect provider reality and the external journal, record an incident, and use a reviewed service-side remediation to resolve the job state. Blind retries and editing a status merely to unblock the queue are unsafe. Lost claim responses can also produce an unknown job; never infer that no work ran.

## Production recovery remains disabled

Both the API capability list and SQL claim function exclude production restoration. Adding `restore_production` to environment variables cannot enable it. The schema retains prerequisite checks for a reviewed future recovery workflow, but there is no production execution route.

This is a deliberate architecture boundary: a restore would rewind the queue, approvals, maintenance settings, account revocations and audit records in the very database coordinating it. Historically canceled jobs could reappear too. Before enabling production restore, implement an external durable coordinator with a new recovery generation/fence, external audit and approvals, immutable source/target binding, ingress and service write isolation, an independently verified safety backup, recovery of Storage bytes, and post-restore reinstatement of current access restrictions. Invalidate **all** pre-recovery jobs, not just the restore job. Reconcile provider payments and queued events before reopening. Restored data must never automatically reopen access.

The local automated drill exports a real isolated PostgreSQL/PGlite data directory, closes it, loads the archive into a new instance, verifies user records and RLS isolation, and runs an expiry workflow. It proves local database restoration for these migrations. It does **not** prove hosted Supabase Auth, Storage file recovery, offsite encryption, provider rollback, real-world RPO/RTO, or production readiness. A full hosted staging drill is still required.

## Rollback and incident recovery

Preserve the prior release artifact and database/Storage recovery point. Keep the additive schema and its data if application rollback is necessary; dropping the new tables would erase incident and access history. Prefer a corrective forward release. Code predating this change does not enforce the new service-role API session/MFA/maintenance checks, so it is not a safe unrestricted rollback once those controls are relied on. Use an independent maintenance/ingress fence and preserve the access enforcement layer while correcting the release.

Do not reverse restrictive policies or delete records as a troubleshooting shortcut. If database connectivity fails, the application cannot rely on its own operations dashboard for recovery: use the authorized provider console and an external incident record. Never paste privileged credentials into the dashboard, repository, logs or incident notes.
