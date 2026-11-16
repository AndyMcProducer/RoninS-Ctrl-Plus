/*
 * In-memory gimbal simulator.
 *
 * It accepts both DUML (0x55) and DJIR (0xAA) frames, animates a simple
 * yaw/roll/pitch model, and emits telemetry so the UI can be exercised without
 * hardware.
 *
 * Exposed as window.RoninSimulator.
 */
(function (global) {
  'use strict';

  const B = global.RoninBytes;
  const DJIR = global.RoninDJIR;
  const DUML = global.RoninDUML;

  const TICK_MS = 50;
  const PUSH_INTERVAL_MS = 100;
  const SPEED_WINDOW_MS = 500;

  function clampPosition(value) {
    return B.clamp(value, -1800, 1800);
  }

  function RoninSimulator() {
    this.name = 'Simulator';
    this.detail = 'In-memory gimbal';
    this.connected = false;
    this.onData = null;

    this.position = { yaw: 0, roll: 0, pitch: 0 };
    this.target = { yaw: 0, roll: 0, pitch: 0 };
    this.velocity = { yaw: 0, roll: 0, pitch: 0 };
    this.animation = null;
    this.speedUntil = 0;
    this.lastPush = 0;
    this.tickTimer = null;

    this.dumlParser = new DUML.Parser();
    this.djirParser = new DJIR.Parser();
  }

  RoninSimulator.prototype.connect = function () {
    const self = this;
    return new Promise(function (resolve) {
      self.connected = true;
      self.lastTick = Date.now();
      self.tickTimer = setInterval(function () { self.tick(); }, TICK_MS);
      setTimeout(function () {
        resolve({ name: self.name, detail: self.detail });
      }, 150);
    });
  };

  RoninSimulator.prototype.disconnect = function () {
    this.connected = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.velocity = { yaw: 0, roll: 0, pitch: 0 };
  };

  RoninSimulator.prototype.send = function (bytes) {
    if (!this.connected) return Promise.reject(new Error('Simulator is not connected'));
    const data = B.toU8(bytes);
    if (!data.length) return Promise.resolve();

    let frames = [];
    if (data[0] === DUML.SOF) {
      frames = this.dumlParser.push(data);
      frames.forEach(this.handleFrame.bind(this, 'duml'));
    } else if (data[0] === DJIR.SOF) {
      frames = this.djirParser.push(data);
      frames.forEach(this.handleFrame.bind(this, 'djir'));
    }
    return Promise.resolve();
  };

  RoninSimulator.prototype.handleFrame = function (framing, frame) {
    if (frame.cmdSet !== DJIR.GIMBAL_CMD_SET) return;

    switch (frame.cmdId) {
      case DJIR.GIMBAL_CMD.POSITION:
        this.handlePosition(frame.payload);
        break;
      case DJIR.GIMBAL_CMD.SPEED:
        this.handleSpeed(frame.payload);
        break;
      case DJIR.GIMBAL_CMD.INFO:
        this.replyPosition(framing, frame);
        break;
      case DJIR.GIMBAL_CMD.PUSH_SET:
        // Nothing to do: the simulator pushes all the time.
        break;
      case DJIR.GIMBAL_CMD.FOLLOW_MODE:
        if (frame.payload.length >= 2 && frame.payload[1] === 0x01) {
          this.moveTo({ yaw: 0, roll: 0, pitch: 0 }, 800);
        }
        break;
      default:
        break;
    }
  };

  RoninSimulator.prototype.handlePosition = function (payload) {
    if (payload.length < 8) return;

    const delta = {
      yaw: B.readI16LE(payload, 0),
      roll: B.readI16LE(payload, 2),
      pitch: B.readI16LE(payload, 4)
    };
    const ctrl = payload[6];
    const timeMs = Math.max(100, payload[7] * 100);
    const absolute = (ctrl & 0x01) !== 0;

    const target = absolute
      ? { yaw: delta.yaw, roll: delta.roll, pitch: delta.pitch }
      : {
        yaw: this.position.yaw + delta.yaw,
        roll: this.position.roll + delta.roll,
        pitch: this.position.pitch + delta.pitch
      };

    this.moveTo(target, timeMs);
  };

  RoninSimulator.prototype.handleSpeed = function (payload) {
    if (payload.length < 7) return;

    const ctrl = payload[6];
    if ((ctrl & 0x80) === 0) {
      this.velocity = { yaw: 0, roll: 0, pitch: 0 };
      return;
    }

    this.animation = null;
    this.velocity = {
      yaw: B.readI16LE(payload, 0),
      roll: B.readI16LE(payload, 2),
      pitch: B.readI16LE(payload, 4)
    };
    this.speedUntil = Date.now() + SPEED_WINDOW_MS;
  };

  RoninSimulator.prototype.moveTo = function (target, timeMs) {
    this.velocity = { yaw: 0, roll: 0, pitch: 0 };
    this.target = {
      yaw: clampPosition(target.yaw),
      roll: clampPosition(target.roll),
      pitch: clampPosition(target.pitch)
    };
    this.animation = {
      start: { yaw: this.position.yaw, roll: this.position.roll, pitch: this.position.pitch },
      duration: Math.max(100, timeMs),
      startedAt: Date.now()
    };
  };

  RoninSimulator.prototype.tick = function () {
    const now = Date.now();
    const dt = Math.max(0, now - (this.lastTick || now)) / 1000;
    this.lastTick = now;

    if (this.animation) {
      const t = B.clamp((now - this.animation.startedAt) / this.animation.duration, 0, 1);
      const ease = t * t * (3 - 2 * t); // smoothstep
      this.position = {
        yaw: this.animation.start.yaw + (this.target.yaw - this.animation.start.yaw) * ease,
        roll: this.animation.start.roll + (this.target.roll - this.animation.start.roll) * ease,
        pitch: this.animation.start.pitch + (this.target.pitch - this.animation.start.pitch) * ease
      };
      if (t >= 1) this.animation = null;
    } else if (now < this.speedUntil) {
      this.position.yaw = clampPosition(this.position.yaw + this.velocity.yaw * dt);
      this.position.roll = clampPosition(this.position.roll + this.velocity.roll * dt);
      this.position.pitch = clampPosition(this.position.pitch + this.velocity.pitch * dt);
    } else {
      this.velocity = { yaw: 0, roll: 0, pitch: 0 };
    }

    if (now - this.lastPush >= PUSH_INTERVAL_MS) {
      this.lastPush = now;
      this.emitPush();
    }
  };

  RoninSimulator.prototype.positionPayload = function () {
    const payload = new Uint8Array(22);
    payload[0] = 0x01; // angles valid
    B.writeI16LE(payload, 1, Math.round(this.position.yaw));
    B.writeI16LE(payload, 3, Math.round(this.position.roll));
    B.writeI16LE(payload, 5, Math.round(this.position.pitch));
    B.writeI16LE(payload, 7, Math.round(this.position.yaw));
    B.writeI16LE(payload, 9, Math.round(this.position.roll));
    B.writeI16LE(payload, 11, Math.round(this.position.pitch));
    payload[13] = 45;
    payload[14] = 0;
    payload[15] = 45;
    payload[16] = 0;
    payload[17] = 45;
    payload[18] = 0;
    payload[19] = 50;
    payload[20] = 50;
    payload[21] = 50;
    return payload;
  };

  RoninSimulator.prototype.emitPush = function () {
    if (!this.onData) return;
    const frame = DUML.buildFrame({
      sender: DUML.ADDR.GIMBAL,
      receiver: DUML.ADDR.APP,
      flags: DUML.FLAGS.NOTIFY,
      cmdSet: DJIR.GIMBAL_CMD_SET,
      cmdId: DJIR.GIMBAL_CMD.PUSH_DATA,
      payload: this.positionPayload()
    });
    this.onData(frame);
  };

  RoninSimulator.prototype.replyPosition = function (framing, frame) {
    if (!this.onData) return;

    if (framing === 'duml') {
      // Documented reply layout: return code, data type, yaw, roll, pitch.
      const payload = new Uint8Array(8);
      payload[0] = 0x00; // success
      payload[1] = 0x01; // attitude angle
      B.writeI16LE(payload, 2, Math.round(this.position.yaw));
      B.writeI16LE(payload, 4, Math.round(this.position.roll));
      B.writeI16LE(payload, 6, Math.round(this.position.pitch));

      this.onData(DUML.buildFrame({
        sender: DUML.ADDR.GIMBAL,
        receiver: DUML.ADDR.APP,
        seq: frame.seq,
        flags: DUML.FLAGS.RESPONSE,
        cmdSet: DJIR.GIMBAL_CMD_SET,
        cmdId: DJIR.GIMBAL_CMD.INFO,
        payload: payload
      }));
      return;
    }

    // DJIR_SDK-compatible reply: yaw, roll, pitch at payload 0/2/4.
    const payload = new Uint8Array(6);
    B.writeI16LE(payload, 0, Math.round(this.position.yaw));
    B.writeI16LE(payload, 2, Math.round(this.position.roll));
    B.writeI16LE(payload, 4, Math.round(this.position.pitch));

    this.onData(DJIR.buildFrame({
      cmdType: DJIR.CMD_TYPE_REPLY,
      cmdSet: DJIR.GIMBAL_CMD_SET,
      cmdId: DJIR.GIMBAL_CMD.INFO,
      seq: frame.seq,
      payload: payload
    }));
  };

  global.RoninSimulator = RoninSimulator;
})(window);
