#!/usr/bin/env node
/**
 * 自定义组件作用域校验
 * ------------------------------------------------------------------
 * 背景：本项目启用了 `lazyCodeLoading: "requiredComponents"`（按需注入），
 * 但组件原先全部注册在 app.json 的**全局** usingComponents 里，开发者工具会提示：
 *
 *   [Perf] 全局自定义组件可能影响按需注入的效果，请谨慎使用（在 app.json 中检测到 4 个）
 *
 * 全局注册等于「每个页面都注入这 4 个组件」，按需注入形同失效。
 * 现已全部下移到**页面级 / 组件级** usingComponents。
 *
 * 代价是：漏注册不会编译报错，只会让标签静默渲染成空白块 —— 与
 * `check-icons.js` 里「图标名对不上就渲染成虚线占位」是同一类隐性故障。
 * 本脚本把它提前到构建期暴露。
 *
 * 校验四类：
 *   1) app.json 不得再有全局 usingComponents（否则按需注入失效）
 *   2) 每个 WXML 用到的自定义组件，必须在其同名 json 的 usingComponents 里注册
 *   3) 组件内部依赖链（nav-bar / crest 内部自己也用 icon）已注册
 *   4) 反向检查：注册了却没用到 —— 提示级，说明可以删
 *
 * 用法：node tools/check-component-scope.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

/** 全部自定义组件标签名，与 miniprogram/components/ 下的目录一一对应 */
const TAGS = fs
  .readdirSync(path.join(MP, 'components'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let pass = 0;
let fail = 0;
const warnings = [];

function head(t) {
  console.log('\n' + '─'.repeat(64));
  console.log(t);
  console.log('─'.repeat(64));
}

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
  }
}

function note(msg) {
  warnings.push(msg);
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.wxml')) out.push(p);
  }
  return out;
}

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** WXML 里实际用到的自定义组件标签（支持多行属性写法） */
function tagsUsedIn(src) {
  return TAGS.filter((t) => new RegExp('<' + t + '[\\s/>]').test(src));
}

const regPath = (t) => `/components/${t}/index`;

console.log('='.repeat(64));
console.log('自定义组件作用域校验');
console.log('='.repeat(64));
console.log(`组件标签    ${TAGS.join(' / ')}`);

/* ========== 1. app.json ========== */
head('1. app.json 的按需注入前提');
const appJson = readJson(path.join(MP, 'app.json')) || {};
const globalUC = appJson.usingComponents || {};
check(
  'app.json 未注册全局自定义组件（按需注入才生效）',
  Object.keys(globalUC).length === 0,
  '仍注册了：' + Object.keys(globalUC).join(', ') + ' —— 每个页面都会被注入，按需注入失效'
);
check(
  'lazyCodeLoading 为 requiredComponents',
  appJson.lazyCodeLoading === 'requiredComponents',
  `实际：${JSON.stringify(appJson.lazyCodeLoading)}`
);

/* ========== 2. 逐文件注册完整性 ========== */
head('2. 各文件用到的组件均已注册');
const wxmls = walk(MP, []).sort();
const missing = [];
const unused = [];

for (const wxml of wxmls) {
  const src = fs.readFileSync(wxml, 'utf8');
  const used = tagsUsedIn(src);
  const jsonFile = wxml.replace(/\.wxml$/, '.json');
  const json = readJson(jsonFile) || {};
  const reg = json.usingComponents || {};
  const rel = path.relative(MP, wxml);
  const jsonRel = path.basename(jsonFile);

  for (const t of used) {
    if (reg[t] !== regPath(t)) {
      missing.push(
        `${rel} 用了 <${t}>，但 ${jsonRel} 未正确注册（当前 ${JSON.stringify(reg[t])}，应为 "${regPath(t)}"）`
      );
    }
  }
  for (const t of Object.keys(reg)) {
    if (used.indexOf(t) === -1) unused.push(`${rel} 注册了 ${t} 但该文件未使用`);
  }
}

check(`${wxmls.length} 个 WXML 的组件引用均已注册`, missing.length === 0, missing.join('\n      '));

/* ========== 3. 组件内部依赖链 ========== */
head('3. 组件内部依赖链（组件里再嵌组件）');
const nestedFiles = wxmls.filter((f) => path.relative(MP, f).startsWith('components/') || f.includes('custom-tab-bar'));
check('存在需要校验内部依赖的组件文件', nestedFiles.length > 0, `实读 ${nestedFiles.length}`);

for (const wxml of nestedFiles) {
  const src = fs.readFileSync(wxml, 'utf8');
  const used = tagsUsedIn(src);
  const json = readJson(wxml.replace(/\.wxml$/, '.json')) || {};
  const reg = json.usingComponents || {};
  const rel = path.relative(MP, wxml);
  const okAll = used.every((t) => reg[t] === regPath(t));
  check(
    `${rel} 内部依赖 [${used.join(', ') || '无'}] 已注册`,
    okAll,
    JSON.stringify(reg)
  );
}

/* ========== 4. 冗余注册 ========== */
head('4. 冗余注册（提示级）');
if (unused.length) {
  unused.forEach(note);
  console.log(`  ! 发现 ${unused.length} 处注册了但未使用（仅提示，不阻塞）：`);
  unused.forEach((u) => console.log('      ' + u));
} else {
  check('没有「注册了却没用到」的组件', true);
}

/* ========== 汇总 ========== */
console.log('\n' + '═'.repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败 / ${warnings.length} 提示`);
if (warnings.length) console.log('提示项不阻塞构建，可在方便时清理');
console.log('═'.repeat(64));
process.exit(fail ? 1 : 0);
