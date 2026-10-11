#!/usr/bin/env node
/**
 * 管理台 · 本地预览台
 * ==================================================================
 * 为什么需要它：管理台的静态页（`admin/`）只有放进 admin 云函数包里、
 * 部署到线上才能打开 —— 于是「改完后台代码，先看看长什么样」这件事
 * 一直没有低成本的做法，只能先部署再看（而那正是需要人先同意的动作）。
 *
 * 本台把「页面 + 接口 + 数据」整条链在本机跑起来：
 *   · 页面与样式 = `admin/` 里的**真实文件**（不是另画一份 mock 界面）
 *   · 接口       = admin 云函数的**真实 handlers**（经 tools/lib/mock-wx-sdk.js 的内存库）
 *   · 数据       = 内存里的样例，**不连线上库、不写线上库**
 *   ⇒ 看到的就是真实的渲染结果，唯一假的只有「数据来源」。
 *
 * ⚠️ 因此页面上强制插了一条横幅声明「数据是内存样例」。
 *    本项目对「把演示值当成用户真实数据」零容忍（见 README 四·4），
 *    预览台尤其容易让人误记成「库里真有这些用户」 —— 横幅是防这个的。
 * ⚠️ 密钥：本台**不读也不打印** `admin/.admin-key`。用的是与线上无关的
 *    预览专用密钥，避免把真实密钥带进终端输出或浏览器。
 *
 * 用法：node tools/preview-admin.js
 *      然后打开 http://127.0.0.1:9100/admin （密钥已自动填好，直接点「进入管理台」）
 * 端口：环境变量 PORT 可改，默认 9100。
 */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { URL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const FN_DIR = path.join(ROOT, 'miniprogram', 'cloudfunctions', 'admin');
const STATIC_DIR = path.join(ROOT, 'admin');

const { createStore, createMockSdk } = require('./lib/mock-wx-sdk');

const store = createStore();
const mockSdk = createMockSdk(store);

// ⚠️ 必须是纯 ASCII 且 ≥32 字符：服务端 domain.authorize 要求密钥长度 32–256，
//    少于 32 一律 401（这里第一次写成中文短串就踩了这个 —— 表现为「密钥明明对却进不去」）。
const PREVIEW_KEY = 'preview-only-key-not-for-production-use';
process.env.ADMIN_KEY_SHA256 = crypto.createHash('sha256').update(PREVIEW_KEY).digest('hex');

// 必须在 require 云函数源码**之前**把 SDK 换掉：它在加载时就会 cloud.database()
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return mockSdk;
  return origLoad.call(this, request, parent, isMain);
};
const admin = require(path.join(FN_DIR, 'index.js'));
Module._load = origLoad;

/* ==================================================================
   样例数据 —— 全部是内存样例，不是任何真实用户
   ------------------------------------------------------------------
   ⚠️ 昵称一律带「预览样例」前缀、邮箱一律 example.com：
      万一有人截图发出去，也能一眼看出这不是真实数据。
   ⚠️ `_id` 按线上规则派生（sha256('openid:' + openid)），这样
      「档案 ID」显示的形态与线上一致 —— 预览不该长成另一个样子。
   ================================================================== */
function stableId(openid) {
  return crypto.createHash('sha256').update('openid:' + openid).digest('hex');
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}
function seedUsers(rows) {
  const map = new Map();
  for (const r of rows) {
    const id = stableId(r.openid);
    map.set(id, Object.assign({ _id: id, plan: '', grade: '', city: '', avatarUrl: '', email: '', activeSession: false }, r, { _id: id }));
  }
  store.collections.users = map;
}
seedUsers([
  {
    openid: 'preview_openid_1',
    nickName: '预览样例·小林',
    email: 'lin@example.com',
    grade: '高三',
    city: '深圳',
    plan: '加拿大本科',
    avatarUrl: '',
    activeSession: true,
    createdAt: daysAgo(21),
    updatedAt: daysAgo(1),
  },
  {
    openid: 'preview_openid_2',
    nickName: '预览样例·Avery',
    email: 'avery@example.com',
    grade: '高二',
    city: '上海',
    plan: '英国本科',
    // cloud:// 形态刻意留着：它检验「管理台无法预览云存储头像」时
    // 会不会退化成一个裂图（正确行为是文字占位 + 说明）
    avatarUrl: 'cloud://preview.bucket/avatar/sample.png',
    activeSession: true,
    createdAt: daysAgo(9),
    updatedAt: daysAgo(3),
  },
  {
    // 完全没填过的档案：检验「未填写」是真话，而不是显示 0 或占位串
    openid: 'preview_openid_3',
    nickName: '',
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  },
]);

