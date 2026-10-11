#!/usr/bin/env node
/**
 * 个人资料页（10）验证台
 * ==================================================================
 * 覆盖「光读代码看不出来、必须跑起来才算数」的四类缺陷：
 *
 *   1) 空值被预填
 *      本项目曾把设计稿里的演示值当成默认资料内置，真机上显示出与用户无关的姓名。
 *      → 断言首次进入时五个字段**全部为空**，且只读账号信息在本地模式下不渲染。
 *
 *   2) 本地模式的保存被说成「已同步」
 *      本地适配器**可以存下来，但不能报告成功**（数据真实性红线）。
 *      → 断言本地保存的提示是「已保存到本机」而不是「已保存」。
 *
 *   3) 保存顺手把未登录用户变成已登录
 *      `local['user.updateProfile']` 曾写 `store.setSignedIn(true, ...)`，
 *      于是「未登录时改个昵称」会静默点亮登录态，账号页随即出现「退出登录」。
 *      → 断言保存前后 `sp_sign_in` 不变。
 *
 *   4) 未执行的分支 = 未验证的分支
 *      全部 remote 代码在本地模式下永远不跑。这里把 `baseUrl` 指到一个假地址，
 *      让真实 remote 适配器跑起来，断言请求的 URL / method / 载荷，
 *      并断言「头像上传失败时绝不把本机临时路径写进账号」。
 *
 * 用法：
 *   node tools/verify-profile-page.js              # 静态 + 本地模式逻辑（离线，随时可跑）
 *   node tools/verify-profile-page.js --runtime    # 追加真机量取（需开发者工具 + 服务端口）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'miniprogram');
const CONTRACT = path.join(ROOT, 'API接口契约.md');
const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const AUTO_PORT = 9421;
const PAGE_URL = '/pages/profile/profile';
const WITH_RUNTIME = process.argv.includes('--runtime');

let pass = 0;
const failures = [];
let skipped = 0;

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
function skip(label, why) {
  skipped++;
  console.log(`  ⊘ 跳过 ${label}${why ? '：' + why : ''}`);
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}

const read = (p) => fs.readFileSync(p, 'utf8');

/* ================================================================
   第 1 节 · 静态守卫
   ================================================================ */
