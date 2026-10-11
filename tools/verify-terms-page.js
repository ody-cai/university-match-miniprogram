#!/usr/bin/env node
/**
 * 条款页（00a）启动判定验证台
 * ==================================================================
 * 对应 2026-09-20 用户反馈：「我已经登录过了，却每次打开小程序都要再看一遍服务条款页」。
 *
 * 三个根因（都是**跑起来才看得出来**的）：
 *
 *   1) 同意态判定被挂在网络回调上
 *      `onLoad` 里把 `api.isAgreed()` 写在 `api.loadContent().then()` 内部 ——
 *      isAgreed 是同步读本地 Storage，跟内容配置毫无关系，却要等一次
 *      `/v1/content` 云函数往返（CONFIG.timeout = 15s）才决定跳不跳。
 *      云函数冷启动 + 弱网下，用户就完整地看到协议页 →「又让我看一遍」。
 *      → 断言：loadContent 永不 resolve 时，已同意用户仍必须跳转。
 *
 *   2) 跳转没有 fail 兜底
 *      `onAgree` 里写了 `fail: () => wx.reLaunch(...)`，`onLoad` 里却漏了 ——
 *      冷启动首屏 switchTab 一旦失败就是静默停住，无任何提示。
 *      → 断言：switchTab 失败时必须 reLaunch。
 *
 *   3) 同意写入失败被吞掉
 *      `api.agreeTerms()` 的返回值被丢弃，紧接着无条件 switchTab ——
 *      Storage 写失败（配额满 / 异常）时用户进了首页，下次启动又被要求同意，
 *      死循环且全程无提示。
 *      → 断言：写入失败时**不得**放行，且必须给提示。
 *
 * 另有显示缺陷：
 *   4) `docs` 初始值是空数组字面量，首帧三份条款入口整块空白，
 *      等 loadContent 回来才出现（版式跳动）。应取 `api.content().terms.docs`。
 *
 * 用法：node tools/verify-terms-page.js
 */
const fs = require('fs');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', 'miniprogram');
const TERMS_JS = path.join(PROJECT, 'pages', 'terms', 'terms.js');
const TERMS_WXML = path.join(PROJECT, 'pages', 'terms', 'terms.wxml');
const CONTENT_JS = path.join(PROJECT, 'data', 'content.js');

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

/** 去掉注释，避免注释里的示例代码被静态断言当真 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ================================================================
   第 1 节 · 静态守卫
   ================================================================ */
