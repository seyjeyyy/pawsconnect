# PawsConnect interface system

The existing PawsConnect orange, navy, warm surfaces and Lucide icons remain the visual language. Workspace screens use a quieter pale background, white surfaces, a consistent 14px card radius and a light border. Public pages retain the shelter identity and existing content.

## Layout

- Persistent workspace header: account identity, notifications, optional tour, website link and sign-out. Breadcrumbs identify the current area.
- Desktop: grouped sidebar beside flexible content. Collapse leaves a keyboard-accessible reopen control. Group headings preserve the current section.
- At 900px and below: the sidebar becomes a modal drawer with a labelled title, focus trap, Escape dismissal and focus return. Navigation closes the drawer. Content uses one column.
- The main region stays mounted during lazy route loading. Skeletons occupy the section being fetched. Data failures show a retry action; they do not remove the navigation shell.

## Information hierarchy

- Staff see only modules assigned by the database. The overview contains a small set of applicable operational counts and links to the work behind them. Financial reporting is an independently loaded expandable section.
- User account navigation groups shopping, adoption/pets, community and personal settings. Approved volunteer tasks belong to this account.
- Super administrator navigation retains security/access, audit and IT operations. It has no implicit shelter authority.

## Controls and feedback

- Use existing primary/secondary/text buttons, clear action labels, visible keyboard focus and status text alongside color.
- Tables have bounded horizontal scrolling on narrow screens; actions remain touch-friendly. Search, status, direction and pagination controls use real server queries. Exports describe the current page.
- Record dialogs use Radix focus handling. Cancel/close controls are keyboard accessible. Failed submissions keep entered values. Existing destructive-action confirmations are retained.
- Listing uploads are optimized before transfer while evidence and document bytes are preserved. Public cards already lazy-load images below the fold.
- The workspace tour is started from the header; no automatic tour overlay is added. Existing public-page tour invitation remains optional.

## Follow-up validation

Browser coverage includes desktop, tablet and mobile widths, menu navigation, drawer Escape/focus, restricted menus, authentication transitions and anonymous service failures. A full WCAG audit, assistive-technology testing, every authenticated workflow form with real hosted data, and a complete redesign of each public content page remain beyond these checks. Screenshots from isolated fixtures are test artifacts, not operational records.
