const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(view: DataView): string {
  if (view.byteLength !== 20) {
    throw new Error("incorrect buffer size");
  }
  const str = new Array(27).fill("0");
  let n = 27;
  let bp = new Array(5);
  bp[0] = view.getUint32(0, false);
  bp[1] = view.getUint32(4, false);
  bp[2] = view.getUint32(8, false);
  bp[3] = view.getUint32(12, false);
  bp[4] = view.getUint32(16, false);

  const srcBase = BigInt(4294967296);
  const dstBase = BigInt(62);

  while (bp.length !== 0) {
    const quotient = [];
    let remainder = 0;

    for (const c of bp) {
      const value = BigInt(c) + BigInt(remainder) * srcBase;

      const digit = value / dstBase;

      remainder = Number(value % dstBase);

      if (quotient.length !== 0 || digit !== BigInt(0)) {
        quotient.push(Number(digit));
      }
    }

    // Writes at the end of the destination buffer because we computed the
    // lowest bits first.
    n--;
    str[n] = BASE62.charAt(remainder);
    bp = quotient;
  }
  return str.join("");
}

function debase62(str: string): Uint8Array {
  if (str.length !== 27)
    throw new Error("Expected 27 characters long base62 string");
  const srcBase = BigInt(62);
  const dstBase = BigInt(4294967296);
  let bp = new Array(27);
  const dst = new Uint8Array(20);
  for (let i = 0; i < str.length; i++) {
    bp[i] = str.charCodeAt(i);
    // 0-9
    if (bp[i] >= 48 && bp[i] <= 57) {
      bp[i] -= 48; // '0'
      continue;
    }
    // 10-35
    if (bp[i] >= 65 && bp[i] <= 90) {
      bp[i] = 10 + (bp[i] - 65);
      continue;
    }
    // 36-61
    if (bp[i] >= 97 && bp[i] <= 122) {
      bp[i] = 36 + (bp[i] - 97);
      continue;
    }
    throw new Error(`Unexpected symbol "${str.charAt(i)}"`);
  }
  let n = 20;
  while (bp.length !== 0) {
    const quotient = [];
    let remainder = BigInt(0);

    for (const c of bp) {
      const value = BigInt(c) + BigInt(remainder) * srcBase;
      const digit = value / dstBase;
      remainder = value % dstBase;

      if (quotient.length !== 0 || digit !== BigInt(0)) {
        quotient.push(Number(digit));
      }
    }

    if (n < 4) {
      throw new Error("short buffer");
    }

    dst[n - 4] = Number(remainder) >> 24;
    dst[n - 3] = Number(remainder) >> 16;
    dst[n - 2] = Number(remainder) >> 8;
    dst[n - 1] = Number(remainder);
    n -= 4;
    bp = quotient;
  }

  return dst;
}

function toEpoch(timestamp: number, desc?: boolean): number {
  if (!desc) {
    return Math.round(timestamp / 1000) - 14e8;
  }
  return 4294967295 - (Math.round(timestamp / 1000) - 14e8);
}

function fromEpoch(timestamp: number, desc?: boolean): number {
  if (!desc) {
    return (14e8 + timestamp) * 1000;
  }
  return (4294967295 - timestamp + 14e8) * 1000;
}

function randomBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function generate(
  prefix?: string,
  desc: boolean = false,
  timestamp: number = Date.now(),
): string {
  const buf = new ArrayBuffer(20);
  const view = new DataView(buf);
  const ts = toEpoch(timestamp, desc);
  let offset = 0;
  view.setUint32(offset, ts, false);
  offset += 4;
  const rnd = randomBytes();
  for (const b of Array.from(rnd)) {
    view.setUint8(offset++, b);
  }

  if (desc) return prefix ? `${prefix}_z` + base62(view) : "z" + base62(view);
  return prefix ? `${prefix}_` + base62(view) : base62(view);
}

function parse(ksuid: string): { ts: Date; rnd: Uint8Array; prefix?: string } {
  let prefix: string | undefined;
  const prefixPosition = ksuid.indexOf("_");

  if (prefixPosition !== -1) {
    prefix = ksuid.slice(0, prefixPosition);
    ksuid = ksuid.slice(prefixPosition + 1);
  }

  if (ksuid.length > 28 || ksuid.length < 27) {
    throw new Error(`Incorrect length: ${ksuid.length}, expected 27 or 28`);
  }
  const desc = ksuid.length === 28 && ksuid[0] === "z";
  if (ksuid.length === 28 && ksuid[0] !== "z") {
    throw new Error(`KSUID is 28 symbol, but first char is not "z"`);
  }
  const buf = debase62(desc ? ksuid.slice(1, 28) : ksuid);
  const view = new DataView(buf.buffer);
  const tsValue = view.getUint32(0, false);
  const ts = new Date(fromEpoch(tsValue, desc));

  return {
    ts,
    rnd: buf.slice(4),
    prefix: prefix,
  };
}

export const ksuid = {
  base62,
  debase62,
  toEpoch,
  fromEpoch,
  randomBytes,
  generate,
  parse,
};
