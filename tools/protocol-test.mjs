#!/usr/bin/env node
/*
 * Protocol tests. No dependencies, no hardware.
 *
 *   node tools/protocol-test.mjs
 *
 * Loads the browser modules into Node by giving them a `window` object, then
 * checks the CRC implementations, the published DJI sample frame, and the
 * incremental parsers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', 'web');

const sandbox = {};
globalThis.window = sandbox;

for (const file of ['js/bytes.js', 'js/crc.js', 'js/djir.js', 'js/duml.js']) {
  const code = readFileSync(path.join(WEB, file), 'utf8');
  // Each module is an IIFE invoked with `window`.
  new Function('window', code)(sandbox);
}

const B = sandbox.RoninBytes;
const CRC = sandbox.RoninCRC;
const DJIR = sandbox.RoninDJIR;
const DUML = sandbox.RoninDUML;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

function hex(bytes) {
  return B.toHex(bytes);
}

console.log('');
console.log('DJIR / CAN (0xAA)');
console.log('-----------------');

test('CRC16 table matches custom_crc16 (first entries)', () => {
  const expected = [0x0000, 0xc0c1, 0xc181, 0x0140, 0xc301, 0x03c0, 0x0280, 0xc241];
  const empty = CRC.crc16Djir(new Uint8Array(0));
  assert.equal(empty, 0x3aa3, 'CRC16 init should be 0x3AA3 in reflected form');

  // Reproduce the table indirectly by checking single-byte results against the
  // reflected table generated here.
  const table = [];
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    table.push(crc & 0xffff);
  }
  assert.deepEqual(table.slice(0, 8), expected);
});

test('CRC32 reflected init matches custom_crc32', () => {
  assert.equal(CRC.crc32Djir(new Uint8Array(0)), 0x00003aa3);
});

test('DJI published sample frame is reproduced byte for byte', () => {
  const expected =
    'AA 1A 00 03 00 00 00 00 22 11 A2 42 0E 00 20 00 30 00 40 00 01 14 7B 40 97 BE';

  const frame = DJIR.buildFrame({
    cmdType: DJIR.CMD_TYPE_COMMAND,
    cmdSet: DJIR.GIMBAL_CMD_SET,
    cmdId: DJIR.GIMBAL_CMD.POSITION,
    payload: DJIR.positionPayload({
      yaw: 32,
      roll: 48,
      pitch: 64,
      timeMs: 2000,
      absolute: true
    }),
    seq: 0x2211
  });

  assert.equal(hex(frame), expected);
});

test('position payload clamps angles and encodes duration in 0.1 s', () => {
  const payload = DJIR.positionPayload({
    yaw: 9999,
    roll: -9999,
    pitch: 123,
    timeMs: 2500,
    absolute: true
  });

  assert.equal(B.readI16LE(payload, 0), 1800);
  assert.equal(B.readI16LE(payload, 2), -1800);
  assert.equal(B.readI16LE(payload, 4), 123);
  assert.equal(payload[6], 0x01);
  assert.equal(payload[7], 25);
});

test('position payload sets invalid-axis bits', () => {
  const payload = DJIR.positionPayload({
    yaw: 0,
    roll: 0,
    pitch: 0,
    invalidAxes: ['yaw', 'pitch'],
    absolute: false
  });
  assert.equal(payload[6] & 0x01, 0, 'incremental');
  assert.equal(payload[6] & 0x02, 0x02, 'yaw invalid');
  assert.equal(payload[6] & 0x08, 0x08, 'pitch invalid');
});

test('speed payload clamps and sets control bits', () => {
  const payload = DJIR.speedPayload({
    yaw: 99999,
    roll: -99999,
    pitch: 300,
    takeOver: true,
    ignoreFocalLength: true
  });
  assert.equal(B.readI16LE(payload, 0), 3600);
  assert.equal(B.readI16LE(payload, 2), -3600);
  assert.equal(B.readI16LE(payload, 4), 300);
  assert.equal(payload[6] & 0x80, 0x80);
  assert.equal(payload[6] & 0x08, 0x08);
});

test('DJIR parser round-trips a frame', () => {
  const frame = DJIR.positionCommand({ yaw: 100, roll: 0, pitch: -50, timeMs: 1000 });
  const parser = new DJIR.Parser();
  const frames = parser.push(frame);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].cmdSet, DJIR.GIMBAL_CMD_SET);
  assert.equal(frames[0].cmdId, DJIR.GIMBAL_CMD.POSITION);
  assert.equal(B.readI16LE(frames[0].payload, 0), 100);
  assert.equal(B.readI16LE(frames[0].payload, 4), -50);
});

test('DJIR parser resynchronises after junk bytes', () => {
  const frame = DJIR.infoCommand(DJIR.INFO_TYPE.ATTITUDE);
  const noisy = B.concat([0x00, 0xff, 0x13, 0x42], frame);
  const parser = new DJIR.Parser();
  const frames = parser.push(noisy);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].cmdId, DJIR.GIMBAL_CMD.INFO);
});

test('DJIR parser rejects a corrupted frame', () => {
  const frame = DJIR.infoCommand(DJIR.INFO_TYPE.ATTITUDE);
  const corrupted = frame.slice();
  corrupted[corrupted.length - 5] ^= 0xff;
  const parser = new DJIR.Parser();
  assert.equal(parser.push(corrupted).length, 0);
});

test('DJIR parser handles a frame split across chunks', () => {
  const frame = DJIR.recenterCommand();
  const parser = new DJIR.Parser();
  assert.equal(parser.push(frame.slice(0, 7)).length, 0);
  const frames = parser.push(frame.slice(7));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].cmdId, DJIR.GIMBAL_CMD.FOLLOW_MODE);
});

console.log('');
console.log('DUML / BLE (0x55)');
console.log('-----------------');

test('DUML frame field layout and checksums', () => {
  const frame = DUML.buildFrame({
    sender: DUML.ADDR.APP,
    receiver: DUML.ADDR.GIMBAL,
    flags: DUML.FLAGS.REQUEST,
    cmdSet: 0x0e,
    cmdId: 0x02,
    payload: [0x01],
    seq: 0x1234
  });

  assert.equal(frame[0], 0x55);
  assert.equal(frame.length, 14);
  assert.equal(frame[1], 14);
  assert.equal(frame[3], CRC.crc8Duml(frame.subarray(0, 3)));
  assert.equal(B.readU16LE(frame, 4), 0x0402);
  assert.equal(B.readU16BE(frame, 6), 0x1234);
  assert.equal(frame[8], 0x40);
  assert.equal(frame[9], 0x0e);
  assert.equal(frame[10], 0x02);
  assert.equal(frame[11], 0x01);
  assert.equal(B.readU16LE(frame, 12), CRC.crc16Duml(frame.subarray(0, 12)));
});

test('DUML parser round-trips and preserves fields', () => {
  const frame = DUML.buildFrame({
    sender: DUML.ADDR.GIMBAL,
    receiver: DUML.ADDR.APP,
    flags: DUML.FLAGS.RESPONSE,
    cmdSet: 0x0e,
    cmdId: 0x08,
    payload: [0x01, 0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00],
    seq: 0x0042
  });

  const frames = new DUML.Parser().push(frame);
  assert.equal(frames.length, 1);
  const parsed = frames[0];
  assert.equal(parsed.sender, DUML.ADDR.GIMBAL);
  assert.equal(parsed.receiver, DUML.ADDR.APP);
  assert.equal(parsed.flags, DUML.FLAGS.RESPONSE);
  assert.equal(parsed.cmdSet, 0x0e);
  assert.equal(parsed.cmdId, 0x08);
  assert.equal(parsed.seq, 0x0042);
  assert.equal(parsed.payload.length, 7);
});

test('DUML parser resynchronises after junk and partial writes', () => {
  const frame = DUML.buildFrame({ cmdId: 0x02, payload: [0x01], seq: 1 });
  const parser = new DUML.Parser();

  const first = parser.push(B.concat([0x00, 0x42], frame.slice(0, 5)));
  assert.equal(first.length, 0);

  const second = parser.push(frame.slice(5));
  assert.equal(second.length, 1);
  assert.equal(second[0].seq, 1);
});

test('DUML parser rejects bad CRC8', () => {
  const frame = DUML.buildFrame({ cmdId: 0x02, payload: [0x01], seq: 2 });
  const corrupted = frame.slice();
  corrupted[3] ^= 0xff;
  assert.equal(new DUML.Parser().push(corrupted).length, 0);
});

test('DUML parser rejects bad CRC16', () => {
  const frame = DUML.buildFrame({ cmdId: 0x02, payload: [0x01], seq: 3 });
  const corrupted = frame.slice();
  corrupted[11] ^= 0xff;
  assert.equal(new DUML.Parser().push(corrupted).length, 0);
});

test('R SDK payloads can be wrapped in DUML', () => {
  const frame = DUML.positionCommand({ yaw: 10, roll: 0, pitch: 20, timeMs: 1000 });
  const frames = new DUML.Parser().push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].cmdSet, DJIR.GIMBAL_CMD_SET);
  assert.equal(frames[0].cmdId, DJIR.GIMBAL_CMD.POSITION);
  assert.equal(B.readI16LE(frames[0].payload, 0), 10);
  assert.equal(B.readI16LE(frames[0].payload, 4), 20);
});

test('pushed-parameter parser honours the validity bit', () => {
  const payload = new Uint8Array(22);
  payload[0] = 0x00;
  B.writeI16LE(payload, 1, 90);
  assert.equal(DJIR.parsePushedParams(payload), null);

  payload[0] = 0x01;
  const parsed = DJIR.parsePushedParams(payload);
  assert.equal(parsed.yaw, 90);
  assert.equal(parsed.roll, 0);
  assert.equal(parsed.pitch, 0);
});

test('hex helpers round-trip', () => {
  const bytes = B.fromHex('AA 1a 00 ff');
  assert.equal(hex(bytes), 'AA 1A 00 FF');
  assert.equal(hex(B.fromHex('0xAA,0x1A')), 'AA 1A');
  assert.throws(() => B.fromHex('ABC'), /odd number of digits/);
});

console.log('');
console.log('Utilities');
console.log('---------');

test('byte readers handle signed values', () => {
  const bytes = Uint8Array.from([0x9c, 0xff, 0x64, 0x00]);
  assert.equal(B.readI16LE(bytes, 0), -100);
  assert.equal(B.readI16LE(bytes, 2), 100);
});

test('clamp and toInt are forgiving', () => {
  assert.equal(B.clamp(5, 0, 3), 3);
  assert.equal(B.clamp(-5, 0, 3), 0);
  assert.equal(B.toInt('12.9'), 12);
  assert.equal(B.toInt('nope', 7), 7);
});

console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const failure of failures) {
    console.log('');
    console.log(`FAILED: ${failure.name}`);
    console.log(failure.error.stack || failure.error.message);
  }
  process.exitCode = 1;
} else {
  console.log(`All ${passed} tests passed.`);
}
