#!/usr/bin/env node
/**
 * 云开发传输层 · 本地验证台
 * ==================================================================
 * 为什么需要它 —— 本机没有微信开发者工具，而这次改动全部落在
 * **真机上才跑得到**的路径上，静态检查一条都测不出来：
 *
 *   · 云开发模式下 callFunction 到底收到了什么（路径？方法？参数？）
 *   · 云函数返回 501（该端点还没实现）时，页面会看到报错还是本地兜底
 *   · 云函数忘记 return 时，客户端会不会把空响应当成功
 *   · 登录态过期在 cloud 路线下能不能触发重新登录
 *   · 启动恢复会话会不会因为「云开发没有 token」而永远判定未登录
 *   · 上传截图走的是云存储还是老路径
 *
 * 做法：mock 最小 `wx`（storage / cloud.callFunction / cloud.uploadFile /
 * request），require 真实文件，走与真机相同的代码路径。
 *
 * ⚠️ 不能替代真机验证：不覆盖渲染，也不覆盖云函数真实执行。
 *    云函数侧只做**静态**断言（不 require wx-server-sdk，本机没装）。
 *
 * 用法：node tools/test-cloud-transport.js
 */
const path = require('path');
const fs = require('fs');

/* ================= mock wx ================= */
const mem = {};
/** 云函数响应处理器：(payload) => result；返回 { __fail: '…' } 模拟调用失败 */
let cloudHandler = null;
let lastCloudCall = null;
let cloudInitArgs = null;
let lastUpload = null;
let lastRequestArgs = null;
let requestReply = null;

global.wx = {
  getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''),
  setStorageSync: (k, v) => {
    mem[k] = v;
  },
  removeStorageSync: (k) => {
    delete mem[k];
  },
  showToast: () => {},
  navigateTo: () => {},
  cloud: {
    init: (o) => {
      cloudInitArgs = o;
    },
    callFunction: (o) => {
      lastCloudCall = o;
      setTimeout(() => {
        if (typeof cloudHandler !== 'function') {
          return o.fail({ errMsg: 'cloud.callFunction:fail no handler' });
        }
        const r = cloudHandler(o.data);
        if (r && r.__fail) o.fail({ errMsg: r.errMsg || r.__fail });
        else o.success({ result: r });
      }, 0);
    },
    uploadFile: (o) => {
      lastUpload = o;
      setTimeout(() => o.success({ fileID: 'cloud://test.env/feedback/abc.png' }), 0);
    },
  },
  request: (o) => {
    lastRequestArgs = o;
    setTimeout(() => {
      if (requestReply) o.success(requestReply);
      else o.fail({ errMsg: 'request:fail mock' });
    }, 0);
  },
  uploadFile: (o) => {
    lastUpload = o;
    setTimeout(() => {
      if (requestReply) o.success(requestReply);
      else o.fail({ errMsg: 'request:fail mock' });
    }, 0);
  },
  login: () => {},
  getAppBaseInfo: () => ({ version: '1.0.0', platform: 'devtools' }),
  getDeviceInfo: () => ({ system: 'macOS' }),
};

const ROOT = path.join(__dirname, '..', 'miniprogram');
const request = require(path.join(ROOT, 'utils', 'request.js'));
const api = require(path.join(ROOT, 'utils', 'api.js'));

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
const tick = () => new Promise((r) => setTimeout(r, 10));

/** 把传输层切到指定模式 */
function useCloud() {
  request.CONFIG.baseUrl = '';
  request.CONFIG.env = 'cloud1-testenv';
}
function useRest() {
  request.CONFIG.env = '';
  request.CONFIG.baseUrl = 'https://api.test.dev';
}
function useNone() {
  request.CONFIG.env = '';
  request.CONFIG.baseUrl = '';
}
/** 云函数返回一份契约 2.4 响应 */
function reply(body) {
  cloudHandler = () => body;
}

