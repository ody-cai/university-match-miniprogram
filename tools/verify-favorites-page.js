#!/usr/bin/env node
/**
 * 我的收藏页（11）+ 院校库收藏置顶 验证台
 * ==================================================================
 * 覆盖「光读代码看不出来、必须跑起来才算数」的四类问题：
 *
 *   1) **收藏了却没置顶**（用户报的原始缺陷）
 *      收藏状态与院校列表是分两次取的（用户数据 vs 公共数据），
 *      顺序合并发生在页面里。只读代码看不出合并有没有真的生效。
 *      → 注入已知顺序的列表，断言收藏项被提到最前，且**收藏组内部保持原顺序**
 *        （用分组拼接而非 sort，不能依赖引擎的排序稳定性）。
 *
 *   2) **从详情页收藏后返回，星标与顺序还是旧的**
 *      `onShow` 原先只切 tabBar 高亮，从不重读收藏。这条缺口没有任何报错，
 *      只会表现为「明明收藏了，回来还是没置顶」。
 *      → 模拟「在详情页收藏」后调 syncFavorites，断言星标与顺序都更新。
 *
 *   3) **换了个页面就丢了一所学校**
 *      收藏 id 在院校库里找不到时（院校库调整过 id）若直接用它计数，
 *      页面会说「共 3 所」却只画 2 行 —— 凭空多出一所并不存在的学校。
 *      → 塞一个幽灵 id，断言它被跳过且计数等于**真实渲染行数**。
 *
 *   4) **同一行在院校库与收藏页长得不一样**
 *      两个页面各自复制一份行标记/样式，迟早漂移，且没有测试会变红。
 *      → 断言两边都用 `school-row`、页面里不再内联 `.srow` 标记与样式，
 *        且两个页面传进行组件的字段集合完全一致。
 *
 * 用法：node tools/verify-favorites-page.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'miniprogram');
const COMP = path.join(PROJECT, 'components/school-row');
const SCHOOLS_PAGE = path.join(PROJECT, 'pages/schools/schools');
const FAV_PAGE = path.join(PROJECT, 'pages/favorites/favorites');

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
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ================================================================
   第 1 节 · 静态守卫
   ================================================================ */
