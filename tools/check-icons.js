#!/usr/bin/env node
/**
 * 图标引用校验
 * ------------------------------------------------------------------
 * 背景：图标名在「内容层 / WXML」里被引用，图像却由 tools/gen-icons.js 生成。
 * 两边一旦对不上（改名了、漏定义了），组件会静默渲染成虚线占位块 ——
 * 只有肉眼在真机截图里才发现。这个脚本把这类问题提前到构建期暴露。
 *
 * ⚠️ v2 修正（重要）：v1 把所有 `content.js` 里出现过的 `icon:` 取值当成
 * 「内容层图标全集」，拿去展开**任意**页面的 `name="{{...}}"`。
 * 结果 `terms.docs` 里的 doc-contract / shield-check / alert-triangle
 * 被误判成要用 ink/white 渲染（那是首页宫格的配色），报了 6 处假缺失。
 * 假警报比漏报更危险 —— 会让人开始无视这个脚本。
 *
 * v2 规则：**按页面作用域取候选名**。每个动态 name 的站点只对照它真实的
 * 数据来源集合；颜色则从写死的色值或表达式里的字符串字面量求值。
 *
 * 校验五类引用：
 *   1) 内容层各集合（见 NAME_SOURCES）—— 名称必须能解析到图像
 *   2) WXML 里写死的 name="xxx" color="xxx"
 *   3) `name="{{...}}"` 动态名（按页面作用域展开）+ 该标签写死的色值
 *   4) 动态色表达式里的字符串字面量（如 `{{f.ready ? 'ink' : 'mute'}}`）
 *   5) `<crest>` 的 shape + icon-color —— 名称映射为 sym-<shape>
 *
 * 用法：node tools/check-icons.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const { getIcon, ICONS, ALIAS } = require(path.join(MP, 'data', 'icons.js'));
// content.js 直接导出内容对象本身（不是 { CONTENT } 包一层），见 api.js DEFAULT_CONTENT
const CONTENT = require(path.join(MP, 'data', 'content.js'));

/** 能解析到图像就算通过（先精确匹配 `名称-颜色`，再回退别名表） */
function ok(name, color) {
  if (!name) return true;
  return !!(color ? getIcon(name + '-' + color) : getIcon(name));
}

const missing = [];
const checked = [];
const usedScopes = new Set();

function flag(name, color, from, why) {
  missing.push({ key: color ? name + '-' + color : name, from, why });
}

/* ================================================================
   一、内容层图标集合（按作用域命名，供 WXML 站点对照）
   ================================================================ */

/** 从 `[{icon}]` 形态的数组里取图标名 */
const namesOf = (arr) => (arr || []).map((x) => x && x.icon).filter(Boolean);

const ALL_CONTENT_ICONS = namesOf(CONTENT.tabBar)
  .concat(namesOf(CONTENT.home.features))
  .concat((CONTENT.functions.groups || []).map((g) => namesOf(g.items)).flat())
  .concat(namesOf(CONTENT.terms.docs));

/**
 * 「哪个 WXML 的动态 name 对应哪份数据」——必须逐条维护。
 * 新增一个用 `name="{{...}}"` 的页面时，在这里登记它的真实来源；
 * 漏登记会走 fallback（全集），那就又变回 v1 的假警报模式了。
 */

/** 院校数据里出现过的校徽形状 → `sym-<shape>`（crest 组件的 symbol 来源） */
const uniSrc = fs.readFileSync(path.join(MP, 'data', 'universities.js'), 'utf8');
const SHAPES = new Set();
{
  const re = /"shape":\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(uniSrc))) SHAPES.add('sym-' + m[1]);
}

