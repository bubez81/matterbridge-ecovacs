# Changelog

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
