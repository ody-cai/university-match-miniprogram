/**
 * 匹配引擎
 * ------------------------------------------------------------------
 * ⚠️ 口径声明：本算法产出的是**预估匹配度**，由本项目自研规则计算，
 *    不是院校官方公布的录取概率。
 *
 * 三个维度（加权求和，满分 100；「不适用」的维度会把**分子与分母一起**剔除）：
 *   学术 —— 高中均分相对院校要求的达成度
 *   语言 —— 雅思总分与单项是否达标；未达标但院校提供语言/预科/双录路径时，
 *           按「离目标线还差多少分」给部分分（差得越远分越低）
 *   课程 —— 考生填写的 AP 成绩是否达到院校的折算分数线。⚠️ `apMin` 是
 *           **AP 单科最低分数**（3 / 4），不是「需要几门」；院校不拿 AP 当录取
 *           依据（credit_only）或考生没填课程时，该维度不适用、不参与加权
 *
 * ⚠️ 所有权重、分档阈值、枚举项都从 data/content.js 读取，
 *    可由后端 /v1/content 下发覆盖，**调整口径不需要发版**。
 *    改动后须同步更新《API接口契约.md》4.5 节，否则端云结果会不一致。
 */
const store = require('./store');
const uni = require('../data/universities');
const content = require('../data/content');

/** 取当前生效的算法配置 */
function cfg(options) {
  return (options && options.content && options.content.matchConfig) || content.matchConfig;
}

/** 枚举（供页面渲染下拉 / 标签） */
const CURRICULA = content.enums.curricula;
const COUNTRIES = content.enums.countries;
const MAJORS = content.enums.majors;
const REGIONS = content.enums.regions;

const TIER_LABEL = { safe: '保底', match: '匹配', reach: '冲刺', unknown: '待评估' };
const TIER_EN = { safe: 'Safe', match: 'Match', reach: 'Reach', unknown: 'Pending' };

/**
 * 档位的展示元信息。
 * 配色遵循设计稿：保底=绿、匹配=钴蓝、冲刺=橙、数据缺失=灰。
 */
const TIER_META = {
  safe: { key: 'safe', label: '保底', tone: 'ok' },
  match: { key: 'match', label: '匹配', tone: 'brand' },
  reach: { key: 'reach', label: '冲刺', tone: 'warn' },
  unknown: { key: 'unknown', label: '待评估', tone: 'mute' },
};

/* ------------------------------------------------------------------
   前置校验
   ------------------------------------------------------------------
   业务事实：**高中均分 + 语言成绩是所有申请路径的公共门槛**，
   AP / A-Level / IB 只是并列的选修路径。
   因此这两项没填齐时，任何分数都会是凭空估算 —— 此时一律不出分。
   ------------------------------------------------------------------ */

/** 用户档案是否足以支撑评分 */
function checkProfile(profile) {
  const p = profile || {};
  const hasGpa = !!(p.gpa && p.gpa > 0);
  const hasIelts = !!(p.ielts && p.ielts.overall > 0);
  return {
    ok: hasGpa && hasIelts,
    hasGpa,
    hasIelts,
    /** 缺哪几项，供 UI 精确提示 */
    missing: [
      !hasGpa ? 'gpa' : null,
      !hasIelts ? 'ielts' : null,
    ].filter(Boolean),
  };
}

/* ------------------------------------------------------------------
   维度打分
   ------------------------------------------------------------------ */

/** 学术：均分 / 要求均分 的比值分档 */
function scoreAcademic(profile, req, options) {
  const c = cfg(options);
  if (!req || !req.gpa || !profile.gpa) return { v: c.neutral, need: true };

  const ratio = profile.gpa / req.gpa;
  let v = c.academicFloor;
  for (const band of c.academicBands) {
    if (ratio >= band.min) {
      v = band.score;
      break;
    }
  }
  return { v, need: false, met: ratio >= 1.0 };
}

/**
 * 语言：总分与单项都达标才算过；未达标时按「离目标线还差多少分」给部分分。
 *
 * ⚠️ 两条 2026-09-23 修正的口径，都别退回去：
 *  1) 单项只在考生**真的填了**（> 0）时才参与判定。把没填的单项当 0 分，
 *     等于把「未知」判成「不达标」—— 那是凭空扣分。
 *  2) 未达标的档位按差距走（`languageGapBands`），不再一律给同一个分。
 *     雅思差 0.5 分和差 2 分是两个完全不同的事件，同分等于没有分辨率。
 */
