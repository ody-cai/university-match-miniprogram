#!/usr/bin/env node
/**
 * 管理后台服务端 · 内存验证台
 * ==================================================================
 * 覆盖对象：`miniprogram/cloudfunctions/admin/{domain,handlers,index}.js`
 *
 * 为什么必须单独有一台：这些模块在加载时就 `require('wx-server-sdk')` 并
 * `cloud.database()`，本机没有该 SDK（只在云端存在）。于是「管理端鉴权、
 * 发布校验、并发冲突、工单状态流转」这些**最容易出事、也最不该出事**的逻辑
 * 在本机跑不到。本台用 `Module._load` 把 SDK 换成一份内存实现，
 * require 真实源码，走与线上完全相同的分支。
 *
 * 内存实现刻意保真到足以测出真问题：
 *   · 文档不存在抛 `document with _id x does not exist`（**云端实测原文**）
 *   · `runTransaction` 失败时整体回滚（否则测不出「写了一半」）
 *   · `where` 支持 and / or / gte / RegExp，分页真的 skip+limit
 *
 * ⚠️ 不代表真机通过：不覆盖云网关、真实数据库权限与索引。
 *    线上链路由 `tools/test-admin-live.js` 打真实环境验证。
 *
 * 用法：node tools/test-admin-server.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');
const crypto = require('crypto');

const FN_DIR = path.join(__dirname, '..', 'miniprogram', 'cloudfunctions', 'admin');

/* ==================================================================
   内存数据库
   ================================================================== */
/* ==================================================================
   内存 SDK：与本机预览台（tools/preview-admin.js）**共用同一份实现**
   ------------------------------------------------------------------
   实现在 tools/lib/mock-wx-sdk.js。为什么不内联在这里：本地预览台也要
   用它，各留一份的话两份 mock 迟早会漂 —— 而漂移的表现是
   「预览里好好的、验证台里挂了」，最难判断的一类不一致。
   ================================================================== */
const { createStore, createMockSdk } = require('./lib/mock-wx-sdk');

/* ==================================================================
   注入 mock 后加载真实服务端源码
   ================================================================== */
const store = createStore();
const mockSdk = createMockSdk(store);
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return mockSdk;
  return _origLoad.call(this, request, parent, isMain);
};
const admin = require(path.join(FN_DIR, 'index.js'));
const domain = require(path.join(FN_DIR, 'domain.js'));
const handlers = require(path.join(FN_DIR, 'handlers.js'));
Module._load = _origLoad;

/* ==================================================================
   断言工具与请求封装
   ================================================================== */
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

const KEY = 'test-admin-key-' + 'x'.repeat(24);
process.env.ADMIN_KEY_SHA256 = crypto.createHash('sha256').update(KEY).digest('hex');

/**
 * 被验证代码在拒绝请求时会 `console.error` 记日志（线上需要，可用于告警）。
 * 本台有大量**故意失败**的用例，原样输出会淹掉断言结果，所以收进数组、
 * 末尾只报条数；真出现非预期错误时也能从计数上看出来。
 */
const serverLogs = [];
const origError = console.error;
console.error = (...args) => serverLogs.push(args.map(String).join(' '));

/** 发一个管理请求；headers 省略时不带密钥 */
function req(method, path, { body, key, query } = {}) {
  const headers = {};
  if (key !== null) headers['x-admin-key'] = key === undefined ? KEY : key;
  return admin.main({ path, httpMethod: method, headers, body: body || {}, queryString: query || {} });
}

/** 造一条工单（模拟小程序 feedback.submit 的落库形态） */
function seedTicket(over) {
  const id = 'auto_' + ++store.seq;
  const now = new Date(Date.now() - Math.floor(Math.random() * 1e7));
  const doc = Object.assign(
    {
      _id: id,
      ticketId: 'fb_20260919_' + crypto.randomBytes(12).toString('hex'),
      type: 'complaint',
      userId: 'openid_secret_should_not_leak',
      content: '院校数据有误，Northeastern 的雅思线不对',
      contact: '用户微信号',
      images: [],
      schoolId: 'toronto',
      client: { version: '1.0.0', platform: 'ios', system: 'iOS 18' },
      status: 'open',
      createdAt: now,
    },
    over || {}
  );
  if (!store.collections.feedbacks) store.collections.feedbacks = new Map();
  store.collections.feedbacks.set(id, doc);
  return doc;
}

/**
 * 造一份用户档案（模拟小程序端 `api` 云函数 auth.login 的落库形态）。
 * ⚠️ `_id` 必须按真实规则派生：`sha256('openid:' + openid)`。
 *    测试里随手编一个 _id 就测不出「详情接口是否真的按主键取档」，
 *    也测不出「openid 有没有被顺手带出去」。
 */
function seedUser(over) {
  const o = over || {};
  const openid = o.openid || 'o_openid_' + crypto.randomBytes(8).toString('hex');
  const id = crypto.createHash('sha256').update('openid:' + openid).digest('hex');
  const now = new Date(Date.now() - Math.floor(Math.random() * 1e7));
  const doc = Object.assign(
    {
      _id: id,
      openid,
      nickName: '',
      avatarUrl: '',
      email: '',
      plan: '',
      grade: '',
      city: '',
      activeSession: false,
      createdAt: now,
      updatedAt: now,
    },
    o
  );
  // 派生字段最后强制回填，免得 over 里写错 _id 就把整条用例测歪
  doc._id = id;
  doc.openid = openid;
  if (!store.collections.users) store.collections.users = new Map();
  store.collections.users.set(id, doc);
  return doc;
}

