#!/usr/bin/env node
/**
 * 数据编译：data-source/*.json  →  miniprogram/data/universities.js
 * ------------------------------------------------------------------
 * 小程序只能 request 已 ICP 备案的域名，境外数据源无法直连；
 * 因此数据在构建期离线合并，编译为一个 CommonJS 模块内置进包。
 * 运行时零网络请求 → 无需备案域名、无需云开发，测试号即可跑通全流程。
 *
 * 用法： node data-source/build.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = __dirname;
const OUT_DIR = path.join(ROOT, 'miniprogram', 'data');

function readJSON(name) {
  const p = path.join(SRC, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`  ! ${name} 解析失败：${e.message}`);
    return null;
  }
}

/* ---------------- 1. 院校主数据（QS 2027） ---------------- */
const qs = readJSON('qs2027.json');
if (!qs) {
  console.error('✗ 缺少 data-source/qs2027.json，无法编译');
  process.exit(1);
}

/* ---------------- 2. 录取要求（按地区分片） ---------------- */

/**
 * 采集分片与前一份主数据的 id 可能不一致（例如 'utoronto' vs 'toronto'）。
 * 因此不依赖 id 硬匹配，改为「id 精确 → 英文名归一化 → 别名表」三级回退，
 * 避免因为一个命名差异就静默丢失整所学校的录取要求。
 */
const ALIAS = {
  utoronto: 'toronto',
  'university-of-toronto': 'toronto',
  ualberta: 'alberta',
  uwaterloo: 'waterloo',
  uwo: 'western',
  'western-university': 'western',
  uottawa: 'ottawa',
  ucalgary: 'calgary',
  dal: 'dalhousie',
  'dalhousie-university': 'dalhousie',
  mcgill: 'mcgill',
  sfu: 'sfu',
  'simon-fraser-university': 'sfu',
  'york-university': 'york',
  uvic: 'uvic',
  'university-of-victoria': 'uvic',
  unsw: 'unsw',
  'unsw-sydney': 'unsw',
  'university-of-new-south-wales': 'unsw',
  unimelb: 'melbourne',
  'university-of-melbourne': 'melbourne',
  usyd: 'sydney',
  'university-of-sydney': 'sydney',
  anu: 'anu',
  'australian-national-university': 'anu',
  monash: 'monash',
  'monash-university': 'monash',
  uq: 'uq',
  'university-of-queensland': 'uq',
  uwa: 'uwa',
  'university-of-western-australia': 'uwa',
  adelaide: 'adelaide',
  'adelaide-university': 'adelaide',
  uts: 'uts',
  'university-of-technology-sydney': 'uts',
  rmit: 'rmit',
  'rmit-university': 'rmit',
  mq: 'macquarie',
  'macquarie-university': 'macquarie',
};

