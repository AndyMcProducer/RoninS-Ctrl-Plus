# Bluetooth / BLE notes

This page is a practical guide to the experimental Bluetooth side.

## Before you start

- Use **Chrome or Edge** on macOS or Windows.
- Serve the app over `http://localhost` (secure context).
- Power on the Ronin-S and make sure it is not connected to another device. BLE
  peripherals commonly stop advertising while connected.
- If the gimbal does not appear, open the DJI Ronin app once, confirm Bluetooth
  works there, then close the app and try again.
- Keep the gimbal on a stand and the speed limit low.

## Default GATT profile

The app starts with DJI's common BLE layout:

```
Service  0000fff0-0000-1000-8000-00805f9b34fb
Notify   0000fff4-0000-1000-8000-00805f9b34fb
Write    0000fff5-0000-1000-8000-00805f9b34fb
```

- Write with **writeWithoutResponse** where possible.
- Subscribe to notifications on `FFF4`.
- `FFF4` is also used to trigger pairing on some DJI devices (write
  `[0x01, 0x00]`).

These UUIDs come from DJI's official Osmo BLE demo. They are a starting point,
**not** a guarantee for the Ronin-S.

## Discovering your device's GATT

1. Connect the gimbal in the app.
2. Open **Advanced → GATT services** and add the UUIDs you want permission to
   access, separated by commas. Web Bluetooth only grants access to services you
   listed before the device picker opened.
3. Click **Discover GATT**.
4. The discovered service/characteristic tree appears in the Connection card.
   Select the write and notify characteristics from there.

If nothing is discovered, you need the real service UUID first — see the capture
workflow below.

## Capture workflow

Reverse engineering is much easier with a real capture.

### Android (recommended)

1. Enable **Developer options**.
2. Enable **Enable Bluetooth HCI snoop log**.
3. Toggle Bluetooth off/on.
4. Open the DJI Ronin app and perform one action you want to reproduce (e.g.
   recenter, tilt).
5. Capture a bug report and pull the log:

   ```bash
   adb bugreport bt-logs
   adb pull /sdcard/Download/bt-logs .
   ```

6. Extract `FS/data/misc/bluetooth/logs/btsnoop_hci.log`.
7. Open it in Wireshark. Use the DJI DUML dissector from
   [`xaionaro/reverse-engineering-dji`](https://github.com/xaionaro/reverse-engineering-dji)
   if it matches your framing.

### macOS

1. Install **Additional Tools for Xcode** (includes PacketLogger).
2. Enable Bluetooth logging in PacketLogger.
3. Perform actions in the DJI Ronin app.
4. Export and inspect ATT/GATT traffic.

### What to look for

- The service and characteristic UUIDs used for writes and notifications.
- The first bytes of each write: `55` suggests DUML, `AA` suggests the DJIR
  framing, anything else means a third framing.
- Which characteristic receives responses/telemetry.
- Pairing/handshake writes that must happen before control commands work.

## Mapping a capture to the app

Once you have a frame:

1. Put the bytes in **Raw command → Payload (hex)**.
2. Set **Cmd set**, **Cmd ID**, and **Flags** to match the capture.
3. Choose the framing that starts with the same byte (`55` → DUML, `AA` → DJIR).
4. Press **Build & send** and compare the TX line in the log with the capture.
5. If the checksums match but the gimbal ignores it, the payload/command set is
   probably wrong for the Ronin-S. Iterate with one variable at a time.

The app logs both TX and RX in hex, so you can diff against Wireshark directly.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `navigator.bluetooth` is undefined | Safari/Firefox, or not a secure context |
| Device picker is empty | Gimbal already connected elsewhere, not advertising, or name filter too strict |
| `NotFoundError` after picker | Service UUID not in the `optionalServices` list |
| Connect succeeds, no notifications | Wrong notify characteristic, or the device needs a pairing/handshake write first |
| Writes succeed, nothing moves | Wrong framing, command set, or payload; check the log and captures |
| Works, then stops after ~0.5 s | Expected: speed commands must be re-sent (the app does this while the joystick is held) |
| macOS Bluetooth gets stuck | Reset the adapter (`blueutil --power 0`, wait, `blueutil --power 1`) or reboot |

## Legal / ethical note

Only capture and reverse engineer devices you own. Do not use this project to
interfere with anyone else's equipment. DJI's protocol documentation and firmware
remain DJI's property; this repository contains only original code and notes.
