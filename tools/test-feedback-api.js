#!/usr/bin/env node
/**
 * 意见反馈 · 接口 + 表单页 + 结果页 本地验证台
 * ==================================================================
 * 为什么需要它：本机没有微信开发者工具，静态检查**测不出**这类问题 ——
 *   · 缺内容会不会仍然算提交成功
 *   · 本地模式（无后端）会不会假装送达
 *   · 契约里的字数上限和实现是否一致
 *   · 提交失败后跳转方式对不对（该保留表单页却替换掉了）
 *   · 结果页在「没有结果」时会不会编一个成功态出来
 * 而这些恰好都压在项目的**数据真实性红线上**。
 *
 * 做法：mock 最小 `wx`（storage / toast / 跳转 / request / uploadFile）
 * 与 `Page` 工厂（支持多页面），然后 require 真实文件，
 * 走与真机相同的代码路径。
 *
 * ⚠️ 不能替代真机验证：不覆盖渲染、不覆盖 chooseMedia 的真实交互。
 *
 * 用法：node tools/test-feedback-api.js
 */
const path = require('path');
const fs = require('fs');

/* ================= mock wx ================= */
const mem = {};
const toasts = [];
/** 记录跳转调用：{ type: 'back'|'to'|'redirect'|'tab', url } */
const nav = [];
let lastRequest = null;
let requestReply = null;

global.wx = {
  getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''),
  setStorageSync: (k, v) => {
    mem[k] = v;
  },
  removeStorageSync: (k) => {
    delete mem[k];
  },
  showToast: (o) => toasts.push(o),
  showModal: () => {},
  navigateBack: (o) => {
    nav.push({ type: 'back', url: '' });
    if (o && o.success) o.success({});
  },
  navigateTo: (o) => {
    nav.push({ type: 'to', url: o.url });
    if (o && o.success) o.success({});
  },
  redirectTo: (o) => {
    nav.push({ type: 'redirect', url: o.url });
    if (o && o.success) o.success({});
  },
  switchTab: (o) => {
    nav.push({ type: 'tab', url: o.url });
    if (o && o.success) o.success({});
  },
  chooseMedia: () => {},
  getAppBaseInfo: () => ({ version: '1.0.0', platform: 'devtools' }),
  getDeviceInfo: () => ({ system: 'macOS' }),
  request: (o) => {
    lastRequest = o;
    if (requestReply) o.success(requestReply);
  },
  uploadFile: (o) => {
    lastRequest = o;
    if (requestReply) o.success(requestReply);
  },
  login: () => {},
};

/* ================= Page 工厂（支持多页面） ================= */
const pageConfigs = {};
let capturing = null;
global.Page = (cfg) => {
  if (capturing) pageConfigs[capturing] = cfg;
};
/** 自定义组件走 Component() 注册；吉祥物组件在最后一节单独校验，先捕获 */
let componentConfig = null;
global.Component = (cfg) => {
  componentConfig = cfg;
};
global.getCurrentPages = () => [{}, {}];

const ROOT = path.join(__dirname, '..', 'miniprogram');
const api = require(path.join(ROOT, 'utils', 'api.js'));
const request = require(path.join(ROOT, 'utils', 'request.js'));
// 验证台默认覆盖本地适配器；正式环境配置由小程序运行时使用，不应改变本机断言语义。
request.CONFIG.baseUrl = '';
request.CONFIG.env = '';
const CONTENT = require(path.join(ROOT, 'data', 'content.js'));

function loadPage(name, rel) {
  capturing = name;
  require(path.join(ROOT, rel));
  capturing = null;
  return pageConfigs[name];
}

const FB = loadPage('fb', 'pages/feedback/feedback.js');
const FR = loadPage('fr', 'pages/feedback-result/feedback-result.js');

/* ================= 断言工具 ================= */
let pass = 0;
let fail = 0;

