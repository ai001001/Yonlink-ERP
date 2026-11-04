'use strict';
/**
 * 样品示意图生成器：按品类、釉色、工艺用代码绘制陶瓷产品 PNG（零依赖）
 * Sample illustration generator: draws ceramic product PNGs by category, glaze and craft (zero dependencies).
 * @module scripts/sample-art
 */
const zlib = require('node:zlib');
const { crc32 } = require('../server/xlsx');

/** 釉色关键词 → RGB / Glaze colour keywords → RGB */
const PALETTE = [
  [/青花|蓝白/, [236, 240, 246], [32, 64, 150]],
  [/哑光白|象牙白|白金|白红|^白|奶白/, [238, 234, 226], [196, 160, 64]],
  [/米黄|奶咖|原色|焦糖/, [222, 200, 166], [150, 110, 70]],
  [/窑变红|红金|朱泥红/, [164, 44, 38], [214, 170, 60]],
  [/星空蓝/, [30, 46, 98], [150, 170, 230]],
  [/粉青|青灰|鼠尾草绿/, [150, 182, 160], [90, 120, 100]],
  [/炭灰|自然灰/, [96, 96, 98], [150, 140, 128]],
  [/黑金/, [34, 32, 34], [205, 165, 70]],
  [/大理石/, [230, 228, 224], [120, 120, 128]],
  [/粉|粉彩/, [236, 186, 190], [130, 190, 150]],
  [/多彩/, [240, 226, 200], [210, 90, 60]],
];

/**
 * 确定性伪随机（按字符串）/ Deterministic hash-based random from a string.
 * @param {string} s
 * @returns {() => number}
 */
function seeded(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * 编码 PNG（RGB）/ Encode an RGB PNG.
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} rgb 像素 / pixels
 * @returns {Buffer}
 */
function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 品类判断 / Determine the drawing category.
 * @param {object} s 样品 / sample
 * @returns {string}
 */
function category(s) {
  const n = `${s.name}${s.name_en}`;
  if (/盘|Plate|Dish/i.test(n)) return 'plate';
  if (/杯|Mug|Cup|Coffee/i.test(n)) return 'mug';
  if (/碗|Bowl/i.test(n)) return 'bowl';
  if (/茶具|Tea Set/i.test(n)) return 'teaset';
  if (/梅瓶|Meiping|Plum/i.test(n)) return 'meiping';
  if (/花器|Ikebana/i.test(n)) return 'bowl';
  if (/花盆|Planter/i.test(n)) return 'planter';
  if (/烛台|Candle Holder/i.test(n)) return 'holder';
  if (/罐|Jar|Canister/i.test(n)) return 'jar';
  if (/球|Ball/i.test(n)) return 'balls';
  if (/扩香|Diffuser/i.test(n)) return 'stones';
  if (/人物|观音|Figure|Statue|Guanyin/i.test(n)) return 'statue';
  if (/猫|兔|鹿|雪人|动物|Cat|Bunny|Fawn|Snowman|Animal/i.test(n)) return 'animal';
  return 'vase';
}

/**
 * 回转体轮廓半径（t：0 底 → 1 顶）/ Lathe profile radius by height fraction.
 * @param {string} cat
 * @param {number} t
 * @returns {number} 相对画幅的半径 / radius as fraction of canvas
 */
function profile(cat, t) {
  switch (cat) {
    case 'vase': return t > 0.86 ? 0.075 + (t > 0.97 ? 0.02 : 0) : 0.12 + 0.17 * Math.sin(Math.PI * Math.min(1, t / 0.86)) ** 1.3;
    case 'meiping': return t > 0.92 ? 0.06 : t > 0.84 ? 0.07 : 0.1 + 0.2 * Math.sin(Math.PI * Math.min(1, t * 0.62 + 0.08)) ** 2;
    case 'mug': return 0.2;
    case 'bowl': return 0.1 + 0.27 * Math.sqrt(t);
    case 'planter': return 0.2 + 0.07 * t;
    case 'holder': return 0.17 - 0.02 * Math.cos(t * Math.PI * 2);
    case 'jar': return t > 0.88 ? 0.05 : t > 0.8 ? 0.19 : 0.19;
    default: return 0.2;
  }
}

/** 物体高度占比 / Object height fraction per category */
const HEIGHT = { vase: 0.74, meiping: 0.74, mug: 0.42, bowl: 0.3, planter: 0.42, holder: 0.46, jar: 0.6 };

/**
 * 绘制样品图 / Render a sample illustration.
 * @param {object} s 样品（name/name_en/color/craft/company_no）/ sample
 * @param {number} [size] 边长像素 / edge length in px
 * @returns {Buffer} PNG
 */
