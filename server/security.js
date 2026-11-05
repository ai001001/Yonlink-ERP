'use strict';
/**
 * 安全模块：密码策略、演示账号、登录限流、内网地址判断、HTTP 安全头
 * Security module: password policy, demo accounts, login throttling, private-address checks, HTTP security headers.
 * @module server/security
 */
const crypto = require('node:crypto');

/**
 * 演示账号与密码（仅用于演示/试用数据；正式使用请在系统参数中关闭展示并修改密码）
 * Demo accounts and passwords (demo/trial data only; disable display and change them for production).
 */
const DEMO_ACCOUNTS = {
  admin: { password: 'Yl@Root#7319x', label: '超级管理员' },
  sales1: { password: 'Yl@Lxm#4826s', label: '外贸业务员 林晓明' },
  sales2: { password: 'Yl@Wf#5937tR', label: '外贸业务员 王芳' },
  sales3: { password: 'Yl@Cj#6048uQ', label: '外贸业务员 陈静' },
  manager1: { password: 'Yl@Zjl#7159vP', label: '业务经理 郑经理' },
  designer1: { password: 'Yl@Zds#8261wN', label: '陶瓷设计师 张雕塑' },
  designer2: { password: 'Yl@Lch#9372xM', label: '陶瓷设计师 李彩绘' },
  designer3: { password: 'Yl@Sy#1483yL', label: '陶瓷设计师 苏雅' },
  purchase1: { password: 'Yl@Zcg#2594zK', label: '采购 赵采购' },
  prod1: { password: 'Yl@Scz#3615aJ', label: '生产管理 孙厂长' },
  finance1: { password: 'Yl@Zkj#4726bH', label: '财务 周会计' },
  hr1: { password: 'Yl@Wrs#5837cG', label: '人事 吴人事' },
};

/** 常见弱密码 / Common weak passwords */
const COMMON = ['123456', '12345678', '123456789', '1234567890', 'password', 'password1', 'qwerty', 'qwerty123', 'abc123', '111111', '000000', 'admin', 'admin123',
  'admin@123', 'p@ssw0rd', 'passw0rd', 'iloveyou', 'welcome', 'welcome1', 'letmein', 'a123456', 'aa123456', 'qq123456', 'woaini', '1qaz2wsx', '1q2w3e4r', 'zxcvbnm'];

/** 密码规则说明 / Password policy description */
const POLICY_TEXT = '至少10位，须同时包含大写字母、小写字母、数字和特殊符号（如 @#$%!），不能包含账号名，不能是常见密码，不能有3个以上相同或连续字符';

/**
 * 校验密码强度，返回不满足的规则 / Check password strength and return failed rules.
 * @param {string} pw 密码 / password
 * @param {string} [username] 账号 / username
 * @returns {string[]} 不满足项（空数组表示通过）/ failed rules (empty = strong)
 */
function passwordProblems(pw, username = '') {
  const p = String(pw || '');
  const out = [];
  if (p.length < 10) out.push('长度不足10位');
  if (p.length > 64) out.push('长度超过64位');
  if (!/[A-Z]/.test(p)) out.push('缺少大写字母');
  if (!/[a-z]/.test(p)) out.push('缺少小写字母');
  if (!/[0-9]/.test(p)) out.push('缺少数字');
  if (!/[^A-Za-z0-9]/.test(p)) out.push('缺少特殊符号');
  if (/\s/.test(p)) out.push('不能包含空格');
  if (username && username.length >= 3 && p.toLowerCase().includes(String(username).toLowerCase())) out.push('不能包含账号名');
  if (COMMON.some((c) => p.toLowerCase().replace(/[^a-z0-9@]/g, '').includes(c) && c.length >= 6)) out.push('包含常见弱密码');
  if (/(.)\1\1/.test(p)) out.push('不能有3个以上相同字符');
  const seq = '0123456789abcdefghijklmnopqrstuvwxyz';
  const low = p.toLowerCase();
  for (let i = 0; i < low.length - 2; i++) {
    const a = seq.indexOf(low[i]);
    if (a >= 0 && seq[a + 1] === low[i + 1] && seq[a + 2] === low[i + 2]) { out.push('不能有3个以上连续字符（如123、abc）'); break; }
  }
  return out;
}

/**
 * 生成符合策略的随机临时密码 / Generate a random temporary password that satisfies the policy.
 * @param {string} [username]
 * @returns {string}
 */
function generatePassword(username = '') {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#$%&!*?'];
  for (;;) {
    const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
    const all = sets.join('');
    while (chars.length < 14) chars.push(all[crypto.randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const pw = chars.join('');
    if (!passwordProblems(pw, username).length) return pw;
  }
}

/**
 * 固定时间比较 / Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * 简易滑动窗口限流器 / Simple sliding-window rate limiter.
 * @param {number} limit 窗口内允许次数 / allowed hits per window
 * @param {number} windowMs 窗口毫秒 / window in ms
 */
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return {
    /** @param {string} key @returns {boolean} 是否超限 / whether limited */
    hit(key) {
      if (!limit) return false;
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      hits.set(key, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      return arr.length > limit;
    },
    /** @param {string} key @returns {number} */
    count(key) {
      const now = Date.now();
      return (hits.get(key) || []).filter((t) => now - t < windowMs).length;
    },
    reset(key) { hits.delete(key); },
  };
}

/**
 * 是否为内网/本机地址 / Whether an IP address is private, loopback or link-local.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  const v = String(ip).replace(/^::ffff:/i, '');
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(v)) return true;
  const m = /^172\.(\d+)\./.exec(v);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const c = /^100\.(\d+)\./.exec(v);
  if (c && Number(c[1]) >= 64 && Number(c[1]) <= 127) return true;
  if (/^(::1?|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(v)) return true;
  return false;
}

/** 浏览器内容安全策略 / Content-Security-Policy for the server build */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; "
  + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/**
 * 写入通用安全响应头 / Apply common security headers to a response.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

module.exports = { DEMO_ACCOUNTS, POLICY_TEXT, passwordProblems, generatePassword, safeEqual, rateLimiter, isPrivateIp, CSP, securityHeaders };
