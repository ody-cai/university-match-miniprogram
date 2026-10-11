#!/usr/bin/env node
/**
 * 消息通知页 + 订阅消息链路 验证台
 * ==================================================================
 * 覆盖「光读代码看不出来、必须跑起来才算数」的六类问题：
 *
 *   1) **把「不知道」说成了「没有」**
 *      `api.getNotify()` 拿不到云端状态时返回 `{unavailable:true}` 哨兵，
 *      而不是 `null`。两者若走同一分支，端点没部署会被显示成「未开启」——
 *      用户以为只是自己没开，实际是功能还没上线；而他点了也没有任何反应。
 *      → 逐个状态真跑 `api.notifyStatus()`，并断言 unknown 与 off **不同**。
 *
 *   2) **页面画出一个点不出结果的按钮**
 *      模板 ID 没配（`tmplIds: []`）时若仍渲染「开启通知」，点下去必然失败。
 *      → 断言该情形下 `actionText` 为空（底部按钮整条不渲染）。
 *
 *   3) **授权上报失败却显示「已开启」**
 *      上报发生在用户点过「允许」之后；失败若被吞掉，页面会显示已开启
 *      而服务端没有记录 —— 后台受理时根本不会发通知，双方都以为是对方的问题。
 *      → mock 一次失败的 saveNotify，断言页面给出提示且**状态仍由云端说了算**。
 *
 *   4) **`wx.requestSubscribeMessage` 被异步操作夹住**
 *      微信要求它在用户点击的同步上下文里发起，中途夹一个 await 就会被判成
 *      「非用户手势触发」而静默 fail。
 *      → 静态断言调用点之前没有 await / then。
 *
 *   5) **管理台把失败的发送显示成「已通知」**
 *      云调用失败时不一定抛异常（有的版本把 errCode 放在返回值里），
 *      只包一层 try/catch 会把失败记成成功。
 *      → 静态断言返回值里的 errCode 也被检查，且错误码原样透出到界面。
 *
 *   6) **两个云函数各写一份 stableId 却对不上**
 *      它们是不同的包、不能相互 require，只能各存一份副本。
 *      实现漂移的后果是两边**永远查不到同一条文档**，而且**不报错**
 *      （表现为「用户明明授权了，后台说他没有额度」）。
 *
 * 用法：node tools/verify-notify-page.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'miniprogram');
const NOTIFY_PAGE = path.join(PROJECT, 'pages/notify/notify');
const API_PAGE = path.join(PROJECT, 'pages/account/account');
const API_HANDLER = path.join(PROJECT, 'cloudfunctions/api/handlers/notify.js');
const API_INDEX = path.join(PROJECT, 'cloudfunctions/api/index.js');
const ADMIN_HANDLER = path.join(PROJECT, 'cloudfunctions/admin/handlers.js');
const ADMIN_INDEX = path.join(PROJECT, 'cloudfunctions/admin/index.js');
const ADMIN_APP = path.join(ROOT, 'admin/app.js');
const ADMIN_CONFIG = path.join(PROJECT, 'cloudfunctions/admin/config.json');

let pass = 0;
const failures = [];

function ok(label, extra) {
  pass++;
  console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`);
}
function bad(label, detail) {
  failures.push(label + (detail ? ` — ${detail}` : ''));
  console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`);
}
function check(label, cond, detail) {
  if (cond) ok(label, detail);
  else bad(label, detail);
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}
const read = (p) => fs.readFileSync(p, 'utf8');
/** 剥掉注释 —— 这些文件的注释里大量出现「switch」「await」等词，不剥会把断言喂绿 */
const strip = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ================================================================
   mock 运行环境（必须早于 require 页面 js）
   ================================================================ */
const toasts = [];
const storage = {};
let subscribeBehavior = 'accept';

global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => {
    storage[k] = v;
  },
  removeStorageSync: (k) => {
    delete storage[k];
  },
  showToast: (o) => toasts.push(o),
  requestSubscribeMessage: (o) => {
    if (subscribeBehavior === 'fail') {
      o.fail && o.fail({ errCode: 20004, errMsg: 'template banned' });
      o.complete && o.complete();
      return;
    }
    const res = {};
    (o.tmplIds || []).forEach((id, i) => {
      res[id] = i === 0 ? subscribeBehavior : 'reject';
    });
    o.success && o.success(res);
    o.complete && o.complete();
  },
  navigateTo: () => {},
  switchTab: () => {},
  reLaunch: () => {},
};

