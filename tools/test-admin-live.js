#!/usr/bin/env node
/**
 * 管理后台 · 线上联调验证台
 * ==================================================================
 * 与 `test-cloud-handlers.js`（纯内存 mock）分工不同：这里**打真实线上环境**，
 * 验证「后台发布 → 小程序读得到」这条跨云函数链路，mock 测不出来。
 *
 * 覆盖：
 *   1. 管理台静态页可访问（页面与接口同源，无需跨域配置）
 *   2. 鉴权：不带密钥 / 错密钥一律 401；正确密钥可读概览
 *   3. 发布往返（关键）：
 *        读原始补丁 → 发布临时文案 → 用 `api` 云函数的 GET /v1/content
 *        确认小程序读到了新值 → 还原为**原始补丁**
 *   4. 审计：发布动作留下记录
 *   5. 版本冲突：用过期 revision 发布必须被拒绝（409），不得覆盖
 *   6. 工单列表可读（空集合必须返回 total:0，而不是 500）
 *
 * ⚠️ 安全与真实性约定：
 *   · 管理密钥只从 `admin/.admin-key`（已 gitignore）读取，绝不打印、绝不入库
 *   · 本台对线上内容只做**临时写入 + 原样还原**，并用 try/finally 保证
 *     即使中途失败也会尝试还原；还原后再次读取校验，还原失败会明确报错
 *   · 不伪造用户工单：工单只读校验，不为了「看起来有数据」而插入假工单
 *
 * 用法：node tools/test-admin-live.js
 * 前置：已完成 tcb login，且 admin 云函数已部署
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV = process.env.CLOUD_ENV_ID;
const BASE = process.env.ADMIN_BASE;
if (!ENV || !BASE) {
  console.error('✖ 请设置 CLOUD_ENV_ID 与 ADMIN_BASE 环境变量');
  process.exit(1);
}
const KEY_PATH = path.join(ROOT, 'admin', '.admin-key');
/** 临时文案，带明确的联调标记，便于人工识别与事后排查 */
const TEMP_TAGLINE = '联调验证用文案（会自动还原）';

let pass = 0;
let fail = 0;
function check(title, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + title);
  } else {
    fail++;
    console.log('  ✗ ' + title + (detail !== undefined ? '\n      ' + detail : ''));
  }
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}

async function call(pathname, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const res = await fetch(BASE + pathname, Object.assign({}, opts, { headers }));
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = { code: -1, message: '响应不是 JSON', data: null };
  }
  return { status: res.status, body };
}

