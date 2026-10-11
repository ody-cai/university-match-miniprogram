#!/usr/bin/env node
'use strict';
/**
 * 用真实浏览器（本机 Chrome，无头）验证管理台端到端可用。
 *
 * 为什么不能只靠 HTTP 断言：管理台是纯前端 SPA，接口地址要靠 location.pathname 相对解析。
 * 曾出现「所有 HTTP 断言通过、但浏览器里一进去就报错」的缺陷 —— 页面 fetch('/admin-api/x')
 * 被解析到站点根，命中云网关 INVALID_PATH 404。只有真的跑一次浏览器才能发现。
 *
 * 用法（密钥不落命令行，从文件读入环境变量）：
 *   ADMIN_KEY="$(cat admin/.admin-key)" node tools/browser-check-admin.js
 *
 * 只做只读操作：登录、切换页签、读取渲染结果。不发布、不改工单、不碰线上数据。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * 目标站点。默认打线上；`ADMIN_BASE` 可指向**本机预览台**，用同一套断言先在本地跑通：
 *
 *   node tools/preview-admin.js &
 *   ADMIN_BASE=http://127.0.0.1:9100 ADMIN_KEY=preview-only-key-not-for-production-use \
 *     node tools/browser-check-admin.js
 *
 * 两者跑的是同一套断言是有意的：预览台的页面、样式、接口逻辑都是真实文件，
 * 只有数据是内存样例 —— 于是「本地全绿、线上翻车」这类差异只剩环境本身，
 * 而不是「两套测试各测各的」。
 */
const HOST = process.env.ADMIN_BASE;
if (!HOST) {
  console.error('✖ 请设置 ADMIN_BASE 环境变量（例如：https://<env-id>-<app-id>.ap-shanghai.app.tcloudbase.com）');
  process.exit(1);
}
// ⚠️ 用**不带斜杠**的地址：这才是用户真的会输入/收藏的入口。
//    曾因为这里写死 `/admin/`，把「无斜杠时相对资源解析到站点根 → 样式和脚本双双 404」
//    这个真实缺陷整轮漏掉：测试里带斜杠一切都对，用户看到的是没有 CSS 的裸 HTML。
const PAGE_URL = HOST + '/admin';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;

