# Protocol notes

Two different protocols are relevant:

1. **DJI R SDK over CAN** — documented by DJI, implemented by `DJIR_SDK`, and
   used by this project's CAN path.
2. **DUML over BLE** — DJI's general binary framing, documented by community
   reverse engineering for Osmo devices. It is the best starting point for the
   Ronin-S Bluetooth experiments, but it is **not confirmed** for the Ronin-S.

The source of truth for the CAN protocol is DJI's *DJI R SDK Protocol and User
Interface* PDF (v2.2), a copy of which is included in `ConstantRobotics/DJIR_SDK`
under `@Docs/`.

---

## 1. DJI R SDK over CAN (`0xAA` framing)

### Frame layout

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 1 | SOF | `0xAA` |
| 1 | 2 | Ver/Length | 10-bit total frame length, little-endian; upper 6 bits = version (0) |
| 3 | 1 | CmdType | bits 4:0 = reply type; bit 5 = frame type (0 command, 1 reply) |
| 4 | 1 | ENC | encryption info; 0 = plain |
| 5 | 3 | RES | reserved, zero |
| 8 | 2 | SEQ | sequence, big-endian |
| 10 | 2 | CRC16 | header CRC, little-endian |
| 12 | 1 | CmdSet | command set |
| 13 | 1 | CmdID | command id |
| 14 | n | CmdData | command payload |
| 14+n | 4 | CRC32 | whole-frame CRC, little-endian |

Total length = `18 + payload length` (10 header + 2 CRC16 + 2 cmd + payload + 4 CRC32).

### CRC parameters

| Name | Width | Poly | Init | RefIn | RefOut | XorOut |
| --- | --- | --- | --- | --- | --- | --- |
| CRC16 | 16 | `0x8005` | `0xC55C` | true | true | `0x0000` |
| CRC32 | 32 | `0x04C11DB7` | `0xC55C0000` | true | true | `0x00000000` |

Reflected form (what the JavaScript uses):

- CRC16: poly `0xA001`, init `reflect16(0xC55C) = 0x3AA3`
- CRC32: poly `0xEDB88320`, init `reflect32(0xC55C0000) = 0x00003AA3`

The implementations in `web/js/crc.js` reproduce the lookup tables in
`DJIR_SDK/3rdparty/custom_crc` exactly.

### Published sample

Position command (yaw 3.2°, roll 4.8°, pitch 6.4°, absolute, 2.0 s, seq `0x2211`):

```
AA 1A 00 03 00 00 00 00 22 11 A2 42 0E 00 20 00 30 00 40 00 01 14 7B 40 97 BE
```

`node tools/protocol-test.mjs` asserts that the builder produces this frame.

### Gimbal command set `0x0E`

| CmdID | Purpose |
| --- | --- |
| `0x00` | Position control |
| `0x01` | Speed control |
| `0x02` | Get gimbal information |
| `0x03` | Set limit angles |
| `0x04` | Get limit angles |
| `0x05` | Set motor stiffness |
| `0x06` | Get motor stiffness |
| `0x07` | Enable/disable parameter push |
| `0x08` | Pushed parameters (telemetry) |
| `0x09` | Get module version |
| `0x0A` | External controller (joystick/dial) push |
| `0x0B` | Get user parameters |
| `0x0C` | Set user parameters |
| `0x0D` | Operating mode |
| `0x0E` | Follow-mode / recenter |
| `0x0F` | Auto calibration |

#### `0x00` position control payload

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 2 | yaw | int16 LE, 0.1° |
| 2 | 2 | roll | int16 LE, 0.1° |
| 4 | 2 | pitch | int16 LE, 0.1° |
| 6 | 1 | ctrl_byte | bit 0: 1 = absolute, 0 = incremental; bits 1–3: yaw/roll/pitch **invalid** |
| 7 | 1 | time_for_action | uint8, 0.1 s (e.g. `20` = 2 s) |

> The `DJIR_SDK`'s `set_inverted_axis()` toggles bits 1–3 of this byte, but the
> protocol document defines those bits as "axis invalid". Treat them as invalid
> flags. This app keeps all axes valid by default.

#### `0x01` speed control payload

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 2 | yaw_speed | int16 LE, 0.1 °/s |
| 2 | 2 | roll_speed | int16 LE, 0.1 °/s |
| 4 | 2 | pitch_speed | int16 LE, 0.1 °/s |
| 6 | 1 | ctrl_byte | bit 7: 1 = take over speed control; bit 3: 1 = ignore focal length |

The command only lasts **0.5 s**; re-send it continuously for longer moves. Send
all-zero speeds to stop.

#### `0x02` get gimbal info

Command payload: one byte.

- `0x00` no operation
- `0x01` attitude angle
- `0x02` joint angle

Reply payload (per the PDF): `return code (1)`, `data_type (1)`, `yaw (2)`,
`roll (2)`, `pitch (2)`.