(async function main() {
  /* ============================================================
     1 · 鉴权
     ============================================================ */
  head('1 · 管理端鉴权');
  const savedHash = process.env.ADMIN_KEY_SHA256;
  delete process.env.ADMIN_KEY_SHA256;
  const noCfg = await req('GET', '/admin-api/overview');
  check('未配置管理员密钥 → 503（不是静默放行）', noCfg.code === 503, JSON.stringify(noCfg));
  process.env.ADMIN_KEY_SHA256 = savedHash;

  const noKey = await req('GET', '/admin-api/overview', { key: null });
  check('不带密钥 → 401', noKey.code === 401, JSON.stringify(noKey));
  const wrong = await req('GET', '/admin-api/overview', { key: 'short' });
  check('长度不足的密钥 → 401', wrong.code === 401, JSON.stringify(wrong));
  const wrong2 = await req('GET', '/admin-api/overview', { key: 'a'.repeat(40) });
  check('长度合法但错误的密钥 → 401', wrong2.code === 401, JSON.stringify(wrong2));
  const okReq = await req('GET', '/admin-api/overview');
  check('正确密钥 → code 0', okReq.code === 0, JSON.stringify(okReq));
  const unknown = await req('GET', '/admin-api/does-not-exist');
  check('未知路径 → 404', unknown.code === 404, JSON.stringify(unknown));

  /* ============================================================
     2 · 内容补丁：读取 / 发布 / 校验
     ============================================================ */
  head('2 · 内容补丁读取与发布');
  store.collections = {};
  const empty = await req('GET', '/admin-api/content');
  check('尚无内容文档时返回空补丁而非报错', empty.code === 0 && JSON.stringify(empty.data.patch) === '{}', JSON.stringify(empty));
  check('初始 revision = 0', empty.data.revision === 0, String(empty.data.revision));

  const pub1 = await req('PUT', '/admin-api/content', { body: { patch: { brand: { name: '升学规划' } }, revision: 0, note: '首次发布' } });
  check('发布成功', pub1.code === 0, JSON.stringify(pub1));
  check('revision 递增到 1', pub1.data.revision === 1, String(pub1.data.revision));

  const pub2 = await req('PUT', '/admin-api/content', { body: { patch: { home: { season: '2028 申请季' } }, revision: 1, note: '换季' } });
  check('第二次发布成功', pub2.code === 0, JSON.stringify(pub2));
  check(
    '发布是整份替换：上一次的 brand 不再残留',
    pub2.data.patch.brand === undefined && pub2.data.patch.home.season === '2028 申请季',
    JSON.stringify(pub2.data.patch)
  );

  const conflict = await req('PUT', '/admin-api/content', { body: { patch: { version: '9.9.9' }, revision: 1, note: '用过期的版本号' } });
  check('过期 revision → 409', conflict.code === 409, JSON.stringify(conflict));
  const afterConflict = await req('GET', '/admin-api/content');
  check('被拒绝的发布未改动线上内容', afterConflict.data.revision === 2 && afterConflict.data.patch.version === undefined, JSON.stringify(afterConflict.data));

  head('2b · 发布前校验必须拦住危险改动');
  const aiOn = await req('PUT', '/admin-api/content', { body: { patch: { ai: { enabled: true } }, revision: 2, note: '打开模型' } });
  check('开启运行期模型能力 → 400（合规红线）', aiOn.code === 400, JSON.stringify(aiOn));
  const grad = await req('PUT', '/admin-api/content', { body: { patch: { defaultAcademic: { gpa: 90 } }, revision: 2, note: '预置成绩' } });
  check('预置用户成绩 → 400（数据真实性红线）', grad.code === 400, JSON.stringify(grad));
  const weights = await req('PUT', '/admin-api/content', { body: { patch: { matchConfig: { weights: { academic: 1 } } }, revision: 2, note: '改权重' } });
  check('改算法口径 → 400（需代码审核）', weights.code === 400, JSON.stringify(weights));
  const unknownField = await req('PUT', '/admin-api/content', { body: { patch: { notARealField: 1 }, revision: 2, note: '拼错字段' } });
  check('未知字段 → 400', unknownField.code === 400, JSON.stringify(unknownField));
  const badPage = await req('PUT', '/admin-api/content', { body: { patch: { home: { features: [{ key: 'x', icon: 'tab-home', label: '假页面', url: '/pages/nope/nope', ready: true }] } }, revision: 2, note: '指向不存在页面' } });
  check('启用的功能入口指向不存在的页面 → 400', badPage.code === 400, JSON.stringify(badPage));
  const badFeedback = await req('PUT', '/admin-api/content', { body: { patch: { feedback: { descMax: 500 } }, revision: 2, note: '放宽字数' } });
  check('反馈字数上限与服务端不一致 → 400', badFeedback.code === 400, JSON.stringify(badFeedback));
  const proto = await req('PUT', '/admin-api/content', { body: { patch: JSON.parse('{"__proto__":{"polluted":1}}'), revision: 2, note: '原型污染' } });
  check('原型污染键 → 400', proto.code === 400, JSON.stringify(proto));
  check('全局对象未被污染', ({}).polluted === undefined);

  /* ============================================================
     3 · 院校补丁
     ============================================================ */
  head('3 · 院校补丁发布与校验');
  const schools0 = await req('GET', '/admin-api/schools');
  check('院校列表可读', schools0.code === 0 && schools0.data.total === domain.schools.length, JSON.stringify({ code: schools0.code, total: schools0.data && schools0.data.total }));
  const toronto = domain.schools.find((s) => s.id === 'toronto');
  check('基线含多伦多大学', !!toronto);

  const hidden = JSON.parse(JSON.stringify(toronto));
  hidden.visible = false;
  const pubSchool = await req('PUT', '/admin-api/schools/toronto', { body: { school: hidden, revision: 2, note: '下架多伦多' } });
  check('发布院校补丁成功', pubSchool.code === 0, JSON.stringify(pubSchool));
  const listed = await req('GET', '/admin-api/schools');
  const listedToronto = listed.data.list.find((s) => s.id === 'toronto');
  check('补丁生效：visible=false 已被记录', !!listedToronto && listedToronto.visible === false, JSON.stringify(listedToronto && listedToronto.visible));

  const unknownSchool = await req('PUT', '/admin-api/schools/not-a-school', { body: { school: { id: 'not-a-school' }, revision: 3, note: 'x' } });
  check('维护不存在的院校 → 400', unknownSchool.code === 400, JSON.stringify(unknownSchool));
  const regionChanged = JSON.parse(JSON.stringify(toronto));
  regionChanged.region = 'us';
  const regionRes = await req('PUT', '/admin-api/schools/toronto', { body: { school: regionChanged, revision: 3, note: '改国家' } });
  check('改动院校所属国家 → 400', regionRes.code === 400, JSON.stringify(regionRes));
  const badGpa = JSON.parse(JSON.stringify(toronto));
  badGpa.require = Object.assign({}, toronto.require, { gpa: 999 });
  const gpaRes = await req('PUT', '/admin-api/schools/toronto', { body: { school: badGpa, revision: 3, note: '均分越界' } });
  check('录取要求数值越界 → 400', gpaRes.code === 400, JSON.stringify(gpaRes));
  const noSource = JSON.parse(JSON.stringify(toronto));
  noSource.source = [];
  const srcRes = await req('PUT', '/admin-api/schools/toronto', { body: { school: noSource, revision: 3, note: '去掉来源' } });
  check('有录取要求却无数据来源 → 400', srcRes.code === 400, JSON.stringify(srcRes));
  const httpSrc = JSON.parse(JSON.stringify(toronto));
  httpSrc.source = ['http://example.com'];
  const httpRes = await req('PUT', '/admin-api/schools/toronto', { body: { school: httpSrc, revision: 3, note: '非 HTTPS 来源' } });
  check('数据来源必须是 HTTPS → 400', httpRes.code === 400, JSON.stringify(httpRes));
  const badVisible = JSON.parse(JSON.stringify(toronto));
  badVisible.visible = 'yes';
  const visRes = await req('PUT', '/admin-api/schools/toronto', { body: { school: badVisible, revision: 3, note: 'visible 非布尔' } });
  check('展示状态必须是布尔值 → 400', visRes.code === 400, JSON.stringify(visRes));

  /* ============================================================
     4 · 工单：映射 / 流转 / 历史
     ============================================================ */
  head('4 · 工单受理');
  store.collections = {};
  const emptyTickets = await req('GET', '/admin-api/tickets');
  check('空工单返回 total 0', emptyTickets.code === 0 && emptyTickets.data.total === 0 && emptyTickets.data.list.length === 0, JSON.stringify(emptyTickets.data));

  const t1 = seedTicket();
  /* 守卫：**全新**工单（note / reply 均为空）直接办结必须被拦下 ——
   * 否则工单办结了却没有留下任何「为什么这么处理」的依据。
   * 注意用独立工单验证：已有一条处理说明的工单允许直接办结（见下），
   * 两者是不同分支，不能混在一条工单上测。 */
  const tFresh = seedTicket();
  const freshResolve = await req('PATCH', '/admin-api/tickets/' + tFresh.ticketId, { body: { revision: 0, status: 'resolved' } });
  check('全新工单无任何处理说明直接办结 → 400', freshResolve.code === 400, JSON.stringify(freshResolve));
  const freshClosed = await req('PATCH', '/admin-api/tickets/' + tFresh.ticketId, { body: { revision: 0, status: 'closed' } });
  check('全新工单直接关闭 → 400', freshClosed.code === 400, JSON.stringify(freshClosed));
  const freshStillOpen = await req('GET', '/admin-api/tickets/' + tFresh.ticketId);
  check('被拦下的工单状态未被改动', freshStillOpen.data.status === 'open' && freshStillOpen.data.revision === 0, JSON.stringify({ status: freshStillOpen.data.status, revision: freshStillOpen.data.revision }));

  const list1 = await req('GET', '/admin-api/tickets', { query: { keyword: t1.ticketId } });
  check('工单可列出', list1.data.total === 1, JSON.stringify(list1.data));
  check('列表项用 ticketId 作为标识（不是数据库 _id）', list1.data.list[0].ticketId === t1.ticketId, list1.data.list[0].ticketId);
  check('列表不泄露微信匿名标识', JSON.stringify(list1.data.list[0]).indexOf('openid_secret_should_not_leak') === -1);
  check('列表不含数据库元字段', list1.data.list[0]._id === undefined && list1.data.list[0].userId === undefined);

  const detail1 = await req('GET', '/admin-api/tickets/' + t1.ticketId);
  check('按 ticketId 能取到详情（内部映射到 _id）', detail1.code === 0 && detail1.data.ticketId === t1.ticketId, JSON.stringify(detail1));
  const notFound = await req('GET', '/admin-api/tickets/fb_20260101_deadbeefdeadbeefdeadbeef');
  check('不存在的工单 → 404', notFound.code === 404, JSON.stringify(notFound));

  const upd1 = await req('PATCH', '/admin-api/tickets/' + t1.ticketId, { body: { revision: 0, status: 'processing', note: '已受理，正在核对官网' } });
  check('开始处理成功', upd1.code === 0, JSON.stringify(upd1));
  check('状态已更新', upd1.data.status === 'processing', upd1.data && upd1.data.status);
  check('revision 递增到 1', upd1.data.revision === 1, String(upd1.data && upd1.data.revision));
  check('处理历史已追加', Array.isArray(upd1.data.history) && upd1.data.history.length === 1, JSON.stringify(upd1.data && upd1.data.history));

  const resolvedNoNote = await req('PATCH', '/admin-api/tickets/' + seedTicket().ticketId, { body: { revision: 0, status: 'resolved' } });
  check('另一条全新工单同样被拦下（守卫不是偶发生效）', resolvedNoNote.code === 400, JSON.stringify(resolvedNoNote));

  const resolved = await req('PATCH', '/admin-api/tickets/' + t1.ticketId, { body: { revision: 1, status: 'resolved', reply: '已核对官网并更新数据，感谢反馈' } });
  check('带说明办结成功', resolved.code === 0, JSON.stringify(resolved));
  check('办结时间已记录', !!resolved.data.resolvedAt, JSON.stringify(resolved.data.resolvedAt));
  check('历史累计两条', resolved.data.history.length === 2, String(resolved.data.history.length));

  const staleTicket = await req('PATCH', '/admin-api/tickets/' + t1.ticketId, { body: { revision: 1, status: 'closed', note: '过期版本号' } });
  check('过期 revision 更新工单 → 409', staleTicket.code === 409, JSON.stringify(staleTicket));
  const badStatus = await req('PATCH', '/admin-api/tickets/' + t1.ticketId, { body: { revision: 2, status: 'done' } });
  check('非法状态 → 400', badStatus.code === 400, JSON.stringify(badStatus));
  const badField = await req('PATCH', '/admin-api/tickets/' + t1.ticketId, { body: { revision: 2, userId: 'hacked' } });
  check('更新不支持的字段 → 400', badField.code === 400, JSON.stringify(badField));
  const badPriority = await req('PATCH', '/admin-api/tickets/' + t1.ticketId, { body: { revision: 2, priority: 'super' } });
  check('非法优先级 → 400', badPriority.code === 400, JSON.stringify(badPriority));
  const emptyPatch = await req('PATCH', '/admin-api/tickets/' + t1.ticketId, { body: { revision: 2 } });
  check('没有任何可更新字段 → 400', emptyPatch.code === 400, JSON.stringify(emptyPatch));

  const afterAll = await req('GET', '/admin-api/tickets/' + t1.ticketId);
  check('以上失败请求都没有污染工单', afterAll.data.status === 'resolved' && afterAll.data.revision === 2, JSON.stringify({ status: afterAll.data.status, revision: afterAll.data.revision }));

  /* ============================================================
     5 · 分页与搜索（不能只搜第一页）
     ============================================================ */
  head('5 · 分页与搜索');
  store.collections = {};
  const TOTAL = 25;
  const needles = [];
  for (let i = 0; i < TOTAL; i++) {
    const t = seedTicket({
      content: i === 23 ? 'UNIQUE-NEEDLE-在第二页之后' : '普通反馈内容 ' + i,
      status: i % 2 === 0 ? 'open' : 'processing',
      createdAt: new Date(Date.now() - i * 60000),
    });
    if (i === 23) needles.push(t.ticketId);
  }
  const page1 = await req('GET', '/admin-api/tickets', { query: { page: '1', size: '10' } });
  check('第一页返回 10 条', page1.data.list.length === 10 && page1.data.total === TOTAL, JSON.stringify({ n: page1.data.list.length, total: page1.data.total }));
  const page3 = await req('GET', '/admin-api/tickets', { query: { page: '3', size: '10' } });
  check('第三页返回剩余 5 条', page3.data.list.length === 5, String(page3.data.list.length));
  const ids1 = page1.data.list.map((x) => x.ticketId);
  const ids3 = page3.data.list.map((x) => x.ticketId);
  check('分页之间不重复', ids1.every((id) => ids3.indexOf(id) === -1));

  const search = await req('GET', '/admin-api/tickets', { query: { size: '10', keyword: 'UNIQUE-NEEDLE' } });
  check('搜索命中第 24 条（不是只搜第一页）', search.data.total === 1 && search.data.list[0].ticketId === needles[0], JSON.stringify({ total: search.data.total, got: search.data.list.map((x) => x.ticketId) }));

  const filtered = await req('GET', '/admin-api/tickets', { query: { status: 'processing', size: '100' } });
  check('按状态筛选结果全部匹配', filtered.data.list.every((x) => x.status === 'processing') && filtered.data.total === 12, JSON.stringify({ total: filtered.data.total }));
  const badFilter = await req('GET', '/admin-api/tickets', { query: { status: 'nope' } });
  check('非法状态筛选 → 400', badFilter.code === 400, JSON.stringify(badFilter));
  const badPageNum = await req('GET', '/admin-api/tickets', { query: { page: '0' } });
  check('非法页码 → 400', badPageNum.code === 400, JSON.stringify(badPageNum));
  const hugeSize = await req('GET', '/admin-api/tickets', { query: { size: '5000' } });
  check('过大的分页尺寸 → 400（防止一次拉全库）', hugeSize.code === 400, JSON.stringify(hugeSize));

  /* ============================================================
     6 · 图片临时链接
     ============================================================ */
  head('6 · 工单截图受控换取临时链接');
  store.collections = {};
  const withImg = seedTicket({ images: ['cloud://env.bucket/feedback/a.png', 'cloud://env.bucket/feedback/b.png'] });
  const imgs = await req('GET', '/admin-api/tickets/' + withImg.ticketId + '/images');
  check('返回两条临时链接', imgs.code === 0 && imgs.data.list.length === 2, JSON.stringify(imgs));
  check('临时链接带有效期参数（由服务端换取）', imgs.data.list.every((x) => x.url.indexOf('https://') === 0), JSON.stringify(imgs.data.list));
  const noImg = seedTicket({ images: [] });
  const imgsEmpty = await req('GET', '/admin-api/tickets/' + noImg.ticketId + '/images');
  check('无截图时返回空列表而不是报错', imgsEmpty.code === 0 && imgsEmpty.data.list.length === 0, JSON.stringify(imgsEmpty));

  /* ============================================================
     7 · 概览与审计
     ============================================================ */
  head('7 · 概览与操作留痕');
  store.collections = {};
  seedTicket({ status: 'open' });
  seedTicket({ status: 'open' });
  seedTicket({ status: 'resolved' });
  const ov = await req('GET', '/admin-api/overview');
  check('概览统计正确', ov.code === 0 && ov.data.tickets.total === 3 && ov.data.tickets.open === 2 && ov.data.tickets.resolved === 1, JSON.stringify(ov.data && ov.data.tickets));
  check('概览含院校总数', ov.data.schoolCount === domain.schools.length, String(ov.data.schoolCount));
  check('尚无内容时 revision = 0', ov.data.contentRevision === 0, String(ov.data.contentRevision));

  const auditEmpty = await req('GET', '/admin-api/audit');
  check('审计集合为空时返回空列表', auditEmpty.code === 0 && auditEmpty.data.list.length === 0, JSON.stringify(auditEmpty.data));

  await req('PUT', '/admin-api/content', { body: { patch: { version: '1.0.1' }, revision: 0, note: '发布' } });
  const audit1 = await req('GET', '/admin-api/audit');
  check('内容发布写入审计', audit1.data.list.some((x) => x.action === 'content.publish'), JSON.stringify(audit1.data.list.map((x) => x.action)));
  check('审计不含上一版内容的明文主体（只留必要字段）', audit1.data.list[0].previousPatch === undefined && audit1.data.list[0]._id === undefined, JSON.stringify(audit1.data.list[0]));

  /* ============================================================
     7b · 用户档案（users 集合）
     ============================================================
     命题两条，一条都不能松：
       ① 后台看到的是**小程序端写入的那一份** users 数据（同集合、同字段）；
       ② **绝不把 openid 带出去** —— 用户文档里 openid 与 _id 同时存在，
          只要视图写成 `Object.assign({}, doc)` 就会静默泄露。
     这条属于「泄露了也不报错、也没人会发现」的类别，只能靠断言钉住。
     ============================================================ */
  head('7b · 用户档案');
  store.collections = {};

  const emptyOv = await req('GET', '/admin-api/overview');
  check(
    '用户集合为空时计数是 0（不是 null ——「0 个」与「读不到」必须能分开）',
    !!emptyOv.data.users && emptyOv.data.users.total === 0 && emptyOv.data.users.signedIn === 0,
    JSON.stringify(emptyOv.data.users)
  );
  const emptyUsers = await req('GET', '/admin-api/users');
  check(
    '空集合返回空列表而不是报错（不造演示用户）',
    emptyUsers.code === 0 && emptyUsers.data.list.length === 0 && emptyUsers.data.total === 0,
    JSON.stringify(emptyUsers)
  );

  const SECRET_OPENID = 'o_SECRET_openid_should_never_leak_9f3a';
  const uOld = seedUser({ nickName: '早稻田', email: 'a@example.com', city: '深圳', grade: '高二', activeSession: false, createdAt: new Date('2026-01-02T03:04:05Z') });
  const uNew = seedUser({ openid: SECRET_OPENID, nickName: '晚注册', email: 'b@example.com', city: '上海', grade: '高三', plan: '加拿大本科', activeSession: true, avatarUrl: 'cloud://env.bucket/avatar/1.png', createdAt: new Date('2026-08-09T10:11:12Z') });
  const uEmpty = seedUser({ createdAt: new Date('2026-05-05T05:05:05Z') });

  const listAll = await req('GET', '/admin-api/users', { query: { size: '100' } });
  check('列表返回全部档案', listAll.code === 0 && listAll.data.total === 3 && listAll.data.list.length === 3, JSON.stringify(listAll.data && listAll.data.total));
  check('按建档时间倒序（最新的在最前）', listAll.data.list[0].id === uNew._id && listAll.data.list[2].id === uOld._id, JSON.stringify(listAll.data.list.map((x) => x.id.slice(0, 8))));

  // —— openid：两层判据。只看「有没有 openid 这个键」不够，
  //    值被串进别的字段（比如哪天有人把 openid 拼进昵称兜底）也要发现。
  const listJson = JSON.stringify(listAll.data);
  check('列表不返回 openid 字段', listAll.data.list.every((x) => !Object.prototype.hasOwnProperty.call(x, 'openid')) && !/"openid"/.test(listJson), listJson.slice(0, 200));
  check('列表任何一个字节都不含 openid 原文', listJson.indexOf(SECRET_OPENID) === -1 && listJson.indexOf('o_openid_') === -1);

  // —— 视图必须是**显式白名单**：数据库文档里多出来的字段一个都不许漏出去
  const allowed = ['id', 'nickName', 'avatarUrl', 'email', 'plan', 'grade', 'city', 'signedIn', 'createdAt', 'updatedAt'];
  const extraKeys = Object.keys(listAll.data.list[0]).filter((k) => allowed.indexOf(k) === -1);
  check('视图是白名单（文档里其余字段不随意外泄）', extraKeys.length === 0, '多出：' + JSON.stringify(extraKeys));
  // 自测：确认上一条判据真的在比白名单，而不是样本里恰好没有额外字段。
  // `_id`→`id`、`activeSession`→`signedIn` 是**改名映射**，不属于「多出来的字段」；
  // `openid` 则必须消失。这份名单同时说明了这三者的去向。
  const SAMPLE_MAPPED = ['_id', 'openid', 'activeSession'];
  const extraFields = [uOld, uNew, uEmpty].flatMap((u) => Object.keys(u)).filter((k) => SAMPLE_MAPPED.indexOf(k) === -1 && allowed.indexOf(k) === -1);
  check('样本字段与视图白名单一一对得上（自测：白名单断言不是空转）', extraFields.length === 0, JSON.stringify(extraFields));

  check('未填写的字段返回空串（由界面显示「未填写」，服务端不编造默认值）', listAll.data.list.find((x) => x.id === uEmpty._id).nickName === '', JSON.stringify(listAll.data.list.find((x) => x.id === uEmpty._id)));

  const active = listAll.data.list.filter((x) => x.signedIn).map((x) => x.id);
  check('signedIn 只对 activeSession===true 的档案为真', active.length === 1 && active[0] === uNew._id, JSON.stringify(active));

  const ovUsers = await req('GET', '/admin-api/overview');
  check('概览用户计数与列表口径一致（3 份，其中 1 份保持登录）', ovUsers.data.users.total === 3 && ovUsers.data.users.signedIn === 1, JSON.stringify(ovUsers.data.users));

  // —— 详情
  const detail = await req('GET', '/admin-api/users/' + uNew._id);
  check('按档案 ID 取详情', detail.code === 0 && detail.data.nickName === '晚注册' && detail.data.plan === '加拿大本科', JSON.stringify(detail.data));
  check('详情同样不含 openid', JSON.stringify(detail.data).indexOf(SECRET_OPENID) === -1 && !Object.prototype.hasOwnProperty.call(detail.data, 'openid'));
  check('头像原样返回 cloud:// 地址（是否可预览由界面决定，服务端不改写数据）', detail.data.avatarUrl === 'cloud://env.bucket/avatar/1.png', String(detail.data.avatarUrl));

  const missDetail = await req('GET', '/admin-api/users/' + 'f'.repeat(64));
  check('不存在的档案 → 404', missDetail.code === 404, JSON.stringify(missDetail));
  const badId = await req('GET', '/admin-api/users/' + encodeURIComponent('a/../b c'));
  check('非法档案 ID → 400（不把一个奇怪字符串丢进查询）', badId.code === 400, JSON.stringify(badId));

  // —— 搜索与分页
  const byNick = await req('GET', '/admin-api/users', { query: { keyword: '晚注册' } });
  check('关键词命中昵称', byNick.code === 0 && byNick.data.total === 1 && byNick.data.list[0].id === uNew._id, JSON.stringify(byNick.data && byNick.data.total));
  const byMail = await req('GET', '/admin-api/users', { query: { keyword: 'a@example' } });
  check('关键词命中邮箱', byMail.data.total === 1 && byMail.data.list[0].id === uOld._id, JSON.stringify(byMail.data && byMail.data.total));
  const byCity = await req('GET', '/admin-api/users', { query: { keyword: '上海' } });
  check('关键词命中城市', byCity.data.total === 1 && byCity.data.list[0].id === uNew._id, JSON.stringify(byCity.data && byCity.data.total));
  const byNone = await req('GET', '/admin-api/users', { query: { keyword: '压根不存在的人' } });
  check('搜不到时返回空列表（不是全量）', byNone.data.total === 0 && byNone.data.list.length === 0, JSON.stringify(byNone.data && byNone.data.total));
  const regexInjected = await req('GET', '/admin-api/users', { query: { keyword: '.*' } });
  check('关键词里的正则元字符被转义，不会变成「匹配所有」', regexInjected.data.total === 0, JSON.stringify(regexInjected.data && regexInjected.data.total));

  const paged = await req('GET', '/admin-api/users', { query: { page: '2', size: '2' } });
  check('分页真的生效（第 2 页取到第 3 条）', paged.code === 0 && paged.data.list.length === 1 && paged.data.total === 3, JSON.stringify(paged.data && paged.data.list.length));
  const badSize = await req('GET', '/admin-api/users', { query: { size: '5000' } });
  check('分页参数越界 → 400', badSize.code === 400, JSON.stringify(badSize));

  const noKeyUsers = await req('GET', '/admin-api/users', { key: null });
  check('用户档案不透鉴权（不带密钥 → 401）', noKeyUsers.code === 401, JSON.stringify(noKeyUsers));

  // —— 集合缺失：真实部署最常见的事故形态
  head('7c · users 集合缺失时的降级行为');
  store.missing.add('users');
  const missingList = await req('GET', '/admin-api/users');
  check('缺集合时列表接口 → 503 并给出可操作的原因（不是笼统 500）', missingList.code === 503 && /集合/.test(missingList.message), JSON.stringify(missingList));
  const missingDetail = await req('GET', '/admin-api/users/' + uNew._id);
  check('缺集合时详情接口 → 503', missingDetail.code === 503, JSON.stringify(missingDetail));
  const missingOv = await req('GET', '/admin-api/overview');
  check('缺集合时概览仍然可用（不能因为少一张卡片就让后台登不进去）', missingOv.code === 0, JSON.stringify(missingOv).slice(0, 200));
  check('缺集合时概览的用户计数是 null 而不是 0（读不到 ≠ 一个都没有）', missingOv.data.users === null, JSON.stringify(missingOv.data.users));
  store.missing.delete('users');
  const backOv = await req('GET', '/admin-api/overview');
  check('集合恢复后计数立刻回到真实值', backOv.data.users.total === 3, JSON.stringify(backOv.data.users));

  /* ============================================================
     7d · 成绩档案与收藏（2026-09-22 上云后新增）
     ============================================================
     这两块数据以前服务端根本没有，页面只能写一句「看不到，因为没上云」。
     现在有真值了，要守的变成**别把真值显示错、也别为了好看补值**：

       · 空 / 有值必须分得开（`academic === null` 是「从未填过」，不是「都是 0」）；
       · 国家 / 专业 / 课程体系的中文名由服务端查内容层，前端不做映射；
       · 收藏里的院校名由服务端查 schools.json，**查不到的照样列出来并标 missing**
         —— 静默丢弃会让「收藏 5 所」在详情里只列出 4 所；
       · 详情仍然绝不带 openid（多返回两块数据之后这条同样成立）。
     ⚠️ 这一段会往 users 集合里加一条记录，所以放在所有「total === 3」的
        分页 / 计数断言**之后**，否则会把那些断言喂红。
     ============================================================ */
  head('7d · 用户详情里的成绩档案与收藏');

  const GHOST_ID = 'school-that-no-longer-exists';
  const uData = seedUser({
    openid: 'o_data_1',
    nickName: '有成绩的人',
    createdAt: new Date('2026-08-10T00:00:00Z'),
    academic: {
      curriculum: 'IB',
      coursesMap: { AP: [], AL: [], IB: [{ name: 'IB Physics HL', date: '2026 年 5 月', score: 6, max: 7 }], NONE: [] },
      courses: [{ name: 'IB Physics HL', date: '2026 年 5 月', score: 6, max: 7 }],
      gpa: 88,
      gpaScale: 100,
      ielts: { overall: 6.5, l: 6, r: 7, w: 6, s: 6.5 },
      toefl: null,
      sat: null,
      countries: ['ca', 'au'],
      majors: ['cs'],
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
    favorites: ['ubc', 'toronto', GHOST_ID],
    favoritesUpdatedAt: new Date('2026-09-20T01:00:00Z'),
  });

  const dData = await req('GET', '/admin-api/users/' + uData._id);
  const ac = dData.data.academic || {};
  check('详情返回成绩档案（均分正确）', ac.gpa === 88, JSON.stringify(ac.gpa));
  check('均分带上满分制（不给人一个裸数字）', ac.gpaScale === 100, String(ac.gpaScale));
  check('雅思单项原样返回', ac.ielts && ac.ielts.r === 7, JSON.stringify(ac.ielts));
  check('未考的托福 / SAT 是 null（不是 0）', ac.toefl === null && ac.sat === null, JSON.stringify([ac.toefl, ac.sat]));
  check(
    '目标国家 / 专业映射成中文名（前端不做映射，改名字不会两边不一致）',
    ac.countryLabels.join('、') === '加拿大、澳大利亚' && ac.majorLabels.join('、') === '计算机科学',
    JSON.stringify([ac.countryLabels, ac.majorLabels])
  );
  check('课程体系映射成中文名', ac.curriculumLabel === 'IB', String(ac.curriculumLabel));
  check(
    '各体系中文名表一并下发（前端展开科目时按体系分组要用）',
    Array.isArray(ac.curriculumLabels) && ac.curriculumLabels.length >= 4,
    JSON.stringify(ac.curriculumLabels)
  );
  check('国际课程科目原样返回', ac.coursesMap.IB.length === 1 && ac.coursesMap.IB[0].name === 'IB Physics HL', JSON.stringify(ac.coursesMap.IB));

  const favs = dData.data.favorites || [];
  check('收藏映射成院校名（后台看的是院校，不是 id）', favs.length === 3 && favs[1].nameCn === '多伦多大学', JSON.stringify(favs.map((f) => f.nameCn || f.id)));
  check('收藏带国家与排名', favs[0].countryCn === '加拿大' && favs[0].qsLabel === 'QS =45', JSON.stringify(favs[0]));
  check(
    '不在当前院校库里的收藏**照样列出来**并标 missing（不静默丢弃）',
    favs[2].missing === true && favs[2].id === GHOST_ID,
    JSON.stringify(favs[2])
  );
  check('收藏最近同步时间可见', /^\d{4}-\d{2}-\d{2}T/.test(dData.data.favoritesUpdatedAt), String(dData.data.favoritesUpdatedAt));
  check(
    '详情仍绝不返回 openid（多返回两块数据之后这条同样成立）',
    JSON.stringify(dData.data).indexOf('o_data_1') === -1 && !Object.prototype.hasOwnProperty.call(dData.data, 'openid')
  );

  // —— 从未填过的人：必须是 null / 空数组，不能是一份「空档案」
  const dEmptyData = await req('GET', '/admin-api/users/' + uEmpty._id);
  check('从未保存过成绩 → academic 为 null（不是一份空档案）', dEmptyData.data.academic === null, JSON.stringify(dEmptyData.data.academic));
  check('从未同步过收藏 → null（与「同步过但一所都没收藏」区分开）', dEmptyData.data.favorites === null, JSON.stringify(dEmptyData.data.favorites));

  // —— 「同步过但一所都没收藏」必须是 []，不能被折成 null。
  //    这两种空态在排查「用户说收藏丢了」时意义完全不同：
  //    null = 同步压根没跑成功；[] = 真的一所都没收藏。
  const uEmptyFav = seedUser({ openid: 'o_empty_fav', nickName: '同步过收藏的人', favorites: [], favoritesUpdatedAt: new Date('2026-09-21T00:00:00Z') });
  const dEmptyFav = await req('GET', '/admin-api/users/' + uEmptyFav._id);
  check(
    '同步过但一所都没收藏 → 空数组（不是 null）',
    Array.isArray(dEmptyFav.data.favorites) && dEmptyFav.data.favorites.length === 0,
    JSON.stringify(dEmptyFav.data.favorites)
  );

  // —— 列表刻意不带这两块（payload 考量），详情才带
  const listKeys = Object.keys(listAll.data.list[0]);
  check(
    '列表不带 academic / favorites（payload 考量，不是把数据藏起来）',
    listKeys.indexOf('academic') === -1 && listKeys.indexOf('favorites') === -1,
    JSON.stringify(listKeys)
  );

  /* ============================================================
     8 · 管理页与服务端接口一致性（静态）
     ============================================================
     最容易出现、又最难被测试抓到的一类缺陷：页面调了一个**不存在**的路径。
     本地直接把页面打开看，只会看到一句「后台接口不存在」，很难判断是
     路径写错还是服务没起。这里直接比对两边的字符串集合。
     ============================================================ */
  head('8 · 管理页调用的接口路径必须都已实现');
  const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'admin', 'app.js'), 'utf8');
  /** 服务端已实现的路由基（与 index.js 的 if 链一一对应） */
  const SERVER_BASES = ['/admin-api/overview', '/admin-api/content', '/admin-api/tickets', '/admin-api/users', '/admin-api/schools', '/admin-api/audit'];
  const uiPaths = Array.from(
    new Set((UI_SRC.match(/['"`]\/admin-api[^'"`]*/g) || []).map((s) => s.slice(1)))
  ).map((p) => p.split('?')[0]);
  check('管理页至少调用了概览接口', uiPaths.indexOf('/admin-api/overview') > -1, JSON.stringify(uiPaths));
  const unknownUi = uiPaths.filter((p) => !SERVER_BASES.some((b) => p === b || p.indexOf(b + '/') === 0));
  check('管理页没有调用未实现的后台接口', unknownUi.length === 0, '未实现：' + JSON.stringify(unknownUi));
  // 内容补丁的界面入口已于 2026-09-22 按需求下线。服务端路由保留（院校补丁发布
  // 复用同一条发布/校验/审计路径），但**页面不该再调它** —— 否则一旦有人手滑
  // 把编辑框加回来，就等于悄悄恢复了「可以改线上文案」这个被明确移除的能力。
  check('管理页不再调用内容补丁接口（该界面入口已下线）', uiPaths.indexOf('/admin-api/content') === -1, JSON.stringify(uiPaths));
  check('管理页带上了管理密钥请求头', /X-Admin-Key/.test(UI_SRC));
  check('管理页引用了工单截图接口', /\/images/.test(UI_SRC));
  check('管理页不把密钥写入浏览器存储', !/localStorage|sessionStorage/.test(UI_SRC), '命中浏览器存储用法');
  // 函数挂在云网关的 /admin 路径下，页面在 /admin/ 目录；接口地址必须相对「页面目录」解析。
  // 直接写 fetch('/admin-api/x') 会被浏览器解析到站点根，命中网关 INVALID_PATH 404（不是云函数）。
  const fetchTargets = Array.from(UI_SRC.matchAll(/fetch\(\s*([A-Za-z_$][\w$]*)\s*\+\s*path/g)).map((m) => m[1]);
  check('接口请求统一经过 api() 助手（无裸 fetch 拼接）', fetchTargets.length === 1 && !/fetch\(\s*['"`]/.test(UI_SRC), JSON.stringify(fetchTargets));
  check('api() 助手以页面目录为基址（API_BASE），不写死站点根', /const\s+API_BASE\s*=\s*location\.pathname/.test(UI_SRC));
  const staticCopy = path.join(__dirname, '..', 'miniprogram', 'cloudfunctions', 'admin', 'static', 'app.js');
  check('管理页与云函数静态副本逐字一致', fs.readFileSync(staticCopy, 'utf8') === UI_SRC, '副本未同步：' + staticCopy);

  // 函数挂在 /admin 路径下，而用户常直接输入**不带斜杠**的 /admin。
  // 此时页面里的相对资源（styles.css / app.js）会被解析到站点根 → 双双 404，
  // 页面退化成没有样式、没有脚本的裸 HTML（页签点了也不动）。
  // 必须声明 <base>，把相对地址锚定在 /admin/ 之下。这条守卫是那类缺陷的离线闸门。
  const HTML_SRC = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const baseHref = (HTML_SRC.match(/<base[^>]+href="([^"]+)"/) || [])[1] || '';
  check('index.html 声明了 <base>（防无斜杠入口资源 404）', baseHref === '/admin/', '实际 base href=' + JSON.stringify(baseHref));
  const headEnd = HTML_SRC.indexOf('</head>');
  const basePos = HTML_SRC.indexOf('<base');
  // 找真正的 <link> 标签位置，不能用 indexOf('styles.css') —— 注释里也会出现这个词
  const linkPos = HTML_SRC.search(/<link[^>]+href="/);
  check('<base> 出现在 head 内且早于资源引用', basePos > -1 && basePos < headEnd && basePos < linkPos,
    JSON.stringify({ basePos: basePos, linkPos: linkPos, headEnd: headEnd }));
  const htmlStatic = path.join(__dirname, '..', 'miniprogram', 'cloudfunctions', 'admin', 'static', 'index.html');
  check('index.html 与云函数静态副本逐字一致', fs.readFileSync(htmlStatic, 'utf8') === HTML_SRC, '副本未同步：' + htmlStatic);

  // 页签集合必须与需求一致：内容管理已下线、用户档案上线。
  // 判据取 `data-tab`（行为契约）而不是界面文案 —— 文案随时会改，
  // 而「点了页签会不会切到面板」靠的是 data-tab 与 xxxPanel 的对应关系。
  const tabIds = Array.from(HTML_SRC.matchAll(/data-tab="([^"]+)"/g)).map((m) => m[1]);
  check('页签为「投诉工单 / 用户档案 / 院校数据」', JSON.stringify(tabIds) === JSON.stringify(['tickets', 'users', 'schools']), JSON.stringify(tabIds));
  check('页面不再有内容管理页签与面板', !/data-tab="content"/.test(HTML_SRC) && !/id="contentPanel"/.test(HTML_SRC));
  for (const t of tabIds) {
    // 少一个面板 = 点了页签什么都不发生，而且不会报错（本项目踩过同类坑）
    check('页签 ' + t + ' 有对应的面板容器', new RegExp('id="' + t + 'Panel"').test(HTML_SRC));
  }

  /* ============================================================ */
  console.error = origError;
  console.log('\n' + '─'.repeat(64));
  console.log('被验证代码的预期错误日志：' + serverLogs.length + ' 条（均为故意触发的拒绝用例）');
  console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + '）');
  console.log('─'.repeat(64));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n验证台自身异常：', e);
  process.exit(2);
});
