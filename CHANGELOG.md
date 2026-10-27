# Changelog

Each release's notes come from its section here (the release workflow fails without one).

## 0.2.0

First version meant for other people. The emulator now follows Autoblow's API documentation much more closely, and can be run without cloning anything.

**Closer to the real API** (checked endpoint by endpoint against developers.autoblow.com)
- Commands answer with the **device state**, as documented (they used to answer `{"success":true}`); go-to on the AI Ultra and `state-updates` on the VacuPump are the documented exceptions.
- State fields and `operationalMode` values are the documented ones: `strokePlusValve` / `strokeMinusValve`, `TARGET_SPEED_PLAYING` / `TARGET_SPEED_PAUSED`, `GO_TO`, `ONLINE_CONNECTED`, local-script and sync modes, and so on. `syncScriptToken` is an empty string when no script is loaded.
- VacuGlide: `targetSpeed` 0 is allowed; local-script start/stop act only in the matching mode; selecting a local script closes the valves; starting a sync script without one loaded is a 400 (`SYNC_SCRIPT_NOT_LOADED`); offset and loop can be set without a script, the offset persists across loads and loop resets on load.
- AI Ultra: local scripts, `GO_TO`, and the documented state fields.
- VacuPump: sync scripts are **exercises** (`upload-exercises`: HOLD, PULSE, STROKE, REST, validated as documented), they drive the modelled vacuum, stopping releases it, and a start past the end completes at once. The full state (pulse, stroke, workout and sync fields), `info` with capabilities, workouts (two samples), settings that are stored and validated, firmware update info and `state-updates`.
- `/connected` answers exactly `{"connected":false}` when offline; `info` has the documented fields.
- Errors use one shape, `{"error":{"code":"Error","message":"…"}}`; every answer carries `x-ratelimit-limit`, `-remaining` and `-reset`.
- Uploads: a funscript's last action must be at most 16,777,214 ms, CSV drops a last line that has no newline after it, URL uploads don't follow redirects, scripts are UUIDs that expire after 9 days.
- `GET /events/stream?deviceToken=…` (connected, heartbeat, `state-updated` for the VacuPump) and button presses you send from the emulator (`POST /emu/api/devices/<token>/button`).
- The token query parameter works only on the event stream, as documented.

**Easier to use and safer**
- Runs with `npx github:driftsyncone/autoblow-emulator`, from a release tarball, or in Docker; Node 18 and later, Windows, macOS and Linux (paths and settings folders work on all three).
- CORS preflight is answered, so browser apps can call it.
- The emulator's own page and controls refuse other websites and DNS-rebinding names.
- A damaged devices file is moved aside instead of overwritten; bad JSON gets a 400, not a 500; a busy port gives a clear message; `--help` and `--version`.

## 0.1.0

First version: VacuGlide, AI Ultra and VacuPump endpoints, sync scripts, a page with live devices, latency and rate-limit controls.
