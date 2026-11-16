# CAN bridge (`DJIR_SDK`)

The bridge is the native half of the CAN transport. It owns the USB-CAN adapter
and the `DJIR_SDK`, and exposes a small JSON protocol over a local WebSocket to
the web UI (`web/js/bridge.js`).

**Status: not implemented yet.** This folder documents the intended contract and
contains a minimal C++ example showing the SDK calls to wrap. The browser side is
already written and will connect as soon as a bridge listens on
`ws://127.0.0.1:8787`.

---

## Why a bridge?

`DJIR_SDK` is C++ and talks to a **USB-CAN-II C** adapter. Browsers cannot open
that device directly (WebUSB/Web Serial would still need the vendor protocol and
Windows/macOS driver handling). A local process is the simplest portable
answer:

```
Browser UI  ──WebSocket/JSON──▶  bridge  ──USB──▶  USB-CAN-II C  ──CAN──▶  gimbal
```

Hardware parameters from DJI's R SDK document:

| Setting | Value |
| --- | --- |
| Baud rate | 1 Mbit/s |
| Frame type | Standard |
| Gimbal → host | `0x223` |
| Host → gimbal | `0x222` |

The adapter's CANH/CANL/GND go to the gimbal's CAN port. The gimbal side can
supply 8 V on the adapter's VCC pin; check your adapter's isolation and wiring
before connecting anything.

---

## Build the SDK

The bridge example expects `DJIR_SDK` as a **sibling** of this repository:

```
Default Project/
├── RoninS-Ctrl-Plus/
│   └── bridge/
│       └── example/
└── DJIR_SDK/          <- git clone https://github.com/ConstantRobotics/DJIR_SDK
```

```powershell
git clone https://github.com/ConstantRobotics/DJIR_SDK.git
cmake -S DJIR_SDK -B DJIR_SDK/build
cmake --build DJIR_SDK/build --config Release
```

On Windows the vendor USB-CAN driver must be installed first. See the
`DJIR_SDK` README and `@Docs/Device_Connection_Diagram.png` for the official
setup.

```powershell
cmake -S bridge/example -B bridge/example/build
cmake --build bridge/example/build --config Release
```

---

## WebSocket protocol

One JSON object per WebSocket text frame. All angles are **0.1° units** and all
speeds are **0.1 °/s units**, matching the DJI protocol and the UI.

### Bridge → browser

| Message | Meaning |
| --- | --- |
| `{"type":"ready","device":"DJI Ronin"}` | Server is up and the gimbal connected |
| `{"type":"status","level":"info","message":"..."}` | Human-readable progress; `level` is `info`, `ok`, `warn`, or `error` |
| `{"type":"error","message":"..."}` | Fatal or command error |
| `{"type":"telemetry","yaw":12,"roll":0,"pitch":-34,"source":"poll"}` | Position update |
| `{"type":"frame","data":"AA 1A ..."}` | Optional raw frame echo for the hex log |

### Browser → bridge

| Message | Action |
| --- | --- |
| `{"type":"command","action":"position","yaw":0,"roll":0,"pitch":0,"timeMs":1500,"absolute":true}` | `set_move_mode` + `move_to` |
| `{"type":"command","action":"speed","yaw":450,"roll":0,"pitch":0,"takeOver":true,"ignoreFocalLength":true}` | `set_speed_mode` + `set_speed` |
| `{"type":"command","action":"stop"}` | `set_speed(0,0,0)` |
| `{"type":"command","action":"info","infoType":1}` | `get_current_position` |
| `{"type":"command","action":"push","enable":true}` | Enable/disable the SDK's parameter stream if the bridge implements it |
| `{"type":"raw","framing":"djir","data":"AA 1A ..."}` | Send pre-built bytes (advanced panel) |

The UI sends `speed` every 100 ms while the joystick is held, because the
protocol only honours a speed command for about 0.5 s. The bridge should not
queue these — send the latest one and drop stale ones.

### Notes and gotchas

- `DJIRonin::set_speed()` takes `uint16_t`, so the SDK API cannot express
  negative speed. If the bridge needs negative speeds, send the `0x0E/0x01`
  frame manually with `int16_t` values (see `web/js/djir.js`) or extend the SDK.
- `DJIRonin::get_current_position()` blocks until a reply arrives. Call it from
  a worker thread and enforce a timeout so the WebSocket stays responsive.
- The SDK's `DataHandle` reads reply yaw/roll/pitch from payload offsets 0/2/4,
  while DJI's document describes offsets 2/4/6. Log the raw frame once on real
  hardware so you know which one your firmware uses.
- Use one gimbal connection per process. A second `DJIRonin` instance will
  fight over the adapter.

---

## Suggested bridge implementation

1. Open the WebSocket server on `127.0.0.1:8787` (Boost.Beast,
   `uWebSockets`, or a small header-only server).
2. Construct `DJIR_SDK::DJIRonin`, call `connect()`, and emit `ready`.
3. Start a polling thread: every 100 ms call `get_current_position()` and
   broadcast `telemetry`.
4. Handle commands on the socket thread, but serialise SDK calls with a mutex.
5. Stop the gimbal (`set_speed(0,0,0)`) on socket close, Ctrl+C, and SIGTERM.
6. Echo raw frames to the log if you want full parity with the Bluetooth path.

`example/main.cpp` covers steps 2, 3, and 5 in a console program. Treat it as
the reference for the SDK calls, not as a finished server.

---

## Safety

- Keep the gimbal on a stand for the first runs and start with low speeds.
- Verify that killing the bridge also stops the gimbal. A speed command expires
  after roughly 0.5 s, but do not rely on that alone.
- Check the CAN wiring before powering the gimbal. Reversed CANH/CANL or a
  missing ground can damage the adapter.
