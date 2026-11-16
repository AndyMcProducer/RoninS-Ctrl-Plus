/*
 * Small byte helpers used by the protocol modules.
 * Exposed as window.RoninBytes.
 */
(function (global) {
  'use strict';

  function toU8(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw new TypeError('Expected Uint8Array, ArrayBuffer, DataView or number[]');
  }

  function toHex(value, separator) {
    const sep = separator === undefined ? ' ' : separator;
    return Array.from(toU8(value), function (b) {
      return b.toString(16).padStart(2, '0').toUpperCase();
    }).join(sep);
  }

  function fromHex(text) {
    if (typeof text !== 'string') throw new TypeError('Hex input must be a string');
    const clean = text
      .replace(/0x/gi, '')
      .replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2 !== 0) {
      throw new Error('Hex input has an odd number of digits');
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
  }

  function concat() {
    const parts = Array.prototype.map.call(arguments, toU8);
    let length = 0;
    parts.forEach(function (p) { length += p.length; });
    const out = new Uint8Array(length);
    let offset = 0;
    parts.forEach(function (p) {
      out.set(p, offset);
      offset += p.length;
    });
    return out;
  }

  function readU16LE(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8)) & 0xffff;
  }

  function readU16BE(bytes, offset) {
    return ((bytes[offset] << 8) | bytes[offset + 1]) & 0xffff;
  }

  function readI16LE(bytes, offset) {
    const v = readU16LE(bytes, offset);
    return v & 0x8000 ? v - 0x10000 : v;
  }

  function readU32LE(bytes, offset) {
    return (
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)
    ) >>> 0;
  }

  function writeU16LE(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeU16BE(bytes, offset, value) {
    bytes[offset] = (value >>> 8) & 0xff;
    bytes[offset + 1] = value & 0xff;
  }

  function writeI16LE(bytes, offset, value) {
    writeU16LE(bytes, offset, value < 0 ? value + 0x10000 : value);
  }

  function writeU32LE(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function toInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : (fallback || 0);
  }

  global.RoninBytes = {
    toU8: toU8,
    toHex: toHex,
    fromHex: fromHex,
    concat: concat,
    readU16LE: readU16LE,
    readU16BE: readU16BE,
    readI16LE: readI16LE,
    readU32LE: readU32LE,
    writeU16LE: writeU16LE,
    writeU16BE: writeU16BE,
    writeI16LE: writeI16LE,
    writeU32LE: writeU32LE,
    clamp: clamp,
    toInt: toInt
  };
})(window);
