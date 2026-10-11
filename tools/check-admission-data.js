#!/usr/bin/env node
/**
 * 院校录取要求数据质量校验台
 * ==================================================================
 * 为什么需要它：
 *   匹配引擎（utils/match.js）只有 53 行算分逻辑，对 26 所和 2600 所
 *   是**完全相同的代码** —— 它只吃归一化后的 req 对象，不关心是哪所学校。
 *   所以「数据量变大」的风险不在引擎，在**数据本身**：
 *     · 字段类型被改坏 → 引擎拿到 NaN，静默算错分（不报错，最危险）
 *     · 数值越界 → 分档落在不可能的位置
 *     · 覆盖度不足 → 某维度全员取中性分，匹配度分辨率塌陷
 *     · 来源缺失 → 无法复核，违背「数据真实性」红线
 *
 *   这个脚本把上述四类问题在**构建期**挡住，而不是等用户在真机上
 *   看到一个莫名其妙的分数。
 *
 * 判定分级：
 *   ✗ 失败 —— 类型错 / 数值越界 / 来源缺失，必须修（退出码非零）
 *   ⚠️ 警告 —— 覆盖度不足，属已知事实，登记后按需采集
 *   ✓ 通过
 *
 * 用法：node tools/check-admission-data.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'data-source');
const UNI_PATH = path.join(ROOT, 'miniprogram', 'data', 'universities.js');

let fail = 0;
let warn = 0;
let pass = 0;

function check(title, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${title}`);
  } else {
    fail++;
    console.log(`  ✗ ${title}${detail ? '\n      ' + detail : ''}`);
  }
}

function note(title, detail) {
  warn++;
  console.log(`  ⚠️ ${title}${detail ? '\n      ' + detail : ''}`);
}

function head(t) {
  console.log('\n' + '─'.repeat(64));
  console.log(t);
  console.log('─'.repeat(64));
}

/* ---------------- 加载原始数据 ---------------- */
function loadRaw(name) {
  const p = path.join(SRC_DIR, name);
  if (!fs.existsSync(p)) {
    console.error(`✗ 缺少 ${name}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const rawCa = loadRaw('admission-ca.json');
const rawAu = loadRaw('admission-au.json');
const rawUs = loadRaw('admission-us.json');
const rawList = [
  ...(rawCa.schools || rawCa.list || []),
  ...(rawAu.schools || rawAu.list || []),
  ...(rawUs.schools || rawUs.list || []),
];

/* ---------------- 加载编译产物 ---------------- */
if (!fs.existsSync(UNI_PATH)) {
  console.error('✗ 缺少 miniprogram/data/universities.js，先跑 node data-source/build.js');
  process.exit(1);
}
const uni = require(UNI_PATH);
const compiled = uni.SCHOOLS.filter((s) => s.require);

/* ================================================================== */
console.log('═'.repeat(64));
console.log('院校录取要求数据质量校验');
console.log('═'.repeat(64));
console.log(`原始数据 ${rawList.length} 条 ｜ 编译产物 ${compiled.length} 所带录取要求`);

/* ========== 1. 字段类型（引擎的隐式契约） ========== */
head('1. 字段类型 —— 引擎的隐式契约，改坏会静默算错分');

/** 引擎期望的类型：number 或 null；用于 ratio 运算的必须是 number */
const TYPE_SPEC = {
  gpa: 'number|null',
  ielts: 'number|null',
  ieltsSub: 'number|null',
  toefl: 'number|null',
  apMin: 'number|null',
};

for (const field of Object.keys(TYPE_SPEC)) {
  const bad = compiled.filter((s) => {
    const v = s.require[field];
    return v !== null && v !== undefined && typeof v !== 'number';
  });
  check(
    `require.${field} 全为 number|null`,
    bad.length === 0,
    bad.map((s) => `${s.id}=${JSON.stringify(s.require[field])}`).join(', ')
  );
}

const badPathways = compiled.filter(
  (s) => !Array.isArray(s.require.pathways)
);
check('require.pathways 全为数组', badPathways.length === 0, badPathways.map((s) => s.id).join(', '));

// ieltsSubNote 是解释性文字，若存在则 ieltsSub 不应为空
const orphanNote = compiled.filter(
  (s) => s.require.ieltsSubNote && s.require.ieltsSub === null
);
check(
  '有 ieltsSubNote 的院校其 ieltsSub 不为空',
  orphanNote.length === 0,
  orphanNote.map((s) => s.id).join(', ')
);

/* ========== 2. 数值合理性 ========== */
head('2. 数值合理性 —— 越界值会让分档落在不可能的位置');

function rangeCheck(field, min, max) {
  const bad = compiled.filter((s) => {
    const v = s.require[field];
    return typeof v === 'number' && (v < min || v > max);
  });
  check(
    `require.${field} 落在 ${min}–${max}`,
    bad.length === 0,
    bad.map((s) => `${s.id}=${s.require[field]}`).join(', ')
  );
}

rangeCheck('ielts', 0, 9);
rangeCheck('ieltsSub', 0, 9);
rangeCheck('toefl', 0, 120);
rangeCheck('gpa', 0, 100);
/**
 * ⚠️ `apMin` 是 **AP 单科最低分数**（AP 满分 5），不是「需要几门 AP」。
 *    旧范围写成 0–10，两种语义都能过 —— 等于没校验，正是这份宽松让它被
 *    当成门数用了一整轮（详见 .workbuddy/memory/2026-09-23.md）。
 *    收紧到 1–5：一旦有人再往这个字段塞门数（比如 6 门），这里立刻变红。
 */
rangeCheck('apMin', 1, 5);

/**
 * `apCoursesMin` 是**最少 AP 科目数**（与 `apMin` 的单科分数是两个独立约束）。
 * 只允许有官网明文依据的院校带这个字段 —— 目前只有 3 所，见
 * `.workbuddy/tmp/add-ap-courses-min.js` 与 `.workbuddy/memory/2026-09-23.md`。
 */
rangeCheck('apCoursesMin', 1, 10);
/** 目前只有这 3 所官网明文写了 AP 科目数：NYU「需至少 3 门 AP」、ANU / Macquarie「最少/通常 3 门」 */
const AP_COURSES_MIN_SCHOOLS = 3;
const countLine = compiled.filter((s) => s.require.apCoursesMin != null);
check(
  'apCoursesMin 只在有官网明文门数要求的院校出现（当前 3 所）',
  countLine.length === AP_COURSES_MIN_SCHOOLS,
  `实际 ${countLine.length} 所：${countLine.map((s) => `${s.id}=${s.require.apCoursesMin}`).join(', ')}`
);

const badAp = compiled.filter(
  (s) => s.require.ap !== undefined && !['direct', 'credit_only', 'unknown', null].includes(s.require.ap)
);
check('require.ap 取值在枚举内', badAp.length === 0, badAp.map((s) => `${s.id}=${s.require.ap}`).join(', '));

const badSat = compiled.filter(
  (s) => s.require.sat !== undefined && !['required', 'optional', 'not_required', 'unknown', null].includes(s.require.sat)
);
check('require.sat 取值在枚举内', badSat.length === 0, badSat.map((s) => `${s.id}=${s.require.sat}`).join(', '));

/* ========== 3. 来源可追溯（数据真实性红线） ========== */
head('3. 来源可追溯 —— 每条录取要求都必须能回到官方页面');

const noSource = rawList.filter((s) => !s.source || !s.source.length);
check(
  '原始数据每校都有 source[]',
  noSource.length === 0,
  noSource.map((s) => s.id || s.nameEn).join(', ')
);

const noCheckedAt = rawList.filter((s) => !s.checkedAt);
check(
  '原始数据每校都有 checkedAt',
  noCheckedAt.length === 0,
  noCheckedAt.map((s) => s.id || s.nameEn).join(', ')
);

const badUrl = [];
for (const s of rawList) {
  for (const u of s.source || []) {
    if (!/^https?:\/\//.test(u)) badUrl.push(`${s.id}: ${u}`);
  }
}
check('source 全部是合法 URL', badUrl.length === 0, badUrl.join(', '));

/* ========== 4. 覆盖度（真正的规模化瓶颈） ========== */
head('4. 覆盖度 —— 缺失会让该维度全员取中性分，匹配度分辨率塌陷');

const N = compiled.length;
const missing = {
  gpa: compiled.filter((s) => s.require.gpa === null),
  ielts: compiled.filter((s) => s.require.ielts === null),
  apMin: compiled.filter((s) => s.require.apMin === null),
  pathways: compiled.filter((s) => !s.require.pathways.length),
};

function coverage(field, list, fallbackField) {
  const pct = Math.round(((N - list.length) / N) * 100);
  const names = list.map((s) => s.nameCn || s.id).join('、');
  if (list.length === 0) {
    console.log(`  ✓ ${field}：${N}/${N} 全覆盖`);
  } else if (fallbackField && list.every((s) => s.require[fallbackField])) {
    // 有空值但每一条都有文字兜底 —— 这是设计意图，不是缺陷
    console.log(`  ✓ ${field}：${N - list.length}/${N} 有数值（${pct}%），其余 ${list.length} 所有「${fallbackField}」兜底`);
    console.log(`      未公布：${names}`);
  } else {
    note(`${field} 覆盖 ${pct}%（缺 ${list.length} 所）`, `未采集/未公布：${names}`);
  }
}

coverage('学术均分 gpa', missing.gpa, 'gpaNote');
coverage('语言要求 ielts', missing.ielts, 'ieltsSubNote');
coverage('先修课程 apMin', missing.apMin, null);
coverage('衔接路径 pathways', missing.pathways, null);

/* ========== 5. 归一化正确性（构建期转换是否可信） ========== */
head('5. 归一化正确性 —— 原始数据 → 编译产物');

// 原始数据里 ieltsSub 有字符串 / 数字 / 对象三种形态，必须全部归一到 number|null
const rawTypes = {};
for (const s of rawList) {
  const t = s.ieltsSub === null || s.ieltsSub === undefined ? 'null' : typeof s.ieltsSub;
  rawTypes[t] = (rawTypes[t] || 0) + 1;
}
console.log(`  原始 ieltsSub 形态：${JSON.stringify(rawTypes)}`);

const rawNumbers = rawList
  .filter((s) => typeof s.ieltsSub === 'number' && s.ieltsSub !== null)
  .map((s) => s.ieltsSub);
const compiledNumbers = compiled
  .filter((s) => typeof s.require.ieltsSub === 'number')
  .map((s) => s.require.ieltsSub);

check(
  '原始为数字的 ieltsSub 全部原样保留',
  rawNumbers.every((v) => compiledNumbers.includes(v)),
  `原始 ${rawNumbers.length} 个数字，编译产物 ${compiledNumbers.length} 个`
);

// 字符串形态必须被解析出数字、且原文进 note 字段，不允许静默丢弃
// ⚠️ 原始分片与编译产物的 id 可能不一致（utoronto vs toronto），
//    因此按 id 精确匹配失败后要用 nameEn 回退 —— 与本校验台自身的 bug 同源。
function findCompiled(raw) {
  return (
    compiled.find((x) => x.id === raw.id) ||
    compiled.find((x) => x.nameEn === raw.nameEn) ||
    null
  );
}

const rawStrings = rawList.filter((s) => typeof s.ieltsSub === 'string');
const lostStrings = [];
for (const s of rawStrings) {
  const c = findCompiled(s);
  if (!c) {
    lostStrings.push(`${s.id}: 编译产物里找不到对应院校`);
  } else if (c.require.ieltsSub === null) {
    lostStrings.push(`${s.id}: 未解析出数字（原文「${s.ieltsSub}」）`);
  } else if (!c.require.ieltsSubNote) {
    lostStrings.push(`${s.id}: 解析出 ${c.require.ieltsSub} 但原文未存入 ieltsSubNote`);
  }
}
check(
  `原始为文字的 ieltsSub（${rawStrings.length} 条）都被解析出数字且原文入 note`,
  lostStrings.length === 0,
  lostStrings.join('\n      ')
);

// 引擎要求：不许出现既不是 number 也不是 null 的值
const nonNormalized = compiled.filter((s) => {
  const v = s.require.ieltsSub;
  return v !== null && typeof v !== 'number';
});
check('编译产物 ieltsSub 已完全归一化为 number|null', nonNormalized.length === 0);

/* ========== 6. 引擎口径自检 ========== */
head('6. 引擎口径 —— 用固定档案复算，防止代码与契约 4.5 漂移');

const match = require(path.join(ROOT, 'miniprogram', 'utils', 'match.js'));
const content = require(path.join(ROOT, 'miniprogram', 'data', 'content.js'));

const FIXTURE = {
  curriculum: 'AP',
  courses: [{ name: 'AP Calculus BC', score: 5 }],
  gpa: 86,
  gpaScale: 100,
  ielts: { overall: 5.0, l: 4.5, r: 4.5, w: 5.5, s: 5.0 },
  countries: ['ca', 'au'],
  majors: ['cs'],
};

const r = match.run(FIXTURE);
check('run() 返回 total 与 list 长度一致', r.total === r.list.length);
check('每条结果 score 为 null 或 0–100', r.list.every((s) => s.match === null || (s.match >= 0 && s.match <= 100)));
check(
  'tier 取值在 safe/match/reach/unknown 内',
  r.list.every((s) => ['safe', 'match', 'reach', 'unknown'].indexOf(s.tier) > -1)
);
check('档位计数之和等于总数', Object.values(r.tiers).reduce((a, b) => a + b, 0) === r.total);

// 分档阈值：契约 4.5 规定 safe≥85、match 70–84、reach<70
// ⚠️ 例外：语言未达该校直录线时档位**封顶 reach**（`matchConfig.capTierWhenLanguageShort`），
//    因此会出现「分数 ≥70 却是冲刺」的组合。那是有意为之的硬约束，不是分档错乱 ——
//    断言必须认它，否则每次跑都会把一条正确行为报成缺陷。
const thresholdOk = r.list.every((s) => {
  if (s.match === null) return s.tier === 'unknown';
  if (s.capped) return s.tier === 'reach';
  if (s.match >= 85) return s.tier === 'safe';
  if (s.match >= 70) return s.tier === 'match';
  return s.tier === 'reach';
});
check('分档符合阈值（safe≥85 / match≥70；语言未达线时封顶 reach）', thresholdOk);

/* ------------------------------------------------------------------
   2026-09-23 三条新口径的守卫
   每一条都对应一个真实发生过的错误结论，别让它们悄悄退回去
   （背景见 .workbuddy/memory/2026-09-23.md）。
   ------------------------------------------------------------------ */

// ① 语言未达线 → 档位封顶。FIXTURE 雅思 5.0 达不到任何一所的直录线
const cappedList = r.list.filter((s) => s.match !== null && s.capped);
check(
  '语言未达直录线时档位封顶为 reach',
  cappedList.length > 0 && cappedList.every((s) => s.tier === 'reach'),
  `封顶 ${cappedList.length} 所`
);

// ② 课程维度不再拿「门数」扣分 —— 考生没填课程时它必须整条不适用（value=null）。
//    旧实现会给 40 分占位分，于是「AP 0 门 / 需 4 门」也能拿到 76 分并进「匹配」档。
const noCourse = match.run(Object.assign({}, FIXTURE, { courses: [] }));
const currDim = (s) => (s.dims || []).find((x) => x.key === 'curriculum');
check(
  '没填课程时课程维度不出分（value=null），不拿门数硬扣分',
  noCourse.list.filter((s) => s.match !== null).every((s) => currDim(s) && currDim(s).value === null)
);

// ③ 院校只把 AP 用于转学分（credit_only）时，AP 与录取评估无关，同样不出分
const creditOnly = match.run(FIXTURE).list.filter(
  (s) => s.match !== null && s.require && s.require.ap === 'credit_only'
);
check(
  'credit_only 的院校不按 AP 折算线给课程维度打分',
  creditOnly.length > 0 && creditOnly.every((s) => currDim(s) && currDim(s).value === null),
  `${creditOnly.length} 所`
);

// ③-b `apCoursesMin`（最少科目数）与 `apMin`（单科分数）是两个独立约束，都要判。
//      2026-09-23 之前「至少 3 门 AP」被塞进 `apMin`，算法只按分数解释 → 门数要求丢失。
const nyu = uni.SCHOOLS.find((s) => s.id === 'nyu');
const apCourses = (n) =>
  Array.from({ length: n }, (_, i) => ({ name: 'AP ' + i, score: 5 }));
const cDimOf = (e) => (e.dims || []).find((x) => x.key === 'curriculum');
const nyu2 = cDimOf(match.evaluate(nyu, Object.assign({}, FIXTURE, { courses: apCourses(2) })));
const nyu3 = cDimOf(match.evaluate(nyu, Object.assign({}, FIXTURE, { courses: apCourses(3) })));
check(
  'AP 门数不足时课程维度拿不到满分（NYU 需至少 3 门）',
  !!nyu2 && !!nyu3 && nyu2.value < 100 && nyu3.value === 100,
  `2 门=${nyu2 && nyu2.value} / 3 门=${nyu3 && nyu3.value}`
);

// ④ 语言未达线时按差距分档，差得越远分越低。
//    旧口径一律 72 分 ——「差 0.5 分」和「差 2 分」拿到同一个数，分辨率归零。
const probe = uni.SCHOOLS.find(
  (s) => s.require && s.require.ielts === 6.5 && (s.require.pathways || []).length
);
const langScoreAt = (overall) => {
  const e = match.evaluate(
    probe,
    Object.assign({}, FIXTURE, { ielts: { overall, l: overall, r: overall, w: overall, s: overall } })
  );
  const d = (e.dims || []).find((x) => x.key === 'language');
  return d ? d.value : null;
};
const langCurve = [6.5, 6.0, 5.5, 5.0].map(langScoreAt);
check(
  '语言未达线时按差距递减给分（达标 > 差 0.5 > 差 1.0 > 差 1.5）',
  langCurve[0] > langCurve[1] && langCurve[1] > langCurve[2] && langCurve[2] > langCurve[3],
  langCurve.join(' > ')
);

// ⑤ 单项没填 ≠ 单项不达标。只填总分时，单项未填不得被当成 0 分拉低判定
const overallOnly = match.evaluate(probe, Object.assign({}, FIXTURE, { ielts: { overall: 6.5 } }));
const langOnly = (overallOnly.dims || []).find((x) => x.key === 'language');
check(
  '只填总分且单项未知时，语言维度按总分达标判定',
  !!langOnly && langOnly.value === 100,
  `实际 ${langOnly && langOnly.value}`
);

// 可复现性：同一档案跑两次结果必须完全一致
const r2 = match.run(FIXTURE);
check(
  '同一档案两次运行结果完全一致（可复现）',
  JSON.stringify(r.list.map((s) => [s.id, s.match, s.tier])) ===
    JSON.stringify(r2.list.map((s) => [s.id, s.match, s.tier]))
);

// 权重口径：学术 42% + 语言 33% + 课程 25%
const w = content.matchConfig.weights;
check(
  '权重之和为 1（学术 42% / 语言 33% / 课程 25%）',
  Math.abs(w.academic + w.language + w.curriculum - 1) < 1e-9,
  `实际 ${JSON.stringify(w)}`
);

// 不伪造结论：档案不全时必须不出分
const empty = match.run({ countries: ['ca'] });
check('档案不全时不出分（needsProfile）', empty.needsProfile === true && empty.list.length === 0);

// 数据缺失的院校必须标待评估，不得给分
const noReq = r.list.filter((s) => s.needData === true);
check('录取要求缺失的院校 tier 为 unknown 且 match 为 null', noReq.every((s) => s.tier === 'unknown' && s.match === null));

/* ========== 7. 排名字段自洽（2026-09-19 新增） ========== */
head('7. 排名字段自洽 —— 区间名次与国内排名由构建期计算，最容易悄悄错');

const allSchools = uni.SCHOOLS;
const ids = allSchools.map((s) => s.id);
check('院校 id 无重复', new Set(ids).size === ids.length,
  ids.filter((v, i) => ids.indexOf(v) !== i).join(', '));

check('每所院校都有 non-empty qsDisplay', allSchools.every((s) => s.qsDisplay !== undefined && s.qsDisplay !== ''),
  allSchools.filter((s) => !s.qsDisplay).map((s) => s.id).join(', '));

// 区间名次：qsLabel 必须展示区间，且 qs 数值落在区间内（排序用下界）
const ranged = allSchools.filter((s) => s.qsRange);
const rangedBad = ranged.filter((s) => {
  if (!s.qsLabel.includes(s.qsRange)) return true;
  const m = String(s.qsRange).match(/^(\d+)-(\d+)$/);
  if (!m) return true;
  return !(s.qs >= +m[1] && s.qs <= +m[2]);
});
check(
  `区间名次院校（${ranged.length} 所）qsLabel 展示区间且 qs 落在区间内`,
  rangedBad.length === 0,
  rangedBad.map((s) => `${s.id} qs=${s.qs} range=${s.qsRange} label=${s.qsLabel}`).join('\n      ')
);

// 非区间院校的 qsLabel 必须与 qs 一致（含并列标记）
const exactBad = allSchools.filter(
  (s) => !s.qsRange && s.qsLabel !== 'QS ' + (s.qsTie ? '=' : '') + s.qs
);
check('非区间院校 qsLabel 与 qs/qsTie 一致', exactBad.length === 0,
  exactBad.map((s) => `${s.id} label=${s.qsLabel} qs=${s.qs} tie=${s.qsTie}`).join('\n      '));

// 国内排名：每个地区内应为 1..N 的连续整数，且与 qs 升序一致
const byRegion = {};
for (const s of allSchools) (byRegion[s.region] = byRegion[s.region] || []).push(s);
let rankBad = [];
for (const [reg, list] of Object.entries(byRegion)) {
  const sorted = list.slice().sort((a, b) => a.qs - b.qs);
  sorted.forEach((s, i) => {
    if (s.nationalRank !== i + 1) rankBad.push(`${reg}:${s.id} 期望 ${i + 1} 实际 ${s.nationalRank}`);
  });
}
check('各地区 nationalRank 连续且与 QS 升序一致', rankBad.length === 0, rankBad.join(', '));

// 名次不能有重复的「国家内第 N 名」——并列必须共享同一个 N
const dupRank = [];
for (const [reg, list] of Object.entries(byRegion)) {
  const seen = {};
  for (const s of list) {
    const k = s.nationalRank;
    if (seen[k] && seen[k].qs !== s.qs) dupRank.push(`${reg}: ${seen[k].id} 与 ${s.id} 同为第 ${k} 名但 QS 不同`);
    seen[k] = s;
  }
}
check('同一国内排名不会对应不同 QS 名次', dupRank.length === 0, dupRank.join('; '));

// 并列标记一致性：同一个 QS 数值出现多次时，这些院校都应标 qsTie
const qsCount = {};
for (const s of allSchools) qsCount[s.qs] = (qsCount[s.qs] || 0) + 1;
const tieBad = allSchools.filter((s) => qsCount[s.qs] > 1 && !s.qsTie && !s.qsRange);
check('同一 QS 数值多校时均标记并列', tieBad.length === 0, tieBad.map((s) => s.id).join(', '));

/* ========== 8. 不出假结论：占位分不得堆出分数（2026-09-19 新增） ========== */
head('8. 不出假结论 —— 无官方数据的维度不得堆出「匹配」结论');

check(
  'MATCH_REGIONS 含 us（美国已采集录取要求）',
  Array.isArray(uni.MATCH_REGIONS) && uni.MATCH_REGIONS.indexOf('us') > -1,
  JSON.stringify(uni.MATCH_REGIONS)
);

// 覆盖三个地区各跑一次，确认没有地区因数据形态不同而漏掉
const FIXTURE_REGIONS = [['ca', 'au'], ['us'], ['ca', 'au', 'us', 'uk']];
const offenders = [];
for (const countries of FIXTURE_REGIONS) {
  const rr = match.run(Object.assign({}, FIXTURE, { countries }));
  for (const s of rr.list) {
    const req = s.require;
    if (!req) continue;
    // 学术与语言两个主维度都无官方数值 → 必然双双取 neutral 占位分
    if (req.gpa === null && req.ielts === null) {
      if (s.match !== null || s.tier !== 'unknown') {
        offenders.push(`${countries.join('+')}:${s.id} score=${s.match} tier=${s.tier}`);
      }
    }
  }
}
check(
  '关键项全空的院校一律「待评估」，不出分',
  offenders.length === 0,
  offenders.join('\n      ')
);

// 反向确认：确实存在这类院校，否则上面那条断言是空跑
const emptyReqCount = uni.SCHOOLS.filter(
  (s) => s.require && s.require.gpa === null && s.require.ielts === null
).length;
check(
  `存在「关键项全空」的院校样本（${emptyReqCount} 所）供上述断言生效`,
  emptyReqCount > 0,
  '若为 0，说明数据形态变了，上面的断言需要重新设计'
);

// 有分数的院校，其分数必须真的来自官方数据（至少一个主维度有值）
const scoredAll = match
  .run(Object.assign({}, FIXTURE, { countries: ['ca', 'au', 'us', 'uk'] }))
  .list.filter((s) => s.match !== null);
const noBasis = scoredAll.filter((s) => {
  const req = s.require;
  return !req || (req.gpa === null && req.ielts === null);
});
check('所有被算分的院校都至少有一个主维度有官方数据', noBasis.length === 0,
  noBasis.map((s) => s.id).join(', '));

// partialData 标记必须与实际缺数据的维度一致
const partialBad = scoredAll.filter((s) => {
  const req = s.require;
  const expectPartial = req.gpa === null || req.ielts === null;
  return !!s.partialData !== expectPartial;
});
check('partialData 标记与实际缺数据情况一致', partialBad.length === 0,
  partialBad.map((s) => `${s.id} partial=${s.partialData}`).join(', '));

/* ========== 汇总 ========== */
console.log('\n' + '═'.repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败 / ${warn} 警告`);
if (warn) console.log(`警告项属于「已知的采集缺口」，登记后按需补齐，不阻塞构建`);
console.log('═'.repeat(64));
process.exit(fail ? 1 : 0);