function scoreLanguage(profile, req, options) {
  const c = cfg(options);
  if (!req || !req.ielts || !profile.ielts || !profile.ielts.overall) {
    return { v: c.neutral, need: true };
  }
  const i = profile.ielts;
  const overallGap = Math.max(0, req.ielts - i.overall);

  const subs = [i.l, i.r, i.w, i.s].map(Number).filter((x) => x > 0);
  const subGap = req.ieltsSub && subs.length
    ? Math.max(0, req.ieltsSub - Math.min.apply(null, subs))
    : 0;
  const gap = Math.max(overallGap, subGap);

  if (gap <= 0) return { v: c.languageScores.met, need: false, met: true, gap: 0 };

  const hasPath = !!(req.pathways && req.pathways.length);
  if (!hasPath) {
    return { v: c.languageScores.noPathway, need: false, met: false, gap, hasPath: false };
  }

  const bands = c.languageGapBands || [];
  let v = c.languageScores.noPathway;
  for (const b of bands) {
    if (gap <= b.maxGap) {
      v = b.score;
      break;
    }
  }
  return { v, need: false, met: false, gap, hasPath: true };
}

/**
 * 课程：考生填写的 AP 成绩能否用于该校的录取折算。
 * ------------------------------------------------------------------
 * ⚠️ 口径于 2026-09-23 修正。旧实现把 `require.apMin` 当成「需要的 AP 门数」，
 *    于是界面上出现了「AP 0 门 / 需 4 门」——而各校官网从来没有这个要求。
 *    证据（详见 `data/content.js` 的 `matchConfig.curriculum` 注释与
 *    `.workbuddy/memory/2026-09-23.md`）：
 *      · `apMin` 的取值只有 3 和 4，来源链接全是 transfer-credit 页；
 *      · 滑铁卢原文 "a minimum final grade of 4"；
 *      · 达尔豪斯 "national exam result of 4 or 5 are eligible for transfer credits
 *        consideration"，且录取只看高中成绩 —— 对应 `ap: 'credit_only'`；
 *      · 澳校数据分片的 meta 自己写着「最少 3 门、**单门 3 分+**」，
 *        进入字段的是那个 3 **分**。
 *    ⇒ 判定看**分数**，门数只是「有几门达到了线」。
 *
 * 返回 `applicable: false` 的三种情形都不该扣分 —— AP 是并列的选修路径，
 * 不是所有申请人的公共门槛（公共门槛只有均分 + 语言，见 `checkProfile`）。
 */
function scoreCurriculum(profile, req, options) {
  const c = cfg(options);

  if (!req) return { applicable: false, why: 'noApRequirement' };

  // ① 院校只把 AP 用于转学分，与录取评估无关
  if (req.ap === 'credit_only') return { applicable: false, why: 'creditOnly' };

  /**
   * 两个**并列**的约束，不要合并：
   *   · `apMin`        —— AP 单科最低分（1–5）
   *   · `apCoursesMin` —— 至少需要几门（只有官网明文写了才有值）
   * 2026-09-23 之前只有 `apMin`，采集时把「至少 3 门 AP」也塞了进去，
   * 于是同一个字段在不同院校里分别表示「3 分」和「3 门」。
   * 两者都没有 ⇒ 该校没有可用于录取折算的 AP 口径 ⇒ 该维度不适用。
   */
  const hasScoreLine = req.apMin !== null && req.apMin !== undefined;
  const hasCountLine = req.apCoursesMin !== null && req.apCoursesMin !== undefined;
  if (!hasScoreLine && !hasCountLine) return { applicable: false, why: 'noApRequirement' };

  // ② 考生一门都没填 —— 没走这条路径
  const courses = profile.courses || [];
  //    只统计**已出分**的科目：score 为 null 表示「还没出分」，
  //    拿它当 0 分就是编一个成绩出来。
  const graded = courses.filter(
    (x) => x && x.score !== null && x.score !== undefined && x.score !== ''
  );
  if (!graded.length) return { applicable: false, why: 'noCourse' };

  // ③ 两个约束各算一个满足度，取更严的那个
  const passed = hasScoreLine
    ? graded.filter((x) => Number(x.score) >= req.apMin).length
    : graded.length;
  const scoreRatio = passed / graded.length;
  const countRatio = hasCountLine ? Math.min(1, graded.length / req.apCoursesMin) : 1;
  const ratio = Math.min(scoreRatio, countRatio);

  return {
    applicable: true,
    v: Math.round(c.curriculum.floor + (c.curriculum.met - c.curriculum.floor) * ratio),
    met: ratio >= 1,
    passed,
    total: graded.length,
    countOk: countRatio >= 1,
  };
}

