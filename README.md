# matterbridge-ecovacs

A [Matterbridge](https://matterbridge.io/) plugin that bridges **Ecovacs Deebot** robot vacuums into **Apple Home** (and any other Matter-compatible platform) as native vacuum devices — without Home Assistant.

## Why this plugin?

Ecovacs only added native Matter support to newer models (X8, T50, X9 series). Older models like the **T30 Omni**, X2, T20, etc. have no official update planned. This plugin fills that gap.

## Architecture

```
Ecovacs Cloud API
       │
  ecovacs-deebot.js  (cloud MQTT)
       │
  matterbridge-ecovacs  (this plugin)
       │
  Matterbridge  (childbridge mode, one instance per vacuum)
       │
  Matter fabric
       │
  Apple Home / Siri / Automations
```

## What you get in Apple Home

| Feature | Supported |
|---|---|
| Start / Stop cleaning | ✅ |
| Pause / Resume | ✅ |
| Return to dock (goHome) | ✅ |
| Clean mode: Vacuum / Mop / Vacuum+Mop | ✅ |
| Battery level | ✅ |
| Operational state (Cleaning, Charging, Docked, Error…) | ✅ |
| Automations & Scenes | ✅ |
| Siri voice control | ✅ |
| Room/zone selection | ❌ (Matter spec limitation — use Ecovacs app) |
| Map view | ❌ (Matter spec limitation — use Ecovacs app) |

## Requirements

- [Matterbridge](https://github.com/Luligu/matterbridge) ≥ 3.7.0
- Node.js ≥ 20.19.0 (22 or 24 LTS recommended)
- An Ecovacs account (email + password)
- A compatible Deebot model (tested with T30 Omni and T20; should work with any 950-type model)

## Installation

### Via Matterbridge UI (recommended)

1. Open the Matterbridge web interface (usually `http://your-ip:8283`)
2. Go to **Plugins** → **Install**
3. Search for `matterbridge-ecovacs` and click Install
4. Restart Matterbridge

### Via command line

```bash
npm install -g matterbridge-ecovacs
matterbridge --add matterbridge-ecovacs
```

## ⚠️ Important: childbridge mode required

Due to a limitation in Apple Home, robot vacuums **cannot** be placed in a shared Matter bridge alongside other devices (the Home app crashes). Each vacuum must be its own paired Matter node.

**You must run Matterbridge in `childbridge` mode:**

```bash
matterbridge --childbridge
```

Or set it in the Matterbridge UI under **Settings** → **Bridge Mode**.

If you have other plugins (lights, sensors, etc.) in the same Matterbridge instance, they will each still be paired independently — this is normal in childbridge mode.

## Configuration

In the Matterbridge UI, configure the plugin with:

| Field | Description | Example |
|---|---|---|
| `email` | Ecovacs account email | `your@email.com` |
| `password` | Ecovacs account password | `yourpassword` |
| `countryCode` | Two-letter country code | `IT` (Italy), `DE`, `US`, `UK` |
| `authDomain` | Optional: `yeedi.com` for Yeedi devices, leave empty for standard | `` |
| `whiteList` | Optional: only include these device nicknames | `["T30 Omni"]` |
| `pollingInterval` | Seconds between status polls (0 = push only) | `30` |
| `debug` | Enable verbose logging | `false` |

### Example config.json entry

```json
{
  "name": "Ecovacs",
  "type": "DynamicPlatform",
  "email": "you@email.com",
  "password": "yourpassword",
  "countryCode": "IT",
  "whiteList": ["T30 Omni"],
  "pollingInterval": 30,
  "debug": false
}
```

## Adding to Apple Home

After starting Matterbridge, each vacuum will appear as a separate Matter accessory to pair:

1. Open **Apple Home** → tap **+** → **Add Accessory**
2. Scan the QR code shown in the Matterbridge UI for your vacuum
3. Accept "Uncertified Accessory" (expected for community plugins)
4. The vacuum appears in Home with the 🤖 vacuum icon

## Country codes

| Country | Code |
|---|---|
| Italy | `IT` |
| Germany | `DE` |
| France | `FR` |
| United Kingdom | `UK` |
| United States | `US` |
| Spain | `ES` |
| Netherlands | `NL` |
| Belgium | `BE` |
| Sweden | `SE` |
| Denmark | `DK` |
| Norway | `NO` |
| Switzerland | `CH` |
| Austria | `AT` |
| Portugal | `PT` |
| Australia | `AU` |
| Japan | `JP` |

For other countries, try `WW` (worldwide).

## Supported models

Tested and known to work:
- Deebot T30 Omni
- Deebot T20 Omni

Should work with all 950-type models (X1, X2, T8, T9, T10, T20, T30, X Omni series) via the underlying `ecovacs-deebot.js` library.

## Troubleshooting

**Vacuum doesn't appear in Apple Home**
- Make sure Matterbridge is in `childbridge` mode
- Check logs for authentication errors
- Verify country code matches your account region

**"Uncertified Accessory" warning**
- This is expected. Tap "Add Anyway" to continue.

**Vacuum shows wrong state**
- Try increasing `pollingInterval` to 30 seconds
- Enable `debug: true` and check Matterbridge logs

**Authentication fails**
- Verify email and password are correct
- Try the `authDomain` field if you have a regional Ecovacs account
- Some regions use `yeedi.com` as auth domain

## Contributing

PRs welcome! Especially for:
- Testing with additional models
- Adding ServiceArea (room selection) support when the Matter spec matures
- Adding map sync

## License

Apache-2.0
