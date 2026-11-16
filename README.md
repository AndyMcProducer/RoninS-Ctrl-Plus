# RoninS-Ctrl-Plus

A small, experimental web app for controlling a **DJI Ronin-S** gimbal from a browser.

It ships with two transport paths and a simulator:

| Transport | Status | What it needs |
| --- | --- | --- |
| **Simulator** | Working | Nothing. Great for trying the UI. |
| **Bluetooth LE (Web Bluetooth)** | Experimental | Chrome or Edge on macOS/Windows, Ronin-S powered on and pairing enabled |
| **CAN bridge (`DJIR_SDK`)** | Planned / documented | USB-CAN-II C adapter, native bridge app (see `bridge/`) |

> **Important:** The `DJIR_SDK` linked in the original brief is a **CAN bus** SDK
> (USB-CAN-II C adapter), not a Bluetooth SDK. The CAN protocol is documented and
> implemented here in JavaScript; the Bluetooth side is reverse-engineering
> territory and is deliberately built as a flexible testbed.

## Status

| Part | State |
| --- | --- |
| UI + simulator | Working; exercised in Chromium (connect, move, joystick, stop, telemetry) |
| Protocol layer (DJIR + DUML) | Unit-tested; reproduces DJI's published CAN sample byte for byte |
| Web Bluetooth transport | Implemented, **not verified on Ronin-S hardware**; UUIDs and framing are a starting hypothesis |
| Native CAN bridge | Contract + annotated C++ example; WebSocket server still to build |

Nothing here has been validated against a physical Ronin-S yet. Treat the
Bluetooth path as a research tool and the CAN path as a documented starting
point, not a finished product.

---

## Quick start

You need **Node.js 18+** (only for the tiny local server and protocol tests — there
are no npm dependencies).

```powershell
cd RoninS-Ctrl-Plus
npm start
# or: node tools/serve.mjs
```

Open <http://localhost:8080> in **Chrome** or **Edge**.

`localhost` counts as a secure context, which Web Bluetooth requires. Opening
`index.html` directly from disk will not work reliably.

### Portable macOS bundle

The repository includes everything a Mac needs to run from a folder:

- **`Start Me.command`** — double-click launcher (Node.js or Python 3 is
  detected automatically).
- **`START-HERE.txt`** — plain-language instructions, Gatekeeper workaround,
  and troubleshooting.
- **`start-mac.sh`** — the same launcher for Terminal users.
- **`tools/serve.py`** — Python fallback server when Node is not installed.

A prebuilt zip is produced with:

```bash
bash tools/package-mac.sh
# -> dist/RoninS-Ctrl-Plus-mac-portable.zip
```

Unzip it on the Mac and double-click `Start Me.command`. Chrome or Edge is still
required for Web Bluetooth; Safari/Firefox can only run the simulator. The
launcher falls back to opening `web/index.html` directly if neither Node nor
Python is present, so the simulator always works.

### Try it without hardware

1. Leave the transport on **Simulator**.
2. Click **Connect**.
3. Drag the joystick, hit **Recenter**, or send a **Move to** command.

The simulator emulates the gimbal, including position telemetry and the 0.5 s
speed-command safety window.

---

## Platform support

| Browser / OS | Web Bluetooth | Notes |
| --- | --- | --- |
| Chrome / Edge on macOS | Yes | Recommended on Mac |
| Chrome / Edge on Windows 10/11 | Yes | Recommended on Windows |
| Safari on macOS | No | Apple has not implemented Web Bluetooth |
| Firefox | No | Not implemented |
| Chrome on iOS | No | Apple restricts WKWebView |
| Chrome on Android | Yes | Should work; not the primary target |

If you need Safari support, the practical option is a native macOS app or a local
bridge process plus a regular web UI (see `docs/architecture.md`).

---

## Bluetooth setup (Ronin-S)

1. Power on the Ronin-S and make sure it is not connected to the DJI Ronin app
   on a phone. A BLE device usually stops advertising once it is connected.
2. Put the gimbal into pairing/discoverable mode if needed (see the Ronin-S manual).
3. Open the app in Chrome/Edge, choose **Bluetooth**, then **Connect**.
4. Pick the gimbal from the browser picker.

The app defaults to DJI's common BLE layout:

```
Service  0000fff0-0000-1000-8000-00805f9b34fb
Notify   0000fff4-0000-1000-8000-00805f9b34fb
Write    0000fff5-0000-1000-8000-00805f9b34fb
```

This is the same layout used by DJI's official Osmo BLE demo. It is **not
guaranteed** for the Ronin-S. Use **Discover GATT** after connecting and the
Advanced panel to switch UUIDs if your device exposes something else.

Because the Ronin-S BLE protocol is undocumented, the app has three escape hatches:

- **Protocol framing**: DUML (`0x55`) or the DJIR CAN framing (`0xAA`).
- **Raw send**: build and send any payload with your own command set/id/flags.
- **Live log**: every TX/RX frame in hex, so you can compare against captures.

See `docs/bluetooth.md` for a suggested discovery and capture workflow.

---

## Controls

- **Joystick** — yaw/pitch speed control with a dead zone. Hold to move, release
  to stop. Arrow keys/WASD also work when the pad has focus.
- **Roll slider** — roll speed while the joystick is held.
- **Recenter** — absolute move to `0, 0, 0`.
- **Stop** — immediately sends zero speed and releases speed control.
- **Move to** — absolute or incremental yaw/roll/pitch move with a duration.
- **Telemetry** — yaw/roll/pitch readout in degrees, parsed from notifications.
- **Raw command** — arbitrary payload with computed CRC for experimentation.