const NAME_SOURCES = {
  'pages/home/home.wxml': namesOf(CONTENT.home.features),
  'pages/functions/functions.wxml': (CONTENT.functions.groups || [])
    .map((g) => namesOf(g.items))
    .flat(),
  'pages/terms/terms.wxml': namesOf(CONTENT.terms.docs),
  'custom-tab-bar/index.wxml': namesOf(CONTENT.tabBar),
  'components/crest/index.wxml': Array.from(SHAPES),
  /**
   * 反馈结果页的徽标：`name="{{badgeIcon}}"` 由页面 js 按状态赋值，
   * **取值只可能是这两个**（success → check；fail / stale → alert-mark），
   * 所以在这里显式登记，避免走全集兜底把 terms 页的 shield-check / alert-triangle
   * 也算进来 —— 那两个只有 blue / warn 版本，会报出假的 `-white` 缺失。
   * ⚠️ 页面的 badgeIcon 若新增取值，务必同步这一行。
   */
  'pages/feedback-result/feedback-result.wxml': ['check', 'alert-mark'],
};

/* ================================================================
   二、颜色求值
   ================================================================ */

/**
 * 调色板以 tools/gen-icons.js 的 COLORS 为唯一来源（正则抽取，避免两处维护）。
 * 用途：过滤动态表达式里的字面量 —— `{{theme === 'dark' ? 'white' : 'ink'}}`
 * 中 `'dark'` 是**比较条件**，不是颜色，不筛掉就会误报 `chevron-left-dark`。
 */
const genSrc = fs.readFileSync(path.join(__dirname, 'gen-icons.js'), 'utf8');
const COLORS_BLOCK = (genSrc.match(/const COLORS = \{([\s\S]*?)\n\};/) || [])[1] || '';
const KNOWN_COLORS = new Set(
  (COLORS_BLOCK.match(/(\w+)\s*:\s*'#[0-9A-Fa-f]{3,8}'/g) || []).map((s) =>
    s.split(':')[0].trim()
  )
);

/** 被忽略的动态色字面量（不是调色板里的颜色），仅作提示，不算错 */
const ignoredLiterals = new Set();

/**
 * 从 color 属性原文求出「静态可枚举」的颜色集合。
 *   "ink"                          → ['ink']
 *   "{{f.ready ? 'ink':'mute'}}"   → ['ink','mute']   （只取三元结果分支）
 *   "{{theme === 'dark' ? 'white':'ink'}}" → ['white','ink']（条件里的 'dark' 不算色）
 *   "{{item.tone}}"                → []               （纯变量，静态不可知，跳过）
 */
function colorsOf(raw) {
  if (!raw) return [];
  if (raw.indexOf('{{') === -1) return [raw];

  const out = [];
  for (const expr of raw.match(/\{\{[\s\S]*?\}\}/g) || []) {
    const body = expr.slice(2, -2);
    // 条件部分（第一个 ? 之前）不参与求值，只保留结果分支
    const chunks = body.split('?');
    const branches = chunks.length > 1 ? chunks.slice(1).join('?') : body;
    for (const lit of branches.match(/'([^']+)'/g) || []) {
      const v = lit.slice(1, -1);
      if (KNOWN_COLORS.has(v)) out.push(v);
      else ignoredLiterals.add(v);
    }
  }
  return Array.from(new Set(out));
}

/* ================================================================
   三、遍历 WXML
   ================================================================ */
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.wxml')) scan(p);
  }
}

