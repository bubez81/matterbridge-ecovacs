# Changelog

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