Safety behaviours built in:

- Speed commands are re-sent while the joystick is held, because the DJI protocol
  only honours a speed command for ~0.5 s.
- Releasing the pointer, **Stop**, `Escape`, window blur, or hiding the tab sends
  a zero-speed stop command.
- Speed is clamped to the protocol range (0–360 °/s).

**You are responsible for the gimbal.** Test with the gimbal on a stand, keep
hands and cables clear, and start with low speeds.

---

## The CAN path (`DJIR_SDK`)

The `DJIR_SDK` is a C++/CMake library that talks to the gimbal over a USB-CAN-II C
adapter (CAN 1 Mbit/s, Rx `0x223`, Tx `0x222`). It is **not** usable directly from
a browser. The intended architecture is:

```
Browser UI  ──WebSocket/JSON──▶  native bridge (C++ + DJIR_SDK)  ──USB──▶  USB-CAN-II C  ──CAN──▶  Ronin
```

The web UI already contains a **CAN bridge** transport that speaks the JSON
protocol described in `bridge/README.md`. The bridge itself is the next milestone;
`bridge/example/` contains a minimal C++ program showing exactly which SDK calls
to wrap.

The JavaScript side also implements the full `0xAA` frame format, CRC16/CRC32
and R SDK command payloads. That code is used for:

- the **CAN bridge** transport (pending the native bridge),
- the **DJIR (`0xAA`)** framing option for raw Bluetooth experiments,
- offline protocol tests (`node tools/protocol-test.mjs`).

### Protocol facts verified against the SDK and DJI's R SDK PDF

- Frame: `AA | length(2, LE) | cmdType | enc | reserved(3) | seq(2, BE) | CRC16(2, LE) | cmdSet | cmdId | payload | CRC32(4, LE)`
- CRC16: poly `0x8005`, init `0xC55C`, reflected, xorOut `0`
- CRC32: poly `0x04C11DB7`, init `0xC55C0000`, reflected, xorOut `0`
- Gimbal command set: `0x0E`
  - `0x00` position control
  - `0x01` speed control (valid for ~0.5 s per command)
  - `0x02` get gimbal info
  - `0x07` enable/disable parameter push
  - `0x08` pushed parameters (yaw/roll/pitch telemetry)
- Speed control `ctrl_byte`: bit 7 = take over speed control, bit 3 = ignore
  camera focal length.
- Position control `ctrl_byte`: bit 0 = absolute (1) / incremental (0),
  bits 1–3 = yaw/roll/pitch invalid.

The protocol test suite checks the frame builder against DJI's published sample:

```
AA 1A 00 03 00 00 00 00 22 11 A2 42 0E 00 20 00 30 00 40 00 01 14 7B 40 97 BE
```

---

## Project layout

```
RoninS-Ctrl-Plus/
├── README.md
├── START-HERE.txt
├── Start Me.command        # macOS double-click launcher
├── start-mac.sh            # Terminal launcher for macOS
├── LICENSE
├── package.json
├── .gitignore
├── .gitattributes
├── .github/workflows/tests.yml
├── docs/
│   ├── architecture.md      # transports, browser constraints, bridge plan
│   ├── bluetooth.md         # BLE discovery, UUIDs, capture workflow
│   └── protocol-notes.md    # DJIR (CAN) + DUML (BLE) notes
├── web/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── js/
│       ├── bytes.js         # byte/hex helpers
│       ├── crc.js           # CRC8/16/32 (DJIR + DUML)
│       ├── djir.js          # 0xAA framing, R SDK commands, parser
│       ├── duml.js          # 0x55 framing, parser
│       ├── ble.js           # Web Bluetooth transport
│       ├── bridge.js        # WebSocket CAN-bridge client
│       └── simulator.js     # fake gimbal for demos/tests
├── bridge/
│   ├── README.md            # JSON/WebSocket contract
│   └── example/             # minimal C++ DJIR_SDK wrapper
│       ├── CMakeLists.txt
│       └── src/main.cpp
└── tools/
    ├── serve.mjs            # dependency-free static server (Node)
    ├── serve.py             # dependency-free static server (Python 3)
    ├── package-mac.sh       # builds the portable macOS zip
    └── protocol-test.mjs    # Node protocol tests
```

---

## Tests

```powershell
npm test
# or: node tools/protocol-test.mjs
```

This validates the CRC implementations, the DJI sample frame, and DUML
encode/decode round-trips. It has no npm dependencies, and the same command runs
in GitHub Actions.

---

## Roadmap

- [x] Web UI, simulator, Web Bluetooth transport
- [x] DJIR frame builder/parser + DJI sample verification
- [x] DUML frame builder/parser
- [x] CAN bridge JSON client + protocol spec
- [ ] Native CAN bridge (C++ + `DJIR_SDK` + WebSocket)
- [ ] Confirm Ronin-S BLE service/characteristic UUIDs
- [ ] Decode Ronin-S BLE telemetry/commands from captures
- [ ] Presets, smooth moves, and keyboard-only mode

---

## License

Our code is MIT-licensed (see `LICENSE`). `DJIR_SDK` and DJI firmware/protocol
documentation remain the property of their respective owners and are **not**
bundled in this repository. `DJIR_SDK` is consumed as an external dependency by
the bridge example.

DJI, Ronin and related marks are trademarks of DJI. This project is unofficial
and not affiliated with or endorsed by DJI.
