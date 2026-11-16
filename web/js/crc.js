/*
 * CRC implementations for RoninS-Ctrl-Plus.
 *
 * DJIR (CAN, 0xAA framing)
 *   Exact ports of DJIR_SDK/3rdparty/custom_crc:
 *     CRC16: poly 0x8005, init 0xC55C, reflected, xorOut 0
 *     CRC32: poly 0x04C11DB7, init 0xC55C0000, reflected, xorOut 0
 *   Reflected register form (used here):
 *     CRC16: poly 0xA001, init 0x3AA3
 *     CRC32: poly 0xEDB88320, init 0x00003AA3
 *
 * DUML (BLE, 0x55 framing) - community reverse-engineering defaults
 *   CRC8:  poly 0x31, init 0xEE, reflected
 *   CRC16: poly 0x1021, init 0x496C, reflected
 *   Reflected register form:
 *     CRC8:  poly 0x8C, init 0x77
 *     CRC16: poly 0x8408, init 0x3692
 *
 * Exposed as window.RoninCRC.
 */
(function (global) {
  'use strict';

  const tableCache = Object.create(null);

  function reflect(value, bits) {
    let out = 0;
    for (let i = 0; i < bits; i += 1) {
      out = (out << 1) | (value & 1);
      value >>>= 1;
    }
    return out >>> 0;
  }

  function maskFor(width) {
    if (width === 8) return 0xff;
    if (width === 16) return 0xffff;
    if (width === 32) return 0xffffffff;
    throw new Error('Unsupported CRC width: ' + width);
  }

  function reflectedTable(width, polynomial) {
    const key = width + ':' + polynomial;
    if (tableCache[key]) return tableCache[key];

    const mask = maskFor(width);
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let crc = i;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? (crc >>> 1) ^ polynomial : crc >>> 1;
      }
      table[i] = crc & mask;
    }
    tableCache[key] = table;
    return table;
  }

  /**
   * LSB-first (reflected) CRC with an already-reflected polynomial and init.
   */
  function crcReflected(bytes, width, polynomial, init, xorOut) {
    const mask = maskFor(width);
    const table = reflectedTable(width, polynomial);
    let crc = init & mask;

    for (let i = 0; i < bytes.length; i += 1) {
      crc = (table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) & mask;
    }

    return (crc ^ (xorOut || 0)) >>> 0;
  }

  /**
   * MSB-first CRC, useful for checking the reflected implementation against
   * the "spec" parameterisation.
   */
  function crcMsb(bytes, width, polynomial, init, xorOut) {
    const mask = maskFor(width);
    const top = 1 << (width - 1);
    let crc = init & mask;

    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= (bytes[i] << (width - 8)) & mask;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & top ? ((crc << 1) ^ polynomial) & mask : (crc << 1) & mask;
      }
    }

    return (crc ^ (xorOut || 0)) >>> 0;
  }

  // --- DJIR / CAN -----------------------------------------------------------

  function crc16Djir(bytes) {
    return crcReflected(bytes, 16, 0xa001, 0x3aa3, 0x0000) & 0xffff;
  }

  function crc32Djir(bytes) {
    return crcReflected(bytes, 32, 0xedb88320, 0x00003aa3, 0x00000000);
  }

  // --- DUML / BLE -----------------------------------------------------------

  function crc8Duml(bytes) {
    return crcReflected(bytes, 8, 0x8c, 0x77, 0x00) & 0xff;
  }

  function crc16Duml(bytes) {
    return crcReflected(bytes, 16, 0x8408, 0x3692, 0x0000) & 0xffff;
  }

  global.RoninCRC = {
    reflect: reflect,
    crcReflected: crcReflected,
    crcMsb: crcMsb,
    crc16Djir: crc16Djir,
    crc32Djir: crc32Djir,
    crc8Duml: crc8Duml,
    crc16Duml: crc16Duml
  };
})(window);
