/**
 * 统一响应与共用校验
 * ==================================================================
 * ⚠️ 单独成文件而不是放在 index.js 里，是为了**避免循环依赖**：
 *    index.js require handlers，handlers 又需要 ok / fail，
 *    若把它们定义在 index.js，就会形成 index ⇄ handler 的环。
 *    Node 在处理环时会让其中一方的 module.exports 尚未赋值完，
 *    表现为 `ok is not a function`，且只在某些加载顺序下复现 ——
 *    这类 bug 在云函数里极难定位（本地跑得好好的，线上偶发）。
 */

/** 成功响应 —— 结构严格对应契约 2.4 */
function ok(data) {
  return { code: 0, message: '', data: data === undefined ? null : data };
}

/** 失败响应 */
function fail(code, message) {
  return { code: code, message: message || '', data: null };
}

/**
 * 业务错误：handler 里 `throw bizError(400, '…')`，由入口转成 fail(code, message)
 *
 * 为什么需要它：如果 handler 直接 throw 普通 Error，入口只能一律当 500 处理，
 * 那么「问题描述超过 200 字」这类**用户自己就能改**的错误会显示成
 * 「服务器开小差了」，用户不知道改哪儿。
 */
function bizError(code, message) {
  const e = new Error(message);
  e.bizCode = code;
  return e;
}

/**
 * 按 Unicode 码点计数
 * ------------------------------------------------------------------
 * 不能用 `str.length`：它数的是 UTF-16 码元，一个 emoji（如 🙂）算 2，
 * 于是「输入 200 字却被提示超限」。契约 4.8 明确要求按**码点**计，
 * 前后端必须用同一口径，否则用户会遇到「前端说没超、后端说超了」。
 */
function cpLength(s) {
  return Array.from(String(s === undefined || s === null ? '' : s)).length;
}

/** 裁剪到指定码点数（超出直接截断，不做省略号 —— 调用方自行决定展示方式） */
function cpSlice(s, max) {
  return Array.from(String(s === undefined || s === null ? '' : s)).slice(0, max).join('');
}

/** 北京时间（UTC+8）下的 YYYYMMDD，用于工单号 */
function dayKey(date) {
  const d = new Date((date ? date.getTime() : Date.now()) + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

module.exports = { ok, fail, bizError, cpLength, cpSlice, dayKey };
