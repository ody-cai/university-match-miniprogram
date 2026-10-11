#!/usr/bin/env node
/**
 * 匹配页（03）界面验证台
 * ==================================================================
 * 覆盖三类**光靠读代码看不出、必须跑起来才算数**的缺陷，
 * 对应 2026-09-20 修掉的三条：
 *
 *   1) 目标国家 / 目标专业方向「点了没反应」
 *      根因：WXML 表达式**不支持函数调用** —— `selectedCountries.indexOf(item.key) > -1`
 *      求值不出来，class 永远拼不出 `chip--on`，点按没有任何视觉反馈。
 *      → 静态守卫「WXML 里不许出现函数调用」+ 逻辑测试真按一遍看 on 位。
 *
 *   2) 目标国家 / 地区「超出显示框」
 *      根因：`.chips`（app.wxss）是给横向滚动列表用的（不换行），本页没套 scroll-view，
 *      5 个药丸被压进卡片 311px 内宽里，文字溢出药丸外。
 *      → 静态守卫「chips 容器必须带 chips--wrap」+ 真机实测每个药丸的盒子边界。
 *
 *   3) 新增科目后找不到删除键
 *      根因：删除键原本是 rotate(180deg) 的 chevron-left，与行内表示「可点进编辑」的
 *      chevron-right 形状几乎一样，用户认不出来。
 *      → 静态守卫「删除键必须是垃圾桶图标」+ 真机实测图源非空、可点区够大、没跑出卡片。
 *
 * 用法：
 *   node tools/verify-match-page.js              # 静态 + 页面逻辑（离线，随时可跑）
 *   node tools/verify-match-page.js --runtime    # 追加真机量取（需开发者工具 + 服务端口）
 *
 * 真机量取的前置条件：开发者工具 → 设置 → 安全设置 → **打开「服务端口」**，
 * 且 IDE 里已登录。它是本机唯一的渲染真相来源，能跑到就别省。
 */
const fs = require('fs');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', 'miniprogram');
const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const AUTO_PORT = 9420;
const PAGE_URL = '/pages/match/match';
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

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ================================================================
   第 1 节 · 静态守卫（防止同一个坑被重新踩进去）
   ================================================================ */