let pass = 0;
let fail = 0;
function check(title, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + title); }
  else { fail++; console.log('  ✗ ' + title + (detail !== undefined ? '\n      ' + detail : '')); }
}
function head(t) { console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 极简 CDP 客户端：用 Node 内置 WebSocket，零 npm 依赖。
 *
 * ⚠️ 两个踩过的坑，别再踩回去（都会伪装成「脚本明明成功、却什么都没做」）
 * ------------------------------------------------------------------
 * 1) **必须给 Chrome 加 --no-sandbox**（见下方 spawn 处）。
 *    本机沙箱会拦掉 Chrome 自己的进程沙箱，Chrome 会打印
 *    「sandbox initialization failed: Operation not permitted」并让 network service
 *    反复崩溃重启；DevTools 的 WebSocket 恰好由 network service 承载，于是
 *    握手返回 101 之后**连接立刻被对端半关闭**。加 --no-sandbox 即恢复。
 *    （顺带排除过的两个错误猜想：--remote-allow-origins 无效；permessage-deflate
 *     也不是原因 —— 内置 WebSocket 在 --no-sandbox 下收发完全正常。）
 * 2) **必须处理 error / close 事件**。连接异常时若 Promise 既不 resolve 也不 reject，
 *    而事件循环里又只剩这个 Promise，Node 会**静默以退出码 0 结束** ——
 *    表现为「一行输出都没有，却报成功」。这是最难察觉的一类假成功。
 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let settled = false;
    let dead = false;
    const pending = new Map();
    const listeners = [];

    // 统一的「连接已死」处理。两种时机都要覆盖：
    //   a) 还没 resolve 就断开 → reject 掉整个 connect
    //   b) **已经 resolve 之后**才断开 → 必须把**所有在途请求**全部 reject。
    //     只做 a) 是不够的：曾经就是漏了 b)，导致已发出的 send() 永远不落定，
    //     Node 在没有其它活跃句柄时静默以 0 退出，整台验证台「零输出、却报成功」。
    const kill = (reason) => {
      if (dead) return;
      dead = true;
      const err = new Error(reason);
      pending.forEach((p) => p.rej(err));
      pending.clear();
      listeners.forEach((fn) => fn({ method: '__cdpClosed', params: { reason } }));
      if (!settled) { settled = true; reject(err); }
    };
    ws.addEventListener('error', () => kill('CDP WebSocket 连接失败（Chrome 是否因沙箱问题崩溃？需 --no-sandbox）'));
    ws.addEventListener('close', (ev) => kill('CDP WebSocket 被对端关闭，close code=' + ev.code + (ev.reason ? ' reason=' + ev.reason : '')));
    ws.addEventListener('open', () => {
      settled = true;
      resolve({
        send(method, params = {}) {
          if (dead) return Promise.reject(new Error('CDP 连接已断开，无法发送 ' + method));
          const mid = ++id;
          return new Promise((res, rej) => {
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        on(fn) { listeners.push(fn); },
        close() { try { ws.close(); } catch (e) { /* 忽略 */ } },
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      } else if (msg.method) {
        listeners.forEach((fn) => fn(msg));
      }
    });
  });
}

(async function main() {
  const KEY = process.env.ADMIN_KEY;
  if (!KEY) { console.error('缺少 ADMIN_KEY 环境变量。用法：ADMIN_KEY="$(cat admin/.admin-key)" node tools/browser-check-admin.js'); process.exit(2); }
  if (!fs.existsSync(CHROME)) { console.error('未找到 Chrome：' + CHROME); process.exit(2); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-check-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    // ⚠️ 必加：本机沙箱会阻止 Chrome 初始化自己的沙箱，其 network service 会反复崩溃，
    //    导致 DevTools WebSocket 在 101 握手后立刻被断开。缺了这行整个验证台会静默假成功。
    '--no-sandbox', '--disable-setuid-sandbox',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let cdp = null;
  try {
    /* ---------- 等到 CDP 端口就绪 ---------- */
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (e) { /* 还没起来 */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('Chrome 调试端口未就绪');
    cdp = await connect(target.webSocketDebuggerUrl);

    const consoleErrors = [];
    const failedRequests = [];
    const apiResponses = [];
    const hostResponses = [];
    cdp.on((msg) => {
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const text = msg.params.entry.text || '';
        // favicon 缺失与云开发中间页自身的 404 不属于管理台缺陷，不计入
        if (!/favicon/i.test(text)) consoleErrors.push(text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('未捕获异常：' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
      if (msg.method === 'Network.loadingFailed') {
        failedRequests.push(msg.params.errorText);
      }
      if (msg.method === 'Network.responseReceived') {
        const u = msg.params.response.url;
        if (u.includes('/admin-api/')) apiResponses.push({ url: u, status: msg.params.response.status });
        if (u.startsWith(HOST)) hostResponses.push({ url: u, status: msg.params.response.status, type: msg.params.type });
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    let loadFlag = false;
    cdp.on((m) => { if (m.method === 'Page.loadEventFired') loadFlag = true; });
    const waitForLoad = async (ms = 25000) => {
      loadFlag = false;
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (loadFlag) return true; await sleep(200); }
      return false;
    };

    await cdp.send('Page.navigate', { url: PAGE_URL });
    await waitForLoad();

    /** 求值小工具：导航/上下文切换期间会失效，失败即重试 */
    const evaluate = async (expression, opts = {}) => {
      for (let i = 0; i < 5; i++) {
        try {
          const r = await cdp.send('Runtime.evaluate', Object.assign({ expression, returnByValue: true }, opts));
          return r.result.value;
        } catch (e) { await sleep(400); }
      }
      return undefined;
    };

    /* ---------- 0. 云开发默认测试域名的中间页 ----------
     * 直连 *.app.tcloudbase.com 的默认测试域名时，浏览器导航会被插入一张「页面访问提示」中间页
     * （HTTP 404 + #submitBtn「确定访问」，3 秒倒计时后才可点击）。
     * 这不是管理台自身的缺陷，但会让人误以为「打不开」。这里显式识别并跳过，同时把事实报出来。 */
    /* ---------- 0a. 资源地址解析：两种入口都必须能加载样式与脚本 ----------
     * 真实事故：用户直接输入不带斜杠的 /admin，而页面用相对地址引用资源 ——
     *   /admin  → 站点根 /styles.css      （404，页面变成一堆裸 HTML，页签点了也不动）
     *   /admin/ → /admin/styles.css       （正常）
     * 测试当时写死了带斜杠的地址，于是「全绿」却漏掉了用户每天真正打开的那个入口。
     * 这里按浏览器规则（含 <base>）真实解析并请求，两种入口都要过。 */
    head('0a · 样式与脚本地址（无斜杠 / 有斜杠两种入口都要能加载）');
    const pageHtml = await (await fetch(PAGE_URL)).text();
    const baseTag = (pageHtml.match(/<base[^>]+href="([^"]+)"/) || [])[1] || '';
    check('页面声明了 <base>（否则无斜杠入口的相对资源会落到站点根）', !!baseTag, '未找到 <base href>');
    const assetRefs = [...pageHtml.matchAll(/<link[^>]+href="([^"]+)"|<script[^>]+src="([^"]+)"/g)].map((m) => m[1] || m[2]);
    check('页面引用了样式表与脚本', assetRefs.length >= 2, JSON.stringify(assetRefs));
    for (const entry of [PAGE_URL, PAGE_URL + '/']) {
      const from = new URL(baseTag || entry, entry).href;      // 先按 <base> 定位，再解析相对地址
      const resolved = assetRefs.map((r) => new URL(r, from).href);
      const codes = await Promise.all(resolved.map(async (u) => (await fetch(u)).status));
      check('入口 ' + new URL(entry).pathname + ' 的资源全部可加载',
        codes.every((c) => c === 200),
        JSON.stringify(resolved.map((u, i) => new URL(u).pathname + '→' + codes[i])));
    }

    head('0 · 云开发测试域名中间页');
    const intermediate = await evaluate('!!document.getElementById("submitBtn") && /测试域名/.test(document.body.innerText)');
    check('已识别是否被中间页拦截', intermediate === true || intermediate === false, String(intermediate));
    if (intermediate) {
      console.log('    ℹ 命中腾讯云 CloudBase 测试域名中间页，自动点击「确定访问」继续');
      await evaluate(`(async () => {
        const b = document.getElementById('submitBtn');
        for (let i = 0; i < 20 && b && b.disabled; i++) await new Promise(r => setTimeout(r, 500));
        if (b) b.click();
        return true;
      })()`, { awaitPromise: true });
      await waitForLoad();
    }

    // app.js 是外部脚本，DOM 解析完 ≠ 脚本执行完。必须等到 app.js 真正跑完，
    // 否则 #loginBtn 上还没有任何监听器：点击不会有反应、也不报错，看起来像「登录没反应」。
    const appReady = async (ms = 30000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const ok = await evaluate('document.readyState === "complete" && (0,eval)("typeof boot") === "function" && (0,eval)("typeof api") === "function"');
        if (ok === true) return true;
        await sleep(300);
      }
      return false;
    };
    check('管理台脚本已完整执行（boot/api 已定义）', await appReady());
    // app.js 就绪之前的控制台报错 / 网络响应属于云开发中间页自身（它是 404 的占位页，还会缺 favicon），
    // 与管理台无关，单独留存为参考信息；第 4 节只对「脚本就绪之后」的报错与资源做断言。
    const preReadyConsole = consoleErrors.splice(0, consoleErrors.length);

    /* ---------- 1. 首屏 ---------- */
    head('1 · 真实浏览器打开管理台');
    const first = await evaluate('document.title + " | " + document.getElementById("loginView").className');
    check('页面标题为运营管理台', /运营管理台/.test(first || ''), JSON.stringify(first));
    check('登录区默认可见（未登录不展示数据）', /login-view/.test(first || ''), JSON.stringify(first));

    // 只断言「HTML 里有 styles.css」是不够的 —— 关键在**样式是否真的生效**。
    // 直接读计算样式：.metric-grid 默认是 block，只有 CSS 生效才会是 grid。
    const styleProbe = await evaluate(`(() => {
      const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
      const grid = cs('#overviewCards');
      const mark = cs('.brand-mark');
      return {
        sheets: document.styleSheets.length,
        gridDisplay: grid ? grid.display : null,
        markBg: mark ? mark.backgroundColor : null,
      };
    })()`);
    check('样式表已加载（styleSheets 非空）', styleProbe && styleProbe.sheets >= 1, JSON.stringify(styleProbe));
    check('样式已真正生效（#overviewCards 计算为 grid 布局）', styleProbe && styleProbe.gridDisplay === 'grid', JSON.stringify(styleProbe));
    check('样式已真正生效（品牌块底色来自 CSS 变量）', styleProbe && /rgb\(35,\s*88,\s*215\)/.test(styleProbe.markBg || ''), JSON.stringify(styleProbe));

    /* ---------- 2. 真实登录点击 ---------- */
    head('2 · 输入密钥并点击登录（真实点击，非模拟请求）');
    const loginExpr = `(async () => {
      const $ = (s) => document.querySelector(s);
      if (!$('#keyInput')) return { stage: 'no-form' };
      $('#keyInput').value = ${JSON.stringify(KEY)};
      const keyInputLen = $('#keyInput').value.length;
      $('#loginBtn').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const d = $('#dashboardView');
        if (d && !d.classList.contains('hidden')) break;
        await new Promise(r => setTimeout(r, 200));
      }
      // 概览区先渲染、工单列表是随后的异步请求，必须等它落定再断言，否则读到的是骨架屏。
      let ticketsSettled = false;
      const t1 = Date.now();
      while (Date.now() - t1 < 15000) {
        const p = $('#ticketsPanel');
        if (p && !/skeleton/.test(p.innerHTML) && p.innerText.trim().length > 0) { ticketsSettled = true; break; }
        await new Promise(r => setTimeout(r, 300));
      }
      const d = $('#dashboardView');
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      return {
        stage: 'done',
        keyInputLen: keyInputLen,
        ticketsSettled: ticketsSettled,
        dashboardVisible: !!(d && !d.classList.contains('hidden')),
        loginError: norm($('#loginError') && $('#loginError').textContent),
        connection: norm($('#connectionState') && $('#connectionState').textContent),
        cards: norm($('#overviewCards') && $('#overviewCards').innerText),
        ticketsPanel: norm($('#ticketsPanel') && $('#ticketsPanel').innerText).slice(0, 400),
      };
    })()`;
    const login = (await evaluate(loginExpr, { awaitPromise: true })) || {};
    check('密钥成功填入输入框', login.keyInputLen === KEY.length, 'keyInputLen=' + login.keyInputLen + ' 期望=' + KEY.length);
    check('登录后进入概览（dashboard 可见）', login.dashboardVisible === true, JSON.stringify(login));
    check('没有出现登录错误提示', !login.loginError, 'loginError=' + login.loginError);
    check('连接状态显示已连接', login.connection === '已连接', 'status=' + login.connection);
    check('概览指标已渲染（含「全部工单」「注册用户」「可管理院校」）',
      /全部工单/.test(login.cards || '') && /注册用户/.test(login.cards || '') && /可管理院校/.test(login.cards || ''), login.cards);
    check('工单面板加载完成且无报错（有列表或空态）',
      login.ticketsSettled === true && !/加载工单失败/.test(login.ticketsPanel || '') && /工单|暂无/.test(login.ticketsPanel || ''),
      'settled=' + login.ticketsSettled + ' text=' + login.ticketsPanel);

    /* ---------- 3. 逐个页签打开（覆盖各数据接口） ----------
       ⚠️ 页签集合由页面自己声明（读 data-tab），不在脚本里写死一份 ——
          写死的话新增/删除页签时这里不会变红，等于没覆盖。
       ⚠️ **不能用固定 sleep**：慢网络下读到的还是骨架屏，而骨架 `skeleton` 没有文字，
          `innerText` 就是空串 —— 看起来像「面板渲染失败」，实际只是没等它落定。
          2026-09-22 打线上时就这样误报了「院校数据页签没有可渲染的面板」3 条。
          ⇒ 轮询到不再出现骨架为止，并把「15 秒还没内容」单独报成一条失败，
            让「慢」和「坏」在输出里分得开。 */
    head('3 · 切换到用户档案 / 院校数据页签');
    const tabsExpr = `(async () => {
      const $ = (s) => document.querySelector(s);
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      const out = {};
      const tabs = Array.from(document.querySelectorAll('.tab'));
      out.__ids = tabs.map((t) => t.dataset.tab);
      for (const t of tabs) {
        t.click();
        const t0 = Date.now();
        while (Date.now() - t0 < 15000) {
          const el = $('#' + t.dataset.tab + 'Panel');
          if (el && !/skeleton/.test(el.innerHTML) && el.innerText.trim().length > 0) break;
          await new Promise(r => setTimeout(r, 250));
        }
        const el = $('#' + t.dataset.tab + 'Panel');
        out[t.dataset.tab] = el ? norm(el.innerText).slice(0, 500) : null;
        out['__settled_' + t.dataset.tab] = !!(el && el.innerText.trim().length > 0);
      }
      return out;
    })()`;
    const tabs = (await evaluate(tabsExpr, { awaitPromise: true })) || {};
    const tabIds = tabs.__ids || [];
    check('页面没有「内容管理」页签（该入口已下线）', tabIds.indexOf('content') === -1, JSON.stringify(tabIds));
    check('页面有「用户档案」页签', tabIds.indexOf('users') > -1, JSON.stringify(tabIds));
    for (const id of tabIds) {
      check('页签 ' + id + ' 在 15 秒内渲染出内容（不是一直停在骨架屏）', tabs['__settled_' + id] === true, JSON.stringify(tabs[id]));
      check('页签 ' + id + ' 没有加载失败提示', !/加载.*失败/.test(tabs[id] || ''), tabs[id]);
    }
    check('用户档案页签渲染出列表或空态', /用户档案/.test(tabs.users || '') && /档案|还没有/.test(tabs.users || ''), tabs.users);
    check('院校数据页签加载成功（无失败提示）', tabs.schools && !/加载院校数据失败/.test(tabs.schools), tabs.schools);
    check('院校列表渲染出可编辑条目', /QS|编辑|院校/.test(tabs.schools || ''), tabs.schools);

    /* ---------- 3b. 用户档案详情弹层（只读） ----------
       列表渲染成功 ≠ 详情能用。详情的取数走的是另一条路径
       （/admin-api/users/{id}），而「点了没反应、也不报错」是本项目踩过的坑。 */
    head('3b · 打开用户档案详情');
    const userDetail = await evaluate(`(async () => {
      const $ = (s) => document.querySelector(s);
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      const usersTab = Array.from(document.querySelectorAll('.tab')).find((x) => x.dataset.tab === 'users');
      if (usersTab) usersTab.click();
      await new Promise((r) => setTimeout(r, 1500));
      const btn = document.querySelector('#usersPanel [data-action="user"]');
      if (!btn) return { stage: 'no-row' };
      btn.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        const m = $('#modal');
        const b = $('#modalBody');
        if (m && !m.classList.contains('hidden') && b && !/skeleton/.test(b.innerHTML) && b.innerText.trim()) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const m = $('#modal');
      const b = $('#modalBody');
      const code = b && b.querySelector('code');
      return {
        stage: 'opened',
        body: norm(b && b.innerText).slice(0, 800),
        html: (b && b.innerHTML) || '',
        archiveId: code ? code.textContent : '',
        // 逐条 dt 取字段名：用「有没有 openid 这个字段」判定，而不是全文检索 ——
        // 弹层里本来就有一句**解释**「openid 不下发」，全文检索会把这句话当违规。
        fields: Array.from(b ? b.querySelectorAll('dt') : []).map((x) => x.textContent.trim()),
      };
    })()`, { awaitPromise: true }) || {};
    check('用户档案列表里有可点开的条目', userDetail.stage === 'opened', JSON.stringify(userDetail));
    check('详情弹层展示了基本信息字段', /昵称/.test(userDetail.body || '') && /登录状态/.test(userDetail.body || '') && /建档时间/.test(userDetail.body || ''), userDetail.body);
    /**
     * ⚠️ 成绩档案与收藏自 2026-09-22 起**已上云**，用户详情里会真的展示它们。
     *    这条断言于是从「说明为什么看不到」改成「空态也要给原因、有值时结构要齐」。
     *    留白让人猜，和写一句「看不到」却不解释，是同一种毛病。
     */
    check(
      '详情弹层展示了成绩档案区块，且空态有原因（不留白让人猜）',
      /成绩档案/.test(userDetail.body || '') && /(还没有保存过成绩|高中均分)/.test(userDetail.body || ''),
      (userDetail.body || '').slice(0, 160)
    );
    check(
      '详情弹层展示了收藏院校区块，且两种空态可区分',
      /收藏院校/.test(userDetail.body || '') &&
        /(尚未同步过收藏|还没有收藏|收藏院校（\d+）|目前一所都没有)/.test(userDetail.body || ''),
      (userDetail.body || '').slice(0, 160)
    );
    check('详情里没有 openid 这个字段', (userDetail.fields || []).indexOf('openid') === -1, JSON.stringify(userDetail.fields));
    check('「档案 ID」显示的是不可逆哈希（64 位十六进制），不是微信标识',
      /^[a-f0-9]{64}$/.test(userDetail.archiveId || ''), JSON.stringify(userDetail.archiveId));
    /**
     * ⚠️ 判据必须落在**控件元素**上，不能拿「保存」这类词去全文匹配。
     *    2026-09-22 实测踩过：详情页里有一句「该用户还没有**保存**过成绩」，
     *    于是原写法 `!/保存/.test(html)` 直接变红 —— 而那跟「能不能编辑」
     *    毫无关系。同一个断言集里已经有过一次同类教训（见上方 fields 的注释：
     *    「不能用全文检索判 openid，因为弹层里本来就有一句解释」）。
     */
    check('详情弹层为只读（没有可编辑的输入框 / 下拉 / 按钮）',
      !/<(input|textarea|select|button)[\s>]/.test(userDetail.html || ''), (userDetail.html || '').slice(0, 200));
    // 关掉弹层，避免影响后续截图
    await evaluate(`(() => { const m = document.getElementById('modal'); if (m) m.classList.add('hidden'); return true; })()`);

    /* ---------- 4. 网络层：接口必须真的打到云函数且无 4xx/5xx ---------- */
    /* ---------- 3b. 工单详情里的「受理通知」区块（契约 4.9） ----------
     * 只断言它**渲染出来了**，**不点发送** —— 本台是只读的（见文件头），
     * 而发送会真的消耗用户那一条订阅额度。预览台虽是内存数据，纪律要一致。
     * 这一段守的是「拼出来的 DOM 在真实浏览器里不报错、且按钮真的在」——
     * `notifyBlock()` 是字符串拼接，语法检查过得去，渲染却可能整块空掉。 */
    head('3b · 工单详情的「受理通知」区块');
    const ticketDetail = await evaluate(`(async function(){
      var tab = Array.from(document.querySelectorAll('.tab')).find(function(x){ return x.dataset.tab === 'tickets'; });
      if (tab) tab.click();
      await new Promise(function(r){ setTimeout(r, 700); });
      var open = document.querySelector('[data-action="ticket"]');
      if (!open) return { opened: false };
      open.click();
      await new Promise(function(r){ setTimeout(r, 700); });
      var body = document.querySelector('#modalBody');
      var modal = document.querySelector('#modal');
      return {
        opened: true,
        modalVisible: !!(modal && !modal.classList.contains('hidden')),
        text: body ? body.innerText : '',
        hasButton: !!document.querySelector('[data-action="notify-ticket"]')
      };
    })()`, { awaitPromise: true });

    check('工单详情弹层能打开', !!(ticketDetail && ticketDetail.opened && ticketDetail.modalVisible),
      JSON.stringify(ticketDetail && { opened: ticketDetail.opened, visible: ticketDetail.modalVisible }));
    check('详情里有「受理通知」区块', !!(ticketDetail && /受理通知/.test(ticketDetail.text || '')),
      (ticketDetail && ticketDetail.text || '').slice(0, 160));
    check('从未发送过时给出「发送受理通知」按钮', !!(ticketDetail && ticketDetail.hasButton));
    check('详情文案不再声称「系统不会自动发送」', !(ticketDetail && /系统不会自动发送/.test(ticketDetail.text || '')));
    // 关掉弹层，避免影响第 4 节的网络断言与截图
    await evaluate("document.querySelector('#modalClose') && document.querySelector('#modalClose').click()");

    head('4 · 网络层（后台接口调用是否真的成功）');
    await sleep(500);
    check('至少发生了若干次 /admin-api 调用', apiResponses.length >= 3, JSON.stringify(apiResponses));
    const bad = apiResponses.filter((r) => r.status !== 200);
    check('所有 /admin-api 响应均为 200（无网关 404 / 鉴权失败）', bad.length === 0, JSON.stringify(bad));
    // 只看样式与脚本：这是「页面裸奔」的直接指标，且无歧义 —— 云开发中间页不会加载它们。
    // 不用时间切片区分「就绪前 / 就绪后」：真实页面的资源同样在就绪前就到达了。
    // 文档本身的成功与否已由标题、脚本执行、样式生效三组断言证明，这里不重复判断。
    const selfAssets = hostResponses.filter((r) => ['Stylesheet', 'Script'].includes(r.type) && !r.url.includes('/admin-api/'));
    const badAssets = selfAssets.filter((r) => r.status >= 400);
    check('页面自身的样式与脚本无 4xx', selfAssets.length >= 2 && badAssets.length === 0,
      JSON.stringify({ 共: selfAssets.length, 失败: badAssets }));
    check('浏览器控制台无错误（脚本就绪之后）', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 5)));
    if (preReadyConsole.length) console.log('    ℹ 中间页阶段的控制台噪音（不计入断言）：' + JSON.stringify(preReadyConsole.slice(0, 3)));

    /* ---------- 5. 截图留证 ---------- */
    head('5 · 截图留证');
    const outDir = path.join(__dirname, '..', 'reports');
    fs.mkdirSync(outDir, { recursive: true });
    /** 切好状态再截、截图前等页面落定；文件写入 reports/ 供人工复核 */
    const shoot = async (name, prep) => {
      if (prep) {
        await evaluate(prep, { awaitPromise: true });
        await sleep(1200);
      }
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(outDir, name);
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      return { path: p, size: fs.statSync(p).size };
    };
    const shotMain = await shoot('admin-console-check.png', `(() => {
      const t = Array.from(document.querySelectorAll('.tab')).find((x) => x.dataset.tab === 'tickets');
      if (t) t.click();
      window.scrollTo(0, 0);
      return true;
    })()`);
    check('已保存管理台截图（概览 + 工单）', shotMain.size > 10000, shotMain.path);
    // 新增功能必须有**看得见**的留证：只截图概览的话，「用户档案」出问题不会被发现
    const shotUsers = await shoot('admin-users-tab.png', `(async () => {
      const t = Array.from(document.querySelectorAll('.tab')).find((x) => x.dataset.tab === 'users');
      if (!t) return false;
      t.click();
      await new Promise((r) => setTimeout(r, 1800));
      const p = document.getElementById('usersPanel');
      if (p) p.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    check('已保存「用户档案」页签截图', shotUsers.size > 10000, shotUsers.path);

    console.log('\n' + '─'.repeat(64));
    console.log('截图：' + shotMain.path);
    console.log('      ' + shotUsers.path);
    console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + '）');
    console.log('─'.repeat(64));
  } catch (e) {
    console.error('\n验证过程出错：' + e.message);
    fail++;
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGKILL');
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  process.exit(fail > 0 ? 1 : 0);
})();
