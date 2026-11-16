/*
 * Web Bluetooth transport.
 *
 * Exposed as window.RoninBLE.
 */
(function (global) {
  'use strict';

  const B = global.RoninBytes;

  const BASE_UUID = '-0000-1000-8000-00805f9b34fb';

  function normalizeUuid(uuid) {
    if (!uuid) return '';
    const raw = String(uuid).trim().toLowerCase();
    if (/^[0-9a-f]{4}$/.test(raw)) return '0000' + raw + BASE_UUID;
    if (/^[0-9a-f]{8}$/.test(raw)) return raw + BASE_UUID;
    return raw;
  }

  function shortUuid(uuid) {
    const full = normalizeUuid(uuid);
    if (full.endsWith(BASE_UUID)) {
      const head = full.slice(0, full.length - BASE_UUID.length);
      if (head.startsWith('0000') && head.length === 8) return head.slice(4);
      if (head.length === 8) return head;
    }
    return full;
  }

  function isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  function describeError(error) {
    const name = error && error.name ? error.name : 'Error';
    switch (name) {
      case 'NotFoundError':
        return 'No device selected, or the device did not match the name filter. Clear the filter to show all BLE devices.';
      case 'SecurityError':
        return 'Bluetooth permission denied. Web Bluetooth requires a secure context (localhost or HTTPS) and a user gesture.';
      case 'NetworkError':
        return 'GATT connection failed. The gimbal may already be connected to another device, or it stopped advertising.';
      case 'NotSupportedError':
        return 'The requested service was not granted. Add its UUID to the service list before connecting.';
      case 'InvalidStateError':
        return 'Bluetooth is not available (adapter off or permission missing).';
      case 'AbortError':
        return 'The Bluetooth operation was cancelled.';
      default:
        return (error && error.message) || String(error);
    }
  }

  function RoninBLE(config) {
    this.config = config || {};
    this.device = null;
    this.server = null;
    this.services = [];
    this.characteristics = Object.create(null);
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this.notifyHandler = null;
    this.onData = null;
    this.onStatus = null;
    this.onDisconnect = null;
  }

  RoninBLE.prototype.status = function (level, message) {
    if (this.onStatus) this.onStatus(level, message);
  };

  RoninBLE.prototype.connect = function () {
    const self = this;

    if (!isSupported()) {
      return Promise.reject(new Error(
        'Web Bluetooth is not available in this browser. Use Chrome or Edge on macOS/Windows, and serve the app from http://localhost or HTTPS.'
      ));
    }

    const nameFilter = (this.config.nameFilter || '').trim();
    const serviceUuids = (this.config.serviceUuids || [])
      .map(normalizeUuid)
      .filter(Boolean);

    const requestOptions = {
      optionalServices: Array.from(new Set(serviceUuids))
    };

    if (nameFilter) {
      requestOptions.filters = [{ namePrefix: nameFilter }];
    } else {
      requestOptions.acceptAllDevices = true;
    }

    self.status('info', 'Opening the Bluetooth device picker...');

    return navigator.bluetooth.requestDevice(requestOptions)
      .then(function (device) {
        self.device = device;
        self.device.addEventListener('gattserverdisconnected', function () {
          self.handleDisconnected();
        });

        self.status('info', 'Connecting to GATT server...');
        return self.device.gatt.connect();
      })
      .then(function (server) {
        self.server = server;
        return self.discover();
      })
      .then(function () {
        return self.autoSelect();
      })
      .then(function () {
        self.status('ok', 'Connected to ' + self.device.name);
        return {
          name: self.device.name || 'Unnamed BLE device',
          detail: self.device.id
        };
      })
      .catch(function (error) {
        const message = describeError(error);
        self.status('error', message);
        throw new Error(message);
      });
  };

  RoninBLE.prototype.handleDisconnected = function () {
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this.status('warn', 'Gimbal disconnected');
    if (this.onDisconnect) this.onDisconnect();
  };

  RoninBLE.prototype.discover = function () {
    const self = this;

    if (!self.server) return Promise.reject(new Error('Not connected'));

    self.services = [];
    self.characteristics = Object.create(null);

    return self.server.getPrimaryServices()
      .catch(function () { return []; })
      .then(function (services) {
        return Promise.all(services.map(function (service) {
          return service.getCharacteristics()
            .catch(function () { return []; })
            .then(function (characteristics) {
              const entry = {
                uuid: normalizeUuid(service.uuid),
                short: shortUuid(service.uuid),
                characteristics: characteristics.map(function (characteristic) {
                  const uuid = normalizeUuid(characteristic.uuid);
                  self.characteristics[uuid] = characteristic;
                  return {
                    uuid: uuid,
                    short: shortUuid(characteristic.uuid),
                    properties: {
                      read: !!characteristic.properties.read,
                      write: !!characteristic.properties.write,
                      writeWithoutResponse: !!characteristic.properties.writeWithoutResponse,
                      notify: !!characteristic.properties.notify,
                      indicate: !!characteristic.properties.indicate
                    }
                  };
                })
              };
              return entry;
            });
        }));
      })
      .then(function (services) {
        self.services = services;
        const count = services.reduce(function (sum, s) { return sum + s.characteristics.length; }, 0);
        self.status('info', 'Discovered ' + services.length + ' service(s), ' + count + ' characteristic(s)');
        return services;
      });
  };

  RoninBLE.prototype.findCharacteristic = function (uuid) {
    return this.characteristics[normalizeUuid(uuid)] || null;
  };

  RoninBLE.prototype.findByProperty = function (properties) {
    for (let i = 0; i < this.services.length; i += 1) {
      const service = this.services[i];
      for (let j = 0; j < service.characteristics.length; j += 1) {
        const entry = service.characteristics[j];
        if (properties.every(function (p) { return entry.properties[p]; })) {
          const characteristic = this.findCharacteristic(entry.uuid);
          if (characteristic) return characteristic;
        }
      }
    }
    return null;
  };

  RoninBLE.prototype.autoSelect = function () {
    const self = this;
    const config = self.config;

    let write = config.writeUuid ? self.findCharacteristic(config.writeUuid) : null;
    if (!write) {
      write = self.findByProperty(['writeWithoutResponse']) || self.findByProperty(['write']);
    }

    let notify = config.notifyUuid ? self.findCharacteristic(config.notifyUuid) : null;
    if (!notify) {
      notify = self.findByProperty(['notify']) || self.findByProperty(['indicate']);
    }

    return self.select(write ? write.uuid : null, notify ? notify.uuid : null);
  };

  RoninBLE.prototype.select = function (writeUuid, notifyUuid) {
    const self = this;

    if (self.notifyCharacteristic && self.notifyHandler) {
      const old = self.notifyCharacteristic;
      const handler = self.notifyHandler;
      self.notifyCharacteristic = null;
      self.notifyHandler = null;
      try {
        old.removeEventListener('characteristicvaluechanged', handler);
        old.stopNotifications().catch(function () {});
      } catch (e) {
        // ignore
      }
    }

    self.writeCharacteristic = writeUuid ? self.findCharacteristic(writeUuid) : null;
    self.notifyCharacteristic = notifyUuid ? self.findCharacteristic(notifyUuid) : null;

    if (self.writeCharacteristic) {
      self.status('info', 'Write characteristic: ' + self.writeCharacteristic.uuid);
    } else {
      self.status('warn', 'No write characteristic selected');
    }

    if (!self.notifyCharacteristic) {
      self.status('warn', 'No notify characteristic selected');
      return Promise.resolve();
    }

    self.notifyHandler = function (event) {
      if (!self.onData) return;
      const value = event.target.value;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      self.onData(bytes);
    };
    self.notifyCharacteristic.addEventListener('characteristicvaluechanged', self.notifyHandler);

    self.status('info', 'Subscribing to ' + self.notifyCharacteristic.uuid + '...');
    return self.notifyCharacteristic.startNotifications()
      .then(function () {
        self.status('ok', 'Notifications enabled on ' + shortUuid(self.notifyCharacteristic.uuid));
        return self.services;
      })
      .catch(function (error) {
        self.status('error', 'Could not subscribe: ' + describeError(error));
        throw error;
      });
  };

  RoninBLE.prototype.write = function (bytes) {
    const self = this;
    const characteristic = self.writeCharacteristic;

    if (!characteristic) {
      return Promise.reject(new Error('No write characteristic selected. Use Discover GATT and choose one.'));
    }

    const data = B.toU8(bytes);
    const mode = self.config.writeMode || 'auto';

    function withResponse() {
      return characteristic.writeValueWithResponse
        ? characteristic.writeValueWithResponse(data)
        : characteristic.writeValue(data);
    }

    function withoutResponse() {
      return characteristic.writeValueWithoutResponse
        ? characteristic.writeValueWithoutResponse(data)
        : characteristic.writeValue(data);
    }

    if (mode === 'withResponse') return withResponse();
    if (mode === 'withoutResponse') return withoutResponse();

    return withoutResponse().catch(function () {
      return withResponse();
    });
  };

  RoninBLE.prototype.disconnect = function () {
    if (this.notifyCharacteristic) {
      try {
        this.notifyCharacteristic.stopNotifications().catch(function () {});
      } catch (e) {
        // ignore
      }
    }
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.device = null;
    this.server = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
  };

  RoninBLE.prototype.describe = function () {
    if (!this.device) return 'Not connected';
    return (this.device.name || 'Unnamed') + ' · ' + (this.device.id || '');
  };

  global.RoninBLE = {
    Transport: RoninBLE,
    isSupported: isSupported,
    normalizeUuid: normalizeUuid,
    shortUuid: shortUuid,
    describeError: describeError
  };
})(window);