/** 课程维度的明细文案：把「分数线」和「门数线」分别说清楚，不打成一个模糊的百分比 */
function curriculumDetail(profile, req, k) {
  const parts = [];
  if (req.apMin !== null && req.apMin !== undefined) {
    parts.push(`${k.passed}/${k.total} 门达到 ${req.apMin} 分`);
  } else {
    parts.push(`已填 ${k.total} 门`);
  }
  if (req.apCoursesMin) {
    parts.push(`需至少 ${req.apCoursesMin} 门${k.countOk ? '（已满足）' : '（当前不足）'}`);
  }
  return `${profile.curriculum} ` + parts.join('，');
}

/** 课程维度不适用时，向用户如实说明「这所学校怎么看 AP」 */
function apNote(req, why) {
  if (why === 'creditOnly') {
    return `该校 AP 仅用于转学分（单科 ${req.apMin} 分以上），不作为录取评估依据`;
  }
  if (why === 'noApRequirement') return '该校未公布 AP 折算口径，此维度不计分';
  return '你没有填写 AP 科目成绩，此维度不计分';
}

/* ------------------------------------------------------------------
   单校评估
   ------------------------------------------------------------------ */
function evaluate(school, profile, options) {
  const req = school.require;
  const c = cfg(options);

  // ① 院校录取要求尚未采集 —— 不给出分数，避免编造结论
  if (!req) {
    return {
      id: school.id,
      score: null,
      tier: 'unknown',
      dims: [],
      needData: true,
      reason: 'noRequirement',
      matched: false,
    };
  }

  // ② 录取要求「采集到了，但关键项全空」—— 同样不出分
  //    ⚠️ 这是 2026-09-19 发现并修的严重缺陷，别把这道闸门删掉。
  //    学术与语言是评分的两个主维度，若两者都没有官方数值，它们会双双取
  //    neutral 占位分（70），加上「不要求先修课程」白送的 100 分，加权后
  //    稳定得到 70+ 的「匹配」结论 —— 全部由占位值堆出来的假结论。
  //    真实案例：美国多所顶尖私校官网明文「不设最低分」，一旦进入匹配池，
  //    会让学生看到「普林斯顿 匹配度 78%」这种完全不成立的结果。
  //    宁可如实标「待评估」，也不给一个没有依据的分数。
  if (req.gpa === null && req.ielts === null) {
    return {
      id: school.id,
      score: null,
      tier: 'unknown',
      dims: [],
      needData: true,
      reason: 'insufficientRequirement',
      matched: false,
    };
  }

  // ③ 用户档案不完整（缺均分或语言）—— 同样不出分
  const ready = checkProfile(profile);
  if (!ready.ok) {
    return {
      id: school.id,
      score: null,
      tier: 'unknown',
      dims: [],
      needData: true,
      reason: 'noProfile',
      missing: ready.missing,
      matched: false,
    };
  }

  const a = scoreAcademic(profile, req, options);
  const l = scoreLanguage(profile, req, options);
  const k = scoreCurriculum(profile, req, options);

  /**
   * 加权求和。
   * ⚠️ 「不适用」的维度必须把**权重也一起**从分母里剔掉，剩下的按比例放大：
   *    · 给它塞个占位分充数 → 又变成「占位分堆出结论」（本项目踩过的大坑）；
   *    · 直接丢掉它的权重、分母仍按 1 算 → 等于把 0.25 白送出去，分数虚高。
   */
  const parts = [
    { v: a.v, w: c.weights.academic },
    { v: l.v, w: c.weights.language },
    { v: k.applicable ? k.v : null, w: c.weights.curriculum },
  ].filter((p) => p.v !== null && p.v !== undefined);
  const wsum = parts.reduce((n, p) => n + p.w, 0) || 1;
  const score = Math.round(parts.reduce((n, p) => n + p.v * p.w, 0) / wsum);

  let tier;
  if (score >= c.thresholds.safe) tier = 'safe';
  else if (score >= c.thresholds.match) tier = 'match';
  else tier = 'reach';

  /**
   * 语言未达线 → 档位封顶「冲刺」。
   * ------------------------------------------------------------------
   * `req.ielts` 是各校官网的**直录最低语言要求**，不是「建议分」。未达标就拿不到
   * 直录 offer，只能走语言班 / 预科 / 双录（`pathways`）—— 那是一条更长、
   * 且差距过大时根本走不通的路。加权总分再高，也改变不了「这门还没过」这件事。
   *
   * ⚠️ 只有**知道这条线**（`req.ielts` 有值）时才封顶。院校未公布语言线时
   *    `scoreLanguage` 走的是 `need: true` 的中性分，`l.gap` 为 undefined，
   *    此时不封顶 —— 不知道线就不能断言人家没达标。
   */
  const languageShort = typeof l.gap === 'number' && l.gap > 0;
  const capped = !!(c.capTierWhenLanguageShort && languageShort && tier !== 'reach');
  if (capped) tier = 'reach';

  // 维度明细，用于详情页的进度条。
  // ⚠️ `value` 允许为 null —— 表示「该维度对这所学校不适用」，详情页据此
  //    只渲染一行 `detail` 说明，不画进度条、也不给百分比（见 `pages/detail/detail.wxml`）。
  const dims = [
    {
      key: 'academic',
      label: '学术成绩',
      value: a.v,
      met: !!a.met,
      detail: req.gpa
        ? `均分 ${profile.gpa} / 要求 ${req.gpa}`
        : (req.gpaNote || '该校未公布统一均分线'),
    },
    {
      key: 'language',
      label: '语言成绩',
      value: l.v,
      met: !!l.met,
      detail: req.ielts
        ? `雅思 ${Number(profile.ielts.overall).toFixed(1)} / 需 ${req.ielts}${req.ieltsSub ? '（单项 ' + req.ieltsSub + '）' : ''}` +
          (l.gap > 0 ? `，还差 ${l.gap} 分` : '，已达标')
        : '该校未公布明确雅思线',
    },
    {
      key: 'curriculum',
      label: '先修课程',
      value: k.applicable ? k.v : null,
      met: !!k.met,
      detail: k.applicable
        ? curriculumDetail(profile, req, k)
        : apNote(req, k.why),
    },
  ];

  /**
   * 哪些维度是「无官方数据、取了占位分」的。
   * 这些维度仍然参与加权（否则权重就要重算，属于口径变更），
   * 但总分会因此缺乏分辨率 —— 必须把这件事透传给 UI，
   * 在分数旁边如实标注，不能让用户以为这是一个有依据的结论。
   */
  const missingDims = [];
  if (a.need) missingDims.push('academic');
  if (l.need) missingDims.push('language');

  return {
    id: school.id,
    score,
    tier,
    dims,
    needData: false,
    partialData: missingDims.length > 0,
    missingDims,
    /** 档位是否因「语言未达直录线」而被封顶到冲刺 */
    capped,
    // 课程维度不适用时视作通过 —— 它本来就没参与评分，不该把结论卡在这里
    matched: a.v >= 96 && l.v >= 100 && (!k.applicable || k.v >= 100),
  };
}

