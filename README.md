# Fireplace

A phone remote for Source Pro Bluetooth electric fireplaces (the ones that use the
"Source Pro Fireplace Remote" / "Fireplace Bluetooth Source Pro" app), built with Expo / React Native.

Controls: power, heat (setpoint or OFF/HIGH), flame level, flame pattern, log/ember level,
°F/°C, and a shut-off timer. The **Log** tab shows the raw Bluetooth traffic in both directions.

## Run it on your phone

Bluetooth needs native code, so this won't run in Expo Go. Build a development client once:

```sh
npm install
npm install -g eas-cli && eas login     # free Expo account
eas build --profile development --platform android   # gives you an .apk to install
eas build --profile development --platform ios       # needs an Apple Developer account
npx expo start --dev-client             # then open the app on the phone
```

Or build locally with Android Studio / Xcode: `npx expo run:android` / `npx expo run:ios`.

For a standalone app that doesn't need the dev server, use `--profile preview`.

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
