/*
 * DJI R SDK over the DJIR CAN framing (0xAA).
 *
 * Frame:
 *   AA | len(2, LE; high 6 bits = version) | cmdType | enc | res(3) |
 *   seq(2, BE) | CRC16(2, LE) | cmdSet | cmdId | payload | CRC32(4, LE)
 *
 * Exposed as window.RoninDJIR.
 */
(function (global) {
  'use strict';

  const B = global.RoninBytes;
  const CRC = global.RoninCRC;

  const SOF = 0xaa;
  const CMD_TYPE_COMMAND = 0x03; // bits 4:0 = 3 (reply required), bit 5 = 0 (command)
  const CMD_TYPE_REPLY = 0x20; // bit 5 = 1 (reply), reply type 0
  const GIMBAL_CMD_SET = 0x0e;

  const GIMBAL_CMD = {
    POSITION: 0x00,
    SPEED: 0x01,
    INFO: 0x02,
    LIMIT_SET: 0x03,
    LIMIT_GET: 0x04,
    STIFFNESS_SET: 0x05,
    STIFFNESS_GET: 0x06,
    PUSH_SET: 0x07,
    PUSH_DATA: 0x08,
    VERSION: 0x09,
    EXTERNAL_CONTROL: 0x0a,
    USER_PARAMS_GET: 0x0b,
    USER_PARAMS_SET: 0x0c,
    MODE: 0x0d,
    FOLLOW_MODE: 0x0e,
    CALIBRATE: 0x0f
  };

  const POSITION_CTRL = {
    ABSOLUTE: 0x01,
    INCREMENTAL: 0x00,
    YAW_INVALID: 0x02,
    ROLL_INVALID: 0x04,
    PITCH_INVALID: 0x08
  };

  const SPEED_CTRL = {
    TAKE_OVER: 0x80,
    IGNORE_FOCAL_LENGTH: 0x08
  };

  const INFO_TYPE = {
    NONE: 0x00,
    ATTITUDE: 0x01,
    JOINT: 0x02
  };

  let sequence = 0x2210;

  function nextSequence() {
    sequence += 1;
    if (sequence > 0xfffd) sequence = 0x0002;
    return sequence;
  }

  function setSequence(value) {
    sequence = value & 0xffff;
  }

  /**
   * Build a 0xAA frame.
   * @param {object} opts
   * @param {number} [opts.cmdType=0x03]
   * @param {number} [opts.cmdSet=0x0E]
   * @param {number} [opts.cmdId]
   * @param {Uint8Array|number[]} [opts.payload]
   * @param {number} [opts.seq]  16-bit sequence; generated when omitted
   * @param {number} [opts.version=0]
   * @param {number} [opts.enc=0]
   * @returns {Uint8Array}
   */
  function buildFrame(opts) {
    const options = opts || {};
    const payload = options.payload ? B.toU8(options.payload) : new Uint8Array(0);
    const cmdType = options.cmdType === undefined ? CMD_TYPE_COMMAND : options.cmdType & 0xff;
    const cmdSet = options.cmdSet === undefined ? GIMBAL_CMD_SET : options.cmdSet & 0xff;
    const cmdId = options.cmdId === undefined ? 0 : options.cmdId & 0xff;
    const seq = options.seq === undefined ? nextSequence() : options.seq & 0xffff;
    const version = options.version === undefined ? 0 : options.version & 0x3f;
    const enc = options.enc === undefined ? 0 : options.enc & 0xff;

    const length = 18 + payload.length;
    if (length > 0x3ff) throw new Error('DJIR frame too long: ' + length);

    const out = new Uint8Array(length);
    out[0] = SOF;
    out[1] = length & 0xff;
    out[2] = ((length >>> 8) & 0x03) | (version << 2);
    out[3] = cmdType;
    out[4] = enc;
    out[5] = 0;
    out[6] = 0;
    out[7] = 0;
    B.writeU16BE(out, 8, seq);

    const headerCrc = CRC.crc16Djir(out.subarray(0, 10));
    B.writeU16LE(out, 10, headerCrc);

    out[12] = cmdSet;
    out[13] = cmdId;
    out.set(payload, 14);

    const frameCrc = CRC.crc32Djir(out.subarray(0, 14 + payload.length));
    B.writeU32LE(out, 14 + payload.length, frameCrc);

    return out;
  }

  // --- R SDK payload builders ----------------------------------------------

  function positionPayload(opts) {
    const options = opts || {};
    const yaw = B.clamp(B.toInt(options.yaw, 0), -1800, 1800);
    const roll = B.clamp(B.toInt(options.roll, 0), -1800, 1800);
    const pitch = B.clamp(B.toInt(options.pitch, 0), -1800, 1800);

    let ctrl = options.absolute === false ? POSITION_CTRL.INCREMENTAL : POSITION_CTRL.ABSOLUTE;
    const invalid = options.invalidAxes || [];
    if (invalid.indexOf('yaw') !== -1) ctrl |= POSITION_CTRL.YAW_INVALID;
    if (invalid.indexOf('roll') !== -1) ctrl |= POSITION_CTRL.ROLL_INVALID;
    if (invalid.indexOf('pitch') !== -1) ctrl |= POSITION_CTRL.PITCH_INVALID;

    const timeMs = B.toInt(options.timeMs, 1000);
    const time = B.clamp(Math.round(timeMs / 100), 1, 255);

    const out = new Uint8Array(8);
    B.writeI16LE(out, 0, yaw);
    B.writeI16LE(out, 2, roll);
    B.writeI16LE(out, 4, pitch);
    out[6] = ctrl;
    out[7] = time;
    return out;
  }

  function speedPayload(opts) {
    const options = opts || {};
    const yaw = B.clamp(B.toInt(options.yaw, 0), -3600, 3600);
    const roll = B.clamp(B.toInt(options.roll, 0), -3600, 3600);
    const pitch = B.clamp(B.toInt(options.pitch, 0), -3600, 3600);

    let ctrl = options.takeOver === false ? 0 : SPEED_CTRL.TAKE_OVER;
    if (options.ignoreFocalLength !== false) ctrl |= SPEED_CTRL.IGNORE_FOCAL_LENGTH;

    const out = new Uint8Array(7);
    B.writeI16LE(out, 0, yaw);
    B.writeI16LE(out, 2, roll);
    B.writeI16LE(out, 4, pitch);
    out[6] = ctrl;
    return out;
  }

  function infoPayload(type) {
    const value = type === undefined ? INFO_TYPE.ATTITUDE : type;
    return Uint8Array.from([value & 0xff]);
  }

  function pushTogglePayload(enable) {
    return Uint8Array.from([enable ? 0x01 : 0x02]);
  }

  function recenterPayload() {
    return Uint8Array.from([0xfe, 0x01]);
  }

  function modePayload(operatingMode, portraitMode) {
    return Uint8Array.from([
      operatingMode === undefined ? 0xfe : operatingMode & 0xff,
      portraitMode === undefined ? 0x00 : portraitMode & 0xff
    ]);
  }

  // --- High-level commands --------------------------------------------------

  function command(cmdId, payload, opts) {
    const options = opts || {};
    return buildFrame({
      cmdType: options.cmdType === undefined ? CMD_TYPE_COMMAND : options.cmdType,
      cmdSet: options.cmdSet === undefined ? GIMBAL_CMD_SET : options.cmdSet,
      cmdId: cmdId,
      payload: payload,
      seq: options.seq
    });
  }

  function positionCommand(opts) {
    return command(GIMBAL_CMD.POSITION, positionPayload(opts), opts);
  }

  function speedCommand(opts) {
    return command(GIMBAL_CMD.SPEED, speedPayload(opts), opts);
  }

  function infoCommand(type) {
    return command(GIMBAL_CMD.INFO, infoPayload(type));
  }

  function pushToggleCommand(enable) {
    return command(GIMBAL_CMD.PUSH_SET, pushTogglePayload(enable));
  }

  function recenterCommand() {
    return command(GIMBAL_CMD.FOLLOW_MODE, recenterPayload());
  }

  // --- Parsing --------------------------------------------------------------

  function parsePosition(payload) {
    if (!payload || payload.length < 6) return null;
    // SDK-compatible layout used by DJIR_SDK's DataHandle::_process_cmd.
    return {
      yaw: B.readI16LE(payload, 0),
      roll: B.readI16LE(payload, 2),
      pitch: B.readI16LE(payload, 4)
    };
  }

  function parsePositionDoc(payload) {
    if (!payload || payload.length < 8) return null;
    return {
      returnCode: payload[0],
      dataType: payload[1],
      yaw: B.readI16LE(payload, 2),
      roll: B.readI16LE(payload, 4),
      pitch: B.readI16LE(payload, 6)
    };
  }

  function parsePushedParams(payload) {
    if (!payload || payload.length < 7) return null;
    if ((payload[0] & 0x01) === 0) return null; // angle information invalid
    return {
      yaw: B.readI16LE(payload, 1),
      roll: B.readI16LE(payload, 3),
      pitch: B.readI16LE(payload, 5)
    };
  }

  /**
   * Incremental byte-stream parser. Feed it arbitrary BLE notification chunks;
   * it emits complete, CRC-checked frames.
   */
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

      // Drop bytes until an SOF is found.
      let start = 0;
      while (start < buf.length && buf[start] !== SOF) start += 1;
      if (start > 0) this.buffer = buf.slice(start);
      if (this.buffer.length < 18) break;

      const frame = this.buffer;
      const length = frame[1] | ((frame[2] & 0x03) << 8);
      if (length < 18 || length > 0x3ff) {
        this.buffer = frame.slice(1);
        continue;
      }
      if (frame.length < length) break;

      const candidate = frame.slice(0, length);
      const headerCrc = CRC.crc16Djir(candidate.subarray(0, 10));
      const recvHeaderCrc = B.readU16LE(candidate, 10);
      const frameCrc = CRC.crc32Djir(candidate.subarray(0, length - 4));
      const recvFrameCrc = B.readU32LE(candidate, length - 4);

      if (headerCrc !== recvHeaderCrc || frameCrc !== recvFrameCrc) {
        // Bad checksum: resynchronise one byte later.
        this.buffer = frame.slice(1);
        continue;
      }

      frames.push({
        raw: candidate,
        length: length,
        cmdType: candidate[3],
        isReply: (candidate[3] & 0x20) !== 0,
        enc: candidate[4],
        seq: B.readU16BE(candidate, 8),
        cmdSet: candidate[12],
        cmdId: candidate[13],
        payload: candidate.slice(14, length - 4)
      });

      this.buffer = frame.slice(length);
      if (this.buffer.length < 18) break;
    }

    return frames;
  };

  global.RoninDJIR = {
    SOF: SOF,
    GIMBAL_CMD_SET: GIMBAL_CMD_SET,
    GIMBAL_CMD: GIMBAL_CMD,
    POSITION_CTRL: POSITION_CTRL,
    SPEED_CTRL: SPEED_CTRL,
    INFO_TYPE: INFO_TYPE,
    CMD_TYPE_COMMAND: CMD_TYPE_COMMAND,
    CMD_TYPE_REPLY: CMD_TYPE_REPLY,
    nextSequence: nextSequence,
    setSequence: setSequence,
    buildFrame: buildFrame,
    positionPayload: positionPayload,
    speedPayload: speedPayload,
    infoPayload: infoPayload,
    pushTogglePayload: pushTogglePayload,
    recenterPayload: recenterPayload,
    modePayload: modePayload,
    positionCommand: positionCommand,
    speedCommand: speedCommand,
    infoCommand: infoCommand,
    pushToggleCommand: pushToggleCommand,
    recenterCommand: recenterCommand,
    parsePosition: parsePosition,
    parsePositionDoc: parsePositionDoc,
    parsePushedParams: parsePushedParams,
    Parser: Parser
  };
})(window);