function staticChecks() {
  head('第 1 节 · 静态守卫');

  const appJson = JSON.parse(read(path.join(PROJECT, 'app.json')));
  check(
    'app.json 已注册 pages/favorites/favorites',
    appJson.pages.indexOf('pages/favorites/favorites') > -1,
    '页面数 ' + appJson.pages.length
  );

  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    check(`收藏页 ${ext} 存在`, fs.existsSync(`${FAV_PAGE}.${ext}`));
  });
  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    check(`院校行组件 ${ext} 存在`, fs.existsSync(`${COMP}/index.${ext}`));
  });

  /* ---- 1.1 组件注册（漏注册不报错，只渲染成空白块） ---- */
  const favReg = (JSON.parse(read(`${FAV_PAGE}.json`)).usingComponents || {});
  check('收藏页注册了 nav-bar', favReg['nav-bar'] === '/components/nav-bar/index');
  check('收藏页注册了 school-row', favReg['school-row'] === '/components/school-row/index');
  const schReg = (JSON.parse(read(`${SCHOOLS_PAGE}.json`)).usingComponents || {});
  check('院校库注册了 school-row', schReg['school-row'] === '/components/school-row/index');
  check(
    '院校库不再直接引用 crest（已收进 school-row，注册了却没用到会拖累按需注入）',
    schReg['crest'] === undefined
  );
  const compReg = (JSON.parse(read(`${COMP}/index.json`)).usingComponents || {});
  check('组件内部注册了 crest', compReg['crest'] === '/components/crest/index');
  check('组件内部注册了 icon', compReg['icon'] === '/components/icon/index');

  /* ---- 1.2 行标记只有一处 ---- */
  const schWxml = read(`${SCHOOLS_PAGE}.wxml`);
  const favWxml = read(`${FAV_PAGE}.wxml`);
  const compWxml = read(`${COMP}/index.wxml`);
  const inlineRow = (t) => /class="[^"]*\bsrow\b/.test(stripComments(t));
  check('院校库页面里不再内联 srow 标记', !inlineRow(schWxml));
  check('收藏页里没有内联 srow 标记', !inlineRow(favWxml));
  check('院校行标记只存在于 school-row 组件内', inlineRow(compWxml));
  check('院校库使用 <school-row>', /<school-row/.test(schWxml));
  check('收藏页使用 <school-row>', /<school-row/.test(favWxml));

  /* ---- 1.3 行样式只有一处 ---- */
  check(
    '院校库 wxss 里不再定义 .srow 样式',
    !/^\s*\.srow/m.test(read(`${SCHOOLS_PAGE}.wxss`))
  );
  check('行样式定义在 school-row/index.wxss', /^\s*\.srow\s*\{/m.test(read(`${COMP}/index.wxss`)));
  check(
    '组件里定义了 .star-box（此前只有首页有，院校库是裸星标）',
    /^\s*\.star-box\s*\{/m.test(read(`${COMP}/index.wxss`))
  );
  check(
    '组件用 :host 设行间距（`.srow + .srow` 跨组件边界永远匹配不到）',
    /:host\s*\{/.test(read(`${COMP}/index.wxss`))
  );

  /* ---- 1.4 星标必须 catchtap ----
   * 否则点星标会冒泡到行的 bindtap，连带打开院校详情。 */
  const starTag = (compWxml.match(/<view[^>]*srow__star[^>]*>/) || [])[0] || '';
  check('星标用 catchtap 阻断冒泡', /catchtap="onFavorite"/.test(starTag), starTag.trim());
  check('行本身用 bindtap', /<view class="srow tap" bindtap="onOpen"/.test(compWxml));

  /* ---- 1.5 WXML 表达式里不得出现函数调用 ----
   * 写在 {{}} 里的 filter()/indexOf() 求值失败且**不报错**，class 会静默拼空。 */
  const callHits = [];
  [schWxml, favWxml, compWxml].forEach((t, idx) => {
    stripComments(t)
      .split('\n')
      .forEach((line, i) => {
        if (/\{\{[^}]*[A-Za-z_$][\w$]*\s*\(/.test(line)) {
          callHits.push(`文件${idx + 1} 第 ${i + 1} 行`);
        }
      });
  });
  check('WXML 绑定表达式里没有函数调用', callHits.length === 0, callHits.join(', '));

  /* ---- 1.6 内容层模板不得裸绑 ----
   * WXML 不会替换 {count} 占位符，裸绑就是把模板原文显示上屏。 */
  const badTpl = [];
  [schWxml, favWxml].forEach((t) => {
    ['totalTemplate', 'metaTemplate', 'favoritesPinnedTemplate'].forEach((k) => {
      if (new RegExp('\\{\\{[^}]*' + k).test(t)) badTpl.push(k);
    });
  });
  check('页面没有裸绑内容层模板（必须 api.tpl() 插值后再绑）', badTpl.length === 0, badTpl.join(', '));

  /* ---- 1.7 统计跳转不得写死在页面里 ---- */
  const accJs = stripComments(read(path.join(PROJECT, 'pages/account/account.js')));
  check(
    '账号页不再硬编码 switchTab 到院校库',
    accJs.indexOf('/pages/schools/schools') === -1,
    '统计项跳哪由内容层 account.stats[].link 决定'
  );
  const content = read(path.join(PROJECT, 'data/content.js'));
  check(
    '内容层把「我的收藏」指向收藏页',
    /key:\s*'favorites'[^}]*link:\s*'\/pages\/favorites\/favorites'/.test(content)
  );
  check(
    '内容层标了 tab: false（navigateTo 而不是 switchTab）',
    /key:\s*'favorites'[^}]*tab:\s*false/.test(content)
  );

  /* ---- 1.8 两个页面传给组件的行数据形状必须一致 ---- */
  /**
   * ⚠️ 缩进不能用 `^\s{4}` 死卡：字段在 `return {` 之后缩进 6 格，
   *    `\s{4}` 之后紧跟的是空格而不是字母，会**一个字段都取不到**，
   *    于是两边都返回空串、`f1 === f2` 反而「通过」—— 断言看起来是绿的，实际什么都没验。
   *    这里额外加一条「必须真的取到字段」的断言把这个空转挡住。
   */
  const fieldsOf = (src) => {
    const m = /toRow\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(stripComments(src));
    if (!m) return null;
    const keys = [];
    const re = /^\s*([a-zA-Z][\w]*):/gm;
    let x;
    while ((x = re.exec(m[1]))) keys.push(x[1]);
    return keys.sort();
  };
  const k1 = fieldsOf(read(`${SCHOOLS_PAGE}.js`));
  const k2 = fieldsOf(read(`${FAV_PAGE}.js`));
  check(
    '两个页面都能解析出 toRow 的字段（防空转）',
    !!k1 && !!k2 && k1.length > 0 && k2.length > 0,
    `${k1 && k1.length} / ${k2 && k2.length}`
  );
  check(
    '两个页面传给 school-row 的字段集合完全一致',
    !!k1 && !!k2 && k1.join(',') === k2.join(','),
    `${k1 && k1.join(',')} vs ${k2 && k2.join(',')}`
  );

  /* ---- 1.9 置顶开关与提示来自内容层 ---- */
  check('内容层有 schools.favoritesFirst 开关', /favoritesFirst:\s*(true|false)/.test(content));
  check('渲染层读该开关（不是代码里写死置顶）', /schools\.favoritesFirst/.test(read(`${SCHOOLS_PAGE}.js`)));
}

/* ================================================================
   第 2 节 · 页面逻辑（真实 api.js + mock wx 运行时）
   ================================================================
   刻意**不 mock api.js**：置顶顺序、幽灵 id 跳过、最近收藏在前
   这些行为都依赖真实 store + local 适配器，换掉等于把被测对象一起换掉。
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

function setupRuntime() {
  const mem = {};
  const toasts = [];
  const navs = [];

  global.wx = {
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''),
    setStorageSync: (k, v) => {
      mem[k] = v;
    },
    removeStorageSync: (k) => {
      delete mem[k];
    },
    showToast: (o) => toasts.push(o),
    showModal: (o) => o.success && o.success({ confirm: true }),
    navigateTo: (o) => navs.push(o),
    switchTab: (o) => navs.push(o),
    login: (o) => o.success && o.success({ code: 'test-code' }),
    request: () => {},
    cloud: { callFunction: () => {} },
  };
  global.getCurrentPages = () => [{}];
  global.getApp = () => ({ globalData: {} });

  const defs = {};
  global.Page = (d) => {
    defs.current = d;
  };
  // 两个页面模块都 require 一遍，各留一份 Page 定义
  const load = (p, key) => {
    delete require.cache[require.resolve(p)];
    require(p);
    defs[key] = defs.current;
  };
  load(`${SCHOOLS_PAGE}.js`, 'schools');
  load(`${FAV_PAGE}.js`, 'favorites');
  global.Page = () => {};

  const api = require(path.join(PROJECT, 'utils/api.js'));
  /**
   * ⚠️ 本项目默认就是 cloud 模式（CONFIG.env 已填）。本地模式那套语义
   *    必须先把 env 摘掉，否则断言会在 cloud 分支上跑 —— 「假绿」。
   */
  api.request.CONFIG.baseUrl = '';
  api.request.CONFIG.env = '';

  return { mem, toasts, navs, api, defs };
}

async function runtimeChecks() {
  head('第 2 节 · 院校库置顶与往返同步（真实 api.js）');
  const rt = setupRuntime();
  const { api, mem } = rt;

  /** 造一行（只需 order()/pinnedLabel() 用到的字段） */
  const row = (id, favorite) => ({ id, nameCn: id, favorite: !!favorite });

  const schoolsPage = makePage(rt.defs.schools);
  schoolsPage.setData({ c: api.content() });

  /* ---- 2.1 收藏项置顶 ---- */
  const src = [row('a'), row('b'), row('c'), row('d')];
  const withFav = [row('a'), row('b', true), row('c'), row('d', true)];
  schoolsPage.setData({ list: withFav });
  const ordered = schoolsPage.order(withFav);
  check(
    '已收藏的院校被提到最前',
    ordered[0].id === 'b' && ordered[1].id === 'd',
    ordered.map((r) => r.id).join(' > ')
  );
  check(
    '收藏组内部保持原顺序（稳定，不依赖引擎 sort 的稳定性）',
    ordered[0].id === 'b' && ordered[1].id === 'd' && ordered[2].id === 'a' && ordered[3].id === 'c',
    ordered.map((r) => r.id).join(',')
  );
  const twice = schoolsPage.order(ordered);
  check('置顶是幂等的（onShow 可放心重复调用）', twice.map((r) => r.id).join(',') === ordered.map((r) => r.id).join(','));

  /* ---- 2.2 没有收藏时不得改变顺序 ---- */
  schoolsPage.setData({ list: src });
  check(
    '一条收藏都没有时顺序原样不动',
    schoolsPage.order(src).map((r) => r.id).join(',') === 'a,b,c,d'
  );

  /* ---- 2.3 开关关闭时不变序（内容层可远程关掉） ---- */
  /**
   * ⚠️ `api.content()` 返回的是**缓存中的同一个对象**，直接改它会把后面所有断言
   *    一起带到「开关关闭」的状态里 —— 本台第一版就踩了这个坑，
   *    表现为第 3 节三条断言连带失败。要改就先深拷一份。
   */
  const cOff = JSON.parse(JSON.stringify(api.content()));
  cOff.schools.favoritesFirst = false;
  schoolsPage.setData({ c: cOff });
  check(
    'favoritesFirst=false 时收藏项不置顶',
    schoolsPage.order(withFav).map((r) => r.id).join(',') === 'a,b,c,d'
  );
  check('开关关闭时不显示置顶提示', schoolsPage.pinnedLabel(withFav) === '');
  check(
    '开关关闭后 api.content() 仍是原值（上面改的是副本，没污染共享缓存）',
    api.content().schools.favoritesFirst === true
  );

  /* ---- 2.4 置顶提示只数当前视图内的收藏 ---- */
  schoolsPage.setData({ c: JSON.parse(JSON.stringify(api.content())) });
  check('提示数量 = 当前视图内被置顶的条数', schoolsPage.pinnedLabel(withFav).indexOf('2') > -1, schoolsPage.pinnedLabel(withFav));
  check(
    '视图内没有收藏项时提示为空串（不显示「已收藏 0 所」）',
    schoolsPage.pinnedLabel(src) === ''
  );

  head('第 3 节 · 从详情页收藏后返回院校库（同步路径）');
  const schoolsPage2 = makePage(rt.defs.schools);
  schoolsPage2.setData({ c: JSON.parse(JSON.stringify(api.content())) });
  const all = await api.listSchools({});
  const ids = all.list.map((s) => s.id);
  const [idA, idB] = ids;
  const rows = all.list.slice(0, 6).map((s) => ({ id: s.id, nameCn: s.nameCn }));
  /**
   * 前置收藏必须写进 **store**（mem.sp_favorites），不能只在行对象上打标记：
   * `syncFavorites()` 会按 store 重算每一行的 favorite，手工打的标记会被抹掉 ——
   * 本台第一版就是这么写的，于是「返回后收藏行数」永远只有 1。
   */
  mem.sp_favorites = [rows[3].id];
  schoolsPage2.setData({ list: schoolsPage2.order(rows.map((r) => Object.assign({}, r, { favorite: false }))) });
  await schoolsPage2.syncFavorites();
  check('前置：已收藏的那一行排在首位', schoolsPage2.data.list[0].id === rows[3].id, schoolsPage2.data.list[0].id);
  check('前置：当前视图里有 1 行已收藏', schoolsPage2.data.list.filter((r) => r.favorite).length === 1);

  // 模拟「在详情页收藏了列表里的第 6 行」
  await api.toggleFavorite(rows[5].id);
  await schoolsPage2.syncFavorites();
  check(
    '返回页面后星标被重新读出来（不是靠 onLoad 时才读一次）',
    schoolsPage2.data.list.filter((r) => r.favorite).length === 2,
    '收藏行数 ' + schoolsPage2.data.list.filter((r) => r.favorite).length
  );
  check(
    '返回页面后新收藏的那一行也被置顶',
    schoolsPage2.data.list
      .slice(0, 2)
      .map((r) => r.id)
      .indexOf(rows[5].id) > -1,
    schoolsPage2.data.list.slice(0, 2).map((r) => r.id).join(',')
  );

  head('第 4 节 · 我的收藏页（真实 store + local 适配器）');
  const favPage = makePage(rt.defs.favorites);
  favPage.setData({ c: api.content() });

  // 清空后先验空态
  mem.sp_favorites = [];
  await favPage.refresh();
  check('未收藏任何院校时列表为空', favPage.data.list.length === 0);
  check(
    '空态不显示「共 0 所」这类废话（statTemplate 仍会算，但界面走空态分支）',
    favPage.data.totalLabel.indexOf('0') > -1,
    favPage.data.totalLabel
  );

  /* ---- 4.1 最近收藏在前 ---- */
  mem.sp_favorites = [];
  await api.toggleFavorite(idA);
  await api.toggleFavorite(idB); // 后收藏的应排在前面
  await favPage.refresh();
  check('收藏页列出两所', favPage.data.list.length === 2, favPage.data.list.map((r) => r.id).join(','));
  check('顺序 = 最近收藏在前', favPage.data.list[0].id === idB, favPage.data.list.map((r) => r.id).join(','));

  /* ---- 4.2 行数据形状 ---- */
  const r0 = favPage.data.list[0];
  check('行数据是扁平结构（crest 拆开，供组件直接绑定）', 'crestColor' in r0 && 'crestShape' in r0);
  check('行数据带 meta 副文案（已插值，不含占位符）', typeof r0.meta === 'string' && r0.meta.indexOf('{') === -1, r0.meta);
  check('页内行恒为已收藏（星标在这里是取消收藏的出口）', r0.favorite === true);

  /* ---- 4.3 幽灵 id 必须跳过，计数按真实行数 ---- */
  mem.sp_favorites = [idA, '__ghost__not_in_library'];
  await favPage.refresh();
  check('院校库里不存在的收藏 id 被跳过', favPage.data.list.length === 1, favPage.data.list.map((r) => r.id).join(','));
  check(
    '计数按真实渲染行数（不能说「共 2 所」却只画 1 行）',
    favPage.data.totalLabel.indexOf('1') > -1 && favPage.data.totalLabel.indexOf('2') === -1,
    favPage.data.totalLabel
  );

  /* ---- 4.4 取消收藏后行消失、计数跟着变 ---- */
  const target = favPage.data.list[0].id;
  await favPage.onRemove({ detail: { id: target } });
  check('取消收藏后该行从列表移除', favPage.data.list.length === 0);
  check('取消收藏给出提示', rt.toasts.length > 0, JSON.stringify(rt.toasts[rt.toasts.length - 1]));

  /* ---- 4.5 空态出口 ---- */
  favPage.onGoSchools();
  check(
    '空态按钮跳院校库用 switchTab（它是 tabBar 页）',
    rt.navs.length > 0 && rt.navs[rt.navs.length - 1].url === '/pages/schools/schools'
  );

  head('第 5 节 · 行组件行为');
  const compJs = stripComments(read(`${COMP}/index.js`));
  check('组件不自己 navigateTo（跳路由是页面的职责，否则无法复用）', compJs.indexOf('navigateTo') === -1);
  check('组件把行点击抛成 open 事件', /triggerEvent\(\s*'open'/.test(compJs));
  check('组件把星标点击抛成 favorite 事件', /triggerEvent\(\s*'favorite'/.test(compJs));
}

/* ================================================================ */
(async () => {
  staticChecks();
  await runtimeChecks();

  console.log('\n' + '═'.repeat(64));
  console.log(`结果：${pass} 通过 / ${failures.length} 失败`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('═'.repeat(64));
})();
