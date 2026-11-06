# Business operations

The organisation keeps a business register in `org.json`, alongside its existing plans and board records. Jobs, customers, metrics, financial entries, knowledge, incoming events and previous record revisions persist across cycles. Existing data is migrated on load; existing cycle settings are preserved. Plans still in live state become linked calendar commitments, with completed plans awaiting verification. Previously archived plans retain their existing archives.

## Working with the calendar

A job is a commitment with an owner, acceptance description, next action and optional earliest start/deadline. Dates must be ISO timestamps with a timezone offset. The interface converts your local date and time to UTC.

Jobs follow open → in progress → awaiting verification → done. A job can also be blocked or cancelled. The engine derives execution progress through its linked plan. The calendar does not maintain a second task status. A plan that ends unsuccessfully leaves a blocked commitment with its reason.

Dependencies refer to other job IDs. Cycles and self-dependencies are refused. Only verified completion releases a dependent job. Dates or unfinished dependencies cannot be used to postpone a plan already executing; give the CEO steer to amend or cancel that execution.

An owner or person submits delivery evidence. Verification requires a note from the owner, assigned independent reviewer, or a person. Worker agents cannot verify jobs. Once assigned, an independent reviewer can be changed only by the shareholders, CEO or COO.

A recurring job requires a deadline and a positive number of days. Verification creates one future occurrence, linked to the completed one. If several dates were missed, they coalesce into one future occurrence; the engine never launches a burst of historical repeats. The interval is elapsed UTC time in 24-hour days, not a local-time calendar recurrence rule.

## Reviews, recovery and operating digest

`reviewIntervalMinutes` is zero for continuous execution or 1–43200 for scheduled reviews. The interface and establish command create organisations with 60 minutes; API callers and older organisations default to zero.

After a cycle, scheduled mode records the next standing review and waits. Waiting makes no model calls. A job start/deadline, incoming event, shareholder steer or explicit review request can wake it earlier. A date already delivered to the engine is not delivered repeatedly.

Manual pause, Stop, budget exhaustion and cycle limits always take precedence. Review requests and events remain queued while paused. Resume considers missed dates once. `resumeOnRestart` defaults to false; when enabled, a restart resumes only an organisation previously running/waiting or paused specifically for a restart. The service must be running to receive events and fire timers.

At each cycle close, a deterministic digest records open, overdue, blocked and unverified jobs, upcoming dates, model spend, financial totals and open Signatory requests. The Business tab also computes a live digest. Runtime failures use the existing error banner and board feed; there is no external email/pager connection.

## Registers and authority

- Jobs and customers have a named executive owner. A lead and its workers maintain that lead's records. The CEO and COO can coordinate across remits.
- Measurements have a target, nullable value, unit, basis, source and observation time. A value with no source or time is refused. Only people confirm observations.
- Financial entries use integer hundredths of their stated currency, a direction, and forecast/outstanding/confirmed/void status. Totals stay separate by currency and exclude forecasts/voids. Model cost is reported separately. Only a person can confirm or alter confirmed transactions. No operation sends payments.
- Knowledge records retain policies, facts, decisions and lessons. Previous revisions are preserved. Standing policies can be changed only by the CEO or shareholders.
- Incoming events are deduplicated by the exact pair `source` and `externalId`. Each new event creates a job and requests a review. Event delivery is acknowledged only after saving state. A replay returns the existing event even if its body differs.
- An edit must include its current `id` and `revision`. Stale edits are refused instead of silently overwriting another actor's work.
- Registers reject additions beyond 10,000 records. History is retained on disk; review/export it as an organisation grows. This remains a single-process application, not a distributed scheduler.

Current records are supplied to executive calls. Local agents also get `read_business` (query and pagination) and `update_business`. Structured executive responses can return validated `operations` arrays. Invalid batches are rejected atomically and the board records the correction. Hosted leads can return updates with `record_phase`; replaying a recorded phase does not apply them again.

## Local API

All routes inherit the existing localhost/origin controls. They are for a person or trusted local integration. This is not an authenticated public webhook receiver. A vendor connector must validate its vendor's events before forwarding them here. No vendor account is connected by this feature.

Read `GET /api/orgs/:id/business` for all registers and the live digest. Send a command to `POST /api/orgs/:id/business`; it returns the updated organisation view. Owners must be actual executive IDs in that organisation.

Example incoming event:

```json
{
  "kind": "event",
  "record": {
    "source": "customer-inbox",
    "externalId": "message-001",
    "ownerId": "cro",
    "title": "Quote for 100 boxes of paperclips",
    "detail": "Draft a quote for review; the customer has not placed an order.",
    "dueAt": "2030-11-08T10:00:00Z"
  }
}
```

Other command kinds are `job`, `customer`, `metric`, `finance`, `memory`, and `verify`. Their input shapes are in [business-schema.ts](../src/shared/business-schema.ts). Omit `id` and `revision` when creating a record; edits send the existing values and the complete editable fields. The interface supplies these automatically.

`POST /api/orgs/:id/review-now` requests a review without resuming a manually paused organisation. `PATCH /api/orgs/:id/settings` accepts `reviewIntervalMinutes` and `resumeOnRestart` with the existing settings.

`POST /api/examples/only-paperclips` establishes the fictional example without starting it. It is available only with the simulator. Use the home-page button or `npm run example:paperclips`.

## Validation

The business tests cover old-state migration, optimistic revisions, remit checks, dependency cycles, evidence and independent review, financial provenance, event deduplication across reloads, recurring jobs, calendar wake-ups, manual pause, restart policy, cycle limits, archived execution evidence and the Only Paperclips handover. HTTP tests exercise the same commands and origin controls.

After `npm run build`, `npm run test:browser` uses installed Chrome (override with `CHROME_PATH`) to exercise the example button, month view, a submitted job form, all registers, live execution and a narrow layout. The normal test suite includes this smoke test when Chrome and the built client are available, otherwise it skips that one test. `npm run docs:screenshots` updates the two README images from the same simulation.

