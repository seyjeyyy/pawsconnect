# Account model and protected-action matrix

There is one sign-in form and one Supabase identity per person. Primary experiences are **User**, **Staff**, and **Super administrator**. Existing role rows remain compatibility assignments for transactional workflows and field ownership, so no historical relationship changes. Staff specialties are assignments, not additional accounts. Approved volunteer enrollment unlocks tasks on the User account.

`account_permissions(uuid)` is the database authority. `staff_access` stores explicit grants. Effective grants are intersected with legacy authority, so revoking an old assignment also revokes its permissions. Existing staff are backfilled with their current authority. A new staff member starts with exactly the modules selected by the system administrator. Empty grants close operational modules without deleting an identity. New privileged workflow functions are not callable by anonymous or authenticated clients.

## Matrix

Every row also requires a current, non-revoked session. Public/owner routes continue to enforce record ownership. Super administrator does not imply any shelter permission.

| Protected action / API family | Required authority | Additional restrictions |
| --- | --- | --- |
| Account profile, addresses, cart, saved pets, purchases, applications, donations, reports, inquiries, payments, refunds | Signed-in User (all account types retain identity) | Actor ownership; Stripe payment verification unchanged |
| Volunteer tasks, assigned rescues | Approved enrollment / retained field assignment | Own tasks/assigned reports only; enrollment deactivation revokes volunteer compatibility membership |
| `/admin/overview` | Any assigned operational module | SQL returns only metrics belonging to authorized modules |
| Read animals, animal picker, intakes | `animals.view` | Private health is a separate permission |
| Create/edit animal records and listing uploads | `animals.manage` | Reserved/adopted state controlled by adoption workflow |
| Health records, behavior assessments | `animals.health` (behavior also `animals.manage`) | Permanent health history; staff/veterinarian compatibility authority |
| Adoption review, interviews, reservations, handover | `adoptions.review` | Existing transition, reservation and payment rules |
| Approve/reject adoption | `adoptions.review` + `adoptions.decide` | Administrator authority still needs independent elevated-role approval |
| Rescue review, assignment and resolution | `rescue.manage` | Atomic state checks and eligible assignee |
| Field rescue progress | `rescue.assigned` | Existing field/volunteer assignment and report ownership checks |
| Transport coordination, quotes, vehicles, drivers, alternatives, handover | `transport.manage` | Coverage, driver verification, schedule conflicts, verified fees |
| Field trip progress | `transport.assigned` | Assigned driver only |
| Products, categories, stock, orders, shipments, review moderation | `store.manage` | Atomic inventory and order transitions |
| Donations read | `donations.view` | Monetary amounts paid only by verified webhook |
| Receive/cancel in-kind donations | `donations.manage` | Expected current status required |
| Payments, refunds, expenses, financial aggregates | `finance.manage` | Live payments only in revenue; refund requests do not issue provider refunds |
| Volunteer approval and tasks | `volunteers.manage` | Approved enrollment required to assign tasks |
| Service zones | `zones.view` to read; `zones.manage` to write | Existing administrator authority for writes, verified GeoJSON |
| Inquiry reply | `contacts.manage` | Transactional reply + notification |
| Workspace CSV export | `reports.export` or system authority for system records | SQL authorization plus module read permission; current filtered page only; anyone allowed to read can inherently copy those records |
| Users, role/specialist assignments, staff module grants | Super administrator | Cannot edit own staff grants; system-only account cannot silently become shelter staff |
| Elevated access approvals | Super administrator | Requester and approver must differ; final-holder rules unchanged |
| Security events, alerts, audit, IT operations | Super administrator | Existing operations approvals/session/worker controls unchanged |
| Public/private uploads | Owner or corresponding assigned module | Private URL expires in 120 seconds; rescue field readers need an assignment |

## Migration and rollout

1. Back up the database and record the currently deployed release. Review migration 018 and the assignment snapshot against the shelter's actual responsibilities. Do not merge accounts by names or email aliases.
2. Apply all preceding migrations, then `supabase/migrations/202610110018_staff_permissions.sql` in the Supabase SQL editor. Use one transaction. This workspace has no live SQL CLI authority.
3. Verify account counts, role membership, transaction counts/ownership and grants; run `npm run check:deployment` against the deployment's project. It requires schema 018 and the `staff_access` table.
4. Deploy this compatible application. In Users, review each staff member and narrow modules to their actual duties. Existing grants are preserved initially to avoid silently removing working operations. Account protection, elevated approval and specialist assignment remain available.
5. Test independent grant removal in a second browser: the target's notification invalidates private queries immediately when delivered; every subsequent API request reloads current database permissions regardless of Realtime. Visible private queries also refresh every 60 seconds. Offline clients cannot receive an immediate UI update; backend denial remains authoritative.
6. Review possible duplicate identities manually with verified identity and explicit owner approval. No automated merge script is provided because there is no verified duplicate set.

## Rollback

Before any staff grant is changed, stop application traffic and execute `supabase/rollback/018_before_permission_changes.sql`, then restore the previous application. Migration 018 retains exact previous function and policy definitions for this purpose. The script keeps ownership indexes, accounts, history and approved volunteer memberships. It refuses rollback once grants have been edited because restoring broad legacy access would violate those restrictions.

After grants change, retain schema 018 and deploy a forward fix. Do not deploy old API code that ignores module permissions. A broader recovery requires an independently reviewed grant reconciliation and database backup restore plan; the rollback script deliberately cannot erase restrictions to make a downgrade convenient.

## Limits

The compatibility role table is intentionally retained, not destructively removed. This is a staged migration to three primary experiences, with explicit module controls. Operational specialists retain assignment-specific limits. System administrators continue to have a separate IT Operations area within their system workspace. Granular per-field finance permissions, a schema with no legacy memberships, a production identity merge and hosted acceptance testing are not claimed here.