(async function main() {
  /* ============================================================
     1 · 传输层判定
     ============================================================ */
  head('1 · 传输层判定（rest / cloud / none 的优先级）');

  useNone();
  check('两者皆空 → none', request.transport() === 'none', '实际 ' + request.transport());
  check('两者皆空 → isReady() 为 false', request.isReady() === false);
  check('none 模式下请求直接 reject NO_BACKEND', await (async () => {
    try {
      await request({ url: '/v1/x' });
      return false;
    } catch (e) {
      return e.code === 'NO_BACKEND';
    }
  })());

  useCloud();
  check('只填 env → cloud', request.transport() === 'cloud', '实际 ' + request.transport());
  check('只填 env → isReady() 为 true', request.isReady() === true);

  useRest();
  check('只填 baseUrl → rest', request.transport() === 'rest', '实际 ' + request.transport());

  request.CONFIG.env = 'cloud1-testenv';
  check(
    '两者同填 → rest 优先（且这是文档化的约定，不是巧合）',
    request.transport() === 'rest',
    '实际 ' + request.transport()
  );

  /* ============================================================
     2 · cloud 请求封包
     ============================================================ */
  head('2 · cloud 模式下的请求封包');

  useCloud();
  lastCloudCall = null;
  reply({ code: 0, message: '', data: { ok: 1 } });
  const r2 = await request({ url: '/v1/feedback', method: 'POST', data: { content: 'x' } });

  check('调用的是聚合云函数 api', lastCloudCall && lastCloudCall.name === 'api', '实际 ' + (lastCloudCall && lastCloudCall.name));
  check('payload 带 REST 路径', lastCloudCall.data.path === '/v1/feedback', JSON.stringify(lastCloudCall.data));
  check('payload 带方法', lastCloudCall.data.method === 'POST');
  check('payload 原样透传业务数据', JSON.stringify(lastCloudCall.data.data) === '{"content":"x"}');
  check('code:0 时 resolve 出 data 本体', JSON.stringify(r2) === '{"ok":1}', JSON.stringify(r2));

  /* ============================================================
     3 · 统一响应归一化（rest 与 cloud 必须一致）
     ============================================================ */
  head('3 · 统一响应归一化');

  useCloud();
  reply({ code: 501, message: '该接口尚未在云端实现', data: null });
  let e501 = null;
  try {
    await request({ url: '/v1/favorites', method: 'GET' });
  } catch (e) {
    e501 = e;
  }
  check('501 被还原成 code 501 的错误', e501 && e501.code === 501, e501 && String(e501.code));
  check('501 的错误信息可直接展示', !!(e501 && /尚未/.test(e501.message)), e501 && e501.message);

  useCloud();
  reply({ code: 400, message: '问题描述请控制在 200 字以内', data: null });
  let e400 = null;
  try {
    await request({ url: '/v1/feedback', method: 'POST', data: {}, idempotent: false });
  } catch (e) {
    e400 = e;
  }
  check('400 保留服务端下发的中文 message', e400 && e400.message.indexOf('200') > -1, e400 && e400.message);

  useCloud();
  mem['sp_token'] = 'tk';
  request.setToken('tk');
  let e401 = null;
  let unauthorizedFired = false;
  request.setUnauthorizedHandler(() => {
    unauthorizedFired = true;
  });
  reply({ code: 401, message: '', data: null });
  try {
    await request({ url: '/v1/user/profile', method: 'GET' });
  } catch (e) {
    e401 = e;
  }
  check('401 被识别（不是笼统的「请求失败」）', e401 && e401.code === 401, e401 && String(e401.code));
  check('401 触发登出回调（云开发路线同样要能重新登录）', unauthorizedFired === true);
  check('401 清空了本地登录态', request.getToken() === '', '实际 ' + JSON.stringify(request.getToken()));

  useCloud();
  cloudHandler = () => undefined; // 云函数忘记 return
  let eEmpty = null;
  try {
    await request({ url: '/v1/content', method: 'GET' });
  } catch (e) {
    eEmpty = e;
  }
  check(
    '云函数返回空结果时如实报错，**不伪装成成功**（数据真实性红线）',
    eEmpty && eEmpty.code === 500,
    eEmpty ? String(eEmpty.code) : '居然成功了'
  );

  useCloud();
  cloudHandler = () => ({ __fail: 'cloud.callFunction:fail Error: errCode: -504002' });
  let eFn = null;
  try {
    await request({ url: '/v1/content', method: 'GET' });
  } catch (e) {
    eFn = e;
  }
  check('云函数未部署/执行失败时给出服务端语义的提示', eFn && eFn.code === 500, eFn && String(eFn.code));
  check(
    '该提示不是「请检查网络」（避免把用户带偏到错误方向）',
    eFn && eFn.message.indexOf('网络') === -1,
    eFn && eFn.message
  );

  /* ============================================================
     4 · 501 回落本地（渐进式接入的关键约定）
     ============================================================ */
  head('4 · 未实现端点的回落行为');

  useCloud();
  reply({ code: 501, message: '该接口尚未在云端实现', data: null });
  let fellBack = null;
  try {
    fellBack = await api.getFavorites();
  } catch (e) {
    fellBack = 'THREW:' + e.code;
  }
  check(
    '未实现的只读接口静默回落到本地实现（不把功能变成报错）',
    Array.isArray(fellBack),
    JSON.stringify(fellBack)
  );

  reply({ code: 501, message: '该接口尚未在云端实现', data: null });
  const stats = await api.getStats().catch((e) => 'THREW:' + e.code);
  check(
    '回落后的返回值仍是本地实现的原样结构',
    stats && typeof stats === 'object' && typeof stats.favorites === 'number',
    JSON.stringify(stats)
  );

  reply({ code: 501, message: '该接口尚未在云端实现', data: null });
  const fb = await api.submitFeedback({ type: 'bug', content: '测试' });
  check(
    '反馈工单未实现时，delivered 必须为 false —— 不能把「仅存本机」说成已送达',
    fb.delivered === false,
    JSON.stringify({ delivered: fb.delivered, ticketId: fb.ticketId })
  );
  check('且 ok 仍为 true（本地暂存是正常分支，不是异常）', fb.ok === true);

  useCloud();
  mem['sp_token'] = 'tk';
  request.setToken('tk');
  /**
   * ⚠️ 还要把「本机认为已登录」的标记一起置上。
   *    `api.getFavorites()` 在**未登录**时会直接读本机缓存、根本不发请求
   *    （见 utils/api.js 门面层的短路），那样就测不到「云端返回 401 时
   *    是否回落」这件事了。
   *    这两个标记本来就可能不一致 —— 「会话已在服务端失效、
   *    但本机还留着头像昵称与登录标记」正是最常见的那种不一致。
   */
  mem['sp_sign_in'] = true;
  unauthorizedFired = false;
  request.setUnauthorizedHandler(() => {
    unauthorizedFired = true;
  });
  reply({ code: 401, message: '', data: null });
  let fallbackOn401 = null;
  try {
    await api.getFavorites();
    fallbackOn401 = 'NO-THROW';
  } catch (e) {
    fallbackOn401 = e.code;
  }
  check('401 **不**回落（登录态问题必须暴露出来，不能被本地数据掩盖）', fallbackOn401 === 401, String(fallbackOn401));

  /* ============================================================
     5 · 上传：云存储分支
     ============================================================ */
  head('5 · 截图上传走云存储');

  useCloud();
  lastUpload = null;
  const up = await request.upload('/tmp/shot.png', {});
  check('走 wx.cloud.uploadFile，而不是 wx.uploadFile', !!(lastUpload && lastUpload.cloudPath), JSON.stringify(lastUpload && Object.keys(lastUpload || {})));
  check('cloudPath 落在 feedback/ 前缀下（与云函数校验一致）', /^feedback\//.test(lastUpload.cloudPath), lastUpload.cloudPath);
  check('cloudPath 带原始扩展名', /\.png$/.test(lastUpload.cloudPath), lastUpload.cloudPath);
  check('返回 {fileId}，取的是 fileID 字段', up && up.fileId === 'cloud://test.env/feedback/abc.png', JSON.stringify(up));

  lastUpload = null;
  await request.upload('/tmp/a.png', {});
  const first = lastUpload.cloudPath;
  await request.upload('/tmp/a.png', {});
  check('两次上传的 cloudPath 不同（不会互相覆盖）', first !== lastUpload.cloudPath);

  useNone();
  let eUp = null;
  try {
    await request.upload('/tmp/a.png', {});
  } catch (e) {
    eUp = e;
  }
  check('本地模式下上传明确失败（不伪装成功）', eUp && eUp.code === 'NO_BACKEND', eUp && String(eUp.code));

  /* ============================================================
     6 · 启动恢复会话（cloud 路线没有 token 的坑）
     ============================================================ */
  head('6 · 启动恢复会话');

  useCloud();
  request.clearToken();
  reply({ code: 0, message: '', data: null }); // 服务端：没这个用户
  const s1 = await api.restoreSession();
  check(
    'cloud 模式下**没有 token 也要问服务端**（否则永远判定未登录）',
    lastCloudCall && lastCloudCall.data.path === '/v1/auth/session',
    lastCloudCall ? JSON.stringify(lastCloudCall.data) : '没有发起请求'
  );
  check('服务端返回 data:null 时结果为 null（不是抛错）', s1 === null, JSON.stringify(s1));

  reply({
    code: 0,
    message: '',
    data: { user: { id: 'u1', nickName: 'A', plan: '' } },
  });
  const s2 = await api.restoreSession();
  check('服务端有该用户时恢复出用户对象', s2 && s2.id === 'u1', JSON.stringify(s2));

  useRest();
  request.clearToken();
  lastCloudCall = null;
  lastRequestArgs = null;
  const s3 = await api.restoreSession();
  check('REST 模式下无 token 则不浪费一次网络请求', lastRequestArgs === null && s3 === null);

  /* ============================================================
     7 · 云函数侧静态断言（本机不装 wx-server-sdk，只读源码）
     ============================================================ */
  head('7 · 云函数源码静态检查');

  const FN_DIR = path.join(ROOT, 'cloudfunctions', 'api');
  const readFn = (rel) => fs.readFileSync(path.join(FN_DIR, rel), 'utf8');
  const fnIndex = readFn('index.js');
  const fnFiles = ['index.js', 'lib/response.js', 'handlers/feedback.js', 'handlers/content.js', 'handlers/auth.js'];

  const allFnSrc = fnFiles.map(readFn).join('\n');

  check('云函数目录存在 index.js', fs.existsSync(path.join(FN_DIR, 'index.js')));
  check('有 package.json 声明 wx-server-sdk 依赖', /wx-server-sdk/.test(readFn('package.json')));
  check('入口导出 main（云函数必需）', /exports\.main\s*=/.test(fnIndex));
  check('统一响应结构为 {code, message, data}', /code:\s*0,\s*message:\s*''/.test(readFn('lib/response.js')));

  const routes = (fnIndex.match(/'[A-Z]+ \/v1\/[^']+'/g) || []).map((s) => s.slice(1, -1));
  check(
    '路由表至少含已实现的 4 个端点',
    ['POST /v1/feedback', 'GET /v1/content', 'POST /v1/auth/login', 'GET /v1/auth/session'].every(
      (k) => routes.indexOf(k) > -1
    ),
    routes.join(' | ')
  );
  check('未实现端点返回 501（供客户端识别并回落）', /fail\(501/.test(fnIndex));

  const CONTRACT = fs.readFileSync(path.join(__dirname, '..', 'API接口契约.md'), 'utf8');
  const contractPaths = (CONTRACT.match(/`\/v1\/[a-z/{}]+`/g) || [])
    .map((s) => s.slice(1, -1))
    .filter((p, i, a) => a.indexOf(p) === i);
  const unknownRoutes = routes.filter((r) => {
    const p = r.split(' ')[1];
    return contractPaths.indexOf(p) === -1;
  });
  check(
    '路由表里的路径都能在契约里找到出处（没有自造端点）',
    unknownRoutes.length === 0,
    unknownRoutes.join(' | ')
  );

  /**
   * ⚠️ 断言「源码里不该有 X」之前**必须先剥掉注释**。
   *    本文件第一版就栽在这里：feedback 相关的注释里写了
   *    「刻意不取 CLIENTIP，因为 IP 属于个人信息」，于是
   *    「不采集 IP」这条断言被自己的解释性注释判成了失败。
   */
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const allFnCode = stripComments(allFnSrc);

  // 合规红线：云函数里不得出现任何模型服务域名或 SDK
  const banned = [
    /api\.openai\.com/,
    /dashscope\.aliyuncs\.com/,
    /aip\.baidubce\.com/,
    /hunyuan\.tencentcloudapi\.com/,
    /openai/i,
    /require\(['"]@?tencentcloud/i,
  ];
  const hitBanned = banned.filter((re) => re.test(allFnSrc));
  check(
    '云函数内没有模型服务域名 / 大模型 SDK（运行期 AI 红线）',
    hitBanned.length === 0,
    hitBanned.map(String).join(' | ')
  );

  check(
    '反馈接口未加登录前置（契约 4.8 要求匿名可用）',
    !/if\s*\(\s*!openid\s*\)\s*throw[\s\S]{0,80}feedback/i.test(readFn('handlers/feedback.js'))
  );
  check(
    '反馈的限流按 openid 而不采集 IP（少一项隐私披露义务）',
    !/CLIENTIP/.test(allFnCode) && /userId:\s*openid/.test(readFn('handlers/feedback.js'))
  );
  check(
    '用户对象不下发 openid（契约 5 节：openid 不返回给客户端）',
    !/shapeUser[\s\S]{0,400}openid:\s*doc\.openid/.test(readFn('handlers/auth.js'))
  );
  check('新建用户不预置昵称/套餐（不得编造身份数据）', /nickName: ''/.test(readFn('handlers/auth.js')));

  /* ============================================================
     8 · 微信 AI Skill 不得回归（提审硬约束）
     ============================================================ */
  head('8 · 微信 AI Skill 不得回归');

  /**
   * ⚠️ 2026-09-24 提审被驳回，审核答复原文：
   *    「当前小程序版本包含 Skill 相关能力，该能力尚处于灰度测试阶段，
   *      暂未开放提审，请等待官方统一下发通知后再提交包含 Skill 的版本。
   *      如有常规版本发布诉求，建议移除 Skill 相关代码后重新提交。」
   *
   * 即：**只要包里还有 Skill 声明，这个版本就提不上去**（与代码写得好不好无关）。
   *
   * 它属于「多一份东西也不会让任何测试变红」的那一类 ——
   * 当初加 `agent.skills` 没有任何脚本反对，被驳回时也没有任何脚本报警，
   * 是**审核员**替我们发现的。这一节就是补上那个看守。
   *
   * 本节是**有意的反断言**：官方开放 Skill 提审、真的要重新接入时，
   * 请连同本节 4 条断言一起删掉，并把 `sync-data-copies.js` 第 8 节
   * （`test-insight-templates.js` / `test-feedback-api.js` / `verify-profile-page.js`
   * 的分包副本比对）一并加回来 —— 否则会重演
   * 「页面里看到的和微信 AI 答出来的不是同一份数据」。
   */
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  check(
    'app.json 不声明 agent.skills',
    !appJson.agent || !appJson.agent.skills || appJson.agent.skills.length === 0,
    JSON.stringify(appJson.agent)
  );
  check(
    'app.json 不注册 skills 独立分包',
    !Array.isArray(appJson.subPackages) || appJson.subPackages.every((p) => p.root !== 'skills')
  );
  check(
    'miniprogram/skills/ 目录已移除',
    !fs.existsSync(path.join(ROOT, 'skills')),
    '仍在：' + path.join(ROOT, 'skills')
  );
  const projectCfg = fs.readFileSync(path.join(ROOT, '..', 'project.config.json'), 'utf8');
  check('project.config.json 不再把 skills 作为打包 include', !/"value"\s*:\s*"skills"/.test(projectCfg));

  /* ============================================================ */
  console.log('\n' + '─'.repeat(64));
  console.log(`断言：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
  console.log('─'.repeat(64));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n验证台自身异常：', e);
  process.exit(2);
});
