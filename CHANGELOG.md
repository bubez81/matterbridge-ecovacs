# Changelog

## 0.2.13 — 2026-11-19

- **Fix for the 0.2.12 map check**: the plugin never got the robot's map ID, because it read the map list from the wrong field of the `Maps` event (`mapData` instead of `maps`), so the check gave up after a minute and kept the old rooms. It now takes the map ID from `CurrentMapMID`, which the robot sends first, or from `Maps.maps`. The raw `CachedMapInfo` and `MapSet` messages are logged once to help with other models.

## 0.2.12 — 2026-11-19

- **Rooms follow a new robot map**: after a re-mapping (for example when the Ecovacs map gets corrupted and the house is mapped again) the room IDs change, but the plugin kept the old IDs from its config, so room cleaning in Apple Home pointed at rooms that no longer existed. The plugin now reads the robot's current map at every start and every 6 hours. When the map ID or the room IDs changed, it rebuilds the room list, saves it (with the new `mapId`) and updates the rooms in Apple Home without a restart. Rooms that keep their name in the Ecovacs app keep your custom name and Enabled setting.
- Includes 0.2.11 (`CHANGELOG.md` in the npm package), which was not published on its own.

## 0.2.11 — 2026-11-16

- **Changelog in the npm package**: `CHANGELOG.md` is now published with the package, so the version history can be read on npm too. No code changes.

## 0.2.10 — 2026-11-16

- **Mop pad fallen off shown in Apple Home**: when a mop pad (holder) falls off, the T30 just pauses, without any `Evt` or `ErrorCode` (2026-11-16 11:03, app: "mop holder fell off"), and Home showed "Paused" for an hour. On every pause off the dock the plugin now reads `WaterInfo`. A lower `mopCount` (or one pad out of two) raises MopCleaningPadMissing, which clears when the pad is back.
- **`Evt 1131` after a long pause**: the robot also sends it when it ends a task that was paused for 60 minutes (2026-11-09 and 2026-11-16). It is now shown as "Unable to complete operation" instead of "Stuck", and an active mop pad error is kept.

## 0.2.9 — 2026-11-16

- **Robot errors stay visible while the robot is stuck**: when the main brush got tangled (`ErrorCode 109`), the T30 sent `ErrorCode 0` five seconds later while still stopped, and Apple Home showed only "Paused" for the next 10 minutes. An error raised off the dock now stays until the robot moves again (cleans or returns) or reaches the dock.
- **Dust bin emptying shown in Apple Home**: `CleanInfo` state `autoEmpty` (the station emptying the dust bin, ~12 s after the robot returns with `goCharging-ae`) maps to EmptyingDustBin.
- **No false "Docked" during network drops**: the `Error` event (error text, transport and library failures) no longer changes the state. An unrecognized network error ("Client network socket disconnected before secure TLS connection…") reset the cleaning state, and Home showed the robot on the dock for 30 s while it was cleaning.
- `ErrorCode -2` (ecovacs-deebot threw while parsing a robot message) is no longer shown as a robot error. It made the robot flash "Error" in Home.
- Log: "NoError: Robot is operational" is no longer logged as a warning. Network and library failures are logged at info level, once instead of twice.

## 0.2.8 — 2026-11-16

