# Changelog

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