> **Warning:** the `DJIR_SDK` reads yaw/roll/pitch from payload offsets 0/2/4 of
> the reply, not 2/4/6. Real firmware and the PDF disagree (or the SDK relies on
> a different reply shape). The app parses offsets 0/2/4 first (SDK-compatible)
> and logs the raw frame so you can verify. This is worth confirming on hardware.

#### `0x07` parameter push

Command payload: one byte, `0x01` = enable, `0x02` = disable.

#### `0x08` pushed parameters

Payload:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | ctrl_byte (bit 0: angles valid) |
| 1 | 2 | yaw (0.1°) |
| 3 | 2 | roll (0.1°) |
| 5 | 2 | pitch (0.1°) |
| 7 | 6 | joint yaw/roll/pitch |
| 13 | 9 | limits and stiffness |

This is the cleanest telemetry source: fixed offsets, int16 LE, with a validity
bit. The app parses it and uses it to update the readout.

#### `0x0E` follow-mode / recenter

Two-byte payload: operating mode (`0xFE` = unchanged) and recenter command
(`0x01` = recenter once).

#### `0x0D` operating mode

Payload: operating mode (`0xFE` = unchanged), landscape/portrait setting
(`0x00` none, `0x01`/`0x02` landscape 0°/180°, `0x03`/`0x04` portrait ±90°,
`0x05` auto, `0xFF` default).

### CAN hardware parameters

- Baud rate: 1 Mbit/s
- Standard frames
- Device → host: `0x223`
- Host → device: `0x222`

---

## 2. DUML over BLE (`0x55` framing)

Community documentation for DJI Osmo BLE (not Ronin-S specific):

```
[0x55] [len_lo] [ver<<2 | len_hi] [CRC8]
[target:2B LE] [seq:2B BE] [flags] [cmdSet] [cmdId] [payload...]
[CRC16:2B LE]
```

| Field | Notes |
| --- | --- |
| Length | 10-bit total length = `13 + payload length` |
| Version | 6 bits, usually 1 (`byte[2] >> 2`) |
| CRC8 | poly `0x31`, init `0xEE`, reflected; over bytes 0–2 |
| Target | `sender \| (receiver << 8)`, little-endian on the wire |
| Sequence | big-endian |
| Flags | `0x40` request, `0xC0` response, `0x00` unsolicited telemetry |
| CRC16 | poly `0x1021`, init `0x496C`, reflected; over all bytes except the last 2 |

Reflected forms:

- CRC8: poly `0x8C`, init `reflect8(0xEE) = 0x77`
- CRC16: poly `0x8408`, init `reflect16(0x496C) = 0x3692`

### Addresses

| ID | Device |
| --- | --- |
| `0x01` | Camera |
| `0x02` | App / BLE client |
| `0x03` | Flight controller |
| `0x04` | Gimbal |
| `0x05` | Center board |
| `0x06` | RC |
| `0x07` | Wi-Fi |
| `0x08` | Transcoder |

App → gimbal target = `0x04 << 8 | 0x02` = `0x0402`, wire bytes `02 04`.

### BLE GATT (common DJI layout)

| UUID | Role |
| --- | --- |
| `FFF0` | Service |
| `FFF4` | Pairing trigger + notifications |
| `FFF5` | Command writes (`writeWithoutResponse` recommended) |

This comes from DJI's Osmo BLE demo. Try it on the Ronin-S, then use **Discover
GATT** and capture traffic if it does not respond.

### Using R SDK commands over DUML

The app can wrap the R SDK payloads (`cmdSet 0x0E`, cmd IDs `0x00`–`0x0E`) in a
DUML frame. This is a hypothesis: the payload format is likely shared, but the
Ronin-S may use a different command set (e.g. gimbal `0x04` commands seen on
Osmo). The testbed lets you try both without code changes:

- **Protocol framing** in the Advanced panel selects `DUML (0x55)` or `DJIR (0xAA)`.
- **Command set / command id** fields override the defaults.
- **Raw send** accepts any payload.

### Position sources parsed by the app

| Frame | Interpretation |
| --- | --- |
| `cmdSet 0x0E`, `cmdId 0x02` | R SDK reply: yaw/roll/pitch at payload 0/2/4 |
| `cmdSet 0x0E`, `cmdId 0x08` | R SDK push: yaw/roll/pitch at payload 1/3/5 (if ctrl bit 0 set) |
| `cmdSet 0x04`, `cmdId 0x05` | Osmo gimbal push: pitch/roll/yaw at payload 0/2/4 |

Raw frames are always logged; if your device uses a different layout, the log is
the place to start.

---

## 3. Safety notes

- The protocol's speed command is deliberately short-lived. Keeping it alive by
  re-sending is normal, but a bug can leave a motor spinning. The app sends a
  stop on every plausible exit path; verify this before testing on a real gimbal.
- Start with the joystick speed limit low (the default is 45 °/s) and the gimbal
  on a stable stand.
- Never put fingers, cables, or camera straps near the joints during a test.
- Use a camera body/lens combination within the gimbal's payload limit.