function scan(file) {
  // 相对 miniprogram/ 的路径，与 NAME_SOURCES 的键对齐（如 pages/home/home.wxml）
  const rel = path.relative(MP, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');

  /* ---- <icon ... /> ---- */
  const tags = src.match(/<icon\b[\s\S]*?\/>/g) || [];
  for (const tag of tags) {
    const rawName = (tag.match(/name="([^"]*)"/) || [])[1] || '';
    const rawColor = (tag.match(/color="([^"]*)"/) || [])[1] || '';
    if (!rawName) continue;

    const nameDynamic = rawName.indexOf('{{') > -1;

    let names;
    if (nameDynamic) {
      if (NAME_SOURCES[rel]) {
        names = NAME_SOURCES[rel];
        usedScopes.add(rel);
      } else {
        // 未登记来源 → 用全集兜底，并明确告警（可能产生假缺失）
        names = ALL_CONTENT_ICONS;
        usedScopes.add(rel + ' (未登记，已用全集兜底)');
      }
    } else {
      names = [rawName];
    }
    if (!names.length) continue;

    const colors = colorsOf(rawColor); // 空数组 = 颜色静态不可知，只校验名称

    for (const n of names) {
      if (!colors.length) {
        checked.push(n);
        if (!ok(n)) flag(n, null, rel, '该名称没有生成任何图像，且没有别名可回退');
        continue;
      }
      for (const c of colors) {
        checked.push(n + '-' + c);
        if (!ok(n, c)) {
          flag(n, c, rel, `缺少 ${n}-${c}，且 ${n} 没有别名可回退到其他颜色`);
        }
      }
    }
  }

  /* ---- <crest ... /> ---- */
  const crests = src.match(/<crest\b[\s\S]*?\/>/g) || [];
  for (const tag of crests) {
    const shapeM = (tag.match(/shape="([^"]*)"/) || [])[1] || '';
    const colorM = (tag.match(/icon-color="([^"]*)"/) || [])[1] || '';
    if (!shapeM || shapeM.indexOf('{{') > -1) continue; // 动态 shape 交给数据侧校验
    const name = 'sym-' + shapeM;
    const colors = colorsOf(colorM);
    if (!colors.length) {
      checked.push(name);
      if (!ok(name)) flag(name, null, rel, '校徽符号没有生成图像');
    } else {
      for (const c of colors) {
        checked.push(name + '-' + c);
        if (!ok(name, c)) flag(name, c, rel, `缺少 ${name}-${c}`);
      }
    }
  }
}

walk(MP);

/* ================================================================
   四、数据侧：院校数据里出现过的所有校徽形状都要有白版图形
   （SHAPES 已在前面算出，crest 组件的动态 symbol 也复用同一份）
   ================================================================ */
for (const name of SHAPES) {
  if (!ok(name, 'white')) {
    flag(name, 'white', 'data/universities.js', '院校数据里用到的校徽形状没有对应图像');
  }
}

/* ================================================================
   五、内容层兜底：任何被 `icon:` 声明过的名字（不限颜色）都必须存在
   —— 抓错别字 / 改了名却没改内容层
   ================================================================ */
for (const n of Array.from(new Set(ALL_CONTENT_ICONS))) {
  if (!ok(n)) flag(n, null, 'data/content.js', '该名称没有生成任何图像（内容层声明了但生成器里没有）');
}

/* ================================================================
   输出
   ================================================================ */
console.log('='.repeat(64));
console.log('图标引用校验');
console.log('='.repeat(64));
console.log(`已生成图像   ${Object.keys(ICONS).length} 个键 / ${Object.keys(ALIAS).length} 个别名`);
console.log(`校验引用     ${new Set(checked).size} 处`);
console.log(`作用域映射   ${Array.from(usedScopes).sort().join(' ｜ ')}`);
if (ignoredLiterals.size) {
  console.log(
    `已忽略字面量 ${Array.from(ignoredLiterals).join(', ')}（不在调色板内，按条件值/变量处理）`
  );
}

/** 登记了作用域却本文件没有动态 name 站点 → 映射可能已过期，仅提示 */
const staleScopes = Object.keys(NAME_SOURCES).filter((k) => !usedScopes.has(k));
if (staleScopes.length) {
  console.log(`⚠ 作用域映射未命中（该文件已无动态 name 站点，可清理）：${staleScopes.join(', ')}`);
}

if (missing.length) {
  const seen = new Set();
  const uniq = missing.filter((x) => {
    const k = x.key + '|' + x.from;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`\n✗ 发现 ${uniq.length} 处缺失（真机上会渲染成虚线占位块）：\n`);
  for (const x of uniq) {
    console.log(`  ${x.key}`);
    console.log(`      来源：${x.from}`);
    console.log(`      原因：${x.why}`);
  }
  process.exit(1);
}

console.log('\n✓ 所有被引用的图标都能解析到图像');
