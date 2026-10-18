# Reminders

The agent can set reminders ("remind me to call Ana at 3") (B-A5).

## Model (D)

| Field | Description |
|-------|-------------|
| id | integer |
| text | what to remind |
| due_at | UTC timestamp |
| tz | the IANA time zone at creation, for display |
| repeat | none · daily · weekdays · weekly (MVP) |
| status | `scheduled` · `fired` · `cancelled` |
| task_id | the agent task that created it (optional) |

## Behavior (D)

- Creating one is a gated action (`modifies`); the preview shows the parsed time in the user's local format.
- The scheduler checks every 30 s and fires any reminder whose `due_at` ≤ now and whose status is `scheduled`. Firing posts a system notification with Snooze (10 min) and Done.
- Missed reminders (the app was not running) fire once on startup, marked "missed", and never more than once each.
- Repeating reminders schedule their next occurrence when fired.
- Times without a date mean the next future occurrence ("at 3" at 4 pm = 3 pm tomorrow).