function seedTickets(rows) {
  const map = new Map();
  let n = 0;
  for (const r of rows) {
    const id = 'preview_ticket_' + ++n;
    map.set(id, Object.assign(
      { _id: id, ticketId: 'fb_20260901_' + crypto.randomBytes(12).toString('hex'), type: 'data', images: [], status: 'open', priority: 'normal', note: '', reply: '', assignee: '', createdAt: daysAgo(3) },
      r
    ));
  }
  store.collections.feedbacks = map;
}
seedTickets([
  { content: '预览样例工单：多伦多大学的雅思线看着不对', contact: '预览样例联系方式', schoolId: 'toronto', status: 'open', priority: 'high' },
  { content: '预览样例工单：希望增加按城市筛选', type: 'idea', contact: '', status: 'resolved', note: '预览样例备注：已记录', reply: '预览样例回复' },
]);

/* ==================================================================
   HTTP：路由与云函数 http.js 保持一致
   ------------------------------------------------------------------
   ⚠️ 云网关会**去掉** `/admin` 前缀再交给函数，本地直连则保留。
     两种入口必须先归一化，否则页面请求 `/admin/admin-api/overview`
     会命中 404，而线上是好的 —— 预览台反而给出错误结论。
   ⚠️ 页面必须挂在 `/admin` 路径下：index.html 里有 `<base href="/admin/">`，
     挂到 `/` 会让相对资源解析到站点根 → 样式与脚本双双 404（裸 HTML）。
   ================================================================== */
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

/** 本地预览横幅：让「这是内存样例数据」在页面上无法被忽略 */
const BANNER = `
<div style="background:#fff4d9;color:#7a4b00;border-bottom:1px solid #f0d79a;padding:10px 20px;font:13px/1.6 -apple-system,'PingFang SC',sans-serif">
  <strong>本地预览台</strong> —— 页面、样式与接口逻辑都是真实文件跑的；<strong>数据是内存里的预览样例</strong>，不连线上库、也不会写线上库。
</div>
<script>
  // 预览台自动填好预览专用密钥（与线上密钥无关），省掉一步手工输入
  addEventListener('DOMContentLoaded', function () { var el = document.getElementById('keyInput'); if (el) el.value = ${JSON.stringify(PREVIEW_KEY)}; });
</script>`;

function readStatic(file) {
  const text = fs.readFileSync(path.join(STATIC_DIR, file), 'utf8');
  return file === 'index.html' ? text.replace('<body>', '<body>' + BANNER) : text;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function bodyOf(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(new Error('请求体不是有效 JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

async function main(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let route = url.pathname;
  if (route === '/admin' || route.startsWith('/admin/')) route = route.slice(6) || '/';

  const hit = staticFiles[route];
  if (hit && req.method === 'GET') return send(res, 200, readStatic(hit[0]), hit[1]);

  if (!route.startsWith('/admin-api/')) return send(res, 404, { code: 404, message: '资源不存在', data: null });

  const data = ['GET', 'HEAD'].includes(req.method) ? {} : await bodyOf(req);
  const result = await admin.main({
    path: route,
    httpMethod: req.method,
    headers: req.headers,
    body: data,
    queryString: Object.fromEntries(url.searchParams),
  });
  const code = result.code === 0 ? 200 : (Number.isInteger(result.code) && result.code >= 400 && result.code <= 599 ? result.code : 500);
  return send(res, code, result);
}

const PORT = Number(process.env.PORT || 9100);
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '') {
    res.writeHead(302, { location: '/admin' });
    return res.end();
  }
  main(req, res).catch((e) => send(res, e.code || 500, { code: e.code || 500, message: e.message || '预览台内部错误', data: null }));
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('管理台本地预览已启动：');
  console.log('  地址  http://127.0.0.1:' + PORT + '/admin');
  console.log('  密钥  已自动填入（预览专用，与线上 admin/.admin-key 无关）');
  console.log('  数据  ' + store.collections.users.size + ' 份用户档案 / ' + store.collections.feedbacks.size + ' 条工单，全部为内存样例');
  console.log('  停止  Ctrl+C');
});
