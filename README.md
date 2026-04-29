# matterbridge-ecovacs

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that exposes **Ecovacs Deebot** robot vacuums as native **Matter RVC** devices in Apple Home (and any other Matter-compatible platform) — without Home Assistant.

## Why this plugin?

Ecovacs only added native Matter support to newer flagship models. Older and mid-range models like the **T30 Omni**, T20, X2, T8, T9 etc. have no official Matter update. This plugin fills that gap using the Ecovacs cloud API.

## What you get in Apple Home

| Feature | Details |
|---|---|
| ▶ Start / Stop / Pause / Resume | Full control |
| 🏠 Return to dock | One tap |
| 🧹 Clean mode | Vacuum / Mop / Vacuum+Mop (3 modes) |
| 🗺 Room / zone selection | Select one or more rooms before starting |
| 🔋 Battery level | Real-time percentage |
| 📊 Operational state | Cleaning · Charging · Docked · Returning · Washing mop · Error |
| ⚠️ Error reporting | Stuck · Bin full/missing · Water tank · Mop pad · Wheels jammed · Low battery… |
| 🎙 Siri voice control | "Hey Siri, start Jarvis" |
| ⚙️ Automations and Scenes | Full HomeKit automation support |

## Architecture

```
Ecovacs Cloud (MQTT)
       │
  ecovacs-deebot.js
       │
  matterbridge-ecovacs  (this plugin)
       │
  Matterbridge (childbridge)
       │
  Matter fabric → Apple Home / Google Home / Alexa
```

## Requirements

- [Matterbridge](https://github.com/Luligu/matterbridge) >= 3.7.0
- Node.js >= 20 (22 or 24 LTS recommended)
- An Ecovacs account (email + password)
- A 950-type Deebot (T8, T9, T10, T20, T30, X1, X2 series and variants)

## Installation

### Via Matterbridge UI (recommended)

1. Open the Matterbridge web interface (`http://your-ip:8283`)
2. Go to **Plugins → Install**
3. Search for `matterbridge-ecovacs` and install
4. Configure with your credentials (see below)
5. Restart Matterbridge

### Via command line

```bash
npm install -g matterbridge-ecovacs
matterbridge --add matterbridge-ecovacs
```

## Childbridge mode required

Apple Home requires each robot vacuum to be its own Matter node. You **must** run Matterbridge in `childbridge` mode:

```bash
matterbridge --childbridge
```

Or set it in the Matterbridge UI under **Settings → Bridge mode**.

## Configuration

| Field | Required | Description | Example |
|---|---|---|---|
| `email` | yes | Ecovacs account email | `you@example.com` |
| `password` | yes | Ecovacs account password | `yourpassword` |
| `countryCode` | yes | Two-letter country code | `IT` `DE` `US` `FR` |
| `authDomain` | no | Leave empty for Ecovacs; use `yeedi.com` for Yeedi devices | |
| `whiteList` | no | Only expose these device nicknames or DIDs | `["T30 Omni"]` |
| `rooms` | no | Auto-populated on first run — edit names and enable/disable rooms | |

### Minimal config example

```json
{
  "name": "Ecovacs",
  "type": "DynamicPlatform",
  "email": "you@example.com",
  "password": "yourpassword",
  "countryCode": "IT"
}
```

### Room configuration

On first startup the plugin auto-discovers all rooms from the robot's map and saves them to the plugin config. You can then rename rooms and enable/disable them via the Matterbridge UI. Changes take effect after restarting Matterbridge.

```json
"rooms": [
  { "id": "0", "name": "Living Room", "enabled": true },
  { "id": "1", "name": "Kitchen", "enabled": true },
  { "id": "2", "name": "Bedroom", "enabled": true },
  { "id": "3", "name": "Bathroom", "enabled": false }
]
```

## Adding to Apple Home

1. Open **Apple Home → + → Add Accessory**
2. Scan the QR code shown in the Matterbridge UI, or enter the pairing code manually
3. Accept "Uncertified Accessory" (expected for community plugins)
4. The vacuum appears with the robot vacuum icon

## Country codes

`IT` · `DE` · `FR` · `GB` · `US` · `ES` · `NL` · `BE` · `SE` · `DK` · `NO` · `CH` · `AT` · `PT` · `AU` · `JP` · `CN`

For unlisted countries, try `WW`.

## Supported models

Developed and tested on **Deebot T30 Omni**. Should work with all 950-type protocol models including T8 / T9 / T10 / T20 / T30 series, X1 / X2 series, and any model supported by [ecovacs-deebot.js](https://github.com/mrbungle64/ecovacs-deebot.js).

## Operational states

| Apple Home shows | Meaning |
|---|---|
| Cleaning | Robot is actively cleaning |
| Paused | Cleaning paused |
| Returning | Heading back to the dock |
| Charging | On dock, charging |
| Docked | On dock, idle |
| Cleaning mop | Washing or drying mop pad at station |
| Error | See error details in Apple Home |
| Ready | Stopped / standby |

## Troubleshooting

**Vacuum does not appear in Apple Home**
- Verify Matterbridge is in `childbridge` mode
- Check the Matterbridge logs for authentication errors
- Make sure the country code matches your Ecovacs account region

**Authentication fails**
- Double-check email and password
- For Yeedi devices, set `authDomain` to `yeedi.com`

**Rooms do not appear or are wrong**
- Delete the `rooms` array from the plugin config and restart — rooms will be re-discovered automatically

**State does not update**
- The plugin polls every 5 seconds; state changes from the Ecovacs app may take up to 10 seconds to appear in Apple Home

## Technical notes

- Authentication tokens are cached in `~/.matterbridge/ecovacs-token.json` to avoid rate limiting. Tokens are refreshed automatically when they expire (every ~7 days).
- The plugin auto-patches the `ecovacs-deebot` library at startup to ensure compatibility with the current Ecovacs API.

## License

Apache-2.0

## Credits

Built on [ecovacs-deebot.js](https://github.com/mrbungle64/ecovacs-deebot.js) by mrbungle64 and [Matterbridge](https://github.com/Luligu/matterbridge) by Luligu.