/** 名称归一化：小写、去变音符、去掉 University of / The 等前后缀、只留字母数字 */
function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(the|university|of|at|college|london|sydney|australia's?)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/** 建立「归一化名 → qs id」索引 */
const nameIndex = {};
for (const s of qs.schools) {
  nameIndex[normName(s.nameEn)] = s.id;
  nameIndex[normName(s.nameCn)] = s.id;
}

function resolveId(rec) {
  if (rec.id && qs.schools.some((s) => s.id === rec.id)) return rec.id;
  const alias = ALIAS[String(rec.id || '').toLowerCase()];
  if (alias) return alias;
  const byName = nameIndex[normName(rec.nameEn)] || nameIndex[normName(rec.nameCn)];
  if (byName) return byName;
  return null;
}

const admission = {};
const unmatched = [];
let admissionShards = 0;

/**
 * 录取要求分片清单。新增地区只需在这里加一项：
 * 编译时会尝试读 data-source/admission-<region>.json，不存在就跳过。
 */
const ADMISSION_REGIONS = ['ca', 'au', 'us'];

for (const region of ADMISSION_REGIONS) {
  const shard = readJSON(`admission-${region}.json`);
  if (!shard || !Array.isArray(shard.schools)) continue;
  admissionShards++;
  for (const rec of shard.schools) {
    const id = resolveId(rec);
    if (id) admission[id] = rec;
    else unmatched.push(`${region}:${rec.id}/${rec.nameEn}`);
  }
}

/* ---------------- 3. 合并 ---------------- */

/**
 * 采集到的字段可能是带说明的字符串（如「单项不低于 6.0（商科建议 7.0）」），
 * 而匹配算法需要的是数字。这里统一抽出首个数字，
 * 原文另存到 *Note 字段供页面展示，避免丢失学校给出的附加条件。
 */
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

function note(v) {
  return typeof v === 'string' && /\D/.test(v) ? v : '';
}

const schools = qs.schools.map((s) => {
  const a = admission[s.id] || null;
  const rankTie = !!s.rankTie;
  return {
    id: s.id,
    nameCn: s.nameCn,
    nameEn: s.nameEn,
    region: s.region,
    countryCn: s.countryCn,
    cityCn: s.cityCn,
    provinceCn: s.provinceCn,
    /** 数值型排名，用于排序与筛选 */
    qs: s.qs2027,
    /**
     * 展示用短标签：QS 32 / QS =113 / QS 801-850
     * ⚠️ QS 对 500 名之后只公布区间（如 801-850），此时 qs2027 存区间下界用于排序，
     *    真实名次范围放 qsRange。两者都不能少：前者保证排序可用，后者保证展示不说谎。
     */
    qsLabel: 'QS ' + (s.qsRange || (rankTie ? '=' : '') + s.qs2027),
    /** 详情页大号数字位：区间院校显示区间，避免把「801-850」说成「801」 */
    qsDisplay: s.qsRange || (rankTie ? '=' : '') + s.qs2027,
    /** 区间名次原文，无区间时为 null */
    qsRange: s.qsRange || null,
    qsTie: rankTie,
    qsChange: s.rankChange,
    qsScore: s.score,
    nationalRank: s.nationalRank,
    founded: s.founded,
    type: s.type,
    crest: s.crest,
    city: s.cityCn,
    province: s.provinceCn,
    /** 分校区（有则详情页「相关院校」优先展示） */
    campuses: s.campuses || [],
    /** 优势专业：官方学科优势尚未采集，留空数组，页面据此降级展示 */
    strengths: s.strengths || [],
    /** 录取要求：未采集到则为 null，页面据此降级展示 */
    require: a
      ? {
          gpa: num(a.gpaMin),
          gpaNote: a.gpaNote || '',
          ielts: num(a.ieltsOverall),
          ieltsSub: num(a.ieltsSub),
          /** 单项的原文说明，页面上作为补充信息展示 */
          ieltsSubNote: note(a.ieltsSub),
          toefl: num(a.toefl),
          sat: a.satRequired || 'unknown',
          ap: a.apAccepted || 'unknown',
          /**
           * ⚠️ `apMin` 是 **AP 单科最低分数**，`apCoursesMin` 才是**最少科目数**。
           * 两者是并列的两个约束，不要合并成一个字段 —— 2026-09-23 之前只有
           * `apMin`，采集时把「至少 3 门 AP」也写进了它，导致它在不同院校里
           * 分别表示「3 分」和「3 门」，而算法只按其中一种解释。
           * `apCoursesMin` 只在官网明文写了门数时才有值，否则为 null。
           */
          apMin: num(a.apMin),
          apCoursesMin: num(a.apCoursesMin),
          pathways: a.pathways || [],
        }
      : null,
    source: a ? a.source || [] : [],
  };
});

/* ---------------- 4. 派生统计 ---------------- */
const byRegion = {};
for (const s of schools) {
  byRegion[s.region] = (byRegion[s.region] || 0) + 1;
}

const meta = {
  ...qs.meta,
  compiledAt: new Date().toISOString().slice(0, 10),
  total: schools.length,
  byRegion,
  admissionShards,
  admissionCovered: Object.keys(admission).length,
};

/* ---------------- 5. 输出 ---------------- */
const banner = `/**
 * 自动生成，请勿手改。
 * 源：data-source/qs2027.json${admissionShards ? ' + data-source/admission-*.json' : ''}
 * 重新编译：node data-source/build.js
 *
 * QS 2027 于 2026-06-18 发布；本数据集为 ${meta.compiledAt} 快照。
 * 录取要求为各校官方招生页采集快照，最终以学校官网为准。
 */`;

const js = `${banner}
const META = ${JSON.stringify(meta, null, 2)};

const SCHOOLS = ${JSON.stringify(schools, null, 2)};

/** 地区筛选项（院校库） */
const REGIONS = [
  { key: 'all', label: '全部' },
  { key: 'us', label: '美国' },
  { key: 'uk', label: '英国' },
  { key: 'ca', label: '加拿大' },
  { key: 'au', label: '澳大利亚' }
];

/**
 * 匹配引擎的兜底地区范围（学生未勾选目标国家时使用）。
 * 只有在这三个地区都具备录取要求数据时纳入才有意义 ——
 * 否则该地区的院校会全员落进「待评估」，列表看着很长但全是空的。
 * 2026-09-19 起纳入 us：美国 57 所已全部采集录取要求。
 */
const MATCH_REGIONS = ['ca', 'au', 'us'];

const byId = {};
for (const s of SCHOOLS) byId[s.id] = s;

function getSchool(id) {
  return byId[id] || null;
}

function listByRegion(region) {
  if (!region || region === 'all') return SCHOOLS;
  return SCHOOLS.filter((s) => s.region === region);
}

module.exports = { META, SCHOOLS, REGIONS, MATCH_REGIONS, getSchool, listByRegion };
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'universities.js');
fs.writeFileSync(outFile, js, 'utf8');

console.log('✓ 院校数据已编译');
console.log(`  院校总数      ${schools.length}  （加拿大 ${byRegion.ca || 0} / 澳大利亚 ${byRegion.au || 0} / 英国 ${byRegion.uk || 0} / 美国 ${byRegion.us || 0}）`);
console.log(`  录取要求覆盖  ${meta.admissionCovered} 所${admissionShards ? '' : '（admission-*.json 尚未产出，等待采集）'}`);
console.log(`  → ${path.relative(process.cwd(), outFile)}  (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