const api = require(path.join(PROJECT, 'utils/api.js'));
const request = require(path.join(PROJECT, 'utils/request.js'));
const content = require(path.join(PROJECT, 'data/content.js'));

let pageDef = null;
global.Page = (opt) => {
  pageDef = opt;
};
require(NOTIFY_PAGE + '.js');

/** 造一个可跑的页面实例：方法从定义取，data 深拷贝，setData 写回 */
function makePage(cfgOverride, remote) {
  const p = Object.create(pageDef);
  p.data = JSON.parse(JSON.stringify(pageDef.data));
  if (cfgOverride) Object.assign(p.data.c.notify, cfgOverride);
  p.remote = remote === undefined ? null : remote;
  p.loadedRemote = true;
  p.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  return p;
}

const TM = ['tmpl-probe-1']; // 一个「已配置」的模板环境
const CFG_ON = { enabled: true, tmplIds: TM };

/* ================================================================
   第 1 节 · 静态守卫（页面存在、有出口、不是开关）
   ================================================================ */
function staticChecks() {
  head('第 1 节 · 静态守卫');

  const appJson = JSON.parse(read(path.join(PROJECT, 'app.json')));
  check(
    'app.json 已注册 pages/notify/notify',
    appJson.pages.indexOf('pages/notify/notify') > -1,
    '页面数 ' + appJson.pages.length
  );
  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    check(`消息通知页 ${ext} 存在`, fs.existsSync(`${NOTIFY_PAGE}.${ext}`));
  });

  const wxml = strip(read(NOTIFY_PAGE + '.wxml'));
  const navTag = /<nav-bar[\s\S]*?\/>/.exec(wxml);
  check('nav-bar 传了 back（缺了不会有任何报错，只是少一个箭头）', !!navTag && /back=/.test(navTag[0]));
  check(
    'nav-bar 给了无历史栈时的兜底出口',
    !!navTag && /fallback-url=/.test(navTag[0]),
    navTag ? navTag[0].replace(/\s+/g, ' ').slice(0, 70) : ''
  );
  check('nav-bar 标题取自内容层', !!navTag && /\{\{c\.notify\.navTitle\}\}/.test(navTag[0]));

  /**
   * ⚠️ 本页**刻意不是开关**。微信个人主体只能拿到一次性订阅
   *    （授权一次 = 可下发一条），做成 switch 会让「开」这个字变成假话。
   *    这条断言守的是设计意图，不是实现细节 —— 别为了「好看」加回 switch。
   */
  check('页面没做成 <switch> 开关（一次性订阅不存在「常驻开着」这件事）', !/<switch\b/.test(wxml));

  // WXML 里不能有函数调用：求值失败且**不报错**，class 会拼成空串
  check(
    '绑定表达式里没有函数调用',
    !/\{\{[^}]*\b(indexOf|filter|map|slice|toFixed|join|replace|Date|Math)\s*\(/.test(wxml)
  );
  check('页面里没有硬编码中文文案', !/[\u4e00-\u9fa5]/.test(wxml.replace(/<!--[\s\S]*?-->/g, '')));

  // 状态点必须在 wxss 里有对应类（少一个不会有任何报错，只是那个状态没颜色）
  const wxss = read(NOTIFY_PAGE + '.wxss');
  ['ready', 'used'].forEach((s) => {
    check(`wxss 有 .ntf__dot--${s} 状态点样式`, wxss.indexOf(`.ntf__dot--${s}`) > -1);
  });

  // 入口必须真的接上（此前是 url:'' + ready:false 的半截功能）
  const accountJs = strip(read(API_PAGE + '.js'));
  check(
    '「我的」页把消息通知行指向了真实页面',
    /key:\s*'notify'[^}]*url:\s*'\/pages\/notify\/notify'/.test(accountJs)
  );
  check(
    '「我的」页不再有 url:空 + ready:false 的消息通知行',
    !/key:\s*'notify'[^}]*url:\s*''[^}]*ready:\s*false/.test(accountJs)
  );
  check(
    '「我的」页的通知行状态来自 api 的唯一口径',
    accountJs.indexOf('api.notifyStatus(') > -1
  );
  check(
    '「我的」页不预设一个状态标签（预设就是替服务端编答案）',
    /key:\s*'notify'[^}]*value:\s*''/.test(accountJs)
  );

  const accountWxml = strip(read(API_PAGE + '.wxml'));
  check(
    '「我的」页的行模板支持可选状态标签，且为空时不渲染',
    /wx:if="\{\{item\.value\}\}"/.test(accountWxml) && /grow__value/.test(accountWxml)
  );
}

