# Architecture

## Goal

Control a DJI Ronin-S gimbal from a small, cross-platform UI, with an honest split
between what is documented and what is experimental.

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser (web/)                        │
│                                                              │
│  index.html + app.js                                         │
│      │                                                       │
│      ├── ble.js ───────── Web Bluetooth ──────▶ Ronin-S BLE  │
│      │                                                       │
│      ├── bridge.js ───── WebSocket/JSON ──┐                  │
│      │                                    │                  │
│      └── simulator.js ── in-memory gimbal │                  │
└───────────────────────────────────────────┼──────────────────┘
                                            │
                              ┌─────────────▼─────────────┐
                              │   Native CAN bridge       │
                              │   C++ + DJIR_SDK          │
                              │   USB-CAN-II C adapter    │
                              └─────────────┬─────────────┘
                                            │ CAN 1 Mbit/s
                                            ▼
                                        Ronin gimbal
```

## Transports

### 1. Simulator (`web/js/simulator.js`)

An in-memory gimbal that speaks the DUML framing. It:

- keeps yaw/roll/pitch state,
- responds to position requests and speed commands,
- pushes telemetry at ~10 Hz,
- emulates the 0.5 s speed safety window.

This exists so the UI and protocol code can be developed and tested without
hardware, and so a failed Bluetooth experiment never leaves you without a way to
demo the app.

### 2. Bluetooth LE (`web/js/ble.js`)

Uses the Web Bluetooth API (`navigator.bluetooth`). Key constraints:

- **Chromium only**: Chrome/Edge on macOS/Windows/Android. No Safari, no Firefox.
- **Secure context**: serve over `https://` or `http://localhost`.
- **User gesture**: a click is required before `requestDevice()`.
- **Permission scoping**: Web Bluetooth only lets you access services listed in
  `optionalServices` at request time. That is why the Advanced panel asks for a
  list of service UUIDs rather than promising unrestricted GATT discovery.
- **No pairing UI control**: the OS handles pairing. If the gimbal is already
  connected to the DJI Ronin phone app, it may not advertise.

The transport is deliberately protocol-agnostic: `app.js` decides whether to
wrap R SDK payloads in DUML (`0x55`) or DJIR (`0xAA`) framing.

### 3. CAN bridge (`web/js/bridge.js`)

The browser connects to a local WebSocket server (default
`ws://127.0.0.1:8787`) and exchanges JSON messages. The native bridge is
responsible for `DJIR_SDK` calls and USB-CAN hardware.

Why not Web Serial or WebUSB directly?

- The USB-CAN-II C adapter needs its vendor protocol/driver; the provided SDK
  already handles that.
- `DJIR_SDK` is C++ and uses threads and vendor libraries.
- A local bridge keeps the hardware details out of the browser and works on both
  macOS and Windows as long as the vendor driver exists.

The bridge is not implemented yet. `bridge/README.md` defines its message
protocol and `bridge/example/` shows the SDK calls to wrap.

## Protocol layering

```
R SDK command  (cmdSet 0x0E, cmdId 0x00/0x01/0x02/..., payload)
      │
      ├── DJIR framing  (0xAA, CRC16 + CRC32)   → CAN / raw experiments
      │
      └── DUML framing  (0x55, CRC8 + CRC16)    → BLE experiments
```

The R SDK payloads are documented by DJI for CAN. Whether the Ronin-S accepts the
same command set over BLE is the open question this app is built to investigate.
The UI exposes both framings and raw sends so you can test without editing code.

## State and safety model

- `app.js` keeps the last known position, the current speed demand, and the
  connection state.
- Speed commands run on a 100 ms timer while the joystick is held. A command is
  considered stale after ~500 ms and a stop is sent on release.
- Stop conditions: pointer up, pointer cancel, `Escape`, window blur,
  `visibilitychange` to hidden, disconnect, and **Stop** button.
- Movement commands are clamped to the documented ranges:
  - position: −180°…+180° (in 0.1° units, −1800…1800)
  - speed: 0…360 °/s (in 0.1 °/s units, 0…3600)

## Error handling

- Every transport exposes `connect()`, `disconnect()`, `send()`, and `onData`.
- Errors are surfaced in the status area and the hex log.
- The app never assumes a notification contains exactly one frame; both parsers
  keep a byte buffer and resynchronise on the start-of-frame byte.

## Future work

1. Implement the C++ WebSocket bridge (Boost.Beast or a small header-only server).
2. Capture and decode Ronin-S BLE traffic; fill in the UUID/command table.
3. Add canned presets (e.g. slow pan, tilt reveal) once the protocol is known.
4. Consider a native macOS Swift app if Safari-only support is required.
