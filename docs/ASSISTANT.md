# PawsConnect AI Assistant

One assistant for every signed-in account. It answers from the platform guide and from records the account is allowed to see, and it cannot change anything.

## Setup

| Step | What to do |
| --- | --- |
| 1. Database | Paste `supabase/migrations/202610120019_assistant_history.sql` into the Supabase SQL editor. It only adds two tables. Until it is applied the assistant still answers but keeps no history. |
| 2. Key | Create an API key at console.anthropic.com. Set `ANTHROPIC_API_KEY` in `server/.env` and in the Vercel project (Settings → Environment Variables). Usage is billed to that Anthropic account. |
| 3. Deploy | `npx vercel build --prod` then `npx vercel deploy --prebuilt --prod`. |

Without a key the chat button still appears for signed-in accounts and the panel says the assistant is not set up; nothing else is affected.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Server only. Never put it in a `VITE_` variable. |
| `ASSISTANT_MODEL` | `claude-opus-5-5` | Model id. A smaller model such as `claude-haiku-5-5` costs much less per message. |
| `ASSISTANT_RETENTION_DAYS` | `90` | Messages older than this are deleted the next time their owner opens the assistant. |

## How it works

- `client/src/components/assistant/`: the floating button ships with every page; the panel, its styles and its requests load only when it is opened. The browser sends the message and the current route path, nothing else.
- `server/src/modules/assistant/routes.ts`: `GET /api/assistant/bootstrap`, `GET` and `DELETE /api/assistant/messages`, `POST /api/assistant/chat` (a streamed reply). Every route requires sign-in. The account type, permissions and conversation history are read on the server for the signed-in account; none is accepted from the browser.
- `server/src/modules/assistant/tools.ts`: the complete list of things the assistant can look up. Each tool is read-only, decides whether the account may use it, and filters by the signed-in account in code. The model cannot supply a user id, a table name or a query.
- `server/src/modules/assistant/knowledge.ts`: the platform guide the assistant answers from. Update it when a page, route or workflow rule changes.

## What each account can ask

| Tool | User | Staff | Super administrator |
| --- | --- | --- | --- |
| Animals available for adoption, shop products | yes | yes | yes |
| Own applications, orders, reports, donations, transport, payments, notifications, volunteer status | yes | yes | yes |
| Own account counts | yes | | |
| Counts of work waiting in assigned modules | | assigned modules only | |
| Shelter records (pets, adoptions, rescue, transport, orders, volunteers, donations) | | only modules with the matching permission; administrators and shelter staff, not field roles | |
| System overview; accounts and roles, security alerts, access requests, audit trail | | | yes |

The super administrator gets no shelter records and staff get no system records, matching the workspace. Reporter contact details, addresses, documents, product cost and payment payloads are never selected.

## Limits and safeguards

- 20 messages per account per five minutes; one reply at a time per account; a reply stops when the panel is closed or the Stop button is pressed.
- Only the 12 most recent messages of the current conversation are sent to the model with each question.
- Token usage is stored on each assistant message (`assistant_messages.input_tokens`, `output_tokens`).
- History is readable only by its owner, in the API and under RLS. The owner can start a new conversation or delete all history from the panel.
- Model text is rendered as plain text with bold, lists and in-app links; it is never inserted as HTML.

## Not built

- The assistant does not perform actions. It does not submit reports or applications, fill forms, change statuses or roles, cancel orders or issue refunds; it explains the step and links to the page.
- Field roles (veterinarian, rescue personnel, driver) can ask about the platform and their own records but have no tool for their assigned cases.
- No reporting over time (monthly trends) and no financial figures.
- The provider conversation has not been exercised with a real key in this repository's tests: automated tests cover tool access, data isolation, the HTTP routes and the panel with a stand-in reply.
