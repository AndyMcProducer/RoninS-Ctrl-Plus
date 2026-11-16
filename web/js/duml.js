/*
 * DUML over BLE (0x55 framing).
 *
 * Frame:
 *   55 | len(2, 10-bit LE + 6-bit version) | CRC8 |
 *   target(2, LE) | seq(2, BE) | flags | cmdSet | cmdId | payload | CRC16(2, LE)
 *
 * CRC parameters are the community defaults for DJI BLE. Ronin-S support is
 * experimental; see docs/protocol-notes.md.
 *
 * Exposed as window.RoninDUML.
 */
(function (global) {
  'use strict';

  const B = global.RoninBytes;
  const CRC = global.RoninCRC;
  const DJIR = global.RoninDJIR;

  const SOF = 0x55;
  const ADDR = {
    INVALID: 0x00,
    CAMERA: 0x01,
    APP: 0x02,
    FC: 0x03,
    GIMBAL: 0x04,
    CENTER_BOARD: 0x05,
    RC: 0x06,
    WIFI: 0x07,
    TRANSCODER: 0x08
  };

  const FLAGS = {
    REQUEST: 0x40,
    RESPONSE: 0xc0,
    NOTIFY: 0x00
  };

  let sequence = 0x0000;

  function nextSequence() {
    sequence = (sequence + 1) & 0xffff;
    return sequence;
  }

  function setSequence(value) {
    sequence = value & 0xffff;
  }

  function targetFor(sender, receiver) {
    return ((receiver & 0xff) << 8) | (sender & 0xff);
  }

  /**
   * Build a DUML frame.
   * @param {object} opts
   * @param {number} [opts.sender=0x02]
   * @param {number} [opts.receiver=0x04]
   * @param {number} [opts.target]  raw target override
   * @param {number} [opts.seq]
   * @param {number} [opts.flags=0x40]
   * @param {number} [opts.cmdSet=0x0E]
   * @param {number} [opts.cmdId]
   * @param {Uint8Array|number[]} [opts.payload]
   * @param {number} [opts.version=1]
   * @returns {Uint8Array}
   */
  function buildFrame(opts) {
    const options = opts || {};
    const payload = options.payload ? B.toU8(options.payload) : new Uint8Array(0);
    const sender = options.sender === undefined ? ADDR.APP : options.sender & 0xff;
    const receiver = options.receiver === undefined ? ADDR.GIMBAL : options.receiver & 0xff;
    const target = options.target === undefined
      ? targetFor(sender, receiver)
      : options.target & 0xffff;
    const seq = options.seq === undefined ? nextSequence() : options.seq & 0xffff;
    const flags = options.flags === undefined ? FLAGS.REQUEST : options.flags & 0xff;
    const cmdSet = options.cmdSet === undefined ? 0x0e : options.cmdSet & 0xff;
    const cmdId = options.cmdId === undefined ? 0 : options.cmdId & 0xff;
    const version = options.version === undefined ? 1 : options.version & 0x3f;

    const length = 13 + payload.length;
    if (length > 0x3ff) throw new Error('DUML frame too long: ' + length);

    const out = new Uint8Array(length);
    out[0] = SOF;
    out[1] = length & 0xff;
    out[2] = ((length >>> 8) & 0x03) | (version << 2);
    out[3] = CRC.crc8Duml(out.subarray(0, 3));
    B.writeU16LE(out, 4, target);
    B.writeU16BE(out, 6, seq);
    out[8] = flags;
    out[9] = cmdSet;
    out[10] = cmdId;
    out.set(payload, 11);

    const frameCrc = CRC.crc16Duml(out.subarray(0, length - 2));
    B.writeU16LE(out, length - 2, frameCrc);

    return out;
  }

  // --- R SDK commands wrapped in DUML --------------------------------------

  function command(cmdId, payload, opts) {
    const options = opts || {};
    return buildFrame({
      sender: options.sender,
      receiver: options.receiver,
      target: options.target,
      seq: options.seq,
      flags: options.flags,
      cmdSet: options.cmdSet === undefined ? DJIR.GIMBAL_CMD_SET : options.cmdSet,
      cmdId: cmdId,
      payload: payload
    });
  }

  function positionCommand(opts) {
    return command(DJIR.GIMBAL_CMD.POSITION, DJIR.positionPayload(opts), opts);
  }

  function speedCommand(opts) {
    return command(DJIR.GIMBAL_CMD.SPEED, DJIR.speedPayload(opts), opts);
  }

  function infoCommand(type) {
    return command(DJIR.GIMBAL_CMD.INFO, DJIR.infoPayload(type));
  }

  function pushToggleCommand(enable) {
    return command(DJIR.GIMBAL_CMD.PUSH_SET, DJIR.pushTogglePayload(enable));
  }

  function recenterCommand() {
    return command(DJIR.GIMBAL_CMD.FOLLOW_MODE, DJIR.recenterPayload());
  }

  // --- Parsing --------------------------------------------------------------

  /**
   * Osmo-style gimbal push (cmdSet 0x04, cmdId 0x05).
   * Payload order is pitch, roll, yaw (0.1 deg).
   */
  function parseGimbalPush(payload) {
    if (!payload || payload.length < 6) return null;
    return {
      pitch: B.readI16LE(payload, 0),
      roll: B.readI16LE(payload, 2),
      yaw: B.readI16LE(payload, 4)
    };
  }

  function Parser() {
    this.buffer = new Uint8Array(0);
  }

  Parser.prototype.push = function (chunk) {
    const bytes = B.toU8(chunk);
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;
    return this.drain();
  };

  Parser.prototype.drain = function () {
    const frames = [];

    for (;;) {
      const buf = this.buffer;

      let start = 0;
      while (start < buf.length && buf[start] !== SOF) start += 1;
      if (start > 0) this.buffer = buf.slice(start);
      if (this.buffer.length < 13) break;

      const frame = this.buffer;
      const length = frame[1] | ((frame[2] & 0x03) << 8);
      if (length < 13 || length > 0x3ff) {
        this.buffer = frame.slice(1);
        continue;
      }
      if (frame.length < length) break;

      const candidate = frame.slice(0, length);
      const crc8 = CRC.crc8Duml(candidate.subarray(0, 3));
      if (crc8 !== candidate[3]) {
        this.buffer = frame.slice(1);
        continue;
      }

      const crc16 = CRC.crc16Duml(candidate.subarray(0, length - 2));
      const recvCrc16 = B.readU16LE(candidate, length - 2);
      if (crc16 !== recvCrc16) {
        this.buffer = frame.slice(1);
        continue;
      }

      const target = B.readU16LE(candidate, 4);
      frames.push({
        raw: candidate,
        length: length,
        version: candidate[2] >>> 2,
        target: target,
        sender: target & 0xff,
        receiver: (target >>> 8) & 0xff,
        seq: B.readU16BE(candidate, 6),
        flags: candidate[8],
        cmdSet: candidate[9],
        cmdId: candidate[10],
        payload: candidate.slice(11, length - 2)
      });

      this.buffer = frame.slice(length);
      if (this.buffer.length < 13) break;
    }

    return frames;
  };

  global.RoninDUML = {
    SOF: SOF,
    ADDR: ADDR,
    FLAGS: FLAGS,
    nextSequence: nextSequence,
    setSequence: setSequence,
    targetFor: targetFor,
    buildFrame: buildFrame,
    positionCommand: positionCommand,
    speedCommand: speedCommand,
    infoCommand: infoCommand,
    pushToggleCommand: pushToggleCommand,
    recenterCommand: recenterCommand,
    parseGimbalPush: parseGimbalPush,
    Parser: Parser
  };
})(window);