/** 调 api 云函数的只读接口，模拟小程序真实读取路径 */
function invokeApi(pathname, method) {
  const out = execFileSync(
    'tcb',
    ['fn', 'invoke', 'api', '-e', ENV, '--data', JSON.stringify({ path: pathname, method }), '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  );
  const parsed = JSON.parse(out);
  const d = parsed.data || {};
  if (d.ErrMsg) throw new Error('api 云函数调用失败：' + d.ErrMsg);
  return JSON.parse(d.RetMsg || 'null');
}

(async function main() {
  if (!fs.existsSync(KEY_PATH)) {
    console.error('未找到管理密钥文件 ' + KEY_PATH + '，无法验证。');
    process.exit(2);
  }
  const KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();

  /* ---------- 1. 静态页 ---------- */
  head('1 · 管理台页面可访问');
  const page = await fetch(BASE + '/');
  const html = await page.text();
  check('首页返回 200', page.status === 200, '实际 ' + page.status);
  check('页面标题正确', html.includes('运营管理台'));
  check('页面引用本地样式（无外链资源）', html.includes('styles.css') && !/https?:\/\/(?!cloud1)/.test(html));
  const css = await fetch(BASE + '/styles.css');
  check('样式表返回 200', css.status === 200, '实际 ' + css.status);
  const js = await fetch(BASE + '/app.js');
  check('脚本返回 200', js.status === 200, '实际 ' + js.status);
  const jsSrc = await js.text();

  /* ---------- 1b. 浏览器 URL 解析回归 ---------- */
  // 关键：页面在 /admin/ 下，接口必须按「页面目录」相对解析。
  // 若 app.js 直接 fetch('/admin-api/x')，浏览器会解析到站点根 → 命中网关 INVALID_PATH 404，
  // 表现为密钥正确却进不去。这里按浏览器规则真实解析一遍，避免测试自己拼 URL 掩盖缺陷。
  head('1b · 页面内的接口地址按浏览器规则必须落在云函数上');
  const pageUrl = BASE + '/';
  const declared = [...new Set([...jsSrc.matchAll(/'(\/admin-api\/[^']*)'/g)].map(m => m[1]))];
  check('能从 app.js 提取到接口路径', declared.length >= 5, JSON.stringify(declared));
  // app.js 的 API_BASE = location.pathname 去掉末尾 / 或 index.html，即「页面所在目录」。
  // 这里照同样规则算出基址再解析，等价于浏览器里 fetch(API_BASE + path) 的实际落点。
  // （「API_BASE 是否真的被拼进 fetch」由离线套件 test-admin-server 第 8 节静态守住。）
  const pageDir = new URL('./', pageUrl).pathname.replace(/\/(?:index\.html)?$/, '');
  const resolved = declared.map(p => ({ raw: p, url: new URL(pageDir + p, pageUrl) }));
  const outside = resolved.filter(r => !r.url.pathname.startsWith('/admin/admin-api/'));
  check('所有接口都解析到 /admin 之下（未被网关吞掉）', outside.length === 0,
    '越界：' + JSON.stringify(outside.map(r => r.raw + ' → ' + r.url.pathname)));
  const probe = await Promise.all(resolved.map(async r => {
    const res = await fetch(r.url.href, { headers: { 'Content-Type': 'application/json' } });
    let b = null;
    try { b = await res.json(); } catch (e) { b = { code: -1, message: '非 JSON（疑似网关返回）' }; }
    return { raw: r.raw, pathname: r.url.pathname, status: res.status, code: b && b.code };
  }));
  const notReaching = probe.filter(p => p.code !== 401);
  check('每个接口都真正到达云函数（无密钥应为 401，而非网关 404）', notReaching.length === 0,
    '异常：' + JSON.stringify(notReaching));

  /* ---------- 2. 鉴权 ---------- */
  head('2 · 鉴权必须拦住未授权访问');
  const noKey = await call('/admin-api/overview');
  check('不带密钥 → 401', noKey.body.code === 401, JSON.stringify(noKey.body));
  const wrongKey = await call('/admin-api/overview', { headers: { 'X-Admin-Key': 'wrong-key-'.repeat(4) } });
  check('错误密钥 → 401', wrongKey.body.code === 401, JSON.stringify(wrongKey.body));
  const okKey = await call('/admin-api/overview', { headers: { 'X-Admin-Key': KEY } });
  check('正确密钥 → code 0', okKey.body.code === 0, JSON.stringify(okKey.body));
  check('概览含院校总数', !!(okKey.body.data && okKey.body.data.schoolCount > 0), JSON.stringify(okKey.body.data));

  /* ---------- 3. 工单只读（空集合不得 500） ---------- */
  head('3 · 工单列表（只读，不插入假工单）');
  const tickets = await call('/admin-api/tickets?size=10', { headers: { 'X-Admin-Key': KEY } });
  check('工单列表 code 0', tickets.body.code === 0, JSON.stringify(tickets.body));
  check(
    '空工单返回 total:0 而不是报错',
    !!(tickets.body.data && tickets.body.data.total === 0 && Array.isArray(tickets.body.data.list)),
    JSON.stringify(tickets.body.data)
  );

  /* ---------- 4. 发布往返：后台发布 → 小程序读得到 ---------- */
  head('4 · 发布往返（后台 → 小程序读取路径）');
  const before = await call('/admin-api/content', { headers: { 'X-Admin-Key': KEY } });
  check('读取当前内容补丁 code 0', before.body.code === 0, JSON.stringify(before.body));
  const original = (before.body.data && before.body.data.patch) || {};
  const rev = (before.body.data && before.body.data.revision) || 0;
  console.log('    当前 revision=' + rev + '，补丁字段=' + JSON.stringify(Object.keys(original)));

  let restored = false;
  try {
    const tempPatch = Object.assign({}, original, { brand: Object.assign({}, original.brand, { tagline: TEMP_TAGLINE }) });
    const pub = await call('/admin-api/content', {
      method: 'PUT',
      headers: { 'X-Admin-Key': KEY },
      body: JSON.stringify({ patch: tempPatch, revision: rev, note: '联调验证：临时文案，随后自动还原' }),
    });
    check('发布临时文案成功', pub.body.code === 0, JSON.stringify(pub.body));
    check('发布后 revision 递增', !!(pub.body.data && pub.body.data.revision === rev + 1), JSON.stringify(pub.body.data));

    const readBack = invokeApi('/v1/content', 'GET');
    check('api 云函数读取 code 0', readBack && readBack.code === 0, JSON.stringify(readBack));
    check(
      '小程序读取路径看到了后台发布的新文案',
      !!(readBack && readBack.data && readBack.data.brand && readBack.data.brand.tagline === TEMP_TAGLINE),
      JSON.stringify(readBack && readBack.data && readBack.data.brand)
    );

    /* ---------- 5. 版本冲突 ---------- */
    head('5 · 并发保护：过期 revision 必须被拒绝');
    const stale = await call('/admin-api/content', {
      method: 'PUT',
      headers: { 'X-Admin-Key': KEY },
      body: JSON.stringify({ patch: { brand: { tagline: '不应被写入' } }, revision: rev, note: '企图覆盖' }),
    });
    check('过期 revision → 409', stale.body.code === 409, JSON.stringify(stale.body));
    const afterStale = invokeApi('/v1/content', 'GET');
    check(
      '被拒绝的发布未污染线上内容',
      !!(afterStale && afterStale.data && afterStale.data.brand && afterStale.data.brand.tagline === TEMP_TAGLINE),
      JSON.stringify(afterStale && afterStale.data && afterStale.data.brand)
    );
  } finally {
    /* ---------- 还原 ---------- */
    const cur = await call('/admin-api/content', { headers: { 'X-Admin-Key': KEY } });
    const curRev = (cur.body.data && cur.body.data.revision) || 0;
    const restore = await call('/admin-api/content', {
      method: 'PUT',
      headers: { 'X-Admin-Key': KEY },
      body: JSON.stringify({ patch: original, revision: curRev, note: '联调验证结束：还原原始内容' }),
    });
    restored = restore.body.code === 0;
    console.log('    还原发布：' + (restored ? '成功' : '失败 ' + JSON.stringify(restore.body)));
  }

  head('6 · 还原校验');
  const finalRead = invokeApi('/v1/content', 'GET');
  const finalTagline = finalRead && finalRead.data && finalRead.data.brand && finalRead.data.brand.tagline;
  check('临时文案已从线上内容中移除', finalTagline !== TEMP_TAGLINE, '实际 ' + JSON.stringify(finalTagline));
  check('还原为原始补丁（字段集合一致）', JSON.stringify(Object.keys((finalRead && finalRead.data) || {}).sort()) === JSON.stringify(Object.keys(original).sort()), JSON.stringify(Object.keys((finalRead && finalRead.data) || {})));

  /* ---------- 7. 审计留痕 ---------- */
  head('7 · 操作留痕');
  const audit = await call('/admin-api/audit', { headers: { 'X-Admin-Key': KEY } });
  check('审计列表可读', audit.body.code === 0, JSON.stringify(audit.body));
  const list = (audit.body.data && audit.body.data.list) || [];
  check('发布动作已记录', list.some((x) => x.action === 'content.publish'), JSON.stringify(list.map((x) => x.action)));

  console.log('\n' + '─'.repeat(64));
  console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + '）');
  console.log('─'.repeat(64));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n验证台自身异常：', e);
  process.exit(2);
});
