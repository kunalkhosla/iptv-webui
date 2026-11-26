# Programme reminders

"Remind me" on a future programme in the live guide. Stored per profile on the
server (`data/reminders.json`). Two minutes before start the server sends a Home
Assistant push (if configured) and every open client of that profile shows a
banner. **A reminder never opens a stream**; only the viewer's OK does.

## API

- `GET /api/reminders` -> `{ reminders: [R], due: [R] }`. `due` = fired in the
  last 10 minutes and not acknowledged.
- `POST /api/reminders` `{ stream_id, title, start_ts, stop_ts }` (seconds; start
  in the future, at most 14 days ahead). Idempotent for the same profile,
  channel, start and title. Snaps to the bulk guide's times for that airing.
  `stop_ts` is clamped to at most 12 h after start. At most 100 pending and 200
  in total per profile (the oldest finished ones make room).
- `DELETE /api/reminders/:id`
- `POST /api/reminders/:id/ack`: banner handled (OK or Dismiss) on any client.

All return the `GET` payload.

```
R = { id, stream_id, channel, title, start_ts, stop_ts,
      status: "pending" | "fired" | "missed" | "dropped",
      note: null | "Time changed" | "Channel moved" | "No longer in the guide"
            | "Channel no longer available" | "Server was offline at start time"
            | "Moved earlier in the guide; already started",
      starts_in_secs }
```

## Firing

A 20 s timer fires reminders from start - 2 min until start + 5 min (later than
that they become `missed`). Push: `POST {HA_URL}/api/services/notify/<service>`
with `HA_TOKEN`. Push only for a reminder set on the owner account by one of
the owner user's own profiles: the service is that profile's entry in
`HA_NOTIFY_PROFILES` (`Nick=service,...`, matched on nick or profile id, only
against the owner user's profiles) or else `HA_NOTIFY_SERVICE`. Other users'
profiles and deleted profiles never push (in-app banner only). Without HA
config only the in-app banner shows. Log: `[reminders] fired ...`; a non-OK HA
reply logs its status. An unreadable `reminders.json` is kept as
`reminders.json.corrupt-<ts>` before the store starts empty.

## Guide changes

After each guide rebuild, pending reminders (owner account) are checked
against the bulk XMLTV guide: the same title within 3 hours on that channel
moves the reminder ("Time changed"; moved to a time already more than 5 min
past, it is `missed`: "Moved earlier in the guide; already started"); if the guide covers that slot and the
programme is gone it is `dropped` ("No longer in the guide"); a channel id that
left the catalog is re-homed to a copy of the same channel ("Channel moved") or
dropped. Channels with no bulk-guide data keep their reminders as set.

## Clients

Poll `GET /api/reminders` every 30 s in the foreground and on resume; show each
`due` id once per client: "<title> starts on <channel> in N min" with OK (ack,
then tune to `stream_id`) and Dismiss (ack). Guide programmes with a pending
reminder show a bell; a "My reminders" list shows status and notes.

Web: a bell on every future programme block in the TV Guide (filled when a
pending or fired reminder covers it), a "Reminders" button in the guide toolbar
for the list (status, note, delete), and banners in the top right. Kid profiles
work the same way.