function renderSamplePng(s, size = 320) {
  const rnd = seeded(s.company_no + s.color);
  const pal = PALETTE.find(([re]) => re.test(s.color || '')) || [null, [210, 196, 176], [120, 90, 60]];
  const base = pal[1];
  const accent = pal[2];
  const cat = category(s);
  const craft = `${s.craft || ''}${s.color || ''}`;
  const px = new Uint8Array(size * size * 3);
  const cx = 0.5;
  const floor = 0.86;
  // 冰裂纹网格点 / crackle seed points
  const cells = Array.from({ length: 240 }, () => [rnd(), rnd()]);
  const shapes = [];
  if (HEIGHT[cat]) shapes.push({ kind: 'lathe', cat, x: cx, h: HEIGHT[cat] });
  if (cat === 'mug') shapes.push({ kind: 'handle', x: cx + 0.2, y: floor - 0.22, r: 0.09, w: 0.03 });
  if (cat === 'plate') shapes.push({ kind: 'ellipse', x: cx, y: 0.58, rx: 0.4, ry: 0.27, plate: true });
  if (cat === 'teaset') {
    shapes.push({ kind: 'lathe', cat: 'jar', x: 0.5, h: 0.42, scale: 0.8 });
    for (const dx of [-0.3, 0.3]) shapes.push({ kind: 'lathe', cat: 'bowl', x: 0.5 + dx, h: 0.16, scale: 0.4 });
  }
  if (cat === 'balls') for (const [x, y, r] of [[0.33, 0.62, 0.15], [0.62, 0.55, 0.17], [0.5, 0.74, 0.12]]) shapes.push({ kind: 'ellipse', x, y, rx: r, ry: r, ball: true });
  if (cat === 'stones') for (const [x, y] of [[0.3, 0.7], [0.5, 0.66], [0.7, 0.71]]) shapes.push({ kind: 'ellipse', x, y, rx: 0.11, ry: 0.07 });
  if (cat === 'statue') { shapes.push({ kind: 'ellipse', x: cx, y: 0.6, rx: 0.15, ry: 0.27 }); shapes.push({ kind: 'ellipse', x: cx, y: 0.25, rx: 0.08, ry: 0.09 }); }
  if (cat === 'animal') {
    shapes.push({ kind: 'ellipse', x: cx, y: 0.66, rx: 0.2, ry: 0.19 });
    shapes.push({ kind: 'ellipse', x: cx, y: 0.36, rx: 0.15, ry: 0.13 });
    for (const dx of [-0.09, 0.09]) shapes.push({ kind: 'ellipse', x: cx + dx, y: 0.23, rx: 0.04, ry: 0.07 });
  }

  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const x = xx / size;
      const y = yy / size;
      // 背景：柔和渐变 + 台面 / background gradient and table
      let c = y < floor ? [246 - y * 26, 244 - y * 28, 240 - y * 30] : [214 - (y - floor) * 60, 206 - (y - floor) * 60, 196 - (y - floor) * 60];
      // 投影 / shadow
      const sd = ((x - cx) / 0.33) ** 2 + ((y - floor) / 0.035) ** 2;
      if (sd < 1 && cat !== 'plate') c = c.map((v) => v * (0.82 + 0.18 * sd));
      let hit = null;
      for (const sh of shapes) {
        if (sh.kind === 'lathe') {
          const k = sh.scale || 1;
          const t = (floor - y) / (sh.h * k);
          if (t < 0 || t > 1) continue;
          const r = profile(sh.cat, t) * k;
          const dx = (x - sh.x) / r;
          if (Math.abs(dx) <= 1) hit = { nx: dx, t, ny: 0 };
        } else if (sh.kind === 'handle') {
          const d = Math.hypot(x - sh.x, (y - sh.y) * 1.1);
          if (Math.abs(d - sh.r) < sh.w && x > sh.x - 0.02) hit = { nx: (x - sh.x) / (sh.r + sh.w), t: 0.5, ny: 0 };
        } else {
          const dx = (x - sh.x) / sh.rx;
          const dy = (y - sh.y) / sh.ry;
          const d = dx * dx + dy * dy;
          if (d <= 1) hit = { nx: dx, ny: dy, t: 0.5 - dy / 2, plate: sh.plate, rim: sh.plate && d > 0.72, ball: sh.ball };
        }
      }
      if (hit) {
        const shade = 0.58 + 0.42 * Math.cos(hit.nx * Math.PI / 2) * (hit.plate ? 1 : Math.cos(hit.ny * Math.PI / 2.4));
        let col = base.slice();
        if (/窑变|星空|大理石/.test(craft)) {
          const n = Math.sin(x * 23 + Math.sin(y * 17) * 3) * Math.cos(y * 31 + x * 9);
          col = col.map((v, i) => v + (accent[i] - v) * Math.max(0, n) * 0.6);
        }
        if (/青花|蓝白|手绘/.test(craft) && !hit.rim && Math.sin(y * 70 + Math.sin(x * 40) * 2.5) > 0.82 && hit.t > 0.15 && hit.t < 0.85) col = accent.slice();
        if (/描金|金|烫金/.test(craft) && ((hit.t > 0.8 && hit.t < 0.84) || (hit.t > 0.1 && hit.t < 0.13) || hit.rim)) col = [214, 172, 72];
        if (/冰裂/.test(craft)) {
          let a = 9;
          let b = 9;
          for (const [px2, py2] of cells) {
            const d = Math.hypot(x - px2, y - py2);
            if (d < a) { b = a; a = d; } else if (d < b) b = d;
          }
          if (b - a < 0.0035) col = col.map((v) => v * 0.55);
        }
        if (/浮雕|压纹|刻花/.test(craft)) col = col.map((v) => v * (0.9 + 0.1 * Math.sin(hit.nx * 18)));
        if (/镂空/.test(craft) && Math.sin(hit.nx * 9) > 0.6 && Math.sin(hit.t * 30) > 0.5) col = [70, 60, 50];
        if (/彩绘|贴花|多彩|粉彩/.test(craft) && Math.sin(x * 55) * Math.sin(y * 55) > 0.88) col = accent.slice();
        if (hit.ball && Math.abs(hit.ny + 0.95) < 0.08) col = [214, 172, 72];
        const spec = Math.exp(-(((hit.nx + 0.45) / 0.16) ** 2)) * (hit.plate ? 0.2 : 0.55);
        c = col.map((v) => Math.min(255, v * shade + 255 * spec));
      }
      const o = (yy * size + xx) * 3;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
    }
  }
  return encodePng(size, size, px);
}

module.exports = { renderSamplePng, category };