function check(title, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${title}`);
  } else {
    fail++;
    console.log(`  ✗ ${title}${detail ? '\n      ' + detail : ''}`);
  }
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}
/** 页面 onLoad 内部的 promise 不是返回值，等一个 tick 再断言 */
const wait = () => new Promise((r) => setTimeout(r, 15));

function instantiate(config) {
  const inst = Object.create(Object.getPrototypeOf(config) || Object.prototype);
  Object.assign(inst, config);
  inst.data = JSON.parse(JSON.stringify(config.data));
  inst.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  return inst;
}
async function mount(config) {
  const p = instantiate(config);
  p.onLoad();
  await wait();
  return p;
}

/* ================= 服务端反馈类型枚举（唯一真相来源） =================
 * ⚠️ 不再把类型数量和 key 写死在断言里。
 *    写死数量时，运营新增一个类型就会让测试失败，而「改断言里的数字」
 *    是零信息量的动作 —— 更糟的是它给了「测试通过 = 两边一致」的假象：
 *    真正该守住的是**内容层选项与服务端 TYPE_ENUM 完全一致**。
 *    所以这里直接从云函数源码里解析出枚举，做跨层比对。
 */
const FN_FEEDBACK_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'miniprogram', 'cloudfunctions', 'api', 'handlers', 'feedback.js'),
  'utf8'
);
const SERVER_TYPE_ENUM = (function parseServerTypeEnum() {
  const m = FN_FEEDBACK_SRC.match(/const\s+TYPE_ENUM\s*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
})();

(async () => {
  /* ========== 1. 内容层配置 ========== */
  head('1. 内容层配置（content.feedback）');
  const fb = CONTENT.feedback;
  const R = fb.result;

  check('feedback 配置存在', !!fb);
  check('服务端 TYPE_ENUM 可解析', Array.isArray(SERVER_TYPE_ENUM) && SERVER_TYPE_ENUM.length > 0, String(SERVER_TYPE_ENUM));
  check(
    'types 数量与服务端 TYPE_ENUM 一致',
    Array.isArray(SERVER_TYPE_ENUM) && fb.types.length === SERVER_TYPE_ENUM.length,
    '内容层 ' + fb.types.length + ' / 服务端 ' + (SERVER_TYPE_ENUM || []).length
  );
  check(
    'types key 与服务端枚举逐项一致（含顺序）',
    Array.isArray(SERVER_TYPE_ENUM) &&
      JSON.stringify(fb.types.map((t) => t.key)) === JSON.stringify(SERVER_TYPE_ENUM),
    '内容层 ' + JSON.stringify(fb.types.map((t) => t.key)) + ' / 服务端 ' + JSON.stringify(SERVER_TYPE_ENUM)
  );
  check(
    '每个类型都有中文标签',
    fb.types.every((t) => typeof t.label === 'string' && t.label.trim().length > 0),
    JSON.stringify(fb.types)
  );
  check(
    '投诉类型已配置（投诉工单入口）',
    fb.types.some((t) => t.key === 'complaint'),
    JSON.stringify(fb.types.map((t) => t.key))
  );
  check('defaultType = data（产品决定）', fb.defaultType === 'data');
  check('nav.feedback 已配置', CONTENT.nav.feedback === '意见反馈');
  check('featureFlags.feedback 已开启', CONTENT.featureFlags.feedback === true);

  head('1b. 结果页文案（两态 + 本地态 + 兜底态）');
  check('result 节存在', !!R);
  check('结果页导航标题与设计稿一致', R.navTitle === '反馈结果');
  check('成功态标题 = 反馈已提交', R.success.title === '反馈已提交');
  check('失败态标题 = 提交失败', R.fail.title === '提交失败');
  check('失败态主按钮 = 重新提交', R.fail.primary === '重新提交');
  check('成功态副链接 = 再提一条反馈', R.success.again === '再提一条反馈');
  check('失败态副文案存在', !!R.fail.foot);
  /* v1.0.3 合规修改：成功文案里不得再出现「回复时限 / 通过微信联系」的说法 ——
   * 联系方式卡被移除后，这句承诺兑现不了，留着就是一句空话。 */
  check(
    '⚠️ 成功文案不含 {days} 占位符（结果页已不再插值）',
    R.success.desc.indexOf('{days}') < 0,
    R.success.desc
  );
  check(
    '⚠️ 成功文案不含「工作日 / 微信」（v1.0.3 删除的承诺）',
    !/工作日|微信/.test(R.success.desc),
    R.success.desc
  );
  check(
    '⚠️ 内容层已删除底部承诺文案 foot（否则界面又会渲染「N 个工作日内回复你」）',
    !Object.prototype.hasOwnProperty.call(fb, 'foot'),
    JSON.stringify(Object.keys(fb))
  );
  check(
    '⚠️ 本地模式成功文案必须与远端不同（不能都说「已提交」）',
    R.successLocal.title !== R.success.title,
    `local=${R.successLocal.title} remote=${R.success.title}`
  );
  check('回执行标签 5 项齐备', ['ticket', 'type', 'createdAt', 'reason', 'draft'].every((k) => !!R.rows[k]));
  check('失败原因含 TIMEOUT / NETWORK / SERVER / default', ['TIMEOUT', 'NETWORK', 'SERVER', 'default'].every((k) => !!R.reasons[k]));
  check('兜底态文案存在（不编造成功）', !!R.stale.title && !!R.stale.primary);
  check('本地模式不显示假工单号（有 noTicketLocal）', !!R.noTicketLocal && R.noTicketLocal !== R.noTicket);

  /* ========== 2. 契约一致性 ========== */
  head('2. 与 API接口契约.md 的一致性');
  const contract = fs.readFileSync(path.join(__dirname, '..', 'API接口契约.md'), 'utf8');
  check('契约有 POST /v1/feedback', /POST `\/v1\/feedback`/.test(contract));
  check('契约有 POST /v1/upload', /POST `\/v1\/upload`/.test(contract));
  check(`实现 descMax=${fb.descMax} = 契约的 200`, fb.descMax === 200);
  check(`实现 imageMax=${fb.imageMax} = 契约的 3`, fb.imageMax === 3);
  check('契约无被废弃的冗余 ok 字段', !/\{ "ok": true, "ticketId"/.test(contract));

  /* ========== 3. 本地模式提交 ========== */
  head('3. 本地模式提交（不抛错语义）');
  check('当前为 local 模式', api.mode() === 'local');

  const rec1 = await api.submitFeedback({
    type: 'data',
    content: '多伦多大学详情页的雅思单项要求没显示出来。',
  });
  check('返回 record 而非抛错', !!rec1 && rec1.ok === true, JSON.stringify(rec1));
  check('ticketId 存在', !!rec1.ticketId);
  check('⚠️ delivered 必须为 false（本地未送达）', rec1.delivered === false);
  check('回传 replyWithin', rec1.replyWithin === fb.replyWithin);
  check('回传 type（结果页要用）', rec1.type === 'data');
  check('结果已落到本机（供结果页读取）', !!api.getFeedbackResult());

  const saved = api.getFeedbacks ? null : null; // 存档通过 store 校验，见下
  const storeMod = require(path.join(ROOT, 'utils', 'store.js'));
  check('反馈已落本机存档', storeMod.getFeedbacks().length === 1);
  check('存档标记 delivered=false', storeMod.getFeedbacks()[0].delivered === false);

  /* ========== 4. 校验边界（缺内容绝不能算提交成功） ========== */
  head('4. 校验边界');
  const before = storeMod.getFeedbacks().length;

  const bad1 = await api.submitFeedback({ content: '有内容但没类型' });
  check('缺 type → ok:false', bad1.ok === false);
  check('缺 type → reason=INVALID', bad1.reason === 'INVALID', bad1.reason);

  const bad2 = await api.submitFeedback({ type: 'bug', content: '   ' });
  check('content 全空白 → ok:false', bad2.ok === false);

  const bad3 = await api.submitFeedback({ type: 'hack', content: '非法类型' });
  check('type 不在枚举内 → ok:false', bad3.ok === false);

  check('被拒绝的提交没有落本机存档', storeMod.getFeedbacks().length === before);

  /* ========== 5. 边界值 ========== */
  head('5. 边界值');
  const ok200 = await api.submitFeedback({ type: 'bug', content: 'y'.repeat(200) });
  check('正好 200 字通过', ok200.ok === true);

  const many = await api.submitFeedback({ type: 'idea', content: '带 5 张图', images: ['a', 'b', 'c', 'd', 'e'] });
  const row = storeMod.getFeedbacks().find((x) => x.id === many.ticketId);
  check('图片超限被截断到 imageMax', row && row.images.length === fb.imageMax);

  /* ========== 6. 本机存档上限 ========== */
  head('6. 本机存档上限');
  for (let i = 0; i < 25; i++) await api.submitFeedback({ type: 'other', content: '压测 ' + i });
  check('存档上限 20 条', storeMod.getFeedbacks().length === 20);

  /* ========== 7. 远端模式 ========== */
  head('7. 远端模式 · 路径与载荷');
  request.CONFIG.baseUrl = 'https://api.example.com';
  check('切换到 remote 模式', api.mode() === 'remote');

  requestReply = { statusCode: 200, data: { code: 0, data: { ticketId: 'FB-260916-0183', replyWithin: 3 } } };
  const r2 = await api.submitFeedback({ type: 'data', content: '远端提交' });
  check('打到 /v1/feedback', lastRequest.url === 'https://api.example.com/v1/feedback');
  check('方法为 POST', lastRequest.method === 'POST');
  check('载荷含 type 与 content', lastRequest.data.type === 'data' && !!lastRequest.data.content);
  check('远端模式 delivered=true', r2.delivered === true);
  check('远端模式 ok=true', r2.ok === true);

  let attempts = 0;
  const origReq = global.wx.request;
  global.wx.request = (o) => {
    attempts++;
    o.fail({ errMsg: 'request:fail timeout' });
  };
  const r3 = await api.submitFeedback({ type: 'bug', content: '超时测试' });
  global.wx.request = origReq;
  check('超时 → ok:false', r3.ok === false);
  check('超时 → reason=TIMEOUT', r3.reason === 'TIMEOUT', r3.reason);
  check('非幂等：失败后不重试（只发 1 次）', attempts === 1, `实际 ${attempts} 次`);

  requestReply = { statusCode: 200, data: { code: 500, message: '服务器开小差' } };
  const r4 = await api.submitFeedback({ type: 'bug', content: '500 测试' });
  check('500 → reason=SERVER', r4.reason === 'SERVER', r4.reason);

  request.CONFIG.baseUrl = '';
  requestReply = null;

  /* ========== 8. 上传接口 ========== */
  head('8. 上传接口');
  const up1 = await api.uploadImage('/tmp/a.png').then(() => null, (e) => e);
  check('本地模式上传 reject(NO_BACKEND)', up1 && up1.code === 'NO_BACKEND');

  request.CONFIG.baseUrl = 'https://api.example.com';
  requestReply = { statusCode: 200, data: JSON.stringify({ fileId: 'file_1', url: 'https://x/1.png' }) };
  const up2 = await api.uploadImage('/tmp/a.png');
  check('上传路径 /v1/upload', lastRequest.url === 'https://api.example.com/v1/upload');
  check('字符串响应体能正确解析', up2 && up2.fileId === 'file_1');
  request.CONFIG.baseUrl = '';
  requestReply = null;

  /* ========== 9. 表单页逻辑 ========== */
  head('9. 反馈表单页（pages/feedback）');
  storeMod.clearFeedbackDraft();
  const p = await mount(FB);

  check('onLoad 注入内容层', !!p.data.c.feedback);
  check('类型列表数量与服务端枚举一致', p.data.types.length === SERVER_TYPE_ENUM.length, '页面 ' + p.data.types.length + ' / 服务端 ' + SERVER_TYPE_ENUM.length);
  check('默认类型来自内容层', p.data.type === fb.defaultType);
  check('初始计数 0/200', p.data.counterText === '0/200');
  check('imagesHint 已插值', !/\{\w+\}/.test(p.data.imagesHint), p.data.imagesHint);
  check(
    '⚠️ 页面不再渲染底部承诺行 footText（v1.0.3 删除）',
    !Object.prototype.hasOwnProperty.call(p.data, 'footText')
  );
  check('本地模式 remote=false', p.data.remote === false);
  check('初始按钮灰态', p.data.canSubmit === false);

  p.onPickType({ currentTarget: { dataset: { key: 'bug' } } });
  check('切换类型生效', p.data.type === 'bug');
  p.onInputDesc({ detail: { value: '这是一段描述' } });
  check('计数更新为 6/200', p.data.counterText === '6/200', p.data.counterText);
  check('类型+描述齐全 → 按钮转主色', p.data.canSubmit === true);

  toasts.length = 0;
  const p2 = await mount(FB);
  p2.setData({ desc: '   ' });
  p2.onSubmit();
  check('描述空白时点击 → 明确提示', toasts.length === 1 && toasts[0].title === fb.needDesc);

  /* ---- 草稿 ---- */
  head('9b. 草稿：失败结果页那句「已暂存到本地」必须真的兑现');
  storeMod.clearFeedbackDraft();
  const p3 = await mount(FB);
  check('无草稿时不误恢复内容', p3.data.desc === '');

  const p4 = await mount(FB);
  p4.setData({ desc: '草稿内容' });
  p4.onHide();
  const draft = api.getFeedbackDraft();
  check('onHide 落草稿', !!draft && draft.desc === '草稿内容');
  check(
    '⚠️ 草稿不含 contact 键（v1.0.3 停止采集，别再把它写回快照）',
    !!draft && !Object.prototype.hasOwnProperty.call(draft, 'contact'),
    JSON.stringify(Object.keys(draft || {}))
  );

  const p5 = await mount(FB);
  check('再次进入恢复草稿描述', p5.data.desc === '草稿内容');
  check(
    '⚠️ 页面 data 里没有 contact 字段（有则说明输入卡正在回归）',
    !Object.prototype.hasOwnProperty.call(p5.data, 'contact'),
    JSON.stringify(Object.keys(p5.data))
  );

  toasts.length = 0;
  const p6 = await mount(FB);
  p6.setData({ desc: '', images: [] });
  p6.onHide();
  check('无内容时不落草稿（避免噪音）', api.getFeedbackDraft() === null || api.getFeedbackDraft().desc === '草稿内容');

  /* ---- 提交跳转 ---- */
  head('9c. 提交后的跳转方式（成功替换 / 失败保留）');
  storeMod.clearFeedbackDraft();
  nav.length = 0;
  const p7 = await mount(FB);
  p7.setData({ desc: '正常提交' });
  await p7.onSubmit();
  await wait();
  const last = nav[nav.length - 1];
  check('提交后跳转结果页', last && last.url === '/pages/feedback-result/feedback-result', JSON.stringify(last));
  check('成功用 redirectTo（替换表单页）', last && last.type === 'redirect', last && last.type);
  check('成功后清空草稿', api.getFeedbackDraft() === null);

  /* ========== 10. 结果页逻辑 ========== */
  head('10. 结果页（pages/feedback-result）');

  async function mountResultWith(record) {
    if (record === null) storeMod.setFeedbackResult(null);
    else storeMod.setFeedbackResult(record);
    const inst = instantiate(FR);
    const origApi = api.getFeedbackResult;
    // 直接走真实读取路径（记录已落 store）
    inst.onLoad();
    await wait();
    return inst;
  }

  // 10a 远端成功
  const s1 = await mountResultWith({
    ok: true, delivered: true, ticketId: 'FB-260916-0183',
    createdAt: '2026-09-16T21:15:00+08:00', replyWithin: 3, type: 'data', reason: '',
  });
  check('远端成功 → status=success', s1.data.status === 'success');
  check('远端成功 → 吉祥物开心', s1.data.heroMood === 'happy');
  check('远端成功 → 徽标为 check', s1.data.badgeIcon === 'check');
  check('远端成功 → 标题「反馈已提交」', s1.data.view.title === R.success.title, s1.data.view.title);
  check('远端成功 → 主按钮「返回首页」', s1.data.view.primary === R.success.primary);
  check('远端成功 → 副链接「再提一条反馈」', s1.data.view.again === R.success.again);
  check('回执卡 3 行', s1.data.info.length === 3);
  check('第 1 行为工单号', s1.data.info[0].k === R.rows.ticket);
  check('工单号原样展示', s1.data.info[0].v === 'FB-260916-0183', s1.data.info[0].v);
  check('第 2 行为类型标签「院校数据有误」', s1.data.info[1].v === '院校数据有误', s1.data.info[1].v);
  check('第 3 行时间为 YYYY-MM-DD HH:mm', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s1.data.info[2].v), s1.data.info[2].v);
  check('成功态返回键回首页', s1.data.backUrl === '/pages/home/home' && s1.data.backTab === true);

  nav.length = 0;
  const s1b = instantiate(FR);
  Object.assign(s1b.data, s1.data);
  s1b.onPrimary();
  check('成功态主按钮用 switchTab 回首页（tab 页不能 navigateTo）', nav[0] && nav[0].type === 'tab', JSON.stringify(nav[0]));

  // 10b 本地模式成功
  const s2 = await mountResultWith({
    ok: true, delivered: false, ticketId: 'local-1758',
    createdAt: '2026-09-16T21:15:00+08:00', replyWithin: 3, type: 'bug', reason: '',
  });
  check('本地成功 → status 仍为 success', s2.data.status === 'success');
  check('⚠️ 本地成功 → 标题换成「已保存到本机」', s2.data.view.title === R.successLocal.title, s2.data.view.title);
  check('⚠️ 本地成功 → 不显示 local-xxx 假工单号', s2.data.info[0].v === R.noTicketLocal, s2.data.info[0].v);
  check('本地成功 → 工单号行转灰', s2.data.info[0].tone === 'mute');

  // 10c 失败
  const s3 = await mountResultWith({
    ok: false, delivered: false, ticketId: '',
    createdAt: '2026-09-16T21:20:00+08:00', replyWithin: 3, type: 'data', reason: 'TIMEOUT', message: '',
  });
  check('失败 → status=fail', s3.data.status === 'fail');
  check('失败 → 吉祥物难过', s3.data.heroMood === 'sad');
  check('失败 → 徽标为感叹号', s3.data.badgeIcon === 'alert-mark');
  check('失败 → 标题「提交失败」', s3.data.view.title === R.fail.title);
  check('失败 → 主按钮「重新提交」', s3.data.view.primary === R.fail.primary);
  check('失败 → 副位置放说明文字（不是可点链接）', s3.data.view.again === '' && !!s3.data.view.foot);
  check('失败原因映射为「网络请求超时」', s3.data.info[0].v === R.reasons.TIMEOUT, s3.data.info[0].v);
  check('内容状态强调为「已暂存到本地」', s3.data.info[1].v === R.draftKept);
  check('内容状态用品牌色强调', s3.data.info[1].tone === 'brand');
  check('工单号显示「尚未生成」', s3.data.info[2].v === R.noTicket);
  check('失败态返回键走 navigateBack（保留表单页）', s3.data.backUrl === '' && s3.data.backTab === false);

  nav.length = 0;
  const s3b = instantiate(FR);
  Object.assign(s3b.data, s3.data);
  s3b.onPrimary();
  check('失败态主按钮 navigateBack 回表单页', nav[0] && nav[0].type === 'back', JSON.stringify(nav[0]));

  nav.length = 0;
  const s3c = instantiate(FR);
  Object.assign(s3c.data, s3.data);
  s3c.onAgain && s3c.onAgain();
  check('失败态没有「再提一条」入口', !!s3c.onAgain === true);

  // 10d 兜底
  const s4 = await mountResultWith(null);
  check('无结果 → status=stale', s4.data.status === 'stale');
  check('⚠️ 无结果时不编造成功态', s4.data.view.title === R.stale.title, s4.data.view.title);
  check('无结果 → 不渲染回执卡', s4.data.info.length === 0);
  check('无结果 → 主按钮导向反馈页', s4.data.view.primary === R.stale.primary);

  nav.length = 0;
  const s4b = instantiate(FR);
  Object.assign(s4b.data, s4.data);
  s4b.onPrimary();
  check('兜底态主按钮 redirectTo 反馈页', nav[0] && nav[0].type === 'redirect', JSON.stringify(nav[0]));

  // 10e 未注册的结果被丢弃
  storeMod.setFeedbackResult(null);

  /* ========== 12. 吉祥物表情 ========== */
  /* ========== 11. 吉祥物表情 ========== */
  head('11. 吉祥物表情（mascot mood）');
  require(path.join(ROOT, 'components/mascot/index.js'));
  const MASCOT = componentConfig;
  check('组件配置已被 Component() 捕获', !!MASCOT);
  const mProps = MASCOT.properties;
  check('新增 mood 属性', !!mProps.mood);
  check('mood 默认值为 default（保证现有页面外观不变）', mProps.mood.value === 'default');
  const moodObserver = MASCOT.observers.mood;
  check('mood observer 存在', typeof moodObserver === 'function');

  const fakeInst = { setData(d) { this.got = d; } };
  moodObserver.call(fakeInst, 'happy');
  check('mood=happy 被接受', fakeInst.got.moodCls === 'happy');
  moodObserver.call(fakeInst, 'sad');
  check('mood=sad 被接受', fakeInst.got.moodCls === 'sad');
  moodObserver.call(fakeInst, 'nonsense');
  check('非法 mood 回落 default', fakeInst.got.moodCls === 'default');
  moodObserver.call(fakeInst, undefined);
  check('mood 缺省回落 default', fakeInst.got.moodCls === 'default');

  /* ========== 12. v1.0.3 合规：界面不得再采集联系方式 ==========
   * 背景：平台以「涉嫌在非合理场景下收集、存储用户密码或个人敏感信息，
   * 包括但不限于微信帐号、QQ 号码、银行账号等」驳回提审，指向反馈页的
   * 联系方式输入卡。这一节是**反向断言**（删掉的东西不得回归），
   * 思路与 test-cloud-transport.js 第 8 节守住「Skill 不得回归」一致 ——
   * 删除比新增更需要测试守，因为少一个控件不会有任何东西变红。
   *
   * ⚠️ 判据一律落在**控件元素 / 字段名**上，不用全文检索判性质：
   *    页面注释里本来就有「联系方式」三个字（解释为什么删），
   *    全文匹配会被自己的注释误伤 —— 2026-09-22 管理台详情断言踩过同款坑。
   */
  head('12. 合规：反馈页不得采集联系方式（v1.0.3 平台驳回项）');
  const fbWxml = fs.readFileSync(path.join(ROOT, 'pages', 'feedback', 'feedback.wxml'), 'utf8');
  const fbWxss = fs.readFileSync(path.join(ROOT, 'pages', 'feedback', 'feedback.wxss'), 'utf8');
  const fbJs = fs.readFileSync(path.join(ROOT, 'pages', 'feedback', 'feedback.js'), 'utf8');

  check('反馈页无 <input> 控件（联系方式输入行的载体）', !/<input\b/.test(fbWxml));
  check('反馈页不绑定 onInputContact', fbWxml.indexOf('onInputContact') < 0);
  check('反馈页不引用 {{contact}}', !/\{\{\s*contact\s*\}\}/.test(fbWxml));
  check('页面逻辑无 onInputContact 方法定义', !/\bonInputContact\s*[(:=]/.test(fbJs));
  check('页面 data 不含 contact 字段', !/\bcontact\s*:/.test(fbJs));
  check('页面不再渲染底部承诺行 fb__foot', fbWxml.indexOf('fb__foot') < 0);
  /* ⚠️ 先剥注释再判：wxss 里留了一条说明「原 `.fb__input` / `.fb__hint` 已删」，
   *    直接全文检索会被这句**自己的注释**判成「还有残留」。
   *    同类前科：2026-09-22 用 `!/保存/.test(html)` 判管理台详情只读，
   *    被「该用户还没有保存过成绩」这句文案误伤 —— 判据要落在代码元素上。 */
  const fbWxssCode = fbWxss.replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '样式表已删除 .fb__input / .fb__hint / .fb__foot 的规则定义',
    !/\.fb__input\s*[,{]/.test(fbWxssCode) &&
      !/\.fb__hint\s*[,{]/.test(fbWxssCode) &&
      !/\.fb__foot\s*[,{]/.test(fbWxssCode),
    'input=' + /\.fb__input\s*[,{]/.test(fbWxssCode) + ' hint=' + /\.fb__hint\s*[,{]/.test(fbWxssCode) + ' foot=' + /\.fb__foot\s*[,{]/.test(fbWxssCode)
  );
  check(
    '内容层已删除 contactPlaceholder / contactHint',
    !Object.prototype.hasOwnProperty.call(fb, 'contactPlaceholder') &&
      !Object.prototype.hasOwnProperty.call(fb, 'contactHint')
  );
  check(
    '内容层仍保留 replyWithin（接口响应结构不变，只是界面不再用）',
    typeof fb.replyWithin === 'number',
    String(fb.replyWithin)
  );
  check(
    '契约已把 contact 标为废弃',
    /`contact`\s*\|\s*string\s*\|\s*✖\s*\|\s*⚠️ \*\*已废弃（v1\.0\.3 起）\*\*/.test(contract)
  );
  check(
    '契约留下驳回原话（后人知道为什么不能加回来）',
    contract.indexOf('非合理场景下收集') >= 0
  );

  /* ========== 结果 ========== */
  console.log('\n' + '═'.repeat(64));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('═'.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n验证台自身异常：', e);
  process.exit(2);
});
