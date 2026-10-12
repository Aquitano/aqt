import { isoTimestampOf } from "@aqt/turnstash-core";

export interface ProtoField {
  readonly number: number;
  readonly wireType: number;
  readonly value?: bigint;
  readonly bytes?: Uint8Array;
}

const readVarint = (
  data: Uint8Array,
  start: number,
): { readonly value: bigint; readonly offset: number } | null => {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < data.length) {
    const byte = BigInt(data[offset] ?? 0);
    offset += 1;
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value, offset };
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
};

export const parseFields = (data: Uint8Array): Array<ProtoField> => {
  const fields: Array<ProtoField> = [];
  let offset = 0;
  while (offset < data.length) {
    const key = readVarint(data, offset);
    if (key === null) break;
    offset = key.offset;
    const number = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);
    if (!Number.isSafeInteger(number) || number <= 0) break;
    if (wireType === 0) {
      const value = readVarint(data, offset);
      if (value === null) break;
      fields.push({ number, wireType, value: value.value });
      offset = value.offset;
    } else if (wireType === 2) {
      const length = readVarint(data, offset);
      if (length === null) break;
      offset = length.offset;
      const byteLength = Number(length.value);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > data.length)
        break;
      fields.push({ number, wireType, bytes: data.subarray(offset, offset + byteLength) });
      offset += byteLength;
    } else if (wireType === 1 || wireType === 5) {
      const width = wireType === 1 ? 8 : 4;
      if (offset + width > data.length) break;
      fields.push({ number, wireType, bytes: data.subarray(offset, offset + width) });
      offset += width;
    } else {
      break;
    }
  }
  return fields;
};

export const field = (fields: ReadonlyArray<ProtoField>, number: number): ProtoField | undefined =>
  fields.find((candidate) => candidate.number === number);

const decoder = new TextDecoder("utf-8", { fatal: false });

export const textOf = (candidate: ProtoField | undefined): string | undefined => {
  if (candidate?.bytes === undefined || candidate.bytes.length === 0) return undefined;
  const text = decoder.decode(candidate.bytes);
  return /[\u0000-\u0008\u000E-\u001F\u007F�]/.test(text) ? undefined : text;
};

export const positiveIntOf = (candidate: ProtoField | undefined): number => {
  if (candidate?.value === undefined) return 0;
  const value = Number(candidate.value);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
};

export const subfields = (candidate: ProtoField | undefined): Array<ProtoField> =>
  candidate?.bytes === undefined ? [] : parseFields(candidate.bytes);

export const packedVarints = (candidate: ProtoField | undefined): Array<number> => {
  if (candidate === undefined) return [];
  if (candidate.value !== undefined) return [Number(candidate.value)];
  const values: Array<number> = [];
  let offset = 0;
  const data = candidate.bytes ?? new Uint8Array();
  while (offset < data.length) {
    const next = readVarint(data, offset);
    if (next === null) break;
    values.push(Number(next.value));
    offset = next.offset;
  }
  return values;
};

// A time may arrive as an ISO string, a Timestamp submessage (seconds in #1, nanos in #2) or a bare unix varint.
export const timestampOf = (candidate: ProtoField | undefined): string | undefined => {
  if (candidate === undefined) return undefined;
  const text = textOf(candidate);
  if (text !== undefined && !Number.isNaN(Date.parse(text))) return new Date(text).toISOString();
  if (candidate.bytes !== undefined) {
    const parts = parseFields(candidate.bytes);
    const seconds = field(parts, 1)?.value;
    if (seconds !== undefined) {
      const nanos = field(parts, 2)?.value ?? 0n;
      const millis = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6);
      if (Number.isSafeInteger(millis) && millis > 0) return isoTimestampOf(millis);
    }
  }
  if (candidate.value !== undefined) {
    const raw = Number(candidate.value);
    const millis = raw < 1e12 ? raw * 1000 : raw;
    if (Number.isSafeInteger(millis) && millis > 0) return isoTimestampOf(millis);
  }
  return undefined;
};
