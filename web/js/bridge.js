/*
 * Client for the native CAN bridge (WebSocket + JSON).
 *
 * The bridge is not implemented yet; see bridge/README.md for the protocol and
 * bridge/example/ for the DJIR_SDK calls it should wrap.
 *
 * Exposed as window.RoninBridge.
 */
(function (global) {
  'use strict';

  const B = global.RoninBytes;

  function RoninBridge(config) {
    this.url = (config && config.url) || 'ws://127.0.0.1:8787';
    this.socket = null;
    this.connected = false;
    this.onData = null;
    this.onTelemetry = null;
    this.onStatus = null;
    this.onDisconnect = null;
    this.name = 'CAN bridge';
    this.detail = this.url;
  }

  RoninBridge.prototype.status = function (level, message) {
    if (this.onStatus) this.onStatus(level, message);
  };

  RoninBridge.prototype.connect = function () {
    const self = this;

    return new Promise(function (resolve, reject) {
      if (typeof WebSocket === 'undefined') {
        reject(new Error('WebSocket is not available in this browser'));
        return;
      }

      let settled = false;
      let socket;

      try {
        socket = new WebSocket(self.url);
      } catch (error) {
        reject(new Error('Could not open ' + self.url + ': ' + error.message));
        return;
      }

      self.socket = socket;

      const timeout = setTimeout(function () {
        if (!settled) {
          settled = true;
          try { socket.close(); } catch (e) { /* ignore */ }
          reject(new Error('Timed out connecting to the CAN bridge at ' + self.url));
        }
      }, 4000);

      socket.addEventListener('open', function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        self.connected = true;
        self.status('ok', 'Connected to CAN bridge at ' + self.url);
        resolve({ name: self.name, detail: self.url });
      });

      socket.addEventListener('message', function (event) {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          self.status('warn', 'Bridge sent non-JSON data: ' + event.data);
          return;
        }
        self.handleMessage(message);
      });

      socket.addEventListener('error', function () {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Could not connect to the CAN bridge at ' + self.url + '. Is it running?'));
        } else {
          self.status('error', 'CAN bridge socket error');
        }
      });

      socket.addEventListener('close', function () {
        clearTimeout(timeout);
        const wasConnected = self.connected;
        self.connected = false;
        self.socket = null;
        if (wasConnected) {
          self.status('warn', 'CAN bridge disconnected');
          if (self.onDisconnect) self.onDisconnect();
        }
        if (!settled) {
          settled = true;
          reject(new Error('CAN bridge closed the connection before it was ready'));
        }
      });
    });
  };

  RoninBridge.prototype.handleMessage = function (message) {
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'ready':
        this.status('info', 'Bridge ready' + (message.device ? ': ' + message.device : ''));
        break;
      case 'status':
        this.status(message.level || 'info', message.message || '');
        break;
      case 'error':
        this.status('error', message.message || 'Bridge error');
        break;
      case 'telemetry':
        if (this.onTelemetry) {
          this.onTelemetry({
            yaw: B.toInt(message.yaw, 0),
            roll: B.toInt(message.roll, 0),
            pitch: B.toInt(message.pitch, 0),
            source: message.source || 'bridge'
          });
        }
        break;
      case 'frame':
        if (this.onData && message.data) {
          try {
            this.onData(B.fromHex(message.data));
          } catch (e) {
            this.status('warn', 'Bad frame from bridge: ' + e.message);
          }
        }
        break;
      default:
        break;
    }
  };

  RoninBridge.prototype.send = function (bytes) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('CAN bridge is not connected'));
    }
    this.socket.send(JSON.stringify({
      type: 'raw',
      framing: 'djir',
      data: B.toHex(bytes)
    }));
    return Promise.resolve();
  };

  RoninBridge.prototype.sendCommand = function (action, options) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('CAN bridge is not connected'));
    }
    const message = Object.assign({ type: 'command', action: action }, options || {});
    this.socket.send(JSON.stringify(message));
    return Promise.resolve();
  };

  RoninBridge.prototype.disconnect = function () {
    this.connected = false;
    if (this.socket) {
      try { this.socket.close(); } catch (e) { /* ignore */ }
      this.socket = null;
    }
  };

  global.RoninBridge = RoninBridge;
})(window);