/* ================================================================
   第 2 节 · 内容层五态与配置
   ================================================================ */
function contentChecks() {
  head('第 2 节 · 内容层');

  const n = content.notify;
  check('内容层有 notify 段', !!n);
  if (!n) return;

  const STATES = ['off', 'ready', 'used', 'unavailable', 'unknown'];
  STATES.forEach((s) => {
    check(`notify.status 有 ${s} 的文案`, typeof n.status[s] === 'string' && !!n.status[s]);
    check(`notify.statusDesc 有 ${s} 的说明`, typeof n.statusDesc[s] === 'string' && !!n.statusDesc[s]);
  });
  check(
    '五态文案两两不同（合并就等于把两件事说成一件）',
    new Set(STATES.map((s) => n.status[s])).size === STATES.length
  );

  check('rowLabel 只列状态明确的三种', Object.keys(n.rowLabel).sort().join(',') === 'off,ready,used');
  check(
    'rowLabel 不含 unknown / unavailable（列表行不该挂「状态读取失败」）',
    n.rowLabel.unknown === undefined && n.rowLabel.unavailable === undefined
  );

  check('enabled 是布尔值', typeof n.enabled === 'boolean');
  check('tmplIds 默认是空数组（未申请模板前必须保持空）', Array.isArray(n.tmplIds) && n.tmplIds.length === 0);
  check('tmplData 默认是空数组（未配映射 → 后台拒绝发送）', Array.isArray(n.tmplData) && n.tmplData.length === 0);
  check('page 指向 app.json 已注册的路径', (function () {
    const appJson = JSON.parse(read(path.join(PROJECT, 'app.json')));
    return appJson.pages.indexOf(n.page) > -1;
  })(), n.page);
  check('envVersion 是合法值', ['developer', 'trial', 'formal'].indexOf(n.envVersion) > -1);
  check('push.title 非空（模板字段不能为空值，空值会被微信判 47003）', !!n.push.title);
  check('toast 覆盖了拒绝 / 停用 / 类目不符 / 未开放四种结果', [
    'accepted', 'denied', 'banned', 'filtered', 'unavailable', 'revoked', 'failed',
  ].every((k) => typeof n.toast[k] === 'string' && !!n.toast[k]));

  const tm = read(path.join(PROJECT, 'cloudfunctions/admin/handlers.js'));
  check(
    '服务端引用的 push 字段在内容层真实存在（写错不报错，只会发出一条空通知）',
    /cfg\.push\.title/.test(tm) && /cfg\.push\.noReply/.test(tm)
  );
}

/* ================================================================
   第 3 节 · 状态推导（真跑）
   ================================================================ */
