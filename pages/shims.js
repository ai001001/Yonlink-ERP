'use strict';
/**
 * 浏览器演示版：Node 内置模块替代实现（Buffer / crypto / zlib / sqlite）
 * Browser demo build: stand-ins for the Node built-ins used by the server code.
 * 由 scripts/build-pages.js 打包进 dist/js/backend.js / Bundled by scripts/build-pages.js.
 */

/**
 * 最小 Buffer 实现（仅覆盖后台代码用到的方法）
 * Minimal Buffer covering only the methods used by the server code.
 */
class Buffer extends Uint8Array {
  /** @param {number} n */
  static alloc(n) { return new Buffer(n); }

  /**
   * @param {string|ArrayLike<number>} v
   * @returns {Buffer}
   */
  static from(v, enc) {
    if (typeof v === 'string' && enc === 'base64') {
      const bin = atob(v.replace(/[^A-Za-z0-9+/=]/g, ''));
      const out = new Buffer(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof v === 'string' && (enc === 'latin1' || enc === 'binary')) {
      const out = new Buffer(v.length);
      for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i) & 0xff;
      return out;
    }
    const src = typeof v === 'string' ? new TextEncoder().encode(v) : v;
    const out = new Buffer(src.length);
    out.set(src);
    return out;
  }

  /**
   * @param {Uint8Array[]} list
   * @returns {Buffer}
   */
  static concat(list) {
    const out = new Buffer(list.reduce((s, b) => s + b.length, 0));
    let off = 0;
    for (const b of list) {
      out.set(b, off);
      off += b.length;
    }
    return out;
  }

  /** @param {any} b */
  static isBuffer(b) { return b instanceof Buffer; }

  writeUInt32LE(v, o) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint32(o, v >>> 0, true);
    return o + 4;
  }

  writeUInt16LE(v, o) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint16(o, v & 0xffff, true);
    return o + 2;
  }

  /** @param {string} [enc] 'hex' 或 utf8 / 'hex' or utf8 */
  toString(enc) {
    if (enc === 'hex') return Array.from(this, (x) => x.toString(16).padStart(2, '0')).join('');
    if (enc === 'base64') {
      let bin = '';
      for (let i = 0; i < this.length; i += 0x8000) bin += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    if (enc === 'latin1' || enc === 'binary') return Array.from(this, (x) => String.fromCharCode(x)).join('');
    return new TextDecoder().decode(this);
  }
}

/**
 * 同步 SHA-256 / Synchronous SHA-256.
 * @param {Uint8Array} msg
 * @returns {Buffer}
 */
function sha256(msg) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const p = new Uint8Array(total);
  p.set(msg);
  p[len] = 0x80;
  const dv = new DataView(p.buffer);
  dv.setUint32(total - 4, (len * 8) >>> 0);
  dv.setUint32(total - 8, Math.floor((len * 8) / 0x100000000));
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Buffer(32);
  const odv = new DataView(out.buffer);
  H.forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}

/** node:crypto 替代 / node:crypto stand-in */
const cryptoShim = {
  /** @param {number} n */
  randomBytes(n) {
    const b = new Buffer(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  },
  /**
   * 演示版用迭代 SHA-256 代替 scrypt（数据只存在本浏览器）
   * Demo build derives keys with iterated SHA-256 instead of scrypt (data never leaves the browser).
   */
  scryptSync(password, salt, keylen) {
    let h = Buffer.from(`${salt}:${password}`);
    for (let i = 0; i < 200; i++) h = sha256(Buffer.concat([h, Buffer.from(String(salt))]));
    return h.subarray(0, keylen);
  },
};

/** node:zlib 替代：使用“存储”块的合法 deflate 流 / node:zlib stand-in emitting valid stored-block deflate */
const zlibShim = {
  /** @param {Uint8Array} data */
  deflateRawSync(data) {
    const parts = [];
    let pos = 0;
    do {
      const len = Math.min(65535, data.length - pos);
      const h = new Buffer(5);
      h[0] = pos + len >= data.length ? 1 : 0;
      h[1] = len & 0xff;
      h[2] = len >> 8;
      h[3] = ~len & 0xff;
      h[4] = (~len >> 8) & 0xff;
      parts.push(h, data.subarray(pos, pos + len));
      pos += len;
    } while (pos < data.length);
    return Buffer.concat(parts);
  },
};

/**
 * node:sqlite 的 DatabaseSync 替代，包装 sql.js 数据库
 * node:sqlite DatabaseSync stand-in wrapping the sql.js database in globalThis.__SQL_DB.
 */
class DatabaseSync {
  constructor() {
    this.db = globalThis.__SQL_DB;
  }

  /** @param {string} sql */
  exec(sql) {
    this.db.exec(sql);
  }

  /**
   * @param {string} sql
   * @returns {{get:Function, all:Function, run:Function}}
   */
  prepare(sql) {
    const db = this.db;
    const norm = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
    const withStmt = (args, fn) => {
      const s = db.prepare(sql);
      try {
        s.bind(norm(args));
        return fn(s);
      } finally {
        s.free();
      }
    };
    return {
      get: (...a) => withStmt(a, (s) => (s.step() ? s.getAsObject() : undefined)),
      all: (...a) => withStmt(a, (s) => {
        const rows = [];
        while (s.step()) rows.push(s.getAsObject());
        return rows;
      }),
      run: (...a) => {
        withStmt(a, (s) => s.step());
        return { changes: db.getRowsModified(), lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
      },
    };
  }

  close() {}
}

globalThis.Buffer = Buffer;
const NODE_SHIMS = {
  'node:crypto': cryptoShim,
  'node:zlib': zlibShim,
  'node:sqlite': { DatabaseSync },
  'node:fs': {},
  'node:path': {},
  // 浏览器无法建立 TCP 连接：邮件收发在演示版中被 __ERP_DEMO 拦截 / no raw TCP in browsers; mail is blocked by __ERP_DEMO
  'node:net': {},
  'node:tls': {},
  'node:dns': {},
};