/* ------------------------------------------------------------------
   批量匹配
   ------------------------------------------------------------------ */
/**
 * 批量匹配
 * ------------------------------------------------------------------
 * @param {object} profile 成绩档案
 * @param {object} [options]
 * @param {Array}  [options.schools] 生效院校池（含后台 schoolOverrides 的合并结果）。
 *        省略则用内置静态数据 —— 保持既有调用方语义不变。
 * @param {object} [options.content] 生效内容层（含远程下发的 matchConfig）。
 *        省略则用内置默认值。
 *
 * ⚠️ 为什么用**显式传参**而不是在这里 require 一份全局内容：
 *    本文件**曾**与一个独立分包各持一份拷贝（分包读不到主包），全局可变状态会让
 *    「谁改了配置」变得不可追踪；显式传参让数据流一眼可见，也便于单测注入。
 *    那个分包已于 2026-09-24 整体移除（见仓库文档 `版本备注.md` §三.6），
 *    但**显式传参的设计继续保留** —— 它本身与分包无关。
 */
function run(profile, options) {
  options = options || {};
  const ready = checkProfile(profile);
  const c = options.content || content;

  // 档案不全：直接返回空结果 + 提示，不进评分流程
  if (!ready.ok) {
    return {
      generatedAt: new Date().toISOString(),
      total: 0,
      evaluated: 0,
      tiers: { reach: 0, match: 0, safe: 0, unknown: 0 },
      list: [],
      needsProfile: true,
      missing: ready.missing,
      insight: c.result.needProfileTip,
      disclaimer: c.result.disclaimer,
    };
  }

  // 匹配范围 = 学生勾选的目标国家 / 地区
  const targets =
    profile && profile.countries && profile.countries.length
      ? profile.countries
      : uni.MATCH_REGIONS;

  const schoolPool = Array.isArray(options.schools) ? options.schools : uni.SCHOOLS;
  const pool = schoolPool.filter((s) => s.visible !== false && targets.indexOf(s.region) > -1);

  const list = pool
    .map((s) => {
      const e = evaluate(s, profile, options);
      // ⚠️ 这里是**字段白名单**：evaluate() 返回的新字段必须在此显式列出，
      //    否则会被静默丢掉（partialData / missingDims 就曾这样丢过一次，
      //    导致详情页拿不到「部分维度无数据」的标记）。
      return Object.assign({}, s, {
        match: e.score,
        tier: e.tier,
        dims: e.dims,
        needData: e.needData,
        partialData: e.partialData,
        missingDims: e.missingDims,
        reason: e.reason || '',
        capped: e.capped,
        matched: e.matched,
      });
    })
    .sort((x, y) => {
      if (x.match === null) return 1;
      if (y.match === null) return -1;
      return y.match - x.match;
    });

  const tiers = { reach: 0, match: 0, safe: 0, unknown: 0 };
  for (const s of list) tiers[s.tier]++;

  return {
    generatedAt: new Date().toISOString(),
    total: list.length,
    evaluated: list.length - tiers.unknown,
    tiers,
    list,
    needsProfile: false,
    missing: [],
    insight: buildInsight(list, tiers, options),
    disclaimer: c.result.disclaimer,
  };
}

