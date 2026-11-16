/*
 * RoninS-Ctrl-Plus application shell.
 *
 * Wires the transports (simulator / Web Bluetooth / CAN bridge) to the R SDK
 * command builders in js/djir.js and js/duml.js.
 */
(function () {
  'use strict';

  const B = window.RoninBytes;
  const CRC = window.RoninCRC;
  const DJIR = window.RoninDJIR;
  const DUML = window.RoninDUML;

  const SETTINGS_KEY = 'roninS-Ctrl-Plus.settings.v1';
  const SPEED_INTERVAL_MS = 100;
  const SPEED_LOG_MS = 500;
  const MAX_LOG_LINES = 500;

  const state = {
    transport: null,
    transportKind: 'sim',
    connected: false,
    connecting: false,
    position: { yaw: 0, roll: 0, pitch: 0 },
    positionAt: 0,
    positionSource: '',
    speed: { yaw: 0, pitch: 0, roll: 0 },
    pointerActive: false,
    pointerVec: { x: 0, y: 0 },
    keyVec: { x: 0, y: 0 },
    keys: new Set(),
    speedTimer: null,
    motionActive: false,
    lastSpeedLogAt: 0,
    lastStopAt: 0,
    lastOfflineWarnAt: 0,
    pushEnabled: false,
    dumlParser: null,
    djirParser: null,
    lastRxFraming: null,
    lastTick: 0
  };

  const SETTING_FIELDS = [
    ['transport', 'value'],
    ['nameFilter', 'value'],
    ['serviceUuids', 'value'],
    ['writeUuid', 'value'],
    ['notifyUuid', 'value'],
    ['writeMode', 'value'],
    ['bridgeUrl', 'value'],
    ['framing', 'value'],
    ['cmdSet', 'value'],
    ['flags', 'value'],
    ['sender', 'value'],
    ['receiver', 'value'],
    ['speedLimit', 'value'],
    ['rollSpeed', 'value'],
    ['ignoreFocal', 'checked'],
    ['invertYaw', 'checked'],
    ['invertPitch', 'checked'],
    ['logAutoScroll', 'checked']
  ];

  // --- dom helpers ----------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function on(id, event, handler) {
    const el = $(id);
    if (el) el.addEventListener(event, handler);
  }

  function value(id) {
    const el = $(id);
    return el ? el.value : '';
  }

  function checked(id) {
    const el = $(id);
    return el ? el.checked : false;
  }

  function nowStamp() {
    const d = new Date();
    return [
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
      String(d.getSeconds()).padStart(2, '0')
    ].join(':') + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function hex(value, width) {
    return (value >>> 0).toString(16).toUpperCase().padStart(width || 2, '0');
  }

  function readHexByte(id, fallback) {
    const raw = value(id).trim().replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,2}$/i.test(raw)) return fallback;
    return parseInt(raw, 16) & 0xff;
  }

  function parseUuidList(text) {
    return String(text || '')
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(function (uuid) {
        return window.RoninBLE ? window.RoninBLE.normalizeUuid(uuid) : uuid;
      });
  }

  function numberValue(id, fallback) {
    const n = Number(value(id));
    return Number.isFinite(n) ? n : fallback;
  }

  // --- logging --------------------------------------------------------------

  function appendLog(kind, text) {
    const logEl = $('log');
    const line = document.createElement('span');
    line.className = 'line';

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = nowStamp() + '  ';

    const msg = document.createElement('span');
    if (kind === 'tx') msg.className = 'dir-tx';
    else if (kind === 'rx') msg.className = 'dir-rx';
    else if (kind === 'err') msg.className = 'err';
    else msg.className = 'sys';
    msg.textContent = text;

    line.appendChild(ts);
    line.appendChild(msg);
    logEl.appendChild(line);

    while (logEl.childElementCount > MAX_LOG_LINES) {
      logEl.firstElementChild.remove();
    }

    if (checked('logAutoScroll')) logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(level, text) {
    const dot = $('statusDot');
    dot.className = 'dot' + (level ? ' ' + level : '');
    $('statusText').textContent = text || 'Disconnected';
  }

  function describeFrame(framing, frame) {
    if (framing === 'duml') {
      return 'DUML seq=' + hex(frame.seq, 4) +
        ' target=' + hex(frame.target, 4) +
        ' flags=' + hex(frame.flags, 2) +
        ' cmd=' + hex(frame.cmdSet, 2) + '/' + hex(frame.cmdId, 2) +
        ' payload=' + (frame.payload.length ? B.toHex(frame.payload) : '(empty)');
    }
    return 'DJIR seq=' + hex(frame.seq, 4) +
      ' type=' + hex(frame.cmdType, 2) +
      ' cmd=' + hex(frame.cmdSet, 2) + '/' + hex(frame.cmdId, 2) +
      ' payload=' + (frame.payload.length ? B.toHex(frame.payload) : '(empty)');
  }

  function logFrame(direction, framing, frame, description) {
    const prefix = direction === 'tx' ? 'TX  ' : 'RX  ';
    const label = description ? description + ' | ' : '';
    appendLog(
      direction,
      prefix + label + describeFrame(framing, frame) + ' | ' + B.toHex(frame.raw)
    );
  }

  // --- settings -------------------------------------------------------------

  function saveSettings() {
    const data = {};
    SETTING_FIELDS.forEach(function (entry) {
      const el = $(entry[0]);
      if (!el) return;
      data[entry[0]] = entry[1] === 'checked' ? el.checked : el.value;
    });
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch (e) {
      // Private mode / storage disabled; not fatal.
    }
  }

  function loadSettings() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    } catch (e) {
      data = null;
    }
    if (!data) return;

    SETTING_FIELDS.forEach(function (entry) {
      const id = entry[0];
      const prop = entry[1];
      const el = $(id);
      if (!el || !(id in data)) return;

      if (prop === 'checked') {
        el.checked = !!data[id];
      } else {
        el.value = data[id];
      }

      if (id === 'speedLimit') $('speedLimitValue').textContent = el.value;
      if (id === 'rollSpeed') $('rollSpeedValue').textContent = el.value;
    });
  }

  function bindSettings() {
    SETTING_FIELDS.forEach(function (entry) {
      const el = $(entry[0]);
      if (!el) return;
      el.addEventListener('change', saveSettings);
      el.addEventListener('input', saveSettings);
    });
  }

  // --- UI state -------------------------------------------------------------

  function setUiConnected(connected) {
    $('connectBtn').disabled = connected;
    $('disconnectBtn').disabled = !connected;
    $('transport').disabled = connected;
    $('connBadge').textContent = connected ? 'online' : 'offline';

    [
      'recenterBtn',
      'stopBtn',
      'requestPosBtn',
      'pushBtn',
      'moveBtn',
      'rawSendBtn',
      'rawGetPos',
      'rawStop'
    ].forEach(function (id) {
      $(id).disabled = !connected;
    });

    document.querySelectorAll('.preset').forEach(function (button) {
      button.disabled = !connected;
    });

    $('discoverBtn').disabled = !connected || state.transportKind !== 'ble';

    if (!connected) {
      $('deviceInfo').classList.add('hidden');
      $('gattTree').classList.add('hidden');
      $('gattTree').replaceChildren();
    }
  }

  function updateTransportUi(resetFraming) {
    const kind = value('transport');
    $('bleFields').classList.toggle('hidden', kind !== 'ble');
    $('bridgeField').classList.toggle('hidden', kind !== 'bridge');

    let hint = '';
    if (kind === 'sim') {
      hint = 'No hardware needed. The simulator emulates a gimbal, including telemetry.';
    } else if (kind === 'ble') {
      hint = window.RoninBLE && window.RoninBLE.isSupported()
        ? 'Chrome/Edge only. Power on the gimbal, close the DJI Ronin app, then connect.'
        : 'Web Bluetooth is unavailable here. Use Chrome or Edge on macOS/Windows over http://localhost.';
    } else {
      hint = 'Requires the native CAN bridge (bridge/README.md). Not implemented yet.';
    }
    $('transportHint').textContent = hint;

    if (resetFraming) {
      $('framing').value = kind === 'bridge' ? 'djir' : 'duml';
    }

    $('rawFramingLabel').textContent = value('framing') === 'duml' ? 'DUML' : 'DJIR';
    $('discoverBtn').disabled = !state.connected || kind !== 'ble';
    updateRawPreview();
  }

  // --- transport ------------------------------------------------------------

  function createTransport(kind) {
    if (kind === 'sim') {
      const transport = new window.RoninSimulator();
      transport.onData = handleIncomingBytes;
      return transport;
    }

    if (kind === 'ble') {
      const transport = new window.RoninBLE.Transport({
        nameFilter: value('nameFilter'),
        serviceUuids: parseUuidList(value('serviceUuids')),
        writeUuid: value('writeUuid'),
        notifyUuid: value('notifyUuid'),
        writeMode: value('writeMode')
      });
      transport.onData = handleIncomingBytes;
      transport.onStatus = function (level, message) {
        appendLog(level === 'error' ? 'err' : 'sys', 'BLE: ' + message);
        if (level === 'error') setStatus('error', message);
      };
      transport.onDisconnect = handleTransportDisconnect;
      return transport;
    }

    if (kind === 'bridge') {
      const transport = new window.RoninBridge({ url: value('bridgeUrl') });
      transport.onData = handleIncomingBytes;
      transport.onTelemetry = handleBridgeTelemetry;
      transport.onStatus = function (level, message) {
        appendLog(level === 'error' ? 'err' : 'sys', 'Bridge: ' + message);
        if (level === 'error') setStatus('error', message);
      };
      transport.onDisconnect = handleTransportDisconnect;
      return transport;
    }

    throw new Error('Unknown transport: ' + kind);
  }

  async function connect() {
    if (state.connected || state.connecting) return;

    const kind = value('transport');
    state.connecting = true;
    state.transportKind = kind;
    $('connectBtn').disabled = true;
    setStatus('info', 'Connecting...');
    appendLog('sys', 'Connecting via ' + kind + '...');

    try {
      state.transport = createTransport(kind);

      state.dumlParser = new DUML.Parser();
      state.djirParser = new DJIR.Parser();
      state.lastRxFraming = null;
      state.positionAt = 0;
      state.positionSource = '';
      state.pushEnabled = false;
      $('pushBtn').textContent = 'Enable push';
      $('telemetryAge').textContent = 'no data';
      $('telemetryAge').classList.remove('live');

      const info = await state.transport.connect();

      state.connected = true;
      $('deviceName').textContent = info.name || '—';
      $('deviceDetail').textContent = info.detail || '—';
      $('deviceInfo').classList.remove('hidden');

      setUiConnected(true);
      setStatus('ok', 'Connected to ' + (info.name || 'device'));
      appendLog('sys', 'Connected: ' + (info.name || 'device') + (info.detail ? ' · ' + info.detail : ''));

      if (kind === 'ble' && state.transport.services) {
        renderGattTree();
      }
      updateRawPreview();
    } catch (error) {
      state.connected = false;
      state.transport = null;
      setUiConnected(false);
      setStatus('error', error.message || String(error));
      appendLog('err', 'Connection failed: ' + (error.message || String(error)));
    } finally {
      state.connecting = false;
      $('connectBtn').disabled = state.connected;
    }
  }

  function disconnect() {
    if (!state.connected) return;

    stopMotion({ send: false });
    const transport = state.transport;
    state.connected = false;
    state.transport = null;

    if (transport) {
      try {
        transport.disconnect();
      } catch (e) {
        appendLog('err', 'Disconnect error: ' + e.message);
      }
    }

    setUiConnected(false);
    setStatus('', 'Disconnected');
    appendLog('sys', 'Disconnected');
  }

  function handleTransportDisconnect() {
    if (!state.connected) return;
    state.connected = false;
    state.transport = null;
    stopMotion({ send: false });
    setUiConnected(false);
    setStatus('warn', 'Disconnected');
    appendLog('sys', 'Transport disconnected');
  }

  // --- incoming frames ------------------------------------------------------

  function handleIncomingBytes(bytes) {
    const data = B.toU8(bytes);
    if (!data.length) return;

    appendLog('rx', 'RX  ' + B.toHex(data));

    let framing = state.lastRxFraming;
    let parser;

    if (data[0] === DUML.SOF) {
      framing = 'duml';
      parser = state.dumlParser;
    } else if (data[0] === DJIR.SOF) {
      framing = 'djir';
      parser = state.djirParser;
    } else {
      parser = framing === 'duml' ? state.dumlParser : framing === 'djir' ? state.djirParser : null;
    }

    if (!parser) {
      appendLog('sys', 'Ignoring data from an unknown framing');
      return;
    }

    state.lastRxFraming = framing;

    let frames = [];
    try {
      frames = parser.push(data);
    } catch (error) {
      appendLog('err', 'Parse error: ' + error.message);
      return;
    }

    frames.forEach(function (frame) {
      logFrame('rx', framing, frame, '');
      handleFrame(framing, frame);
    });
  }

  function handleFrame(framing, frame) {
    if (frame.cmdSet === DJIR.GIMBAL_CMD_SET && frame.cmdId === DJIR.GIMBAL_CMD.INFO) {
      parseInfoReply(framing, frame.payload);
      return;
    }

    if (frame.cmdSet === DJIR.GIMBAL_CMD_SET && frame.cmdId === DJIR.GIMBAL_CMD.PUSH_DATA) {
      const pushed = DJIR.parsePushedParams(frame.payload);
      if (pushed) updatePosition(pushed.yaw, pushed.roll, pushed.pitch, 'push');
      return;
    }

    if (framing === 'duml' && frame.cmdSet === 0x04 && frame.cmdId === 0x05) {
      const pushed = DUML.parseGimbalPush(frame.payload);
      if (pushed) updatePosition(pushed.yaw, pushed.roll, pushed.pitch, 'gimbal push');
      return;
    }

    if (frame.cmdSet === DJIR.GIMBAL_CMD_SET &&
        (frame.cmdId === DJIR.GIMBAL_CMD.POSITION || frame.cmdId === DJIR.GIMBAL_CMD.SPEED)) {
      const code = frame.payload.length ? frame.payload[0] : 0xff;
      appendLog('sys', 'Command ' + hex(frame.cmdId, 2) + ' return code: 0x' + hex(code, 2));
    }
  }

  function parseInfoReply(framing, payload) {
    let parsed = null;

    if (framing === 'duml' && payload.length >= 8 && payload[0] <= 0x02 && payload[1] <= 0x02) {
      // Documented reply: return code, data type, yaw, roll, pitch.
      parsed = {
        yaw: B.readI16LE(payload, 2),
        roll: B.readI16LE(payload, 4),
        pitch: B.readI16LE(payload, 6)
      };
    } else {
      // SDK-compatible reply: yaw, roll, pitch at offsets 0/2/4.
      parsed = DJIR.parsePosition(payload);
    }

    if (parsed) {
      updatePosition(parsed.yaw, parsed.roll, parsed.pitch, framing === 'duml' ? 'info reply' : 'SDK reply');
    }
  }

  function handleBridgeTelemetry(telemetry) {
    updatePosition(telemetry.yaw, telemetry.roll, telemetry.pitch, telemetry.source || 'bridge');
    appendLog(
      'rx',
      'RX  BRIDGE telemetry yaw=' + (telemetry.yaw / 10).toFixed(1) +
      ' roll=' + (telemetry.roll / 10).toFixed(1) +
      ' pitch=' + (telemetry.pitch / 10).toFixed(1)
    );
  }

  function updatePosition(yaw, roll, pitch, source) {
    if ([yaw, roll, pitch].some(function (v) { return Math.abs(v) > 3600; })) {
      appendLog('sys', 'Ignoring implausible telemetry: ' + [yaw, roll, pitch].join(', '));
      return;
    }

    state.position = { yaw: yaw, roll: roll, pitch: pitch };
    state.positionAt = Date.now();
    state.positionSource = source || '';

    $('yawValue').innerHTML = (yaw / 10).toFixed(1) + '<span>°</span>';
    $('rollValue').innerHTML = (roll / 10).toFixed(1) + '<span>°</span>';
    $('pitchValue').innerHTML = (pitch / 10).toFixed(1) + '<span>°</span>';

    const age = $('telemetryAge');
    age.textContent = 'live';
    age.classList.add('live');
    age.title = 'Source: ' + (source || 'unknown');
  }

  // --- command sending ------------------------------------------------------

  function framing() {
    return value('framing') === 'djir' ? 'djir' : 'duml';
  }

  function controlFrame(cmdId, payload) {
    const cmdSet = readHexByte('cmdSet', DJIR.GIMBAL_CMD_SET);
    if (framing() === 'duml') {
      return DUML.buildFrame({
        sender: readHexByte('sender', DUML.ADDR.APP),
        receiver: readHexByte('receiver', DUML.ADDR.GIMBAL),
        flags: readHexByte('flags', DUML.FLAGS.REQUEST),
        cmdSet: cmdSet,
        cmdId: cmdId,
        payload: payload
      });
    }
    return DJIR.buildFrame({
      cmdType: DJIR.CMD_TYPE_COMMAND,
      cmdSet: cmdSet,
      cmdId: cmdId,
      payload: payload
    });
  }

  function logBridge(message) {
    appendLog('tx', 'TX  BRIDGE ' + JSON.stringify(message));
  }

  function sendFrame(bytes, framingName, description) {
    if (!state.connected || !state.transport) {
      warnOffline();
      return Promise.resolve();
    }

    const data = B.toU8(bytes);
    const frame = parseSingleFrame(framingName, data);
    if (frame) {
      logFrame('tx', framingName, frame, description || '');
    } else {
      appendLog('tx', 'TX  ' + (description || '') + ' | ' + B.toHex(data));
    }

    return Promise.resolve(state.transport.send(data)).catch(function (error) {
      appendLog('err', 'Send failed: ' + (error.message || error));
      setStatus('error', 'Send failed');
    });
  }

  function parseSingleFrame(framingName, data) {
    try {
      if (framingName === 'duml') {
        const parser = new DUML.Parser();
        const frames = parser.push(data);
        return frames.length ? frames[0] : null;
      }
      const parser = new DJIR.Parser();
      const frames = parser.push(data);
      return frames.length ? frames[0] : null;
    } catch (e) {
      return null;
    }
  }

  function warnOffline() {
    const now = Date.now();
    if (now - state.lastOfflineWarnAt < 1500) return;
    state.lastOfflineWarnAt = now;
    appendLog('sys', 'Not connected. Press Connect first.');
  }

  function sendPosition(yawTenths, rollTenths, pitchTenths, timeMs, absolute, description) {
    // A position command takes over from speed mode; make sure speed is stopped.
    if (state.motionActive) {
      stopMotion({ send: true, force: true });
    } else {
      stopSpeedLoop();
    }

    if (state.transportKind === 'bridge') {
      const message = {
        type: 'command',
        action: 'position',
        yaw: Math.round(yawTenths),
        roll: Math.round(rollTenths),
        pitch: Math.round(pitchTenths),
        timeMs: Math.round(timeMs),
        absolute: !!absolute
      };
      logBridge(message);
      state.transport.sendCommand('position', {
        yaw: message.yaw,
        roll: message.roll,
        pitch: message.pitch,
        timeMs: message.timeMs,
        absolute: message.absolute
      }).catch(function (error) {
        appendLog('err', 'Bridge command failed: ' + error.message);
      });
      return;
    }

    const payload = DJIR.positionPayload({
      yaw: yawTenths,
      roll: rollTenths,
      pitch: pitchTenths,
      timeMs: timeMs,
      absolute: absolute
    });
    sendFrame(
      controlFrame(DJIR.GIMBAL_CMD.POSITION, payload),
      framing(),
      description || 'POSITION ' + (absolute ? 'absolute' : 'incremental')
    );
  }

  function sendSpeed(yaw, pitch, roll, quiet) {
    if (!state.connected || !state.transport) {
      warnOffline();
      return;
    }

    const now = Date.now();
    const shouldLog = !quiet || now - state.lastSpeedLogAt >= SPEED_LOG_MS;
    if (shouldLog) state.lastSpeedLogAt = now;

    if (state.transportKind === 'bridge') {
      const options = {
        yaw: Math.round(yaw),
        roll: Math.round(roll),
        pitch: Math.round(pitch),
        takeOver: true,
        ignoreFocalLength: checked('ignoreFocal')
      };
      if (shouldLog) {
        logBridge({ type: 'command', action: 'speed', yaw: options.yaw, roll: options.roll, pitch: options.pitch });
      }
      state.transport.sendCommand('speed', options).catch(function (error) {
        appendLog('err', 'Bridge speed failed: ' + error.message);
      });
      return;
    }

    const payload = DJIR.speedPayload({
      yaw: yaw,
      roll: roll,
      pitch: pitch,
      takeOver: true,
      ignoreFocalLength: checked('ignoreFocal')
    });
    const description = shouldLog
      ? 'SPEED yaw=' + (yaw / 10).toFixed(1) + ' pitch=' + (pitch / 10).toFixed(1) + ' roll=' + (roll / 10).toFixed(1)
      : '';
    sendFrame(controlFrame(DJIR.GIMBAL_CMD.SPEED, payload), framing(), description);
  }

  function sendStop(force) {
    if (!state.connected || !state.transport) return;

    const now = Date.now();
    if (!force && now - state.lastStopAt < 250) return;
    state.lastStopAt = now;

    if (state.transportKind === 'bridge') {
      logBridge({ type: 'command', action: 'stop' });
      state.transport.sendCommand('stop', {}).catch(function (error) {
        appendLog('err', 'Bridge stop failed: ' + error.message);
      });
      return;
    }

    const payload = DJIR.speedPayload({
      yaw: 0,
      roll: 0,
      pitch: 0,
      takeOver: true,
      ignoreFocalLength: checked('ignoreFocal')
    });
    sendFrame(controlFrame(DJIR.GIMBAL_CMD.SPEED, payload), framing(), 'STOP');
  }

  function sendInfo() {
    if (!state.connected || !state.transport) {
      warnOffline();
      return;
    }

    if (state.transportKind === 'bridge') {
      logBridge({ type: 'command', action: 'info', infoType: 1 });
      state.transport.sendCommand('info', { infoType: 1 }).catch(function (error) {
        appendLog('err', 'Bridge info failed: ' + error.message);
      });
      return;
    }

    sendFrame(
      controlFrame(DJIR.GIMBAL_CMD.INFO, DJIR.infoPayload(DJIR.INFO_TYPE.ATTITUDE)),
      framing(),
      'INFO attitude'
    );
  }

  function sendPush(enable) {
    if (!state.connected || !state.transport) {
      warnOffline();
      return;
    }

    if (state.transportKind === 'bridge') {
      logBridge({ type: 'command', action: 'push', enable: !!enable });
      state.transport.sendCommand('push', { enable: !!enable }).catch(function (error) {
        appendLog('err', 'Bridge push failed: ' + error.message);
      });
      return;
    }

    sendFrame(
      controlFrame(DJIR.GIMBAL_CMD.PUSH_SET, DJIR.pushTogglePayload(enable)),
      framing(),
      enable ? 'PUSH enable' : 'PUSH disable'
    );
  }

  // --- speed loop -----------------------------------------------------------

  function startSpeedLoop() {
    if (state.speedTimer) return;
    state.speedTimer = setInterval(tickSpeed, SPEED_INTERVAL_MS);
  }

  function stopSpeedLoop() {
    if (state.speedTimer) {
      clearInterval(state.speedTimer);
      state.speedTimer = null;
    }
  }

  function tickSpeed() {
    if (!state.connected) {
      stopSpeedLoop();
      return;
    }

    if (state.speed.yaw === 0 && state.speed.pitch === 0 && state.speed.roll === 0) {
      stopSpeedLoop();
      if (state.motionActive) {
        state.motionActive = false;
        sendStop(false);
      }
      return;
    }

    sendSpeed(state.speed.yaw, state.speed.pitch, state.speed.roll, true);
  }

  function stopMotion(options) {
    const settings = options || {};
    const wasActive = state.motionActive || !!state.speedTimer;

    stopSpeedLoop();
    state.motionActive = false;
    state.pointerActive = false;
    state.pointerVec = { x: 0, y: 0 };
    state.keyVec = { x: 0, y: 0 };
    state.keys.clear();
    state.speed = { yaw: 0, pitch: 0, roll: 0 };
    resetJoystickUi();

    if (settings.send !== false && (wasActive || settings.force)) {
      sendStop(settings.force);
    }
  }

  function resetJoystickUi() {
    const knob = $('joystickKnob');
    knob.style.transform = 'translate(-50%, -50%)';
    $('joyYaw').textContent = '0.0';
    $('joyPitch').textContent = '0.0';
    $('joyRoll').textContent = '0.0';
    $('joystick').classList.remove('active');
  }

  function vectorMagnitude(vec) {
    return Math.sqrt(vec.x * vec.x + vec.y * vec.y);
  }

  function currentVector() {
    if (state.pointerActive && vectorMagnitude(state.pointerVec) > 0) return state.pointerVec;
    return state.keyVec;
  }

  function applySpeedDemand() {
    const vec = currentVector();
    const magnitude = vectorMagnitude(vec);
    const limit = Math.max(0, numberValue('speedLimit', 45));

    let yaw = 0;
    let pitch = 0;
    let roll = 0;

    if (magnitude > 0) {
      yaw = vec.x * limit * 10;
      pitch = -vec.y * limit * 10;
      if (checked('invertYaw')) yaw = -yaw;
      if (checked('invertPitch')) pitch = -pitch;
      roll = Math.max(-90, Math.min(90, numberValue('rollSpeed', 0))) * 10;
    }

    state.speed = {
      yaw: Math.round(yaw),
      pitch: Math.round(pitch),
      roll: Math.round(roll)
    };

    const knob = $('joystickKnob');
    if (vec.x === 0 && vec.y === 0) {
      knob.style.transform = 'translate(-50%, -50%)';
    } else {
      const rect = $('joystick').getBoundingClientRect();
      const max = rect.width / 2 - 29 - 10;
      knob.style.transform = 'translate(calc(-50% + ' + (vec.x * max) + 'px), calc(-50% + ' + (vec.y * max) + 'px))';
    }

    $('joyYaw').textContent = (state.speed.yaw / 10).toFixed(1);
    $('joyPitch').textContent = (state.speed.pitch / 10).toFixed(1);
    $('joyRoll').textContent = (state.speed.roll / 10).toFixed(1);

    const moving = state.speed.yaw !== 0 || state.speed.pitch !== 0 || state.speed.roll !== 0;

    if (!state.connected) {
      if (moving) warnOffline();
      return;
    }

    if (moving) {
      const wasActive = state.motionActive;
      state.motionActive = true;
      startSpeedLoop();
      if (!wasActive) sendSpeed(state.speed.yaw, state.speed.pitch, state.speed.roll, false);
    } else if (state.motionActive) {
      state.motionActive = false;
      sendStop(false);
      stopSpeedLoop();
    }
  }

  function vectorFromPointer(event) {
    const joystick = $('joystick');
    const rect = joystick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = Math.max(1, rect.width / 2);

    let x = (event.clientX - cx) / radius;
    let y = (event.clientY - cy) / radius;

    const magnitude = Math.sqrt(x * x + y * y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    if (Math.sqrt(x * x + y * y) < 0.06) {
      x = 0;
      y = 0;
    }
    return { x: x, y: y };
  }

  function bindJoystick() {
    const joystick = $('joystick');
    let pointerId = null;

    joystick.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      pointerId = event.pointerId;
      joystick.setPointerCapture(pointerId);
      state.pointerActive = true;
      state.pointerVec = vectorFromPointer(event);
      joystick.classList.add('active');
      applySpeedDemand();
    });

    joystick.addEventListener('pointermove', function (event) {
      if (!state.pointerActive || event.pointerId !== pointerId) return;
      event.preventDefault();
      state.pointerVec = vectorFromPointer(event);
      applySpeedDemand();
    });

    function endPointer(event) {
      if (!state.pointerActive) return;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      try {
        if (pointerId !== null) joystick.releasePointerCapture(pointerId);
      } catch (e) {
        // already released
      }
      pointerId = null;
      state.pointerActive = false;
      state.pointerVec = { x: 0, y: 0 };
      joystick.classList.remove('active');
      applySpeedDemand();
    }

    joystick.addEventListener('pointerup', endPointer);
    joystick.addEventListener('pointercancel', endPointer);
    joystick.addEventListener('lostpointercapture', endPointer);
    joystick.addEventListener('contextmenu', function (event) { event.preventDefault(); });

    joystick.addEventListener('keydown', function (event) {
      const key = event.key.toLowerCase();
      const relevant = ['arrowleft', 'a', 'arrowright', 'd', 'arrowup', 'w', 'arrowdown', 's'].indexOf(key) !== -1;
      if (!relevant) return;
      event.preventDefault();
      state.keys.add(key);
      updateKeyVector();
    });

    joystick.addEventListener('keyup', function (event) {
      const key = event.key.toLowerCase();
      if (!state.keys.has(key)) return;
      event.preventDefault();
      state.keys.delete(key);
      updateKeyVector();
    });

    joystick.addEventListener('blur', function () {
      if (!state.keys.size) return;
      state.keys.clear();
      updateKeyVector();
    });
  }

  function updateKeyVector() {
    let x = 0;
    let y = 0;
    if (state.keys.has('arrowleft') || state.keys.has('a')) x -= 1;
    if (state.keys.has('arrowright') || state.keys.has('d')) x += 1;
    if (state.keys.has('arrowup') || state.keys.has('w')) y -= 1;
    if (state.keys.has('arrowdown') || state.keys.has('s')) y += 1;

    const magnitude = Math.sqrt(x * x + y * y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    state.keyVec = { x: x, y: y };
    applySpeedDemand();
  }

  // --- GATT rendering -------------------------------------------------------

  function renderGattTree() {
    const tree = $('gattTree');
    tree.replaceChildren();
    tree.classList.remove('hidden');

    const services = state.transport && state.transport.services ? state.transport.services : [];
    if (!services.length) {
      tree.textContent = 'No services discovered. Add the service UUID to the permission list, reconnect, then run Discover GATT.';
      return;
    }

    services.forEach(function (service) {
      const block = document.createElement('div');
      block.className = 'gatt-service';

      const title = document.createElement('div');
      title.className = 'gatt-service-title';
      title.textContent = 'Service ' + service.short.toUpperCase();
      block.appendChild(title);

      if (!service.characteristics.length) {
        const empty = document.createElement('div');
        empty.className = 'gatt-char';
        empty.textContent = '  (no characteristics)';
        block.appendChild(empty);
      }

      service.characteristics.forEach(function (characteristic) {
        const row = document.createElement('div');
        row.className = 'gatt-char';

        const props = Object.keys(characteristic.properties)
          .filter(function (key) { return characteristic.properties[key]; })
          .join(',');

        const label = document.createElement('span');
        label.textContent = characteristic.short.toUpperCase() + '  ' + (props || '—');
        row.appendChild(label);

        const actions = document.createElement('span');
        actions.className = 'gatt-actions';

        const write = document.createElement('button');
        write.type = 'button';
        write.textContent = 'W';
        write.title = 'Use as write characteristic';
        write.disabled = !(characteristic.properties.write || characteristic.properties.writeWithoutResponse);
        write.addEventListener('click', function () { selectCharacteristic('write', characteristic.uuid); });

        const notify = document.createElement('button');
        notify.type = 'button';
        notify.textContent = 'N';
        notify.title = 'Use as notify characteristic';
        notify.disabled = !(characteristic.properties.notify || characteristic.properties.indicate);
        notify.addEventListener('click', function () { selectCharacteristic('notify', characteristic.uuid); });

        actions.appendChild(write);
        actions.appendChild(notify);
        row.appendChild(actions);
        block.appendChild(row);
      });

      tree.appendChild(block);
    });
  }

  function selectCharacteristic(kind, uuid) {
    if (kind === 'write') {
      $('writeUuid').value = uuid;
    } else {
      $('notifyUuid').value = uuid;
    }
    saveSettings();

    if (!state.connected || state.transportKind !== 'ble' || !state.transport) return;

    appendLog('sys', 'Selecting ' + kind + ' characteristic ' + uuid);
    state.transport.select(value('writeUuid') || null, value('notifyUuid') || null)
      .catch(function (error) {
        appendLog('err', 'Characteristic selection failed: ' + (error.message || error));
      });
  }

  // --- raw command ----------------------------------------------------------

  function buildRawFrame(actualSequence) {
    const framingName = framing();
    const cmdSet = readHexByte('rawCmdSet', DJIR.GIMBAL_CMD_SET);
    const cmdId = readHexByte('rawCmdId', 0x00);
    const flags = readHexByte('rawFlags', DUML.FLAGS.REQUEST);
    const payload = B.fromHex(value('rawPayload'));

    if (framingName === 'duml') {
      return DUML.buildFrame({
        sender: readHexByte('sender', DUML.ADDR.APP),
        receiver: readHexByte('receiver', DUML.ADDR.GIMBAL),
        flags: flags,
        cmdSet: cmdSet,
        cmdId: cmdId,
        payload: payload,
        seq: actualSequence ? undefined : 0x0000
      });
    }

    return DJIR.buildFrame({
      cmdType: DJIR.CMD_TYPE_COMMAND,
      cmdSet: cmdSet,
      cmdId: cmdId,
      payload: payload,
      seq: actualSequence ? undefined : 0x0000
    });
  }

  function updateRawPreview() {
    const preview = $('rawPreview');
    try {
      const frame = buildRawFrame(false);
      preview.textContent = B.toHex(frame);
      preview.classList.remove('invalid');
      preview.title = 'Preview only. The sequence number is assigned when you send.';
    } catch (error) {
      preview.textContent = 'Invalid command: ' + error.message;
      preview.classList.add('invalid');
    }
  }

  function sendRaw() {
    let frame;
    try {
      frame = buildRawFrame(true);
    } catch (error) {
      appendLog('err', 'Raw command error: ' + error.message);
      return;
    }

    $('rawPreview').textContent = B.toHex(frame);
    sendFrame(frame, framing(), 'RAW cmd=' + hex(readHexByte('rawCmdSet', 0), 2) + '/' + hex(readHexByte('rawCmdId', 0), 2));
  }

  // --- event wiring ---------------------------------------------------------

  function bindEvents() {
    on('transport', 'change', function () {
      updateTransportUi(true);
      saveSettings();
    });

    on('connectBtn', 'click', connect);
    on('disconnectBtn', 'click', disconnect);

    on('discoverBtn', 'click', function () {
      if (!state.connected || state.transportKind !== 'ble' || !state.transport) {
        appendLog('sys', 'Connect to a Bluetooth device before discovering GATT.');
        return;
      }
      state.transport.discover()
        .then(renderGattTree)
        .catch(function (error) {
          appendLog('err', 'GATT discovery failed: ' + (error.message || error));
        });
    });

    on('recenterBtn', 'click', function () {
      sendPosition(0, 0, 0, 1500, true, 'RECENTER');
    });

    on('stopBtn', 'click', function () {
      stopMotion({ send: true, force: true });
    });

    on('requestPosBtn', 'click', sendInfo);

    on('pushBtn', 'click', function () {
      state.pushEnabled = !state.pushEnabled;
      $('pushBtn').textContent = state.pushEnabled ? 'Disable push' : 'Enable push';
      sendPush(state.pushEnabled);
    });

    on('moveBtn', 'click', function () {
      const yaw = Math.max(-180, Math.min(180, numberValue('moveYaw', 0))) * 10;
      const roll = Math.max(-180, Math.min(180, numberValue('moveRoll', 0))) * 10;
      const pitch = Math.max(-180, Math.min(180, numberValue('movePitch', 0))) * 10;
      const timeMs = Math.max(100, Math.min(25500, Math.round(numberValue('moveTime', 1500) / 100) * 100));
      const absolute = !checked('moveIncremental');

      sendPosition(
        yaw,
        roll,
        pitch,
        timeMs,
        absolute,
        'MOVE ' + (absolute ? 'absolute' : 'incremental') +
          ' yaw=' + (yaw / 10).toFixed(1) +
          ' roll=' + (roll / 10).toFixed(1) +
          ' pitch=' + (pitch / 10).toFixed(1) +
          ' time=' + timeMs + 'ms'
      );
    });

    document.querySelectorAll('.preset').forEach(function (button) {
      button.addEventListener('click', function () {
        const yaw = Number(button.getAttribute('data-yaw')) || 0;
        const pitch = Number(button.getAttribute('data-pitch')) || 0;
        sendPosition(yaw, 0, pitch, 1200, true, 'PRESET yaw=' + (yaw / 10) + ' pitch=' + (pitch / 10));
      });
    });

    on('rawSendBtn', 'click', sendRaw);
    on('rawGetPos', 'click', sendInfo);
    on('rawStop', 'click', function () {
      stopMotion({ send: true, force: true });
    });

    ['rawCmdSet', 'rawCmdId', 'rawFlags', 'rawPayload', 'framing', 'sender', 'receiver'].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', updateRawPreview);
      el.addEventListener('change', updateRawPreview);
    });

    ['serviceUuids', 'writeUuid', 'notifyUuid', 'writeMode'].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        if (state.connected && state.transportKind === 'ble' && state.transport) {
          state.transport.select(value('writeUuid') || null, value('notifyUuid') || null)
            .catch(function (error) {
              appendLog('err', 'Characteristic selection failed: ' + (error.message || error));
            });
        }
      });
    });

    on('framing', 'change', function () {
      $('rawFramingLabel').textContent = framing() === 'duml' ? 'DUML' : 'DJIR';
    });

    on('speedLimit', 'input', function () {
      $('speedLimitValue').textContent = value('speedLimit');
      if (state.motionActive || vectorMagnitude(currentVector()) > 0) applySpeedDemand();
    });

    on('rollSpeed', 'input', function () {
      $('rollSpeedValue').textContent = value('rollSpeed');
      if (state.motionActive) applySpeedDemand();
    });

    on('clearLogBtn', 'click', function () {
      $('log').replaceChildren();
      appendLog('sys', 'Log cleared.');
    });

    on('copyLogBtn', 'click', function () {
      const text = $('log').innerText;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function () { appendLog('sys', 'Log copied to clipboard.'); })
          .catch(function (error) { appendLog('err', 'Copy failed: ' + error.message); });
      } else {
        appendLog('err', 'Clipboard API is unavailable. Select the log text and copy manually.');
      }
    });

    window.addEventListener('blur', function () {
      stopMotion({ send: true });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopMotion({ send: true });
    });

    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        stopMotion({ send: true, force: true });
      }
    });
  }

  // --- telemetry age --------------------------------------------------------

  function startTelemetryClock() {
    setInterval(function () {
      const ageEl = $('telemetryAge');
      if (!state.positionAt) {
        ageEl.textContent = 'no data';
        ageEl.classList.remove('live');
        return;
      }
      const age = Date.now() - state.positionAt;
      if (age < 1000) {
        ageEl.textContent = 'live';
        ageEl.classList.add('live');
      } else {
        ageEl.textContent = Math.round(age / 1000) + 's ago';
        ageEl.classList.remove('live');
      }
    }, 500);
  }

  // --- boot -----------------------------------------------------------------

  function boot() {
    loadSettings();
    bindSettings();
    bindEvents();
    bindJoystick();
    updateTransportUi(false);

    state.dumlParser = new DUML.Parser();
    state.djirParser = new DJIR.Parser();

    setUiConnected(false);
    setStatus('', 'Disconnected');
    startTelemetryClock();
    updateRawPreview();

    appendLog('sys', 'RoninS-Ctrl-Plus ready. Transport: ' + value('transport') + '.');
    appendLog('sys', 'DJIR frame check: ' + B.toHex(DJIR.buildFrame({
      cmdSet: 0x0e,
      cmdId: 0x00,
      payload: DJIR.positionPayload({ yaw: 32, roll: 48, pitch: 64, timeMs: 2000, absolute: true }),
      seq: 0x2211
    })));

    if (!window.isSecureContext) {
      appendLog('err', 'Not a secure context. Web Bluetooth requires http://localhost or HTTPS.');
    }
    if (!window.RoninBLE || !window.RoninBLE.isSupported()) {
      appendLog('sys', 'Web Bluetooth is not available in this browser. Chrome/Edge on macOS or Windows is required.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
