#!/usr/bin/env node
/**
 * 校验「小程序简介.md」里微信后台**介绍字段**的候选文案
 *
 * 为什么要有这个脚本：
 *   介绍字段是 4–120 字符的硬约束，且**官方未标注计数口径**（名称字段是「1 汉字 = 2 字符」，
 *   介绍字段没说）。所以这里同时输出两个数，并以**更严的加权口径**作为控长依据 ——
 *   两种口径都能过，才叫安全。字数类硬指标一律实测，不凭感觉。
 *
 * 文档约定：
 *   候选正文必须写在  <!-- intro -->  ...  <!-- /intro -->  之间，且每行以 "> " 开头。
 *   脚本只认这个区块内的行，第二部分（参赛简介）不受 120 字符限制，只做统计。
 *
 * 用法：node tools/check-intro-chars.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOC = path.join(ROOT, '小程序简介.md');

const MIN = 4;
const MAX = 120;

/* ---------------- 计数 ---------------- */

/**
 * 加权长度：CJK 汉字、全角标点、中文常用破折号/引号/省略号 记 2；其余（ASCII 字母数字、半角符号）记 1。
 * 这是微信「名称」字段的已知口径；介绍字段是否同口径未知，按此控长 = 取更严的一侧。
 */
function weighted(s) {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x2e80 && cp <= 0x9fff) || // CJK 部首、假名、汉字、CJK 标点（、。「」…）
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
      (cp >= 0xff00 && cp <= 0xffef) || // 全角字符（，？！等）
      cp === 0x2014 || cp === 0x2026 || // — …
      (cp >= 0x2018 && cp <= 0x201d);   // '' ""
    n += wide ? 2 : 1;
  }
  return n;
}

const codepoints = (s) => [...s].length;

/* ---------------- 违禁词 ---------------- */

const BANNED = [
  {
    re: /(\bAI\b|人工智能|大模型|智能生成|生成式|深度合成)/i,
    why: '运行期不调用任何模型，提 AI 与事实不符；且会把小程序推进「深度合成」类目（个人主体未开放）',
  },
  {
    re: /(保录取|保证录取|包录取|确保录取|录取率|包过)/,
    why: '匹配度是自研算法的估算值，不是官方数据，不得作录取承诺',
  },
  {
    re: /(最好|最优|最强|最大|最全|最专业|最权威|最领先|第一名|唯一|100%)/,
    why: '运营规范禁止绝对化用语',
  },
  {
    re: /(教育培训|留学中介|招生代理|咨询服务)/,
    why: '与备案前置审批关键词同域，个人主体应回避（风险提示，非官方明文）',
  },
];

/* ---------------- 读取文档 ---------------- */

let src;
try {
  src = fs.readFileSync(DOC, 'utf8');
} catch (e) {
  console.error(`❌ 读不到 ${DOC}`);
  process.exit(1);
}

const lines = src.split('\n');

const START = '<!-- intro -->';
const END = '<!-- /intro -->';
const startIdx = lines.findIndex((l) => l.trim() === START);
const endIdx = lines.findIndex((l) => l.trim() === END);

const fails = [];
const warns = [];
let asserts = 0;

if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
  console.error(`❌ 文档里找不到 ${START} / ${END} 区块`);
  process.exit(1);
}

/* ---------------- 抽取候选 ---------------- */

const candidates = [];
for (let i = startIdx + 1; i < endIdx; i++) {
  const raw = lines[i];
  if (!raw.startsWith('> ')) continue;
  const text = raw.slice(2).trim();
  if (!text) continue;
  candidates.push({ line: i + 1, text });
}

if (candidates.length === 0) {
  console.error(`❌ ${START} 区块内没有以 "> " 开头的候选文案`);
  process.exit(1);
}

/* ---------------- 输出 ---------------- */

console.log('\n📋 微信后台「介绍」字段候选（硬约束：4–120 字符）\n');
console.log('  #   行号   码点   加权   状态   正文');
console.log('  ' + '─'.repeat(96));

candidates.forEach((c, i) => {
  const cp = codepoints(c.text);
  const wt = weighted(c.text);
  const ok = wt >= MIN && wt <= MAX;
  const tag = i === 0 ? 'A' : String.fromCharCode(65 + i);
  console.log(
    `  ${tag}   ${String(c.line).padStart(4)}   ${String(cp).padStart(4)}   ${String(wt).padStart(4)}   ` +
      `${ok ? '✅  ' : '❌  '}   ${c.text.slice(0, 40)}${c.text.length > 40 ? '…' : ''}`
  );

  asserts++;
  if (!ok) {
    fails.push(
      `第 ${c.line} 行（候选 ${tag}）：加权 ${wt} 字符，超出 ${MIN}–${MAX} 区间 —— ${c.text}`
    );
  }

  // 违禁词
  BANNED.forEach((b) => {
    const m = c.text.match(b.re);
    if (m) {
      asserts++;
      fails.push(`第 ${c.line} 行（候选 ${tag}）：命中违禁词「${m[0]}」—— ${b.why}`);
    }
  });

  // 一致性：不能同时出现「择校」与「选校」（术语必须统一）
  if (/择校/.test(c.text)) {
    asserts++;
    fails.push(`第 ${c.line} 行（候选 ${tag}）：用了「择校」—— 本项目统一用「选校」`);
  }
});

console.log('  ' + '─'.repeat(96));
console.log('\n  加权口径 = 汉字 / 全角标点计 2 字符，ASCII 计 1（比官方可能的口径更严，以它为控长依据）');

/* ---------------- 第二部分字数（只统计，不设限） ---------------- */

const sec2 = lines.slice(endIdx + 1).join('\n');
const body = sec2
  .replace(/^#{1,6}.*$/gm, '')
  .replace(/^[-*]\s/gm, '')
  .replace(/^\s*$/gm, '');
const bodyChars = [...body.replace(/\s/g, '')].length;

console.log(`\n📄 参赛作品简介部分：约 ${bodyChars} 字（含标点，不含空白；无硬性上限）`);

/* ---------------- 汇总 ---------------- */

console.log('\n' + '─'.repeat(100));
console.log(`断言 ${asserts} 条`);

if (fails.length) {
  console.log(`\n❌ 失败 ${fails.length} 条：`);
  fails.forEach((f) => console.log(`   · ${f}`));
}
if (warns.length) {
  console.log(`\n⚠️  警告 ${warns.length} 条：`);
  warns.forEach((w) => console.log(`   · ${w}`));
}
if (!fails.length) {
  console.log('\n✅ 全部候选均在 4–120 字符内，且未命中违禁词');
}

console.log('');
process.exit(fails.length ? 1 : 0);
