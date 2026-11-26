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
  At most 100 pending per profile.
- `DELETE /api/reminders/:id`
- `POST /api/reminders/:id/ack`: banner handled (OK or Dismiss) on any client.

All return the `GET` payload.

```
R = { id, stream_id, channel, title, start_ts, stop_ts,
      status: "pending" | "fired" | "missed" | "dropped",
      note: null | "Time changed" | "Channel moved" | "No longer in the guide"
            | "Channel no longer available" | "Server was offline at start time",
      starts_in_secs }
```

## Firing

A 20 s timer fires reminders from start - 2 min until start + 5 min (later than
that they become `missed`). Push: `POST {HA_URL}/api/services/notify/<service>`
with `HA_TOKEN`; the service is the profile's entry in `HA_NOTIFY_PROFILES`
(`Nick=service,...`, matched on nick or profile id) or `HA_NOTIFY_SERVICE`.
Without HA config only the in-app banner shows. Log: `[reminders] fired ...`.

## Guide changes

After each guide rebuild, pending reminders (owner account) are checked
against the bulk XMLTV guide: the same title within 3 hours on that channel
moves the reminder ("Time changed"); if the guide covers that slot and the
programme is gone it is `dropped` ("No longer in the guide"); a channel id that
left the catalog is re-homed to a copy of the same channel ("Channel moved") or
dropped. Channels with no bulk-guide data keep their reminders as set.

## Clients

Poll `GET /api/reminders` every 30 s in the foreground and on resume; show each
`due` id once per client: "<title> starts on <channel> in N min" with OK (ack,
then tune to `stream_id`) and Dismiss (ack). Guide programmes with a pending
reminder show a bell; a "My reminders" list shows status and notes.