- **Ecovacs device verification (login error 1013)** ([#2](https://github.com/bubez81/matterbridge-ecovacs/issues/2)): when Ecovacs asks to verify the device, the plugin requests a code by e-mail and explains in the log what to do. Enter the code in the new **Verification code** setting and restart the plugin. The plugin confirms it (`verifyDevice`) and clears the setting. A wrong or expired code triggers a new one. Previously a new user got 5 failed logins in a row, and the only way out was writing `ecovacs-device-auth.json` by hand.
- No retries while waiting for the code. A new code is requested at most every 15 minutes.

## 0.2.7 — 2026-11-09

- **No false "Stuck" at the end of a cycle**: the T30 sends `Evt 1131` (bumper stuck) also when, back on the dock, it starts drying its mops (2026-11-09 17:49, app: "asciugatura dei panni"), and Home kept showing the error. 1131 is now an error only when the robot is off the dock; on the dock it is logged.
- Log line "Cleaning cycle completed" renamed "Back on the dock after cleaning": it also fires on mid-cycle returns to wash the mops.

## 0.2.6 — 2026-11-09

- **Returning to wash the mops shown in Apple Home**: when the T30 leaves a cycle to wash its mops it sends `CleanInfo` state `goCharging-washing`, which ecovacs-deebot doesn't know: `CleanReport` came out `undefined` and Home showed Docked for the whole drive back. Any raw state starting with `goCharging` now maps to SeekingCharger.

## 0.2.5 — 2026-11-09

- Confirmed with the user's HomePods (latest firmware): CleaningMop shows in Apple Home ("pulizia del panno") and the state goes back to cleaning afterwards, no "Updating" hang.
- Each distinct non-`clean` `CleanInfo` state is logged once with its raw payload. When the T30 leaves a cycle to wash its mops, `CleanReport` comes out `undefined` and Home showed Docked for about a minute instead of returning to the dock: the raw state is needed to map it.

## 0.2.4 — 2026-11-09

- **Dock states in Apple Home (Matter 1.4)**: the robot now advertises EmptyingDustBin, CleaningMop, FillingWaterTank and UpdatingMaps. Mop washing at the dock (before, during and after a cycle: `CleanReport` `washing`, or `StationState` self-cleaning) shows as CleaningMop instead of Charging; the auto-empty station (`AutoEmptyStatus` stationActive) shows as EmptyingDustBin. 0.1.79 had removed these states because the HomePod got stuck on "Updating"; that was the pre-rewrite plugin, and other Apple-Home-only plugins now ship them. Each dock flag expires after 5 minutes without a refresh, so a missed "end" message can't leave Home stuck.
- No T30 signal is known yet for FillingWaterTank and UpdatingMaps: the raw station / work / map / water messages are logged (each distinct shape once, max 30 per message) to find them.
- `CleanReport` and `ChargeState` are logged only when they change (the T30 repeats `washing` every second).

## 0.2.3 — 2026-11-08

- **Cleaning shown in Apple Home again**: the T30 reports cleaning as `CleanInfo` state `clean` with a clean type that ecovacs-deebot's dictionary doesn't know, so `CleanReport` came out `undefined` for the whole cycle and the robot looked docked while cleaning. The raw `CleanInfo` is now hooked: state `clean` → Running (`motionState` pause → Paused) whatever the type. Each distinct `clean` shape (type / motionState / trigger) is logged once.

## 0.2.2 — 2026-10-31

- **Plugin shutdown actually runs**: Matterbridge calls `onShutdown()`, never `onStop()`, so the cleanup never ran. On every in-process restart the old instance stayed alive with its own MQTT session and polling, writing to a destroyed endpoint (`Endpoint … is in the destroyed state`). Renamed to `onShutdown()`, chained to the base implementation.
- **No more duplicate robot sessions**: `connect()` disposes the previous vacbot first (listeners removed, MQTT client ended even when offline — ecovacs-deebot skips `client.end()` then, and mqtt.js kept reconnecting on its own). Only one reconnect timer can be pending.
- **Communication failures are not robot errors**: `ErrorCode 500` (request timeout), `404` (recipient unavailable) and `4200` (bot offline), and transport `Error` messages (timeouts, DNS, MQTT link), no longer put the robot in Error in Apple Home. A 2-minute cloud timeout showed "Impossibile completare la pulizia".

## 0.2.1 — 2026-10-04

- `Evt` errors no longer auto-clear after 60 s: they stay in Apple Home until the problem is resolved — mop pad reattached (`WaterInfo.mopCount` goes up), robot back on the dock, `ErrorCode 0`, a new Start (the robot re-sends the code if the problem persists) or a real cleaning start.
- `Evt 1131` (bumper stuck — app: "Il paracolpi è bloccato") → `Stuck`.
- Removed the `operationCompletion` event trigger: the event is not enabled on the endpoint, so it never fired and only logged "cluster rvcOperationalState not found".
- `repository.url` normalized (`npm pkg fix`).

## 0.2.0 — 2026-10-04

- **ecovacs-deebot 1.0.0-alpha.23** (pure MQTT/JSON rewrite). Requires Node ≥ 22.15. The XMPP stack and the native `canvas` dependency are gone (far fewer deprecated/vulnerable packages).
- **Proactive token refresh**: the token validity reported at login (~7 days) is tracked and cached; the plugin re-authenticates 1 h before expiry and hands the new token to the live MQTT session (`updateUserAccessToken`). The 0.1.88 "Not authorized" recovery stays as a safety net.
- Device-auth login goes through the library's `completeLogin()`.
- Removed the `appVersion` patch (not needed with the 1.0 library).
- `ErrorCode 0/100` (no error) is logged at info level.

## 0.1.90 — 2026-10-04

- Detect the mop pad being reattached: the T30 pushes `WaterInfo.mopCount` (attached mop pads; 1 with a pad detached, 2 after reattaching), which ecovacs-deebot ignores. When the count goes up, the mop-pad error clears immediately. A `GetWaterInfo` request establishes the baseline at connect and when the error fires.
- Note: `Evt 1007` (Mop installed) is not sent by the T30; its handling is kept for other models.

## 0.1.89 — 2026-10-04

- `Evt` codes known to ecovacs-deebot (`library/eventCodes.json`) are logged by name instead of "Unhandled".
- `Evt 1007` (Mop installed) clears the mop-pad error immediately, without waiting 60 s.
- `Evt 1026` (Charging dock not found) → `FailedToFindChargingDock` in Apple Home; it stays until the robot is back on the dock or starts cleaning, because the problem persists until then.

## 0.1.88 — 2026-10-04

- Recover from an invalidated token: MQTT "Not authorized" now triggers a single-flight re-authentication (same device-auth path as startup), refreshes the token cache and reconnects. Previously the MQTT client retried forever with the dead token (robot unreachable, log grew to 100 MB).
- Plain disconnects no longer re-login with email/password (that bypassed the device-auth identity).
- `ErrorCode -1` (client/connection failure) is no longer reported as a robot error.

## 0.1.87 — 2026-10-04

- Errors finally reach Apple Home: while an error is active, `operationalState` is `Error`. Matterbridge clears `operationalError` as soon as the state leaves `Error`, so writing Charging/Docked right after an error silently wiped it.
- A real cleaning start clears any active error; a new Start clears a transient `Evt` error.

## 0.1.86 — 2026-10-04

- Handle `Evt` messages (ignored by ecovacs-deebot). `Evt 1128` (mop pad missing/detached, robot refuses to start) → `MopCleaningPadMissing`; the optimistic Running state is dropped immediately. Auto-clears after 60 s, on a real start or on `ErrorCode 0/100`. Other codes are logged.
- Fix: `ErrorCode` arrives as a string — normalized to number (`"0"` was treated as an error).

## 0.1.81 – 0.1.85

- Verified device identity (`ecovacs-device-auth.json`) to pass Ecovacs device verification (error 1013).
- Token cache bound to the device ID, written with mode 600.
- Extended Ecovacs → Matter error map (dock, station bag, water tanks…).
- `hasActiveError` / `hasStartedCleaning` guards; operationCompletion only after a real cleaning cycle.
- Force-write Docked after registration to evict stale persisted states.
- `ecovacs-deebot` pinned to `0.9.6-alpha.36` (since 0.1.84; the tested and deployed version).

## 0.1.0 — 2026-04-27

### First release

- Matter RVC device support (RvcRunMode, RvcCleanMode, RvcOperationalState, PowerSource)
- Supports Deebot T30 Omni, T20 Omni and any 950-type model via ecovacs-deebot.js
- Standalone Matter node per vacuum (`server` mode) for Apple Home compatibility
- Auto-reconnect with exponential back-off on MQTT disconnect
- Events: CleanReport, ChargeState, BatteryInfo, MopWash, EmptyDustBin
- Commands from Apple Home: Start, Stop, Pause, Resume, GoHome, CleanMode
- Optional polling interval for missed push events
- Whitelist support to filter which devices to register
- Full TypeScript source with zero compile errors