function staticChecks() {
  head('第 1 节 · 静态守卫（防止同一个坑被重新踩进去）');

  const js = fs.readFileSync(TERMS_JS, 'utf8');
  const clean = stripComments(js);

  // 1.1 onLoad 里必须先做同步判定，再谈加载内容
  const onLoadBody = (clean.match(/onLoad\s*\([^)]*\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || '';
  const posAgreed = onLoadBody.indexOf('isAgreed');
  const posLoad = onLoadBody.indexOf('loadContent');
  check(
    'onLoad 里 isAgreed 判定早于 loadContent 调用',
    posAgreed > -1 && posLoad > -1 && posAgreed < posLoad,
    `isAgreed@${posAgreed} loadContent@${posLoad}`
  );

  // 1.2 跳转一律带 fail 兜底
  const switchCalls = clean.match(/wx\.switchTab\s*\(/g) || [];
  const reLaunchCalls = clean.match(/wx\.reLaunch\s*\(/g) || [];
  check(
    '每处 switchTab 都配了 reLaunch 兜底',
    switchCalls.length > 0 && reLaunchCalls.length >= switchCalls.length,
    `switchTab×${switchCalls.length} reLaunch×${reLaunchCalls.length}`
  );

  // 1.3 同意写入的返回值必须被使用（不能裸调用）
  const naked = /api\.agreeTerms\s*\(\s*\)\s*;/.test(clean);
  check('agreeTerms() 的返回值被用于守卫，未裸调用', !naked);

  // 1.4 docs 初始值必须来自内容层，不能是空数组字面量
  check('docs 初始值来自 api.content()，不是 []', !/docs\s*:\s*\[\s*\]/.test(clean));

  // 1.5 真实 api.agreeTerms 的返回值必须反映"是否真的写进去了"
  const apiSrc = fs.readFileSync(path.join(PROJECT, 'utils', 'api.js'), 'utf8');
  check(
    'api.agreeTerms() 返回真实写入结果（= store.isAgreed()）',
    /agreeTerms\s*:\s*\(\)\s*=>\s*\{[\s\S]{0,120}?store\.agree\(\)[\s\S]{0,120}?return\s+store\.isAgreed\(\)/.test(apiSrc)
  );

  // 1.6 内容层必须有"写入失败"的提示文案
  const content = require(CONTENT_JS);
  check(
    '内容层提供 terms.saveFailed 文案',
    typeof content.terms.saveFailed === 'string' && content.terms.saveFailed.length > 0,
    content.terms && content.terms.saveFailed
  );

  // 1.7 WXML：正文受 ready 守卫，判定完成前不渲染（避免"闪一下"）
  const wxml = fs.readFileSync(TERMS_WXML, 'utf8');
  check('WXML 正文受 ready 守卫（未判定完成不渲染）', /wx:if\s*=\s*"\{\{\s*ready\s*\}\}"/.test(wxml));

  // 1.8 WXML 里不得出现函数调用（WXS 的活，写进 {{}} 会静默失败）
  const callRe = /\{\{[^}]*[A-Za-z_$][\w$]*\s*\(/;
  check('WXML 绑定里没有函数调用', !callRe.test(wxml.replace(/<!--[\s\S]*?-->/g, '')));

  /* ---- 1.9 / 1.10 显示缺陷（2026-09-20 同批修掉） ---- */

  // 1.9 底部留白必须叠加安全区。动作栏实高 = 114 + safe，
  //     裸的 118px 在全面屏机型（safe=34）上会让正文最后一行被固定栏压住。
  const wxss = fs.readFileSync(path.join(PROJECT, 'pages', 'terms', 'terms.wxss'), 'utf8');
  const termsPad = (wxss.match(/\.terms\s*\{[^}]*padding-bottom\s*:\s*([^;]+);/) || [])[1] || '';
  check(
    '.terms 底部留白叠加了 env(safe-area-inset-bottom)',
    /env\(safe-area-inset-bottom\)/.test(termsPad),
    termsPad.trim() || '未取到 padding-bottom'
  );

  // 1.10 微信 button 的 ::after 默认带边框，必须整体重置，
  //      否则禁用态 / ghost 变体都会多出一圈描边。
  const appWxss = fs.readFileSync(path.join(PROJECT, 'app.wxss'), 'utf8');
  check(
    '.btn 基础类重置了 button::after 的默认边框',
    /\.btn::after\s*\{[^}]*border\s*:\s*none/.test(appWxss),
    '只有 .btn--primary::after 会被其余变体漏掉'
  );
}

/* ================================================================
   第 2 节 · 页面逻辑（离线跑真实 terms.js 的 handler）
   ================================================================ */
async function logicChecks() {
  head('第 2 节 · 页面逻辑（mock wx，跑真实 handler）');

  const content = require(CONTENT_JS);
  const HOME = '/pages/home/home';

  /** 每个用例都重建一次页面，互不污染 */
  async function boot(opts) {
    const o = opts || {};
    const store = {};
    if (o.agreed) store['sp_agreed_terms'] = true;

    const log = { switchTab: [], reLaunch: [], toasts: [], modals: [], exits: 0 };
    let loadResolve = null;
    let loadReject = null;
    const loadPromise = new Promise((res, rej) => {
      loadResolve = res;
      loadReject = rej;
    });

    const apiStub = {
      content: () => content,
      loadContent: () => (o.neverResolve ? new Promise(() => {}) : loadPromise),
      /** 语义与真实实现一致：写入成功与否如实返回 */
      isAgreed: () => !!store['sp_agreed_terms'],
      agreeTerms: () => {
        if (o.writeFails) return false; // 模拟 Storage 写入失败
        store['sp_agreed_terms'] = true;
        return true;
      },
      tpl: (s, vars) =>
        String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : '')),
    };

    global.wx = {
      showToast: (x) => log.toasts.push(x),
      showModal: (x) => {
        log.modals.push(x);
        const pick = o.modalPick || 'cancel';
        if (x.success) x.success({ confirm: pick === 'confirm', cancel: pick === 'cancel' });
      },
      switchTab: (x) => {
        log.switchTab.push(x.url);
        if (o.switchTabFails) {
          if (x.fail) x.fail({ errMsg: 'switchTab:fail' });
        } else if (x.success) x.success({});
      },
      reLaunch: (x) => {
        log.reLaunch.push(x.url);
        if (x.success) x.success({});
      },
      exitMiniProgram: (x) => {
        log.exits++;
        if (x && x.fail && o.exitFails) x.fail({ errMsg: 'exitMiniProgram:fail' });
      },
      getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
      setStorageSync: (k, v) => {
        store[k] = v;
      },
    };

    const Module = require('module');
    const origRequire = Module.prototype.require;
    Module.prototype.require = function (req) {
      if (typeof req === 'string' && /utils\/api$/.test(req)) return apiStub;
      return origRequire.apply(this, arguments);
    };
    let def = null;
    global.Page = (d) => {
      def = d;
    };
    delete require.cache[require.resolve(TERMS_JS)];
    require(TERMS_JS);
    Module.prototype.require = origRequire;

    const page = Object.assign({}, def);
    page.data = JSON.parse(JSON.stringify(def.data));
    page.setData = function (patch) {
      Object.keys(patch).forEach((k) => {
        const parts = k.split('.');
        let cur = this.data;
        for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
        cur[parts[parts.length - 1]] = patch[k];
      });
    };
    const flush = () => new Promise((r) => setTimeout(r, 20));
    return { page, log, store, loadResolve, loadReject, flush, HOME };
  }

  /* ---- 2.1 已同意：即使内容请求永远不回来，也必须立刻跳走 ---- */
  {
    const b = await boot({ agreed: true, neverResolve: true });
    b.page.onLoad();
    await b.flush();
    check(
      '已同意 + 内容请求挂起 → 仍然跳转首页',
      b.log.switchTab.length === 1 && b.log.switchTab[0] === b.HOME,
      JSON.stringify(b.log.switchTab)
    );
    check('已同意时不重复索取同意（正文不渲染）', b.page.data.ready === false);
  }

  /* ---- 2.2 已同意 + switchTab 失败 → reLaunch 兜底 ---- */
  {
    const b = await boot({ agreed: true, neverResolve: true, switchTabFails: true });
    b.page.onLoad();
    await b.flush();
    check(
      'switchTab 失败 → reLaunch 兜底',
      b.log.reLaunch.length === 1 && b.log.reLaunch[0] === b.HOME,
      JSON.stringify(b.log.reLaunch)
    );
  }

  /* ---- 2.3 未同意：正常渲染，且首帧就有三份条款入口 ---- */
  {
    const b = await boot({ agreed: false });
    const docsAtFirstFrame = b.page.data.docs.slice();
    check(
      '首帧（onLoad 之前）docs 就有 3 项，不等网络',
      docsAtFirstFrame.length === 3,
      `${docsAtFirstFrame.length} 项`
    );
    b.page.onLoad();
    await b.flush();
    b.loadResolve(content);
    await b.flush();
    check('未同意时不跳转', b.log.switchTab.length === 0);
    check('未同意时正文渲染（ready=true）', b.page.data.ready === true);
    check('docs 为 3 项', b.page.data.docs.length === 3);
  }

  /* ---- 2.4 未勾选就点「同意并继续」 ---- */
  {
    const b = await boot({ agreed: false });
    b.page.onLoad();
    await b.flush();
    b.loadResolve(content);
    await b.flush();
    b.page.onAgree();
    check('未勾选 → 不放行', b.log.switchTab.length === 0);
    check('未勾选 → 给出提示', b.log.toasts.length === 1 && b.log.toasts[0].title === content.terms.needCheck);
  }

  /* ---- 2.5 勾选了但 Storage 写入失败：绝不放行 ---- */
  {
    const b = await boot({ agreed: false, writeFails: true });
    b.page.onLoad();
    await b.flush();
    b.loadResolve(content);
    await b.flush();
    b.page.onToggle();
    b.page.onAgree();
    check('写入失败 → 不放行（否则下次启动又是死循环）', b.log.switchTab.length === 0);
    check(
      '写入失败 → 如实提示而非静默',
      b.log.toasts.length === 1 && b.log.toasts[0].title === content.terms.saveFailed,
      JSON.stringify(b.log.toasts.map((t) => t.title))
    );
  }

  /* ---- 2.6 正常同意：写入 + 跳转 ---- */
  {
    const b = await boot({ agreed: false });
    b.page.onLoad();
    await b.flush();
    b.loadResolve(content);
    await b.flush();
    b.page.onToggle();
    check('勾选后 checked=true', b.page.data.checked === true);
    b.page.onAgree();
    check('同意后跳转首页', b.log.switchTab.length === 1 && b.log.switchTab[0] === b.HOME);
    check('同意态已落盘', b.store['sp_agreed_terms'] === true);
  }

  /* ---- 2.7 拒绝出口：两个选项都要有真实响应 ---- */
  {
    const b = await boot({ agreed: false, modalPick: 'confirm' });
    b.page.onLoad();
    await b.flush();
    b.loadResolve(content);
    await b.flush();
    b.page.onDecline();
    check('拒绝 → 弹确认框', b.log.modals.length === 1);
    check('确认后退出小程序', b.log.exits === 1);
    check('拒绝后不落盘同意态', b.store['sp_agreed_terms'] !== true);
  }
  {
    const b = await boot({ agreed: false, modalPick: 'cancel' });
    b.page.onLoad();
    await b.flush();
    b.loadResolve(content);
    await b.flush();
    b.page.onDecline();
    check('选「再想想」→ 不退出，停留在页内', b.log.exits === 0);
  }

  /* ---- 2.8 条款浮层 ---- */
  {
    const b = await boot({ agreed: false });
    b.page.onLoad();
    await b.flush();
    b.loadResolve(content);
    await b.flush();
    b.page.onOpenDoc({ currentTarget: { dataset: { key: 'service' } } });
    check('打开浮层 → doc 有正文', !!b.page.data.doc && b.page.data.doc.sections.length > 0);
    check(
      '浮层更新日期已插值（无残留 {date}）',
      b.page.data.docMeta.indexOf('{date}') === -1 && /\d{4}-\d{2}-\d{2}/.test(b.page.data.docMeta),
      b.page.data.docMeta
    );
    b.page.onCloseDoc();
    check('关闭浮层 → doc 置空', b.page.data.doc === null);
  }
}

(async function main() {
  console.log('条款页（00a）启动判定验证台');
  staticChecks();
  await logicChecks();

  console.log('\n' + '═'.repeat(64));
  if (failures.length === 0) {
    console.log(`全部通过：${pass} 条断言`);
    process.exit(0);
  }
  console.log(`通过 ${pass} 条，失败 ${failures.length} 条：`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
})();