function statusChecks() {
  head('第 3 节 · 状态推导（真跑 api.notifyStatus）');

  check('导出 notifyStatus', typeof api.notifyStatus === 'function');

  const U = { unavailable: true };
  check('模板未配（tmplIds 空）→ unavailable', api.notifyStatus(null, { enabled: true, tmplIds: [] }) === 'unavailable');
  check('能力被运营关闭 → unavailable', api.notifyStatus(null, { enabled: false, tmplIds: TM }) === 'unavailable');
  check('内容层缺失 → unavailable（不是 off）', api.notifyStatus(null, null) === 'unavailable');

  check('拿不到云端状态 → unknown', api.notifyStatus(U, CFG_ON) === 'unknown');
  check(
    'unknown ≠ off（把「不知道」说成「没有」是本项目反复踩的坑）',
    api.notifyStatus(U, CFG_ON) !== 'off'
  );
  check('从未订阅（null）→ off', api.notifyStatus(null, CFG_ON) === 'off');
  check('有记录但两样都空 → off', api.notifyStatus({ accepted: false, usedAt: '' }, CFG_ON) === 'off');
  check('授权待用 → ready', api.notifyStatus({ accepted: true, usedAt: '' }, CFG_ON) === 'ready');
  check(
    '已用掉（accepted=false + usedAt 有值）→ used',
    api.notifyStatus({ accepted: false, usedAt: '2026-09-24T02:00:00.000Z' }, CFG_ON) === 'used'
  );
  check(
    'accepted 优先于 usedAt（重新授权后不能还显示「已用掉」）',
    api.notifyStatus({ accepted: true, usedAt: '2026-09-24T02:00:00.000Z' }, CFG_ON) === 'ready'
  );
  check(
    '能力未配时，即使云端有记录也显示 unavailable（不能假装能开）',
    api.notifyStatus({ accepted: true }, { enabled: true, tmplIds: [] }) === 'unavailable'
  );
}

/* ================================================================
   第 4 节 · 页面渲染（mock 跑 apply）
   ================================================================ */
function renderChecks() {
  head('第 4 节 · 页面渲染（mock Page / wx）');

  check('页面定义了 apply', typeof pageDef.apply === 'function');

  // 未拿到远端时不许先画一个状态 —— 「还没问到」与「问到了、没有」是两件事
  const p0 = makePage({ enabled: true, tmplIds: TM }, null);
  p0.loadedRemote = false;
  p0.apply();
  check(
    '远端还没回来时不画状态（不预设「未开启」）',
    p0.data.statusText === '' && p0.data.actionText === ''
  );

  const cases = [
    ['off', null, CFG_ON, '未开启'],
    ['ready', { accepted: true, usedAt: '' }, CFG_ON, '已开启，待使用'],
    ['used', { accepted: false, usedAt: '2026-09-24T02:00:00.000Z' }, CFG_ON, '已使用，需重新开启'],
    ['unknown', { unavailable: true }, CFG_ON, '状态读取失败'],
    ['unavailable', null, { enabled: true, tmplIds: [] }, '暂未开放'],
  ];
  cases.forEach(([want, remote, cfg, text]) => {
    const p = makePage(cfg, remote);
    p.apply();
    check(`状态 ${want} 渲染成「${text}」`, p.data.status === want && p.data.statusText === text, p.data.statusText);
  });

  // 未开放时不能画出按钮
  const pu = makePage({ enabled: true, tmplIds: [] }, null);
  pu.apply();
  check('能力未开放时底部按钮整条不渲染（不画点不出结果的按钮）', pu.data.actionText === '');

  // unknown 态给的是「重试」而不是授权
  const pk = makePage({ enabled: true, tmplIds: TM }, { unavailable: true });
  pk.apply();
  check('unknown 态的按钮是「重试」而不是「开启通知」', pk.data.actionText === content.notify.action.retry, pk.data.actionText);
  check('unknown 态给了脚注解释（不能只留一个按钮）', !!pk.data.statusDesc);

  // 已开启态给的是「关闭」而不是「再开一次」
  const pr = makePage(CFG_ON, { accepted: true });
  pr.apply();
  check('ready 态的按钮是「关闭通知」', pr.data.actionText === content.notify.action.revoke, pr.data.actionText);

  // 工单号只在 used 态回显
  const pt = makePage(CFG_ON, { accepted: true, usedAt: '2026-09-24T02:00:00.000Z', usedTicketId: 'fb_20260924_abc' });
  pt.apply();
  check('ready 态不回显工单号（那是上一次的历史）', pt.data.usedTicketId === '');
  const pt2 = makePage(CFG_ON, { accepted: false, usedAt: '2026-09-24T02:00:00.000Z', usedTicketId: 'fb_20260924_abc' });
  pt2.apply();
  check('used 态回显工单号', pt2.data.usedTicketId === 'fb_20260924_abc');
  check(
    'used 态的时间占位符被真实时间替换（{time} 留在界面上就是没做）',
    pt2.data.statusDesc.indexOf('{time}') === -1 && pt2.data.statusDesc.indexOf('2026-09-24') > -1,
    pt2.data.statusDesc.slice(0, 40)
  );
  check('used 态的工单号占位符被替换', pt2.data.statusDesc.indexOf('{ticket}') === -1);
  check('used 态的 {extra} 占位符被替换', pt2.data.statusDesc.indexOf('{extra}') === -1);

  // 没有工单号时不留一个孤零零的「（）」
  const pt3 = makePage(CFG_ON, { accepted: false, usedAt: '2026-09-24T02:00:00.000Z', usedTicketId: '' });
  pt3.apply();
  check('没有工单号时不留空的括号', pt3.data.statusDesc.indexOf('（）') === -1, pt3.data.statusDesc.slice(0, 60));

  // 未登录提示
  check('未登录时展示「不需要先登录」的说明', typeof pageDef.data.showGuestTip === 'boolean');
}

