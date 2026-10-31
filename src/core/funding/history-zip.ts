/** Bounded, in-memory CSV ZIP reader for the official OKX funding archive. */
import { crc32, inflateRawSync } from 'node:zlib';

const LIMIT = 16 * 1024 * 1024;

export function fundingCsvFromZip(input: unknown, filename: string): string {
  if (!Buffer.isBuffer(input) || input.length > LIMIT || input.length < 22) throw new Error('invalid-history-zip');
  let end = input.length - 22;
  while (end >= Math.max(0, input.length - 65_557)
    && (input.readUInt32LE(end) !== 0x06054b50 || end + 22 + input.readUInt16LE(end + 20) !== input.length)) end -= 1;
  if (end < 0 || input.readUInt32LE(end) !== 0x06054b50) throw new Error('invalid-history-zip');
  const count = input.readUInt16LE(end + 10);
  const directory = input.readUInt32LE(end + 16);
  if (input.readUInt16LE(end + 4) || input.readUInt16LE(end + 6)
    || input.readUInt16LE(end + 8) !== count || count !== 1
    || directory + input.readUInt32LE(end + 12) !== end) throw new Error('unsupported-history-zip');
  const at = directory;
  if (at + 46 > end || input.readUInt32LE(at) !== 0x02014b50) throw new Error('invalid-history-zip');
  const flags = input.readUInt16LE(at + 8);
  const method = input.readUInt16LE(at + 10);
  const packed = input.readUInt32LE(at + 20);
  const size = input.readUInt32LE(at + 24);
  const nameLength = input.readUInt16LE(at + 28);
  const local = input.readUInt32LE(at + 42);
  if (flags & 1 || ![0, 8].includes(method) || size > LIMIT || packed > LIMIT
    || at + 46 + nameLength + input.readUInt16LE(at + 30) + input.readUInt16LE(at + 32) !== end
    || input.subarray(at + 46, at + 46 + nameLength).toString('utf8') !== filename
    || local + 30 > at || input.readUInt32LE(local) !== 0x04034b50) throw new Error('unsupported-history-zip');
  const offset = local + 30 + input.readUInt16LE(local + 26) + input.readUInt16LE(local + 28);
  if (offset + packed > at) throw new Error('invalid-history-zip');
  const compressed = input.subarray(offset, offset + packed);
  const data = method === 8 ? inflateRawSync(compressed, { maxOutputLength: LIMIT }) : compressed;
  if (data.length !== size || crc32(data) !== input.readUInt32LE(at + 16)) throw new Error('corrupt-history-zip');
  return data.toString('utf8');
}