function staticChecks() {
  head('第 1 节 · 静态守卫');

  const wxmlPath = path.join(PROJECT, 'pages/profile/profile.wxml');
  const jsPath = path.join(PROJECT, 'pages/profile/profile.js');
  const wxml = read(wxmlPath);
  const js = read(jsPath);
  const body = wxml.replace(/<!--[\s\S]*?-->/g, '');
  const jsNoComment = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /* ---- 1.1 WXML 表达式里不得出现函数调用 ----
   * 写在 {{}} 里的 `filter()` / `indexOf()` 求值失败且**不报错**，
   * 结果就是 class 静默拼空、按钮点了没反应（2026-09-20 匹配页踩过）。 */
  const callHits = [];
  body.split('\n').forEach((line, i) => {
    if (/\{\{[^}]*[A-Za-z_$][\w$]*\s*\(/.test(line)) callHits.push(`第 ${i + 1} 行`);
  });
  check('WXML 绑定表达式里没有函数调用', callHits.length === 0, callHits.join(', '));

  /* ---- 1.2 文案全在内容层，WXML 里不得有硬编码中文 ---- */
  const hardcoded = [];
  body.replace(/>([^<]*)</g, (m, text) => {
    if (/[\u4e00-\u9fa5]/.test(text)) hardcoded.push(text.trim());
    return m;
  });
  check('WXML 文本节点里没有硬编码中文', hardcoded.length === 0, hardcoded.join(' | '));
  check(
    'JS 里没有写死提示文案（wx.showToast 不带字面量）',
    !/showToast\(\s*\{\s*title:\s*'/.test(jsNoComment) && !/title:\s*'/.test(jsNoComment),
    '提示语必须取自 c.profile / c.common'
  );

  /* ---- 1.3 头像只能用微信的原生能力获取 ----
   * getUserProfile 2022 年已回收，`open-type="chooseAvatar"` 是唯一合法途径。 */
  const avatarBtn = (body.match(/<button[^>]*chooseavatar[^>]*>/) || [])[0] || '';
  check(
    '头像按钮使用 open-type="chooseAvatar" + bindchooseavatar',
    avatarBtn.includes('open-type="chooseAvatar"') && avatarBtn.includes('bindchooseavatar="onChooseAvatar"'),
    avatarBtn.replace(/\s+/g, ' ').slice(0, 90)
  );

  /* ---- 1.4 昵称输入必须带 type="nickname"（否则拿不到微信昵称填写面板） ---- */
  const nickTag = (body.match(/<input[\s\S]*?bindinput="onNicknameInput"[\s\S]*?\/>/) || [])[0] || '';
  check('昵称输入带 type="nickname"', nickTag.includes('type="nickname"'));

  /* ---- 1.5 组件注册（漏注册不报错，只渲染成空白块） ---- */
  const json = JSON.parse(read(wxmlPath.replace(/\.wxml$/, '.json')));
  const reg = json.usingComponents || {};
  check('注册了 nav-bar', reg['nav-bar'] === '/components/nav-bar/index');
  check('注册了 icon', reg['icon'] === '/components/icon/index');

  /* ---- 1.6 路由已注册 ---- */
  const appJson = JSON.parse(read(path.join(PROJECT, 'app.json')));
  check('app.json 已注册 pages/profile/profile', (appJson.pages || []).indexOf('pages/profile/profile') > -1);

  /* ---- 1.7 底部动作栏：本页是二级页、没有标签栏 ---- */
  check(
    '根节点用 page--cta（不是 page--cta-tab）',
    /class="page page--cta prof"/.test(body)
  );
  check(
    'cta-bar 不带 --tab（本页无标签栏，带了会平白多出一段空白）',
    /class="cta-bar"/.test(body) && !/cta-bar--tab/.test(body)
  );

  /* ---- 1.7b 字段行的分割线不能靠相邻选择器 ----
   * 「年级」行被 <picker> 包着，`.frow + .frow` 在这两行上静默失效 ——
   * 不报错，只是少两条线。所以断言：非首行必须显式带 frow--sep。 */
  const frowCount = (body.match(/class="frow(?: |")/g) || []).length;
  const sepCount = (body.match(/frow--sep/g) || []).length;
  check(
    '每条非首行都带 frow--sep（分割线不依赖相邻选择器）',
    frowCount === 4 && sepCount === 3,
    `共 ${frowCount} 行 / ${sepCount} 条分割线`
  );
  check(
    'wxss 里没有残留 .frow + .frow 写法',
    // ⚠️ 必须先剥掉注释：wxss 里那条说明「不要用相邻选择器」的注释本身就含这个字符串，
    //    不剥就会拿自己的说明文字判自己失败（本项目在检查脚本上踩过两次同类坑）
    !/\.frow\s*\+\s*\.frow/.test(
      read(path.join(PROJECT, 'pages/profile/profile.wxss')).replace(/\/\*[\s\S]*?\*\//g, '')
    )
  );

  /* ---- 1.8 入场动画登记（新页面最容易漏的一步） ---- */
  const appWxss = read(path.join(PROJECT, 'app.wxss'));
  const animList = (appWxss.match(/\.terms__body,[\s\S]*?\{\s*animation: page-in/) || [])[0] || '';
  check('.prof__body 已登记进入场动画列表', animList.indexOf('.prof__body') > -1);

  /* ---- 1.9 内容层键位齐全 ----
   * 动态扫描页面真正引用的键，避免「改了内容层键名、页面读到 undefined」这种静默失败。 */
  const content = require(path.join(PROJECT, 'data/content.js'));
  const cfg = content.profile || {};
  const used = new Set();
  for (const m of js.matchAll(/\bcfg\.(\w+)/g)) used.add(m[1]);
  for (const m of js.matchAll(/c\.profile\.(\w+)/g)) used.add(m[1]);
  const missingKeys = Array.from(used).filter((k) => cfg[k] === undefined);
  check(
    '页面引用的 profile 文案键在内容层都存在',
    missingKeys.length === 0,
    missingKeys.join(', ')
  );
  check('nav.profile 存在', !!content.nav.profile, content.nav.profile);
  check(
    'enums.grades 是非空字符串数组（契约里 grade 就是「高三」这种可读值）',
    Array.isArray(content.enums.grades) &&
      content.enums.grades.length > 0 &&
      content.enums.grades.every((g) => typeof g === 'string'),
    JSON.stringify(content.enums.grades)
  );
  check('meta 行标签齐全', !!((cfg.meta || {}).id && (cfg.meta || {}).createdAt));

  /* ---- 1.10 与接口契约一致的字段名 ----
   * 昵称在页面的 wxml 里叫 nickname，提交时必须写成 nickName —— 拼错就是静默不改。 */
  const mapBody = (js.match(/const FIELD_MAP = \{([^}]*)\}/) || [])[1] || '';
  const apiFields = (mapBody.match(/'([A-Za-z]+)'/g) || []).map((s) => s.slice(1, -1));
  const md = read(CONTRACT);
  const putSection = md.slice(
    md.indexOf('#### PUT `/v1/user/profile`'),
    md.indexOf('#### GET `/v1/user/stats`')
  );
  const contractFields = (putSection.match(/\|\s*`([A-Za-z]+)`\s*\|/g) || []).map((s) =>
    s.replace(/[|\s`]/g, '')
  );
  check('能从契约里解析出 PUT /v1/user/profile 的字段清单', contractFields.length > 0, contractFields.join(', '));
  const drift = apiFields.filter((f) => contractFields.indexOf(f) === -1);
  check(
    '提交的字段名全部在契约内',
    apiFields.length > 0 && drift.length === 0,
    drift.length ? `不在契约里：${drift.join(', ')}` : apiFields.join(', ')
  );
  check(
    '页面把头像也纳入 diff 提交（avatarUrl 在契约里）',
    /patch\.avatarUrl = f\.avatarUrl/.test(js) && contractFields.indexOf('avatarUrl') > -1
  );

  /* ---- 1.11 账号页两个入口都接到了本页 ---- */
  const acctJs = read(path.join(PROJECT, 'pages/account/account.js'));
  const acctWxml = read(path.join(PROJECT, 'pages/account/account.wxml'));
  check(
    '「账号与安全 → 个人资料」已接线（ready:true + url）',
    /key: 'profile', url: '\/pages\/profile\/profile', ready: true/.test(acctJs)
  );
  check('资料卡点击进入个人资料页', /bindtap="onProfileCard"/.test(acctWxml) && /wx\.navigateTo\(\{ url: '\/pages\/profile\/profile' \}\)/.test(acctJs));
  check(
    '账号页资料卡不再有硬编码「未登录」文案',
    !/profile__avatar-text/.test(acctWxml)
  );

  /* ---- 1.11b 身份展示必须以登录态为闸门 ----
   * 用户 2026-09-20 报的缺陷：登出后头像/昵称还挂着，只有按钮消失。
   * 视图层再钉一道，防止有人把闸门当成冗余删掉。 */
  check(
    '账号页头像渲染带 signedIn 闸门',
    /wx:if="\{\{signedIn && user\.avatarUrl\}\}"/.test(acctWxml)
  );
  check(
    '账号页昵称/副文案在未登录时走未登录分支',
    /signedIn\s*\?\s*nick \|\| c\.account\.profileNoNickname\s*:\s*c\.account\.profileNotSignedIn/.test(acctJs)
  );
  check(
    '登录页保存后的送达语义也走 isLocal（不是运行模式）',
    /onlyLocal \? this\.data\.c\.signin\.savedLocal : this\.data\.c\.signin\.saved/.test(
      read(path.join(PROJECT, 'pages/signin/signin.js'))
    ) && !!content.signin.savedLocal
  );

  /* ---- 1.12 云端端点已登记 ----
   * ⚠️ 这一条是「页面上那句『资料会同步到你的账号』是否算数」的判据。
   *    端点没登记 → 云开发路线下 PUT 一律 501 → 客户端静默回落本地，
   *    于是界面在说一句假话，而且不报任何错。 */
  const fnIndex = read(path.join(PROJECT, 'cloudfunctions/api/index.js'));
  check(
    '云函数已登记 GET/PUT /v1/user/profile',
    /'GET \/v1\/user\/profile': user\.profile/.test(fnIndex) &&
      /'PUT \/v1\/user\/profile': user\.updateProfile/.test(fnIndex)
  );
  const userHandler = read(path.join(PROJECT, 'cloudfunctions/api/handlers/user.js'));
  check(
    '云端只写契约内的字段（白名单，plan / openid 不在其中）',
    /const WRITABLE = \{ nickName: 20, email: 60, grade: 10, city: 20, avatarUrl: 300 \}/.test(userHandler) &&
      !/WRITABLE[^}]*plan/.test(userHandler)
  );
  check(
    '云端的长度上限与内容层一致（同一条口径两处定义必须相等）',
    new RegExp('nickName: ' + (content.profile.nicknameMax) + ',').test(userHandler) &&
      new RegExp('email: ' + (content.profile.emailMax) + ',').test(userHandler) &&
      new RegExp('city: ' + (content.profile.cityMax) + '\\b').test(userHandler)
  );
}

/* ================================================================
   第 2 节 / 第 3 节 · 页面逻辑（真实 api.js + mock wx 运行时）
   ================================================================
   刻意**不 mock api.js**：本地模式下的 red line 行为
   （「不得把未登录变已登录」「本机保存不得报成功」）就写在 api.js 的
   local 适配器里，把它换掉等于把被测对象一起换掉了。
   ================================================================ */

/** 造一个带真实 setData 语义（支持 'a.b' 路径）的页面实例 */
function makePage(def) {
  const inst = Object.assign({}, def);
  inst.data = JSON.parse(JSON.stringify(def.data));
  inst.setData = function (obj) {
    Object.keys(obj).forEach((k) => {
      const parts = k.split('.');
      let cur = this.data;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = obj[k];
    });
  };
  return inst;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms || 20));

function setupRuntime() {
  const mem = {};
  const toasts = [];
  const navs = [];
  const requests = [];
  const uploads = [];
  const cloudCalls = [];
  /** 保存失败注入：'ok' | 'savefile-fail' | 'upload-fail' */
  let avatarMode = 'ok';
  /**
   * 云函数回复。默认 501 —— 这正是**线上当前的真实状态**：
   * `handlers/user.js` 还没部署，`/v1/user/profile` 一律 501。
   * 这个默认值让「云模式 + 端点未实现」这条路径默认就会被走到。
   */
  let cloudReply = { code: 501, message: '该接口尚未在云端实现', data: null };

  global.wx = {
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''),
    setStorageSync: (k, v) => {
      mem[k] = v;
    },
    showToast: (o) => toasts.push(o),
    showModal: (o) => {
      if (o.success) o.success({ confirm: true });
    },
    navigateTo: (o) => navs.push(o),
    switchTab: (o) => navs.push(o),
    login: (o) => o.success && o.success({ code: 'test-code' }),
    request: (o) => {
      requests.push(o);
      o.success && o.success({ statusCode: 200, data: { code: 0, data: {} } });
    },
    uploadFile: (o) => {
      uploads.push(o);
      if (avatarMode === 'upload-fail') return o.fail && o.fail({ errMsg: 'uploadFile:fail' });
      o.success && o.success({
        statusCode: 200,
        data: JSON.stringify({ fileId: 'file_a', url: 'https://cdn.example.com/avatar/a.png' }),
      });
    },
    getFileSystemManager: () => ({
      saveFile: (o) => {
        if (avatarMode === 'savefile-fail') return o.fail && o.fail({ errMsg: 'saveFile:fail' });
        o.success && o.success({ savedFilePath: 'wxfile://usr/avatar_a.png' });
      },
    }),
    cloud: {
      callFunction: (o) => {
        cloudCalls.push(o);
        o.success && o.success({ result: cloudReply });
      },
    },
  };
  global.getCurrentPages = () => [{}];
  global.getApp = () => ({ globalData: {} });

  let pageDef = null;
  global.Page = (d) => {
    pageDef = d;
  };

  const jsPath = path.join(PROJECT, 'pages/profile/profile.js');
  delete require.cache[require.resolve(jsPath)];
  require(jsPath);
  global.Page = () => {};

  const api = require(path.join(PROJECT, 'utils/api.js'));

  /**
   * ⚠️ 本项目当前 `CONFIG.env` 是**配好的**（云开发环境 ID），
   *    因此默认 transport 就是 'cloud'、api.mode() 就是 'remote'。
   *    本台第 2 节要验的正是「本地模式」那套诚实语义（存本机 / 不报已同步），
   *    所以先把 env 摘掉让 transport 落到 'none'；
   *    第 3 节再换成假 baseUrl（rest 优先于 cloud）驱动真实 remote 适配器。
   */
  const ORIG_ENV = api.request.CONFIG.env;
  api.request.CONFIG.baseUrl = '';
  api.request.CONFIG.env = '';

  return {
    mem,
    toasts,
    navs,
    requests,
    uploads,
    cloudCalls,
    api,
    pageDef,
    setCloudReply: (r) => {
      cloudReply = r;
    },
    restoreConfig: () => {
      api.request.CONFIG.baseUrl = '';
      api.request.CONFIG.env = ORIG_ENV;
    },
    reset: () => {
      toasts.length = 0;
      navs.length = 0;
      requests.length = 0;
      uploads.length = 0;
      cloudCalls.length = 0;
    },
    setAvatarMode: (m) => {
      avatarMode = m;
    },
  };
}

async function logicChecks(rt) {
  head('第 2 节 · 页面逻辑（本地模式 · mock 运行时）');
  const { api, mem, toasts, navs } = rt;
  const content = require(path.join(PROJECT, 'data/content.js'));
  const CFG = content.profile;

  /* ---- 2.1 首帧：空档案，不留任何预填 ---- */
  const page = makePage(rt.pageDef);
  page.onLoad();
  await wait(40);

  const f0 = page.data.form;
  check(
    '首次进入五个字段全为空（不预填任何示例值）',
    f0.nickname === '' && f0.email === '' && f0.grade === '' && f0.city === '' && f0.avatarUrl === '',
    JSON.stringify(f0)
  );
  check('年级选择器选项来自内容层 enums.grades', page.data.grades.length === content.enums.grades.length, `${page.data.grades.length} 项`);
  check('未登录（本机无登录态）', page.data.signedIn === false);
  check('尚无改动 → dirty=false', page.data.dirty === false);
  check(
    '本地模式不渲染「账号信息」（local-<时间戳> 不是账号，不能摆出来）',
    page.data.hasMeta === false && page.data.meta.length === 0
  );
  check('本地模式提示语取自内容层', page.data.remote === false && !!CFG.localTip);

  /* ---- 2.2 头像：临时路径必须落成持久路径 ---- */
  rt.reset();
  page.onChooseAvatar({ detail: { avatarUrl: 'http://tmp/tmp_avatar.png' } });
  await wait(20);
  check(
    '头像临时路径被转存为持久路径',
    page.data.form.avatarUrl === 'wxfile://usr/avatar_a.png',
    page.data.form.avatarUrl
  );
  check('转存成功后 uploading 归位', page.data.avatarUploading === false);
  check('本地模式头像不算「已上传到远端」', page.data.avatarPermanent === false);
  check('选头像即视为有改动', page.data.dirty === true);

  /* ---- 2.3 转存失败：如实提示「仅本次有效」 ---- */
  rt.reset();
  rt.setAvatarMode('savefile-fail');
  page.onChooseAvatar({ detail: { avatarUrl: 'http://tmp/tmp_avatar2.png' } });
  await wait(20);
  check(
    '转存失败时保留临时路径并如实提示',
    page.data.form.avatarUrl === 'http://tmp/tmp_avatar2.png' &&
      toasts.length === 1 &&
      toasts[0].title === CFG.avatarVolatile,
    toasts.length ? toasts[0].title : '没有 toast'
  );
  rt.setAvatarMode('ok');
  // 还原成一次成功的头像选择，后续用例基于它
  page.onChooseAvatar({ detail: { avatarUrl: 'http://tmp/tmp_avatar.png' } });
  await wait(20);

  /* ---- 2.4 校验：昵称必填 ---- */
  rt.reset();
  const before = JSON.stringify(mem.sp_user || null);
  page.setData({ 'form.nickname': '   ' });
  page.onSave();
  check('昵称空白 → 用内容层文案拦截', toasts.length === 1 && toasts[0].title === CFG.needNickname, toasts[0] && toasts[0].title);
  check('被拒绝的保存没有落盘', JSON.stringify(mem.sp_user || null) === before);

  page.setData({ 'form.nickname': '一'.repeat(CFG.nicknameMax + 1) });
  page.onSave();
  check(
    '昵称超长 → 提示已插值且不含花括号',
    toasts[1] && toasts[1].title === api.tpl(CFG.nicknameTooLong, { max: CFG.nicknameMax }) && toasts[1].title.indexOf('{') < 0,
    toasts[1] && toasts[1].title
  );

  /* ---- 2.5 校验：邮箱选填，但填了要合法 ---- */
  page.setData({ 'form.nickname': '张三', 'form.email': 'abc@' });
  page.onSave();
  check('邮箱格式非法 → 拦截', toasts[2] && toasts[2].title === CFG.invalidEmail, toasts[2] && toasts[2].title);

  page.setData({ 'form.email': 'a'.repeat(CFG.emailMax) + '@example.com' });
  page.onSave();
  check('邮箱超长 → 拦截', toasts[3] && toasts[3].title.indexOf('{') < 0, toasts[3] && toasts[3].title);

  /* ---- 2.6 校验：城市超长 ---- */
  page.setData({ 'form.email': '', 'form.city': '城'.repeat(CFG.cityMax + 1) });
  page.onSave();
  check('城市超长 → 拦截', toasts[4] && toasts[4].title.indexOf('{') < 0, toasts[4] && toasts[4].title);

  /* ---- 2.7 只提交改动过的字段 ---- */
  page.setData({ 'form.city': '' });
  const patch = page.buildPatch();
  check(
    'diff patch 只含改动字段（昵称 + 头像）',
    Object.keys(patch).sort().join() === 'avatarUrl,nickName',
    JSON.stringify(patch)
  );
  check('diff patch 用的字段名是契约里的 nickName', patch.nickName === '张三' && patch.nickname === undefined);

  /* ---- 2.8 未登录保存必须被拦下：本地模式与远端同语义 ----
   * 读取路径在未登录时返回 null（契约 4.2），若写入还放行，就成了
   * 「写进去了但读不出来」—— 用户以为保存成功，回来却是一片空白。 */
  rt.reset();
  const signInBefore = !!mem.sp_sign_in;
  const userBefore = JSON.stringify(mem.sp_user || null);
  page.onSave();
  await wait(20);
  check(
    '未登录（本地模式）保存 → 用内容层文案拦下',
    toasts.length === 1 && toasts[0].title === CFG.needLogin,
    toasts[0] && toasts[0].title
  );
  check('未登录时没有落盘', JSON.stringify(mem.sp_user || null) === userBefore);
  check('未登录时 dirty 保持（内容还在，登录后可继续保存）', page.data.dirty === true);
  check(
    '⚠️ 保存不得把未登录用户变成已登录（回归断言）',
    !!mem.sp_sign_in === signInBefore && signInBefore === false,
    `保存前 ${signInBefore} → 保存后 ${!!mem.sp_sign_in}`
  );

  /* ---- 2.9 本地模式「登录」后保存：提示必须是「已保存到本机」 ----
   * ⚠️ 本地模式的登录态只是「本机已建档」，并没有账号可同步，
   *    所以提示不能因为 signedIn=true 就换成「已保存」（远端模式的版本在第 4 节验）。 */
  page.setData({ original: JSON.parse(JSON.stringify(page.data.form)) });
  page.recomputeDirty();
  mem.sp_sign_in = true;
  await page.refresh();
  rt.reset();
  page.setData({ 'form.nickname': '李四' });
  page.onSave();
  await wait(20);
  check('本地模式保存提示为「已保存到本机」', toasts.length === 1 && toasts[0].title === CFG.savedLocal, toasts[0] && toasts[0].title);
  check('本地模式提示不得写成「已保存」（会让人以为上了云）', toasts[0] && toasts[0].title !== CFG.saved);
  check('保存后昵称写入本机', (mem.sp_user || {}).nickName === '李四');
  check('保存后 dirty 归零', page.data.dirty === false);

  /* ---- 2.10 无改动时不再提交 ---- */
  rt.reset();
  page.onSave();
  check('无改动 → 提示「资料没有改动」且不发请求', toasts.length === 1 && toasts[0].title === CFG.noChange, toasts[0] && toasts[0].title);

  /* ---- 2.11 年级选择器 ---- */
  rt.reset();
  page.onGradeChange({ detail: { value: '3' } });
  check('选择第 4 项 → 高三', page.data.form.grade === '高三', page.data.form.grade);
  check('gradeIndex 同步', page.data.gradeIndex === 3);
  page.onGradeChange({ detail: { value: '99' } });
  check('越界索引回落空串（不编一个年级出来）', page.data.form.grade === '', JSON.stringify(page.data.form.grade));

  /* ---- 2.12 refresh 不得覆盖未保存的编辑（远端读取是网络往返，用户可能已在打字） ---- */
  page.setData({ 'form.city': '深圳' });
  page.recomputeDirty();
  await page.refresh();
  check('dirty 时 refresh 不覆盖编辑态', page.data.form.city === '深圳', JSON.stringify(page.data.form.city));

  // 对齐编辑态与快照（等价于保存成功后的状态），让后续 refresh 正常生效
  page.setData({ original: JSON.parse(JSON.stringify(page.data.form)) });
  page.recomputeDirty();
  check('对齐后 dirty 归位', page.data.dirty === false);

  mem.sp_user = Object.assign({}, mem.sp_user, { grade: '高二' });
  await page.refresh();
  check(
    'refresh 会按已填年级回填选择器位置',
    page.data.gradeIndex === content.enums.grades.indexOf('高二') && page.data.form.grade === '高二',
    `gradeIndex=${page.data.gradeIndex} / grade=${page.data.form.grade}`
  );

  /* ---- 2.13 有未保存改动时 onShow 不重读（否则从登录页返回会冲掉刚填的内容） ---- */
  page.setData({ 'form.city': '广州' });
  page.recomputeDirty();
  page.onShow();
  await wait(20);
  check('dirty 时 onShow 不覆盖编辑态', page.data.form.city === '广州', page.data.form.city);

  /* ---- 2.14 登录入口由用户主动点击触发 ---- */
  rt.reset();
  page.onSignIn();
  check('点登录跳转登录页', navs.length === 1 && navs[0].url === '/pages/signin/signin', navs[0] && navs[0].url);

  /* ---- 2.15 数字型 maxlength 绑定源在内容层 ---- */
  check(
    'maxlength 取自内容层（20 / 60 / 20）',
    CFG.nicknameMax === 20 && CFG.emailMax === 60 && CFG.cityMax === 20,
    `${CFG.nicknameMax} / ${CFG.emailMax} / ${CFG.cityMax}`
  );

  /* ---- 2.16 邻接回归：账号管理页的统计不得自带编造数字 ----
   * 个人资料的两个入口都在账号管理页上，而那一页顶部的三宫格曾经直接沿用
   * 设计稿的「已匹配院校 26」，收藏默认预置了一所多伦多大学 —— 用户什么都没做，
   * 界面就替他认领了成绩与收藏。与「空档案自带 GPA 86」是同一条红线。
   * 这两条断言就钉在这里，防止以后有人为了「界面好看」把数字加回来。 */
  const stats = await api.getStats();
  check('一次没匹配过 → 已匹配院校为 0', stats.matched === 0, JSON.stringify(stats));
  check('从未收藏 → 我的收藏为 0（不是预置的某所学校）', stats.favorites === 0, JSON.stringify(stats));
  check('未上线的文书数恒为 0（不编数字填满三宫格）', stats.documents === 0, String(stats.documents));

  return mem;
}

async function remoteChecks(rt, mem) {
  head('第 3 节 · 远端分支（baseUrl 指向假地址，跑真实 remote 适配器）');
  const { api, toasts, requests, uploads, navs } = rt;
  const content = require(path.join(PROJECT, 'data/content.js'));
  const CFG = content.profile;

  // 把 baseUrl 指到假地址 —— 未执行的代码分支等于未验证的代码
  api.request.CONFIG.baseUrl = 'https://api.example.invalid';
  check('已切到 remote 模式', api.mode() === 'remote', api.transport());

  // 全新实例：此时未登录
  mem.sp_sign_in = false;
  delete mem.sp_user;
  const page = makePage(rt.pageDef);
  page.onLoad();
  await wait(40);
  rt.reset();

  /* ---- 3.1 远端 + 未登录：保存被前置拦下，且一个请求都不发 ---- */
  page.setData({ 'form.nickname': '王五' });
  page.onSave();
  await wait(20);
  check(
    '未登录（远端）保存 → 提示先登录',
    toasts.length === 1 && toasts[0].title === CFG.needLogin,
    toasts[0] && toasts[0].title
  );
  check('未登录时没有发出任何写请求', requests.filter((r) => r.method !== 'GET').length === 0);
  check('远端模式提示语换成「会同步到账号」', CFG.remoteTip !== CFG.localTip && page.data.remote === true);

  /* ---- 3.2 远端 + 已登录：PUT /v1/user/profile，只带改动字段 ---- */
  mem.sp_sign_in = true;
  await page.refresh();
  rt.reset();
  check(
    '远端模式渲染只读账号信息（id 存在时）',
    page.data.hasMeta === false || page.data.meta.every((r) => !!r.value),
    JSON.stringify(page.data.meta)
  );

  page.setData({ 'form.nickname': '王五', 'form.email': 'w@example.com' });
  page.onSave();
  await wait(30);

  const put = requests.filter((r) => r.method === 'PUT')[0];
  check('发出了 PUT 请求', !!put, requests.map((r) => `${r.method} ${r.url}`).join(' | '));
  if (put) {
    check('URL 为 /v1/user/profile', put.url === 'https://api.example.invalid/v1/user/profile', put.url);
    check(
      '载荷只含改动过的两个字段',
      Object.keys(put.data).sort().join() === 'email,nickName',
      JSON.stringify(put.data)
    );
    check('昵称字段名是契约里的 nickName', put.data.nickName === '王五');
  }
  check('远端保存成功提示为「已保存」', toasts.length === 1 && toasts[0].title === CFG.saved, toasts[0] && toasts[0].title);

  /* ---- 3.3 远源头像：走上传拿永久 URL ---- */
  rt.reset();
  page.onChooseAvatar({ detail: { avatarUrl: 'http://tmp/x.png' } });
  await wait(30);
  check(
    '远源头像走上传（/v1/upload，字段名 file）',
    uploads.length === 1 && /\/v1\/upload$/.test(uploads[0].url) && uploads[0].name === 'file',
    uploads[0] && `${uploads[0].url} (${uploads[0].name})`
  );
  check(
    '头像换成服务器返回的永久地址，并标记为可写入账号',
    page.data.form.avatarUrl === 'https://cdn.example.com/avatar/a.png' && page.data.avatarPermanent === true,
    page.data.form.avatarUrl
  );

  /* ---- 3.4 头像上传失败：绝不给账号写本机临时路径 ---- */
  rt.reset();
  const BASE_AVATAR = 'https://cdn.example.com/avatar/old.png';
  page.setData({
    'form.avatarUrl': BASE_AVATAR,
    original: Object.assign({}, page.data.original, { avatarUrl: BASE_AVATAR }),
  });
  page.recomputeDirty();
  check('基线已对齐（dirty=false），便于隔离头像失败的影响', page.data.dirty === false);

  rt.setAvatarMode('upload-fail');
  page.onChooseAvatar({ detail: { avatarUrl: 'http://tmp/y.png' } });
  await wait(30);
  check(
    '上传失败 → 如实提示，且不标记为可写入账号',
    toasts.length === 1 && toasts[0].title === CFG.avatarFailed && page.data.avatarPermanent === false,
    toasts[0] && toasts[0].title
  );

  rt.reset();
  page.setData({ 'form.nickname': '赵六' });
  page.onSave();
  await wait(30);
  const put2 = requests.filter((r) => r.method === 'PUT')[0];
  check(
    '⚠️ 上传失败后保存：patch 里不含 avatarUrl（不把临时路径写进账号）',
    !!put2 && put2.data.avatarUrl === undefined && put2.data.nickName === '赵六',
    JSON.stringify(put2 && put2.data)
  );
  rt.setAvatarMode('ok');

  /* ---- 3.5 收尾：把传输层配置还原，避免影响后续脚本/真机量取 ---- */
  rt.restoreConfig();
  check('已还原为项目原本的传输层配置（cloud）', api.transport() === 'cloud', api.transport());
}

/* ================================================================
   第 3 节 · 退出登录后的账号管理页（本次缺陷的回归）
   ================================================================
   缺陷现象（用户 2026-09-20 报）：点了「退出登录」，**头像与昵称还挂在卡片上**，
   唯独「退出登录」按钮消失了 —— 界面同时表达了「你是谁」和「你没登录」。

   根因两层，必须同时改，只改一层就会复发：
     ① 数据层：本地适配器的 `user.profile` **不看登录态**，直接把 Storage 里
        缓存的用户对象返回（`localUser()`）。云函数上的 `/v1/user/profile`
        当时还没部署 → 501 → 客户端静默回落本地 → 于是「登出后仍读到身份」。
        ⇒ 本地实现必须与契约同语义：**未登录返回 null**。
     ② 视图层：账号页的昵称/头像/徽标没有以登录态为闸门，数据层一旦漏出就直上屏幕。
        ⇒ 卡片必须在 `signedIn` 为假时**整块回到未登录态**。
   ================================================================ */
async function accountLogoutChecks(rt) {
  head('第 3 节 · 账号管理页：退出登录后不得残留身份');
  const { api, mem, pageDef } = rt;
  const content = require(path.join(PROJECT, 'data/content.js'));
  const AC = content.account;

  // 加载真实的账号页（与个人资料页共用同一套 mock 运行时）
  let def = null;
  global.Page = (d) => {
    def = d;
  };
  const jsPath = path.join(PROJECT, 'pages/account/account.js');
  delete require.cache[require.resolve(jsPath)];
  require(jsPath);
  global.Page = pageDef;
  check('账号页定义已加载', !!def && typeof def.refresh === 'function');

  const page = makePage(def);

  /* ---- 3.1 已登录：卡片显示身份 ---- */
  mem.sp_sign_in = true;
  mem.sp_user = {
    id: 'local-1001',
    nickName: '李四',
    avatarUrl: 'wxfile://usr/a.png',
    email: 'a@b.co',
    plan: '',
  };
  page.refresh();
  await wait(20);
  check('已登录时卡片显示昵称', page.data.profileName === '李四', page.data.profileName);
  check('已登录时卡片显示邮箱', page.data.profileSub === 'a@b.co', page.data.profileSub);
  check('已登录时 user 对象存在（头像据此渲染）', !!page.data.user && !!page.data.user.avatarUrl);

  /* ---- 3.2 退出登录：整块回到未登录态 ---- */
  await api.logout();
  page.refresh();
  await wait(20);

  check('退出后 signedIn=false（「退出登录」按钮随之隐藏）', page.data.signedIn === false);
  check(
    '⚠️ 退出后昵称位回到「登录后同步数据」（不得残留用户昵称）',
    page.data.profileName === AC.profileNotSignedIn,
    page.data.profileName
  );
  check(
    '⚠️ 退出后副文案回到未登录提示',
    page.data.profileSub === content.signin.sub,
    page.data.profileSub
  );
  check(
    '⚠️ 退出后不得再持有带身份的用户对象（否则头像照旧渲染）',
    !(page.data.user && page.data.user.avatarUrl),
    JSON.stringify(page.data.user)
  );
  check('退出后版本徽标不渲染', !page.data.plan, JSON.stringify(page.data.plan));

  /* ---- 3.3 本机档案保留（登出文案承诺的是「保留成绩档案」，不是删数据） ---- */
  check('退出后本机仍留着已填资料，重新登录即可恢复', !!(mem.sp_user || {}).nickName, JSON.stringify((mem.sp_user || {}).nickName));
  check('账号页在退出后回到「未接入后端」提示位', !!content.common.offlineTip);

  /* ---- 3.4 数据层语义与契约一致：未登录读不到身份 ---- */
  const p = await api.getProfile();
  check('未登录时 getProfile() 返回 null（与契约「未登录返回 data:null」一致）', p === null, JSON.stringify(p));

  let putErr = null;
  try {
    await api.updateProfile({ nickName: '王五' });
  } catch (e) {
    putErr = e && e.code;
  }
  check('未登录时 updateProfile() 报 401（与服务端 PUT 同语义）', putErr === 401, String(putErr));
  check('被拒的写入没有改动本机档案', (mem.sp_user || {}).nickName === '李四', JSON.stringify((mem.sp_user || {}).nickName));
}

/* ================================================================
   第 5 节 · 云模式但端点尚未实现（501 静默回落）
   ================================================================
   这是**线上此刻的真实状态**：`handlers/user.js` 还没部署，
   `/v1/user/profile` 一律 501，`call()` 会静默回落到本地实现。
   回落本身是设计（后端按优先级逐个补，功能不中断），但它带来一个陷阱：
   **运行模式是 remote，写入却落在本机** —— 此时若按 mode 判断文案，
   界面就会说「已保存」，而资料只写进了这台手机。
   判据只能是「这次到底写到了哪里」（返回值里的 `isLocal`）。
   ================================================================ */
async function cloudFallbackChecks(rt) {
  head('第 5 节 · 云模式 + 端点未实现（501 回落）');
  const { api, mem, toasts, pageDef, cloudCalls } = rt;
  const content = require(path.join(PROJECT, 'data/content.js'));
  const CFG = content.profile;

  rt.restoreConfig();
  check('已切回项目真实的云开发传输层', api.transport() === 'cloud', api.transport());

  mem.sp_sign_in = true;
  mem.sp_user = { id: 'local-2002', nickName: '孙七', avatarUrl: '', email: '', plan: '' };

  const page = makePage(pageDef);
  page.onLoad();
  await wait(40);
  rt.reset();
  check('云模式下页面提示「会同步到账号」（部署后即为事实，过渡期是乐观表述）', page.data.remote === true);

  page.setData({ 'form.nickname': '周八' });
  page.onSave();
  await wait(40);

  check(
    '确实调用了云函数（不是跳过远端直接写本机）',
    cloudCalls.some((c) => c.data && c.data.path === '/v1/user/profile' && c.data.method === 'PUT'),
    cloudCalls.map((c) => c.data && c.data.method + ' ' + c.data.path).join(' | ')
  );
  check(
    '⚠️ 501 回落时不得显示成「已保存」（资料其实只写了本机）',
    toasts.length === 1 && toasts[0].title === CFG.savedLocal && toasts[0].title !== CFG.saved,
    toasts[0] && toasts[0].title
  );
  check('回落是**有效写入**（不是失败），本机确实存下了新昵称', (mem.sp_user || {}).nickName === '周八', JSON.stringify((mem.sp_user || {}).nickName));

  /* 反向自测：把云函数换成「真的实现了」的回复，文案必须回到「已保存」——
     否则上一条断言可能只是因为文案被写死了，而不是真的在分辨送达位置。 */
  rt.setCloudReply({ code: 0, message: '', data: { id: 'u_9', nickName: '周八', isLocal: undefined } });
  rt.reset();
  page.setData({ 'form.nickname': '吴九' });
  page.onSave();
  await wait(40);
  check(
    '端点可用时文案回到「已保存」（证明判据真的在分辨送达位置）',
    toasts.length === 1 && toasts[0].title === CFG.saved,
    toasts[0] && toasts[0].title
  );

  // 还原成 501（线上现状），避免影响后续真机量取
  rt.setCloudReply({ code: 501, message: '该接口尚未在云端实现', data: null });
}

/* ================================================================
   第 5b 节 · 存储迁移（老设备上的历史残留）
   ================================================================
   代码里的默认值只对「Storage 里**没有**这个键」生效（store.get 的 fallback）。
   一个键一旦被写过，改默认值救不回老设备 —— 「默认收藏预置了多伦多」就是这样：
   新装用户干净了，但已经跑过的设备上那颗星一直在。所以必须有一次性迁移。
   这里用 mem 直接构造各种老设备快照，验证迁移的边界（宁可少清，不可多清）。
   ================================================================ */
function storeMigrationChecks(rt) {
  head('第 5b 节 · 存储迁移（v1 → v2：清掉种下的默认收藏）');
  const store = require(path.join(PROJECT, 'utils/store.js'));
  const { mem } = rt;
  const K = store.KEY;

  /* ---- 老设备：收藏里只有那个种子值 → 清掉 ---- */
  delete mem[K.ver];
  mem[K.favorites] = ['toronto'];
  store.migrate();
  check('老设备上的种子收藏被清掉', (mem[K.favorites] || []).length === 0, JSON.stringify(mem[K.favorites]));
  check('迁移后落版本号，不会每次都跑', Number(mem[K.ver]) === 2, String(mem[K.ver]));

  /* ---- 幂等：迁移过的设备上，用户重新收藏的多伦多必须留住 ---- */
  mem[K.favorites] = ['toronto'];
  store.migrate();
  check(
    '幂等：迁移只跑一次，用户后来自己收藏的多伦多不会被再清',
    JSON.stringify(mem[K.favorites]) === '["toronto"]',
    JSON.stringify(mem[K.favorites])
  );

  /* ---- 收藏多于种子值 → 一行都不许动 ---- */
  delete mem[K.ver];
  mem[K.favorites] = ['toronto', 'ubc'];
  store.migrate();
  check(
    '用户自己收藏过的（种子 + 其它）一律不动',
    JSON.stringify(mem[K.favorites]) === '["toronto","ubc"]',
    JSON.stringify(mem[K.favorites])
  );

  /* ---- 只收藏了别的院校 → 不动 ---- */
  delete mem[K.ver];
  mem[K.favorites] = ['ubc'];
  store.migrate();
  check('只收藏了别的院校时不动', JSON.stringify(mem[K.favorites]) === '["ubc"]', JSON.stringify(mem[K.favorites]));

  /* ---- 全新用户：迁移不得凭空写一个 sp_favorites 键进去 ---- */
  delete mem[K.ver];
  delete mem[K.favorites];
  store.migrate();
  check(
    '全新设备：迁移不会凭空造出一个空收藏键',
    !Object.prototype.hasOwnProperty.call(mem, K.favorites),
    JSON.stringify(mem[K.favorites])
  );

  /* ---- 迁移必须在启动时就跑 ---- */
  check('app.onLaunch 调用 store.migrate()', /onLaunch\(\)[\s\S]{0,220}store\.migrate\(\)/.test(read(path.join(PROJECT, 'app.js'))));

  // ⚠️ 2026-09-24：原先这里还有一条「分包 store.js 拷贝与主包一致」——
  //    微信 AI 独立分包（`miniprogram/skills/`）已整体移除（Skill 提审被驳回），
  //    store.js 现在只剩主包一份，影子副本断言随之删除。
  //    若将来恢复分包，这条要一并加回（见 `版本备注.md`）。

  delete mem[K.ver];
  delete mem[K.favorites];
}

/* ================================================================
   第 6 节 · 真机量取（可选，需开发者工具 + 服务端口）
   ================================================================ */
async function runtimeChecks() {
  head('第 6 节 · 真机量取（微信开发者工具）');
  let automator;
  try {
    automator = require('miniprogram-automator');
  } catch (e) {
    skip('真机量取', '未安装 miniprogram-automator');
    return;
  }

  console.log('  正在拉起开发者工具，首次编译约需 20–60 秒…');
  let miniProgram;
  try {
    miniProgram = await automator.launch({
      cliPath: CLI_PATH,
      projectPath: PROJECT,
      port: AUTO_PORT,
      timeout: 90000,
    });
  } catch (e) {
    skip('真机量取', (e && e.message ? e.message : e) + ' ｜ 请在开发者工具「设置 → 安全设置」打开「服务端口」后重试');
    return;
  }

  try {
    const page = await miniProgram.reLaunch(PAGE_URL);
    await page.waitFor(1200);

    const av = await page.$('.av__box');
    check('头像区已渲染', !!av);
    if (av) {
      const avWxml = await av.wxml();
      check(
        '头像占位不是空白块（含真实 PNG 图源）',
        /data:image\/png;base64,[A-Za-z0-9+/=]{40,}/.test(avWxml) && avWxml.indexOf('icon--missing') < 0
      );
      const o = await av.offset();
      const s = await av.size();
      check('头像为 84×84 的圆', Math.abs(s.width - 84) < 1.5 && Math.abs(s.height - 84) < 1.5, `${s.width}×${s.height}`);
      check('头像未被导航栏遮挡', o.top > 44, `top=${o.top}`);
    }

    const rows = await page.$$('.frow');
    check('渲染出 4 行字段（昵称/邮箱/年级/城市）', rows.length === 4, `共 ${rows.length} 行`);

    const cta = await page.$('.cta-bar');
    check('底部保存栏已渲染', !!cta);
    if (cta) {
      const co = await cta.offset();
      const cs = await cta.size();
      check(
        '保存栏贴底（bottom ≈ 屏高）',
        Math.abs(co.top + cs.height - 812) < 40,
        `bottom=${(co.top + cs.height).toFixed(1)}`
      );
    }

    // 输入行里没有硬编码中文，且标签来自内容层
    const bodyWxml = await (await page.$('.prof__body')).wxml();
    check('真机渲染的文案来自内容层（含「昵称」标签）', bodyWxml.indexOf('昵称') > -1);

    await miniProgram.close();
  } catch (e) {
    try {
      await miniProgram.close();
    } catch (_) {}
    throw e;
  }
}

/* ================================================================ */
(async () => {
  console.log('='.repeat(64));
  console.log('个人资料页（10）界面验证');
  console.log('='.repeat(64));

  staticChecks();

  const rt = setupRuntime();
  const mem = await logicChecks(rt);
  // 退出登录的回归必须在**本地模式**下跑（第 3 节会把传输层切成 rest）
  await accountLogoutChecks(rt);
  await remoteChecks(rt, mem);
  await cloudFallbackChecks(rt);
  storeMigrationChecks(rt);

  if (WITH_RUNTIME) await runtimeChecks();
  else console.log('\n  （真机量取未启用，加 --runtime 可跑）');

  console.log('\n' + '='.repeat(64));
  console.log(`结果：${pass} 通过 / ${failures.length} 失败${skipped ? ` / ${skipped} 跳过` : ''}`);
  if (failures.length) failures.forEach((f) => console.log('  ✗ ' + f));
  console.log('='.repeat(64));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('\n✗ 验证中断：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
