#!/usr/bin/env node
/**
 * 首页（01）推荐行 验证台
 * ==================================================================
 * 覆盖「光读代码看不出来、必须跑起来/核数据才算数」的三类问题：
 *
 *   1) **把用户的数据摆在院校属性位上**
 *      推荐行副标题是「描述这所学校」的位置（国家 · QS）。这里曾放过一段
 *      取自**用户学业档案**的目标专业，于是三行都写着「计算机科学」——
 *      读起来像「这所学校的专业」，而它既不是院校数据、也从未参与筛选：
 *        · 兜底分支只按「目标国家 + QS 排序」取列表，没有专业维度；
 *        · 匹配算法只评估 academic / language / curriculum。
 *      2026-09-24 移除。本台守住它不被顺手加回来。
 *
 *   2) **凭空下结论的徽标**
 *      `item.tier` 为空是「这批推荐根本没评估过」（没匹配 → 按 QS 兜底），
 *      `item.tier === 'unknown'` 是「评估过、但该校要求未采集」。
 *      前者出徽标就是编造结论。曾经无差别走 else 贴「待评估」，
 *      对新用户满屏误报 —— 那句话读起来像「这学校数据还在整理」。
 *
 *   3) **要显示院校专业，先得有那份数据**
 *      院校库的 `strengths` 当前覆盖 63/99（美 53/57、加 10/25、
 *      **澳 0/11、英 0/6**）。澳洲英国一所都没有 —— 硬做只能留空或编造。
 *      本台的判定是**条件式**的：不显示专业＝通过；一旦要显示，
 *      被展示区域的 `strengths` 就必须 100% 覆盖。这样既守住当下，
 *      也不会在数据补齐后误报。
 *
 * 用法：node tools/verify-home-page.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'miniprogram');
const HOME = path.join(PROJECT, 'pages/home/home');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`);
  }
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}
const read = (p) => fs.readFileSync(p, 'utf8');
/** 剥注释：这些文件的注释里大量出现 majorLabel / tier 等词，不剥会把断言喂绿 */
const strip =
  (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const wxmlRaw = read(HOME + '.wxml');
const wxml = strip(wxmlRaw);
const js = strip(read(HOME + '.js'));

/* ================================================================
   1 · 推荐行只由院校自身属性构成
   ================================================================ */
head('1 · 推荐行的副标题只描述院校本身');

const recMeta = /<view class="rec__meta">([\s\S]*?)<\/view>/.exec(wxml);
check('能定位推荐行的 rec__meta 区块', !!recMeta);

const metaBody = recMeta ? recMeta[1] : '';
check('副标题里有国家字段', /\{\{item\.countryCn\}\}/.test(metaBody));
check('副标题里有 QS 字段', /\{\{item\.qsLabel\}\}/.test(metaBody));
check(
  '副标题里**没有**用户侧字段（专业 / 目标 / 档案）',
  !/major|Major|profile|档案|目标专业/.test(metaBody),
  metaBody.replace(/\s+/g, ' ').trim().slice(0, 90)
);
check(
  '副标题里不再出现条件渲染的用户标签（wx:if 只剩风格类用途都算可疑）',
  (metaBody.match(/wx:if/g) || []).length === 0
);

check('页面不再持有 majorLabel 这类用户侧标签', wxml.indexOf('majorLabel') === -1 && js.indexOf('majorLabel') === -1);
check('页面 data 里没有 majorLabel', !/majorLabel\s*:/.test(js));

/* ================================================================
   2 · 首页不读学业档案（它不该知道用户选了什么专业）
   ================================================================ */
head('2 · 首页不读学业档案');

check('home.js 不再调用 api.getAcademic()', js.indexOf('getAcademic') === -1);
check('home.js 不再引用专业枚举', !/enums\.majors/.test(js));
check(
  '并行请求只剩「最近匹配 / 院校列表 / 收藏」三项',
  /Promise\.all\(\[[\s\S]*?\]\)/.test(js) &&
    (js.match(/api\.(getLatestMatch|listSchools|getFavorites|getAcademic)/g) || []).length === 3,
  (js.match(/api\.(getLatestMatch|listSchools|getFavorites|getAcademic)/g) || []).join(', ')
);

/* ================================================================
   3 · 徽标不得凭空下结论
   ================================================================ */
head('3 · 匹配徽标只在确有评估结论时出现');

check(
  '徽标外层用 item.tier 做闸门（不是无差别 else）',
  /wx:if="\{\{item\.tier\}\}"/.test(wxml),
  /wx:if="\{\{item\.tier[\s\S]{0,40}/.exec(wxml)?.[0]
);
check(
  '没有评估结论时渲染「待评估」的那条分支仍要求 tier 有值',
  /wx:if="\{\{item\.tier\}\}"[\s\S]*?tierShort\.unknown[\s\S]*?<\/view>/.test(wxml)
);

/* ================================================================
   4 · 要显示院校专业，先得有那份数据（条件式守卫）
   ================================================================ */
head('4 · 「在推荐行显示院校专业」的前提');

const schools = require(path.join(PROJECT, 'data/universities.js'));
const list = schools.SCHOOLS || schools.schools || schools;
const regions = ['us', 'ca', 'au', 'uk'];
const coverage = {};
for (const r of regions) {
  const inRegion = list.filter((s) => s.region === r);
  const withS = inRegion.filter((s) => Array.isArray(s.strengths) && s.strengths.length);
  coverage[r] = { total: inRegion.length, have: withS.length };
}
console.log(
  '  · strengths 覆盖实况：' +
    regions.map((r) => `${r} ${coverage[r].have}/${coverage[r].total}`).join(' / ')
);

const showsStrengths = /strengths/.test(wxml) || /item\.strengths/.test(wxml);
if (!showsStrengths) {
  check('推荐行当前不显示院校专业（与数据覆盖现状相符）', true);
} else {
  // 只有真要显示时，才要求数据必须已经补齐 —— 否则就是在留空或编造
  const missing = regions.filter((r) => coverage[r].have !== coverage[r].total);
  check(
    '既然要显示院校专业，被展示区域的 strengths 必须已 100% 覆盖',
    missing.length === 0,
    '仍缺：' + missing.map((r) => `${r} 缺 ${coverage[r].total - coverage[r].have}`).join('、')
  );
}

/* ================================================================ */
console.log('\n' + '='.repeat(64));
console.log('结果：' + pass + ' 通过 / ' + failures.length + ' 失败');
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('首页推荐行只描述院校本身，且不凭空下结论');
console.log('='.repeat(64));