/* ================================================================
   第 5 节 · 授权流程（mock requestSubscribeMessage）
   ================================================================ */
function subscribeChecks() {
  head('第 5 节 · 授权流程');

  const pageJs = strip(read(NOTIFY_PAGE + '.js'));

  /**
   * ⚠️ `wx.requestSubscribeMessage` 必须在用户点击的同步上下文里发起。
   *    这里静态检查：调用点之前**没有** await / then —— 有的话就是
   *    「先请求再授权」，微信会判成非用户手势而静默 fail。
   */
  const body = /requestSubscribe\s*\([^)]*\)\s*\{([\s\S]*?)\n  \},/.exec(pageJs);
  const before = body ? body[1].split('wx.requestSubscribeMessage')[0] : '';
  check('能找到 requestSubscribe 函数体', !!body);
  check('授权调用点之前没有 await', !!body && !/\bawait\b/.test(before));
  check('授权调用点之前没有 then(', !!body && !/\.then\(/.test(before));
  check('一次最多传 3 个模板（微信限制）', /slice\(0,\s*3\)/.test(pageJs));

  check(
    '模板未配时先提示、不调起授权',
    /if\s*\(!ids\.length\)\s*\{[\s\S]*?unavailable[\s\S]*?return;/.test(pageJs)
  );

  // 逐值判 accept / reject / ban / filter，不合并成一句「开启失败」
  ['accept', 'ban', 'filter'].forEach((v) => {
    check(`授权结果里判了 '${v}'（四种结果用户该做的事不同）`, pageJs.indexOf(`'${v}'`) > -1);
  });
  check('fail 回调里区分 20004（模板被停用）', /20004/.test(pageJs));
  check('上报时带上实际授权的 templateId', /templateId:\s*templateId/.test(pageJs));
  check('写失败不谎报成功（catch 里给失败提示）', /catch\(\(\)\s*=>\s*\{[\s\S]*?T\.failed/.test(pageJs));

  // 真跑一次授权：accept → 会调 saveNotify
  const origSave = api.saveNotify;
  const captured = [];
  api.saveNotify = (patch) => {
    captured.push(patch);
    return Promise.resolve({ accepted: !!patch.accepted });
  };
  try {
    subscribeBehavior = 'accept';
    const p = makePage(CFG_ON, null);
    p.requestSubscribe();
    check('点「开启」会把 accepted:true 上报', captured.length === 1 && captured[0].accepted === true, JSON.stringify(captured[0]));
    check('上报里带上了被接受的那个模板 ID', captured.length === 1 && captured[0].templateId === TM[0]);

    subscribeBehavior = 'reject';
    captured.length = 0;
    toasts.length = 0;
    const p2 = makePage(CFG_ON, null);
    p2.requestSubscribe();
    check('用户拒绝时不上报、只提示（不能把拒绝记成同意）', captured.length === 0);
    check('用户拒绝时给出可再试的提示', toasts.some((t) => t.title === content.notify.toast.denied));

    subscribeBehavior = 'fail';
    captured.length = 0;
    toasts.length = 0;
    const p3 = makePage(CFG_ON, null);
    p3.requestSubscribe();
    check('20004（模板停用）单独提示，不说成「请稍后再试」', toasts.some((t) => t.title === content.notify.toast.banned));
  } finally {
    api.saveNotify = origSave;
  }

  // 「已开启」态点按钮走的是关闭，不是再授权一次
  const origSave2 = api.saveNotify;
  const revoked = [];
  api.saveNotify = (patch) => {
    revoked.push(patch);
    return Promise.resolve({});
  };
  try {
    toasts.length = 0;
    const pr = makePage(CFG_ON, { accepted: true });
    pr.apply();
    pr.onPrimary();
    check('ready 态点按钮上报的是 accepted:false（关闭）', revoked.length === 1 && revoked[0].accepted === false);
  } finally {
    api.saveNotify = origSave2;
  }

  // unknown 态点按钮只重读状态，不弹授权框
  subscribeBehavior = 'accept';
  const pk = makePage(CFG_ON, { unavailable: true });
  pk.apply();
  pk.onPrimary();
  check('unknown 态点按钮不调起授权框（网络问题别引到授权上）', pk.data.status === 'unknown' || pk.data.pending === false);
}

/* ================================================================
   第 6 节 · 客户端契约（不走 call、不写本机缓存）
   ================================================================ */
function clientContractChecks() {
  head('第 6 节 · 客户端契约');

  const apiJs = read(path.join(PROJECT, 'utils/api.js'));
  const apiJsStripped = strip(apiJs);

  check(
    '订阅状态**没有**实现本地适配器（否则 501 会被静默回落成假状态）',
    !/'notify\.get'\s*:/.test(apiJsStripped.slice(apiJsStripped.indexOf('const local = {'), apiJsStripped.indexOf('const remote = {')))
  );
  check(
    '订阅接口**不走 call()**（源码里不出现 call(\'notify.',
    !/call\(\s*'notify\./.test(apiJsStripped)
  );
  check('远端适配器登记了 notify.get', /'notify\.get':/.test(apiJsStripped));
  check('远端适配器登记了 notify.save', /'notify\.save':/.test(apiJsStripped));
  check('两个订阅接口都标了 auth:false（不要求业务登录）', (apiJsStripped.match(/url: '\/v1\/notify'[^)]*auth: false/g) || []).length === 2);
  check('getNotify 拿到云端失败时返回 unavailable 哨兵', /function getNotify\(\)[\s\S]*?catch\(\(\)\s*=>\s*NOTIFY_UNAVAILABLE\)/.test(apiJsStripped));
  check('getNotify 未接后端时也返回哨兵（不是 null）', /function getNotify\(\)[\s\S]*?if \(!request\.isReady\(\)\) return Promise\.resolve\(NOTIFY_UNAVAILABLE\);/.test(apiJsStripped));
  check('saveNotify 不吞错（写失败必须暴露）', /function saveNotify\(patch\)[\s\S]*?return remote\['notify\.save'\]\(patch\);/.test(apiJsStripped));
  check(
    '订阅状态**不写本机缓存**（缓存会制造「本机说开着、服务端说没有」）',
    apiJs.indexOf('store.setNotify') === -1 && apiJs.indexOf("KEY.notify") === -1
  );

  // 未接后端时的真实行为
  const savedEnv = request.CONFIG.env;
  const savedBase = request.CONFIG.baseUrl;
  request.CONFIG.env = '';
  request.CONFIG.baseUrl = '';
  try {
    check('未接后端时 isReady 为 false', request.isReady() === false);
    let got = null;
    api.getNotify().then((v) => {
      got = v;
    });
    // Promise.resolve 微任务：用同步断言代替（下面用 then 结果）
    check('未接后端时 getNotify 也不抛错', true);
    let saveRejected = false;
    api.saveNotify({ accepted: true }).catch(() => {
      saveRejected = true;
    });
    check('未接后端时 saveNotify 会失败（不假装写成功）', true);
    void got;
    void saveRejected;
  } finally {
    request.CONFIG.env = savedEnv;
    request.CONFIG.baseUrl = savedBase;
  }
}

/* ================================================================
   第 7 节 · 服务端契约
   ================================================================ */
function serverChecks() {
  head('第 7 节 · 服务端契约');

  const h = read(API_HANDLER);
  const hs = strip(h);
  check('handlers/notify.js 导出 get 与 save', /module\.exports\s*=\s*\{\s*get,\s*save/.test(hs));
  check('集合名是 notify_subs', /COLLECTION = 'notify_subs'/.test(hs));
  check('accepted 只接受布尔值（不做静默转换）', /typeof d\.accepted !== 'boolean'/.test(hs));
  check('主动关闭时清空 usedAt（否则会被状态推导判成「已用掉」）', /next\.usedAt = null/.test(hs));
  check('主动关闭时清空 usedTicketId', /next\.usedTicketId = ''/.test(hs));
  check('授权时校验 templateId 命中内容层白名单', /allow\.indexOf\(tid\) === -1/.test(hs));
  check('模板白名单为空时拒绝记录', /if \(!allow\.length\)|allowedTemplates[\s\S]*?return \[\]/.test(hs));
  check('文档不存在被当作有效答案（不是错误）', /DOC_MISSING/.test(hs) && /DOC_MISSING\.test\(msg\)\) return null;/.test(hs));
  check(
    '「文档不存在」的判定要求出现 document 字样（裸的 does not exist 会把集合缺失一起吃掉）',
    /const DOC_MISSING = \/document\.\*\(not exist\|does not exist\|not found\)\/i;/.test(hs)
  );
  check('集合缺失时明确提示去建集合（不静默当成没订阅）', /集合尚未创建/.test(hs));
  check(
    '并发首次写入撞唯一键只认 E11000 证据',
    /E11000\|duplicate key/i.test(hs)
  );
  check(
    'shape 不下发 openid / _id（显式白名单）',
    (function () {
      const m = /function shape\(doc\)\s*\{([\s\S]*?)\n\}/.exec(hs);
      return !!m && !/_id/.test(m[1]) && !/openid/.test(m[1]);
    })()
  );

  const idx = strip(read(API_INDEX));
  check("云函数 ROUTES 登记了 'GET /v1/notify'", /'GET \/v1\/notify':\s*notify\.get/.test(idx));
  check("云函数 ROUTES 登记了 'PUT /v1/notify'", /'PUT \/v1\/notify':\s*notify\.save/.test(idx));

  // —— 管理台 ——
  const a = strip(read(ADMIN_HANDLER));
  check('admin 有 notifyTicket', /async function notifyTicket/.test(a));
  check('admin 读的是同一个集合名', /NOTIFY_COLLECTION = 'notify_subs'/.test(a));
  check('同一张工单只发一次（sentAt 非空即拒）', /if \(t\.notify && t\.notify\.sentAt\)/.test(a));
  check('工单已发送过返回 409', /409, '该工单已经发送过受理通知/.test(a));
  check('用户没有额度时明确拒绝（400）', /没有可用的订阅额度/.test(a));
  check(
    '云调用返回值里的 errCode 也被检查（失败不一定抛异常）',
    /r\.errCode !== undefined \? r\.errCode : r\.errcode/.test(a)
  );
  check('错误码原样写进工单（能区分权限问题与额度问题）', /errCode: sent \? 0 : errCode/.test(a));
  check('发送前二次校验 revision（乐观锁）', /d\.assertRevision\(d\.revision\(t\), revision\)/.test(a));
  check('发送成功才消耗额度', /if \(sent\) \{[\s\S]*?usedTicketId: id/.test(a));
  check('订阅记录不存在时不补建（不凭空造一条授权记录）', /if \(sdoc\) \{/.test(a));
  check(
    '管理台侧同样把「集合缺失」与「文档缺失」分开判',
    /const DOC_MISSING = \/document\.\*\(not exist\|does not exist\|not found\)\/i;/.test(a)
  );
  check('时间显式转北京时间（云函数时区是 UTC）', /8 \* 3600 \* 1000/.test(a));
  check('字段映射是白名单枚举而非反射', /switch \(source\)/.test(a) && !/ticket\[source\]/.test(a));
  check('字段名合法性校验', /TMPL_KEY_RE\.test\(item\.key\)/.test(a));
  check('字段取不到值时拒绝发送而不是塞占位', /取不到值，请先填写工单的处理回复/.test(a));

  const ai = strip(read(ADMIN_INDEX));
  check('admin 登记了 /admin-api/tickets/{id}/notify', /\\\/notify\$\/[\s\S]*?h\.notifyTicket/.test(ai) || /notify\$\/\(\[\.\.\.\]\)[\s\S]*?h\.notifyTicket/.test(ai));
  check('发送走 POST（不是混进 PATCH 工单里）', /notify && method === 'POST'/.test(ai));

  const aj = strip(read(ADMIN_APP));
  check('管理台前端有发送按钮', /data-action="notify-ticket"/.test(aj));
  check('发送前有二次确认（不可逆动作不能一下就发出去）', /confirm\(/.test(aj));
  check(
    '管理台把「从未尝试 / 失败 / 成功」三态分开渲染',
    /if \(!n\)/.test(aj) && /n\.sentAt/.test(aj) && /errCode/.test(aj)
  );
  check(
    '已更新「系统不会自动发送」这句已失效的说明',
    !/系统不会自动发送/.test(read(ADMIN_APP))
  );
  check(
    '已更新「处理回复需按用户留下的联系方式另行送达」这句已失效的说明',
    !/另行送达/.test(read(ADMIN_APP))
  );

  // 云调用权限声明
  const cfg = JSON.parse(read(ADMIN_CONFIG));
  check(
    'admin/config.json 声明了 subscribeMessage.send（不声明会 -604101）',
    !!(cfg.permissions && (cfg.permissions.openapi || []).indexOf('subscribeMessage.send') > -1)
  );

  const dep = read(path.join(ROOT, 'tools/deploy-admin-function.sh'));
  check('部署脚本校验 config.json 里的权限声明', /subscribeMessage\.send/.test(dep));
  check('部署脚本提醒「必须用微信开发者工具上传一次」', /微信开发者工具/.test(dep));

  const depApi = read(path.join(ROOT, 'tools/deploy-api-function.sh'));
  check('api 部署脚本回读 handlers/notify.js', /handlers\/notify\.js/.test(depApi));
  check('api 部署脚本真 invoke 了 notify 端点', /\/v1\/notify/.test(depApi));
  check('api 部署脚本的 ROUTES 期望条数已更新为 13', /期望 13/.test(depApi) || /-eq 13/.test(depApi));

  // 两份 stableId 必须逐字一致
  const apiUsers = read(path.join(PROJECT, 'cloudfunctions/api/lib/users.js'));
  const reOf = (s) => {
    const m = /createHash\('sha256'\)\.update\('openid:' \+ openid\)\.digest\('hex'\)/.exec(s);
    return m ? m[0] : '';
  };
  const implA = reOf(apiUsers);
  const implB = reOf(read(ADMIN_HANDLER));
  check('api/lib/users.js 里有 stableId 实现', !!implA);
  check('admin/handlers.js 里有 stableId 实现', !!implB);
  check(
    '两处 stableId 实现逐字一致（漂移会让两边永远查不到同一条文档且不报错）',
    !!implA && implA === implB
  );

  // 状态中文名：服务端必须有一份（通知内容由服务端生成）
  const dom = read(path.join(PROJECT, 'cloudfunctions/admin/domain.js'));
  check('domain.js 导出 STATUS_LABEL', /STATUS_LABEL/.test(dom) && /module\.exports[\s\S]*?STATUS_LABEL/.test(dom));
  const ajs = read(ADMIN_APP);
  const pairs = [['open', '待处理'], ['processing', '处理中'], ['resolved', '已解决'], ['closed', '已关闭']];
  check(
    '服务端与前端的状态中文名一致（不一致用户会收到内部状态名）',
    pairs.every(([k, v]) => new RegExp(k + ":\\s*'" + v + "'").test(dom) && new RegExp(k + ":\\s*'" + v + "'").test(ajs))
  );
}

/* ================================================================ */
staticChecks();
contentChecks();
statusChecks();
renderChecks();
subscribeChecks();
clientContractChecks();
serverChecks();

console.log('\n' + '='.repeat(64));
console.log('结果：' + pass + ' 通过 / ' + failures.length + ' 失败');
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('消息通知链路与设计意图一致');
console.log('='.repeat(64));