/** 根据结果生成一句可执行的结论 */
function buildInsight(list, tiers, options = {}) {
  const c = cfg(options);
  const activeContent = options.content || content;
  const scored = list.filter((s) => s.match !== null);
  if (!scored.length) return activeContent.result.emptyTip;

  /**
   * 各维度平均分。
   * ⚠️ 只统计**真的出了分**的维度：课程维度在「院校不拿 AP 当录取依据」或
   *    「考生没填 AP」时 value 为 null，拿它当 0 加进去会算出一个不存在的短板。
   */
  const sum = { academic: 0, language: 0, curriculum: 0 };
  const cnt = { academic: 0, language: 0, curriculum: 0 };
  for (const s of scored) {
    for (const d of s.dims) {
      if (d.value === null || d.value === undefined) continue;
      sum[d.key] += d.value;
      cnt[d.key] += 1;
    }
  }
  const n = scored.length;
  const avg = {
    academic: Math.round(sum.academic / (cnt.academic || 1)),
    language: Math.round(sum.language / (cnt.language || 1)),
    curriculum: Math.round(sum.curriculum / (cnt.curriculum || 1)),
  };

  if (avg.language < avg.academic - c.insightGap) {
    return `语言成绩是当前最明显的短板（语言 ${avg.language} 分 vs 学术 ${avg.academic} 分）。把雅思提到目标线，可直接解锁一批更稳的院校。`;
  }
  if (cnt.curriculum && avg.curriculum < avg.academic - c.insightGap) {
    return '已填的 AP 科目里达到院校折算线的偏少，提升单科分数可直接改善这一维度。';
  }
  if (tiers.safe === 0) {
    return `${scored.length} 所院校中暂无完全保底的选择，建议同时准备 1–2 所门槛更稳妥的院校。`;
  }
  return `${scored.length} 所院校评估完成：${tiers.safe} 所保底、${tiers.match} 所匹配、${tiers.reach} 所冲刺。`;
}

/* ------------------------------------------------------------------
   院校详情辅助
   ------------------------------------------------------------------ */

/** 同校分校区 / 同国家同档院校推荐 */
function recommend(school, limit, options = {}) {
  const n = limit || 4;
  const schoolPool = Array.isArray(options.schools) ? options.schools : uni.SCHOOLS;
  const out = [];

  // 1) 本校分校区优先
  for (const c of school.campuses || []) {
    out.push(Object.assign({}, c, { badge: '分校区' }));
  }

  // 2) 同国家、QS 排名最接近的院校
  const same = schoolPool.filter(
    (s) => s.visible !== false && s.region === school.region && s.id !== school.id
  ).sort((a, b) => Math.abs(a.qs - school.qs) - Math.abs(b.qs - school.qs));

  for (const s of same) {
    if (out.length >= n) break;
    out.push({
      id: s.id,
      nameCn: s.nameCn,
      nameEn: s.nameEn,
      region: s.region,
      countryCn: s.countryCn,
      cityCn: s.cityCn,
      provinceCn: s.provinceCn,
      qs: s.qs,
      qsLabel: s.qsLabel,
      crest: s.crest,
      badge: '同档',
    });
  }
  return out.slice(0, n);
}

module.exports = {
  CURRICULA,
  COUNTRIES,
  MAJORS,
  REGIONS,
  TIER_LABEL,
  TIER_EN,
  TIER_META,
  run,
  evaluate,
  recommend,
  checkProfile,
};