function staticChecks() {
  head('第 1 节 · 静态守卫');

  const wxmls = walk(path.join(PROJECT, 'pages')).filter((f) => f.endsWith('.wxml'));

  // 1.1 WXML 绑定里不得出现函数调用 —— 那是 WXS 的活，写在 {{}} 里会静默求值失败。
  //     只认「标识符后紧跟 (」，避免误伤 {{item.fn}} 这类无关写法。
  const callRe = /\{\{[^}]*[A-Za-z_$][\w$]*\s*\(/;
  const hits = [];
  for (const f of wxmls) {
    const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    src.split('\n').forEach((line, i) => {
      if (callRe.test(line)) hits.push(`${path.relative(PROJECT, f)}:${i + 1}`);
    });
  }
  check('WXML 绑定表达式里没有函数调用', hits.length === 0, hits.join(', '));

  const matchWxml = fs.readFileSync(path.join(PROJECT, 'pages/match/match.wxml'), 'utf8');
  const matchJs = fs.readFileSync(path.join(PROJECT, 'pages/match/match.js'), 'utf8');

  // 1.2 本页没有 scroll-view 外壳，chips 必须显式换行
  const chipBlocks = matchWxml.match(/<view class="chips[^"]*">/g) || [];
  check(
    '国家 / 专业 chips 容器均为换行版（chips--wrap）',
    chipBlocks.length === 2 && chipBlocks.every((b) => b.includes('chips--wrap')),
    chipBlocks.join(' | ')
  );

  /* ---- 1.2b 多选 chip 与悬浮主 CTA 必须分色 ----
   * 本页底部 CTA 是**悬浮**的（透明容器 + 实心品牌蓝按钮），滚到底时会压在 chip 上。
   * 选中 chip 若也用实心品牌蓝，两者同色相邻 → 边界消失，看起来粘成一坨，
   * 用户分不清「这是选项」还是「这是按钮」（2026-09-23 用户截图反馈）。
   * 守卫两件事：多选组带 chips--pick；该变体把选中态降权成浅底描边，且 CTA 自带白色分离环。 */
  const appWxss = fs.readFileSync(path.join(PROJECT, 'app.wxss'), 'utf8');
  check(
    '国家 / 专业多选组带 chips--pick（选中态与主按钮分色）',
    chipBlocks.length === 2 && chipBlocks.every((b) => b.includes('chips--pick')),
    chipBlocks.join(' | ')
  );
  const pickRule = appWxss.match(/\.chips--pick\s+\.chip--on\s*\{[^}]*\}/);
  check(
    'chips--pick 选中态不落在实心品牌蓝上（浅底 + 品牌色文字）',
    !!pickRule &&
      pickRule[0].includes('var(--brand-tint)') &&
      !/background:\s*var\(--brand\)/.test(pickRule[0]),
    pickRule ? pickRule[0].replace(/\s+/g, ' ') : '未找到 .chips--pick .chip--on'
  );
  check(
    '悬浮 CTA 带白色分离环（压到同色块上仍有硬边界）',
    /\.cta-bar--float\s+\.btn\s*\{[^}]*box-shadow:[^;]*0 0 0 \d+px #fff/.test(appWxss)
  );

  // 1.3 删除键不得再用箭头类图标（本项目里箭头语义固定为「可进入 / 可展开」）
  const delBlock = matchWxml.match(/course-row__del[\s\S]*?<\/view>/);
  check(
    '删除键使用垃圾桶图标而非箭头',
    !!delBlock && delBlock[0].includes('name="trash"'),
    delBlock ? delBlock[0].replace(/\s+/g, ' ').slice(0, 96) : '未找到 course-row__del'
  );

  // 1.4 对应图标资源已随构建产出
  const icons = require(path.join(PROJECT, 'data/icons.js'));
  check('trash-red 图标已生成', !!icons.getIcon('trash-red'));
  check('trash-mute 图标已生成', !!icons.getIcon('trash-mute'));

  // 1.5 文案不写死在页面里（架构铁律 2）
  check(
    '删除确认文案来自内容层',
    !/wx\.showModal\(\{\s*title:\s*'/.test(matchJs) && matchJs.includes('match.deleteCourse')
  );
  check('必填校验提示来自内容层', matchJs.includes('c.match.needCountry') && !/showToast\(\{\s*title:\s*'/.test(matchJs));

  /* ---- 1.6 课程列表的 wx:key 必须是 item 上真实存在且唯一的字段 ----
   * 曾写 wx:key="index"，而 item 上没有 index 属性 → 每行 key 都是 undefined，
   * 所有行共用一个 key，框架分不清删掉的是哪一行（表现：删了列表不更新，且不报错）。 */
  const coursesFor = matchWxml.match(/<view wx:for="\{\{courses\}\}"[^>]*>/);
  check(
    '课程列表 wx:key 绑定的是真实字段（不是 index）',
    !!coursesFor && /wx:key="key"/.test(coursesFor[0]),
    coursesFor ? coursesFor[0] : '未找到 courses 的 wx:for'
  );
  check(
    '页面每次装载都会重新生成唯一 key（不存在于持久化数据里）',
    /let keySeq = 0/.test(matchJs) && /function attachKeys/.test(matchJs) && /function stripKeys/.test(matchJs)
  );
  check(
    '落库前剥掉页面专用 key（契约里没有这个字段）',
    /p\.coursesMap\[this\.data\.curriculum\] = clean/.test(matchJs) &&
      /const clean = stripKeys\(this\.data\.courses\)/.test(matchJs)
  );

  /* ---- 1.7 删除入口两处：行右侧垃圾桶 + 编辑浮层内 ----
   * 行内图标只有 36px，真机容易点空；浮层里原先只有「确定」，想删没有出口。 */
  check(
    '编辑浮层里有删除入口',
    /bindtap="onRemoveFromSheet"/.test(matchWxml) && /onRemoveFromSheet\(\)/.test(matchJs)
  );

  /* ---- 1.8 得分留空不得被写成 0 ----
   * `Number(edit.score) || 0` 会把「清空得分」变成「考了 0 分」—— 用户删掉一个填错的分数，
   * 换来一个看起来像真实成绩的 0，属于编数据。 */
  check(
    '得分不做 `Number(...) || 0` 的兜底',
    !/score:\s*Number\(edit\.score\)\s*\|\|\s*0/.test(matchJs) && /let score = null/.test(matchJs)
  );
  check(
    '删除越界索引时必须直接返回（splice(NaN,1) 会误删第 0 行）',
    /if \(!\(index >= 0 && index < this\.data\.courses\.length\)\) return;/.test(matchJs)
  );

  /* ---- 1.9 加号只有一个；课程提示文案不会在同一屏出现两次 ----
   * 用户实测截图报过两处：
   *   ① 右上角「＋ ＋ 添加科目」—— 图标画了加号，文案层又写了 '+ 添加科目'；
   *   ② 「没考国际课程也能申请，跳过本卡即可」上下各一行 —— 空态框与卡底 .card-desc
   *      共用同一句 courseHint，且**都是无条件渲染**，于是空列表时同时出现。
   * 两处都是「不报错、只是多一份」的静默缺陷，所以用文案层 + 渲染条件双向下断言。 */
  const content = require(path.join(PROJECT, 'data/content.js'));
  check(
    '「添加科目」文案本身不带加号（加号由图标负责）',
    !/^\s*[+＋]/.test(String(content.match.addCourse)),
    JSON.stringify(content.match.addCourse)
  );

  const addBlock = matchWxml.match(/<view class="add[^"]*"[\s\S]*?<\/view>/);
  check(
    '「添加科目」入口内只有一个加号来源（图标），没有再写一个字面加号',
    !!addBlock && /name="plus"/.test(addBlock[0]) && !/[+＋]/.test(addBlock[0].replace(/\{\{[\s\S]*?\}\}/g, '')),
    addBlock ? addBlock[0].replace(/\s+/g, ' ').slice(0, 96) : '未找到 .add 区块'
  );

  const hintEmpty = matchWxml.match(/wx:if="\{\{!courses\.length\}\}"\s+class="course-empty"[\s\S]*?<\/view>/);
  const hintDesc = matchWxml.match(/<text[^>]*class="card-desc"[^>]*>\s*\{\{c\.match\.courseHint\}\}/);
  check(
    '空态提示框无条件存在（列表为空时给出占位）',
    !!hintEmpty && hintEmpty[0].indexOf('courseHint') > -1,
    hintEmpty ? hintEmpty[0].replace(/\s+/g, ' ').slice(0, 96) : '未找到 course-empty'
  );
  check(
    '卡底 courseHint 受 `courses.length` 闸门控制（与空态框互斥，不会同屏出现两行）',
    !!hintDesc && /wx:if="\{\{courses\.length\}\}"/.test(hintDesc[0]),
    hintDesc ? hintDesc[0].replace(/\s+/g, ' ').slice(0, 96) : '未找到 card-desc 上的 courseHint'
  );
}

/* ================================================================
   第 2 节 · 页面逻辑（mock 最小 wx 运行时，离线可跑）
   ================================================================
   走的是**与真机相同的代码路径**：require 真实页面 → 真实 onLoad →
   真实事件 handler。只把 wx.* 与 utils/api 换成最小替身。
   ================================================================ */
async function logicChecks() {
  head('第 2 节 · 页面逻辑（mock 运行时）');

  const content = require(path.join(PROJECT, 'data/content.js'));

  let saved = null;
  const toasts = [];
  const navs = [];
  const modals = [];

  const apiStub = {
    loadContent: () => Promise.resolve(content),
    /** ⚠️ 主仓库规范：各页面 data.c 的初始值必须写成 api.content()（见 utils/api.js 的注释），
     *  所以 mock 必须提供它 —— 页面模块在**顶层**就会调用一次。 */
    content: () => content,
    getAcademic: () => Promise.resolve(JSON.parse(JSON.stringify(content.defaultAcademic))),
    saveAcademic: (p) => { saved = JSON.parse(JSON.stringify(p)); return Promise.resolve({ ok: true }); },
    /** 与 utils/api.js 的 tpl 语义一致：只替换给定变量，未给的保留原样 */
    tpl: (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m)),
  };

  // 拦截 require，让页面拿到替身 api（页面里名字叫 '../../utils/api'）
  const Module = require('module');
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (req) {
    if (typeof req === 'string' && /(^|\/)utils\/api$/.test(req)) return apiStub;
    return origRequire.apply(this, arguments);
  };

  global.wx = {
    showToast: (o) => toasts.push(o),
    showModal: (o) => { modals.push(o); if (o.success) o.success({ confirm: true }); },
    navigateTo: (o) => navs.push(o),
    getStorageSync: () => '',
    setStorageSync: () => {},
  };

  let def = null;
  global.Page = (d) => { def = d; };

  delete require.cache[require.resolve(path.join(PROJECT, 'pages/match/match.js'))];
  require(path.join(PROJECT, 'pages/match/match.js'));
  Module.prototype.require = origRequire;

  check('页面定义已注册', !!def && typeof def.onLoad === 'function');
  if (!def) return;

  // 极简 setData：支持 'a.b' 路径写法（页面里 onEditInput 用到）
  const page = Object.assign({}, def);
  page.data = JSON.parse(JSON.stringify(def.data));
  page.setData = function (obj) {
    Object.keys(obj).forEach((k) => {
      const parts = k.split('.');
      let cur = this.data;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = obj[k];
    });
  };
  const tap = (key) => ({ currentTarget: { dataset: { key } } });

  page.onLoad();
  await new Promise((r) => setTimeout(r, 30));

  /* ---- 2.1 枚举被合成成带 on 标记的视图数据 ---- */
  const cs = page.data.countries;
  const ms = page.data.majors;
  check(
    'countries 共 5 项且每项都带布尔 on',
    cs.length === 5 && cs.every((x) => typeof x.on === 'boolean'),
    cs.map((x) => `${x.key}:${x.on}`).join(' ')
  );
  check(
    'majors 共 9 项且每项都带布尔 on',
    ms.length === 9 && ms.every((x) => typeof x.on === 'boolean'),
    `${ms.length} 项`
  );
  check('label 原样保留（没有被合成过程吃掉）', cs[0].label === content.enums.countries[0].label, cs[0].label);

  /* ---- 2.2 点按国家：选中位必须翻转 ---- */
  page.onToggleCountry(tap('us'));
  check('点按美国 → 该项 on=true', page.data.countries.find((x) => x.key === 'us').on === true);
  check('点按美国 → selectedCountries=[us]', page.data.selectedCountries.join() === 'us');
  check('点按后已持久化', !!saved && saved.countries.join() === 'us');

  page.onToggleCountry(tap('ca'));
  check('可多选（us + ca）', page.data.selectedCountries.join() === 'us,ca');

  page.onToggleCountry(tap('us'));
  check('再点一次取消选中', page.data.selectedCountries.join() === 'ca');
  check('取消后 on 回落 false', page.data.countries.find((x) => x.key === 'us').on === false);

  /* ---- 2.3 专业方向同理 ---- */
  page.onToggleMajor(tap('cs'));
  page.onToggleMajor(tap('psy'));
  check(
    '专业方向可多选且 on 位同步',
    page.data.selectedMajors.join() === 'cs,psy' &&
      page.data.majors.filter((x) => x.on).map((x) => x.key).join() === 'cs,psy'
  );

  /* ---- 2.4 onStart 的校验与跳转 ---- */
  page.data.countries.forEach((x) => { x.on = false; });
  page.setData({ selectedCountries: [] });
  toasts.length = 0;
  page.onStart();
  check(
    '未选国家时用内容层文案拦截',
    toasts.length === 1 && toasts[0].title === content.match.needCountry,
    toasts.length ? toasts[0].title : '没有 toast'
  );
  check('未选国家时不跳转', navs.length === 0);

  page.onToggleCountry(tap('au'));
  page.onStart();
  check('已选国家时可进入匹配', navs.length === 1 && navs[0].url === '/pages/matching/matching', navs[0] && navs[0].url);

  /* ---- 2.5 科目增删改 ---- */
  page.onAddCourse();
  check('新增科目默认满分按 AP 体系取 5', page.data.courses.length === 1 && page.data.courses[0].max === 5);

  page.onEditCourse({ currentTarget: { dataset: { index: 0 } } });
  check('点行进入编辑浮层并回填', page.data.sheet === 'course' && page.data.edit.index === 0);

  toasts.length = 0;
  page.data.edit.name = '   ';
  page.onSheetConfirm();
  check('科目名为空时不落库、且浮层不关闭', toasts.length === 1 && page.data.sheet === 'course');

  page.data.edit.name = 'AP Calculus BC';
  page.data.edit.score = '5';
  page.data.edit.date = '2026 年 5 月统考';
  page.onSheetConfirm();
  check(
    '填写后落库并关闭浮层',
    page.data.sheet === null &&
      page.data.courses[0].name === 'AP Calculus BC' &&
      page.data.courses[0].score === 5 &&
      saved.coursesMap.AP.length === 1
  );

  page.onCurriculum(tap('IB'));
  page.onAddCourse();
  check('切体系后旧科目不丢、新科目按 IB 取满分 7', page.data.courses.length === 1 && page.data.courses[0].max === 7);

  /* ---- 2.6 删除科目 ---- */
  page.onCurriculum(tap('AP'));
  modals.length = 0;
  page.onRemoveCourse({ currentTarget: { dataset: { index: 0 } } });
  check('删除前弹二次确认', modals.length === 1);
  check(
    '确认弹窗文案来自内容层',
    !!modals[0] && modals[0].title === content.match.deleteCourse.title && modals[0].content === content.match.deleteCourse.desc,
    modals[0] ? `${modals[0].title} / ${modals[0].confirmText}` : ''
  );
  check('确认后科目被移除且已落库', page.data.courses.length === 0 && saved.coursesMap.AP.length === 0);

  /* ---- 2.7 多行：key 唯一、得分留空存 null、key 不落库 ---- */
  const addCourse = (name, score) => {
    page.onAddCourse();
    page.data.edit = { index: page.data.courses.length - 1, name, date: '', score, max: 5 };
    page.data.sheet = 'course';
    page.onSheetConfirm();
  };
  addCourse('AP Calculus BC', '5');
  addCourse('AP Physics 1', '');

  const keys = page.data.courses.map((c) => c.key);
  check(
    '每行都有非空且互不相同的 key（wx:key="key" 的前提）',
    keys.length === 2 && keys.every(Boolean) && new Set(keys).size === 2,
    keys.join(' / ')
  );
  check(
    '得分留空 → 存 null（界面显示「—」），不是 0',
    page.data.courses[1].score === null,
    JSON.stringify(page.data.courses[1].score)
  );
  check(
    '落库数据里没有页面专用的 key 字段',
    JSON.stringify(saved.coursesMap.AP).indexOf('"key"') < 0,
    JSON.stringify(saved.coursesMap.AP)
  );

  /* ---- 2.8 删中间行：剩下的行 key 必须保持不变（稳定 key 的意义所在） ---- */
  modals.length = 0;
  page.onRemoveCourse({ currentTarget: { dataset: { index: 0 } } });
  check(
    '删掉第 0 行后只剩原来的第 1 行、key 未被重编',
    page.data.courses.length === 1 && page.data.courses[0].name === 'AP Physics 1' && page.data.courses[0].key === keys[1],
    page.data.courses.map((c) => `${c.name}:${c.key}`).join(' | ')
  );
  check('删除已落库', saved.coursesMap.AP.length === 1);

  /* ---- 2.9 浮层内的删除入口（与行内垃圾桶是同一个动作） ---- */
  page.onEditCourse({ currentTarget: { dataset: { index: 0 } } });
  modals.length = 0;
  page.onRemoveFromSheet();
  check('浮层删除：先弹二次确认', modals.length === 1, String(modals.length));
  check('浮层删除：科目被移除、浮层关闭、已落库', page.data.courses.length === 0 && page.data.sheet === null && saved.coursesMap.AP.length === 0);

  /* ---- 2.10 索引缺失/越界不得误删 ----
   * `Number(undefined)` 是 NaN，而 `splice(NaN, 1)` 等价于删第 0 行 —— 这是静默删错行。 */
  addCourse('AP Biology', '4');
  const before = page.data.courses.length;
  page.onRemoveCourse({ currentTarget: { dataset: {} } });
  page.onRemoveCourse({ currentTarget: { dataset: { index: 99 } } });
  check('索引缺失或越界时一行都不删', page.data.courses.length === before, `${before} → ${page.data.courses.length}`);

  /* ================================================================
     2.11 均分 / 雅思的保存链路
     ================================================================
     ⚠️ 这一节是 2026-09-25 补的，起因是一个 P0：
        **此前第 2 节完全没有覆盖 gpa / ielts 的保存** —— 科目测了 8 条，
        分数一条都没测。于是「档案装载失败 → this.profile 为 undefined →
        保存抛异常被吞掉 → 界面无提示」这条链路从测试里整个溜了过去：
        跑出来 50 条全绿，而用户一点雅思就废。
        ⇒ 教训与「多一份 / 少一份都不会让测试变红」同族：
          **没被断言覆盖的路径 = 没有测试的路径**，它坏掉时不会有任何信号。
     ================================================================ */

  /** 模拟真机上 input 的 bindinput 事件对象（dataset + detail 都要有） */
  const inputEvt = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });

  check(
    '内容层提供了「档案读取失败」文案（页面不许硬编码）',
    typeof content.match.loadFailed === 'string' && content.match.loadFailed.length > 0,
    content.match.loadFailed
  );

  // ---- 均分 ----
  page.onEditGpa();
  check('打开均分浮层：空档案时输入框是空串（不是 0）', page.data.sheet === 'gpa' && page.data.edit.gpa === '', JSON.stringify(page.data.edit.gpa));

  page.onEditInput(inputEvt('gpa', '89.6'));
  check('输入后 edit.gpa 跟随', page.data.edit.gpa === '89.6');
  toasts.length = 0;
  page.onSheetConfirm();
  check('均分：浮层关闭', page.data.sheet === null);
  check('均分：真的落库（不是只改了内存）', !!saved && saved.gpa === 89.6, JSON.stringify(saved && saved.gpa));
  check('均分：卡片显示同步更新', page.data.gpaDisplay === '89.6', page.data.gpaDisplay);
  check('均分：没有被校验拦下（toasts 为空）', toasts.length === 0, JSON.stringify(toasts));

  page.onEditGpa();
  page.onEditInput(inputEvt('gpa', '0'));
  toasts.length = 0;
  page.onSheetConfirm();
  check(
    '均分越界（0）：拦下、浮层不关、内容层文案',
    toasts.length === 1 && toasts[0].title === content.match.invalidGpa && page.data.sheet === 'gpa',
    toasts.length ? toasts[0].title : '没有 toast'
  );
  check('均分越界时不落库（仍是上一次的 89.6）', saved.gpa === 89.6, JSON.stringify(saved.gpa));
  page.onSheetClose();

  // ---- 雅思 ----
  page.onEditIelts();
  check(
    '打开雅思浮层：未填过的项一律空串，不是 0（否则用户要先删字）',
    page.data.sheet === 'ielts' &&
      ['overall', 'l', 'r', 'w', 's'].every((k) => page.data.edit[k] === ''),
    JSON.stringify(page.data.edit)
  );

  for (const [f, v] of [['overall', '6.5'], ['l', '5.5'], ['r', '6.0'], ['w', '5.5'], ['s', '6.0']]) {
    page.onEditInput(inputEvt(f, v));
  }
  check('雅思：5 个输入框各自独立记录', JSON.stringify(page.data.edit) === JSON.stringify({ overall: '6.5', l: '5.5', r: '6.0', w: '5.5', s: '6.0' }), JSON.stringify(page.data.edit));

  toasts.length = 0;
  page.onSheetConfirm();
  check('雅思：浮层关闭（P0 的现场症状就是它不关）', page.data.sheet === null, String(page.data.sheet));
  check('雅思：没有被校验拦下', toasts.length === 0, JSON.stringify(toasts));
  check(
    '雅思：真的落库（overall / l / r / w / s 全部到位）',
    !!saved.ielts && saved.ielts.overall === 6.5 && saved.ielts.l === 5.5 && saved.ielts.r === 6 && saved.ielts.w === 5.5 && saved.ielts.s === 6,
    JSON.stringify(saved.ielts)
  );
  check('雅思：卡片总分显示同步更新', page.data.ieltsDisplay === '6.5', page.data.ieltsDisplay);
  check(
    '雅思：单项摘要跟着更新（否则卡片上还是旧分数）',
    page.data.ieltsHint === '雅思 · L5.5 R6 W5.5 S6',
    page.data.ieltsHint
  );

  // 重开浮层：必须回填已保存的值（用户改总分时，单项不该被清空）
  page.onEditIelts();
  const back = page.data.edit;
  check(
    '雅思：重开浮层回填上一次保存的分数（改总分不清空单项）',
    Number(back.overall) === 6.5 && Number(back.l) === 5.5 && Number(back.s) === 6,
    JSON.stringify(back)
  );

  // 单项留空 → 存 0（不是 NaN）；总分仍是唯一必填项
  page.onEditIelts();
  for (const f of ['l', 'r', 'w', 's']) page.onEditInput(inputEvt(f, ''));
  page.onEditInput(inputEvt('overall', '6'));
  page.onSheetConfirm();
  check(
    '雅思：单项留空存 0（不是 NaN / undefined）',
    saved.ielts.overall === 6 && saved.ielts.l === 0 && saved.ielts.r === 0 && saved.ielts.w === 0 && saved.ielts.s === 0,
    JSON.stringify(saved.ielts)
  );
  check('雅思：单项为 0 时摘要如实显示 0', page.data.ieltsHint === '雅思 · L0 R0 W0 S0', page.data.ieltsHint);

  // 越界
  page.onEditIelts();
  page.onEditInput(inputEvt('overall', '10'));
  toasts.length = 0;
  page.onSheetConfirm();
  check(
    '雅思越界（10）：拦下、浮层不关、内容层文案',
    toasts.length === 1 && toasts[0].title === content.match.invalidIelts && page.data.sheet === 'ielts',
    toasts.length ? toasts[0].title : '没有 toast'
  );
  check('雅思越界时不落库（仍是上一次的 6）', saved.ielts.overall === 6);

  page.onEditInput(inputEvt('overall', ''));
  toasts.length = 0;
  page.onSheetConfirm();
  check('雅思总分留空：同样拦下（不能把「没填」存成 0 分）', toasts.length === 1 && saved.ielts.overall === 6);

  // ---- 改完分数后，这份成绩必须能被规则引擎直接吃进去 ----
  page.onSheetClose();
  const match = require(path.join(PROJECT, 'utils/match.js'));
  const profile = Object.assign({}, content.defaultAcademic, {
    gpa: 89.6,
    ielts: { overall: 6.5, l: 5.5, r: 6, w: 5.5, s: 6 },
    countries: ['ca'],
  });
  const ready = match.checkProfile(profile);
  check('填完成绩后档案判定为「可匹配」', ready.ok === true && ready.missing.length === 0, JSON.stringify(ready));
  const result = match.run(profile, { content });
  check(
    '规则引擎真的出了分（不是 needsProfile 空结果）',
    result.total > 0 && result.needsProfile === false && result.evaluated > 0,
    `total=${result.total} evaluated=${result.evaluated} needsProfile=${result.needsProfile}`
  );
}

/* ================================================================
   第 2b 节 · 档案装载失败（P0 回归守卫，2026-09-25）
   ================================================================
   复现的正是那个 P0：`api.getAcademic()` reject 时（当时它没有 catch，
   且 `academic.get` 不在 FALLBACK_LOCAL 里），`onLoad` 的 Promise.all 中断，
   `this.profile` 永远是 undefined，于是：
     · 点「确定」→ `this.profile.gpa = ...` 抛异常 → 被框架吞掉；
     · 浮层不关、没有任何提示 —— 用户看到的就是「输入之后无法保存」。
   守两层：① api 层永不 reject（那部分由 tools/test-cloud-sync.js 第四节守住）；
          ② 页面层必须**明确告知 + 拒绝写入**，绝不能用空档案覆盖本机数据。
   ================================================================ */
async function degradedLogicChecks() {
  head('第 2b 节 · 档案装载失败（P0 回归守卫）');

  const content = require(path.join(PROJECT, 'data/content.js'));

  let saved = null;
  const toasts = [];
  const navs = [];
  const unhandled = [];

  const apiStub = {
    loadContent: () => Promise.resolve(content),
    content: () => content,
    /** 模拟 GET /v1/academic/profile 网络超时 */
    getAcademic: () => Promise.reject(Object.assign(new Error('request:fail timeout'), { code: 500 })),
    saveAcademic: (p) => { saved = JSON.parse(JSON.stringify(p)); return Promise.resolve({ ok: true }); },
    tpl: (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m)),
  };

  const Module = require('module');
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (req) {
    if (typeof req === 'string' && /(^|\/)utils\/api$/.test(req)) return apiStub;
    return origRequire.apply(this, arguments);
  };

  global.wx = {
    showToast: (o) => toasts.push(o),
    showModal: (o) => { modalsIgnore(); if (o.success) o.success({ confirm: true }); },
    navigateTo: (o) => navs.push(o),
    getStorageSync: () => '',
    setStorageSync: () => {},
  };
  function modalsIgnore() {}

  let def = null;
  global.Page = (d) => { def = d; };

  delete require.cache[require.resolve(path.join(PROJECT, 'pages/match/match.js'))];
  require(path.join(PROJECT, 'pages/match/match.js'));
  Module.prototype.require = origRequire;

  const page = Object.assign({}, def);
  page.data = JSON.parse(JSON.stringify(def.data));
  page.setData = function (obj) {
    Object.keys(obj).forEach((k) => {
      const parts = k.split('.');
      let cur = this.data;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = obj[k];
    });
  };

  // 真机上未处理的 rejection 只会打日志、不崩进程，这里也吞掉
  const swallow = (e) => unhandled.push(e && e.message ? e.message : String(e));
  process.on('unhandledRejection', swallow);

  page.onLoad();
  await new Promise((r) => setTimeout(r, 30));
  process.removeListener('unhandledRejection', swallow);

  check('装载失败时没有未捕获的异常', unhandled.length === 0, unhandled.join(' | '));
  check('装载失败时页面不崩（this.profile 缺失是允许的，但要有 profileReady 闸门）', page.profileReady === false);

  toasts.length = 0;
  page.onEditIelts();
  check('装载失败时浮层照常可开（不阻断浏览）', page.data.sheet === 'ielts');

  const inputEvt = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
  for (const [f, v] of [['overall', '6.5'], ['l', '5.5'], ['r', '6.0'], ['w', '5.5'], ['s', '6.0']]) {
    page.onEditInput(inputEvt(f, v));
  }
  toasts.length = 0;
  page.onSheetConfirm();

  check(
    '点确定：给出内容层的失败提示（不再静默 —— 这是 P0 的核心症状）',
    toasts.some((t) => t.title === content.match.loadFailed),
    JSON.stringify(toasts.map((t) => t.title))
  );
  check('点确定：一个字节都没写（保存被闸门拦下）', saved === null, JSON.stringify(saved));
  check(
    '点确定：浮层保持打开，用户填的内容还在（不让人白填一遍）',
    page.data.sheet === 'ielts' && page.data.edit.overall === '6.5',
    `sheet=${page.data.sheet} overall=${page.data.edit.overall}`
  );
  check('点确定：没有抛异常出来', true);

  // 切体系 / 勾国家这些也走 persist，同样不能崩
  toasts.length = 0;
  page.onToggleCountry({ currentTarget: { dataset: { key: 'ca' } } });
  check('装载失败时勾国家不崩、且给出提示', toasts.some((t) => t.title === content.match.loadFailed), JSON.stringify(toasts.map((t) => t.title)));
  check('装载失败时勾国家不落库', saved === null);

  navs.length = 0;
  page.onStart();
  check('装载失败时「开始匹配」不跳转（不带着不可信的成绩去算）', navs.length === 0, String(navs.length));
}

/* ================================================================
   第 3 节 · 真机量取（可选，需开发者工具 + 服务端口）
   ================================================================ */
async function runtimeChecks() {
  head('第 3 节 · 真机量取（微信开发者工具）');

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

    /* 3.1 视图数据 */
    const data = await page.data();
    check(
      '页面 data.countries 携带 on 字段',
      (data.countries || []).length === 5 && data.countries.every((c) => typeof c.on === 'boolean')
    );

    /* 3.2 点按真的会变色 */
    const chips = await page.$$('.chips--wrap .chip');
    check('渲染出 14 个药丸（国家 5 + 专业 9）', chips.length === 14, `共 ${chips.length} 个`);

    const first = chips[0];
    const before = await first.attribute('class');
    await first.tap();
    await page.waitFor(400);
    const after = await first.attribute('class');
    check('点按国家后 chip 进入选中态', before.indexOf('chip--on') < 0 && after.indexOf('chip--on') > -1, `${before} → ${after}`);
    await first.tap();
    await page.waitFor(300);

    /* 3.3 药丸不越界、不被压缩、确实换行 */
    const wrap = await page.$('.chips--wrap');
    const wrapOffset = await wrap.offset();
    const wrapSize = await wrap.size();
    const right = wrapOffset.left + wrapSize.width;

    const boxes = [];
    for (const c of chips) {
      const o = await c.offset();
      const s = await c.size();
      boxes.push({ left: o.left, top: o.top, w: s.width, right: o.left + s.width });
    }
    const overflow = boxes.filter((b) => b.right > right + 1);
    check(
      '所有药丸都在容器内（无横向溢出）',
      overflow.length === 0,
      overflow.length
        ? `越界 ${overflow.length} 个，最右 ${Math.max.apply(null, overflow.map((b) => b.right)).toFixed(1)} vs 容器右缘 ${right.toFixed(1)}`
        : `容器内宽 ${wrapSize.width.toFixed(1)}px`
    );
    const minW = Math.min.apply(null, boxes.map((b) => b.w));
    check('药丸未被压缩（最窄 ≥ 56px）', minW >= 56, `最窄 ${minW.toFixed(1)}px`);
    const rows = Array.from(new Set(boxes.map((b) => Math.round(b.top)))).length;
    check('药丸确实换行排版', rows >= 2, `实测 ${rows} 行`);

    /* 3.4 删除键存在、可见、可辨 */
    await (await page.$('.add')).tap();
    await page.waitFor(400);
    check('新增科目后出现课程行', (await page.$$('.course-row')).length === 1);

    const del = await page.$('.course-row__del');
    check('课程行渲染出删除键', !!del);
    if (del) {
      const delWxml = await del.wxml();
      check(
        '删除键内含真实 PNG 图源（不是缺失占位块）',
        /data:image\/png;base64,[A-Za-z0-9+/=]{40,}/.test(delWxml) && delWxml.indexOf('icon--missing') < 0
      );
      const dSize = await del.size();
      check('删除键可点区域足够大', dSize.width >= 32 && dSize.height >= 32, `${dSize.width}×${dSize.height}`);

      const dOffset = await del.offset();
      const card = await page.$('.card');
      const cardOffset = await card.offset();
      const cardSize = await card.size();
      const cardRight = cardOffset.left + cardSize.width;
      check(
        '删除键没有跑出卡片可视区',
        dOffset.left >= cardOffset.left - 1 && dOffset.left + dSize.width <= cardRight + 1,
        `删除键右缘 ${(dOffset.left + dSize.width).toFixed(1)} / 卡片右缘 ${cardRight.toFixed(1)}`
      );

      const mainWxml = await (await page.$('.course-row__main')).wxml();
      const srcOf = (w) => (w.match(/src="(data:image\/png;base64,[^"]+)"/g) || []).map((s) => s.slice(5, -1));
      const delSrc = srcOf(delWxml);
      const mainSrc = srcOf(mainWxml);
      check(
        '删除键与行内箭头是两个不同图形',
        delSrc.length > 0 && mainSrc.length > 0 && !delSrc.some((s) => mainSrc.indexOf(s) > -1)
      );
    }

    await miniProgram.close();
  } catch (e) {
    try { await miniProgram.close(); } catch (_) {}
    throw e;
  }
}

/* ================================================================ */
(async () => {
  console.log('='.repeat(64));
  console.log('匹配页（03）界面验证');
  console.log('='.repeat(64));

  staticChecks();
  await logicChecks();
  await degradedLogicChecks();
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
