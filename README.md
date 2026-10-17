# Fireplace

A phone remote for Source Pro Bluetooth electric fireplaces (the ones that use the
"Source Pro Fireplace Remote" / "Fireplace Bluetooth Source Pro" app), built with Expo / React Native.

Controls: power, heat (setpoint or OFF/HIGH), flame level, flame pattern, log/ember level,
°F/°C, and a shut-off timer. The **Log** tab shows the raw Bluetooth traffic in both directions.

## iPhone (no Mac needed)

GitHub Actions builds the app on a Mac in the cloud (`.github/workflows/ios.yml`). The result is an
**unsigned** `Fireplace.ipa`; you sign it with your own Apple ID when you install it.

1. **Build:** push to `main` (or run *Build iOS app* from the repo's **Actions** tab). When it finishes
   (~15–25 min), open the run and download the **Fireplace-ipa** artifact; unzip it to get `Fireplace.ipa`.
   Pushing a tag such as `v1.0.0` also attaches the `.ipa` to a GitHub Release.
2. **Install on Windows with [Sideloadly](https://sideloadly.io):** install iTunes and iCloud from apple.com
   (not the Microsoft Store versions), plug in the iPhone, drag `Fireplace.ipa` into Sideloadly, enter your
   Apple ID, and click Start.
3. **On the iPhone:** Settings → Privacy & Security → **Developer Mode** → on (the phone restarts), then
   Settings → General → VPN & Device Management → trust your Apple ID.

With a free Apple ID the app stops opening after **7 days**. Re-run Sideloadly to refresh it (your settings
are kept), or turn on Sideloadly's auto-refresh. A paid Apple Developer account ($99/yr) makes it last a year.

## Android

```sh
npm install
npm install -g eas-cli && eas login
eas build --profile preview --platform android   # gives you an .apk to install
```

## Protocol

Recovered from the official Android app (`com.keny.fireplacebluetooth` 1.7.2, Flutter). See `src/protocol.ts`.

| | UUID |
|---|---|
| Service | `18704c6e-19b9-4cbb-8100-42a459142300` |
| Status (notify) | `18704c6e-19b9-4cbb-8100-42a459142301` |
| Commands (write) | `18704c6e-19b9-4cbb-8100-42a459142302` |

Commands are one JSON line, terminated with `\n`: `{"C":"<cmd>","v1":"<value>"}`. Newer controllers
use the key `"v2"` instead of `"v1"`.

| Cmd | Meaning | Values |
|---|---|---|
| `Spo` | power | `0` off, `1` on |
| `Sfl` | flame level | `0`–`5` |
| `Sfs` | flame pattern | `1`–`5` |
| `Sll` (v1) / `Sse` (v2) | log / ember bed level | `0`–`5` |
| `Stt` | heat | v1: setpoint, 59–88 °F / 15–32 °C (min shows OFF, max HIGH). v2: one of `0,65,70,75,80,85,90,104` °F or `0,18,21,24,27,29,32,40` °C |
| `Stc` | temperature unit | `0` °F, `1` °C |
| `Sts` | shut-off timer | seconds, `0` cancels |

The fireplace sends `\r\n`-terminated JSON status lines with keys `po`, `fl`, `fs`, `ll`/`se`, `tt`, `tc`,
`ts`, `tr`, and `12` (controller version, `1` or `2`).
