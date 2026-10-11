/**
 * 成绩档案（users 集合的 `academic` 字段）—— 形状、白名单与校验
 * ==================================================================
 * 为什么单独成文件：`handlers/academic.js` 需要「把请求体校验并整形为可入库
 * 的档案」，「重置」还需要一份空档案模板。这些都属于**契约 4.3 的定义**，
 * 与流程（鉴权、读写）分开才好单独测 —— 与 lib/users.js 放 shapeUser 同理。
 *
 * ⚠️ 本文件**不 require wx-server-sdk**，是纯函数模块：任何测试台与静态
 *    检查都能直接加载它，不必先 mock 一整套 SDK。
 *
 * ── 服务端校验到哪一步为止 ────────────────────────────────────────
 * 只做**结构与范围**校验（类型、长度、数值区间），**不校验取值枚举**：
 *   · `curriculum` 的 AP / AL / IB / NONE、`countries` 的 us / uk / ca…、
 *     `majors`（契约附录 A）—— 这些枚举在内容层 `data/content.js` 里，
 *     可以远程下发。服务端再硬编码一份，就会出现「后端说非法、前端说合法」，
 *     而两份枚举的变更节奏不同，**漂移了不会报错**。
 *   · `handlers/user.js` 的 `grade`（取自 enums.grades）同样是只校验长度 ——
 *     这里沿用同一口径，避免同一份契约里出现两套校验哲学。
 * 服务端真正要守住的是「不能写入畸形数据」：类型错、超长、越界数值。
 * 这些写进库里会污染匹配引擎与后台，而且**不会报错**。
 *
 * ── 为什么 `courses` 由 `coursesMap` 派生 ─────────────────────────
 * 存储真源是 `coursesMap`（学生可能同时考了 AP 与 IB，切换体系不该互相清空），
 * `courses` 只是「当前体系」的镜像（见 miniprogram/utils/store.js 的注释）。
 * 镜像如果采信客户端传来的值，就会与 coursesMap 漂移 —— 那是一份数据两个答案。
 * 所以服务端**一律现算**：`courses = coursesMap[curriculum]`。
 */
const { bizError, cpLength } = require('./response');

/** 课程体系键。与 `data/content.js` 的 defaultAcademic.coursesMap 同键 */
const CURRICULA = ['AP', 'AL', 'IB', 'NONE'];

const LIMIT = {
  /** 科目名 / 考试时间等自由文本 */
  courseName: 60,
  courseDate: 40,
  /** 目标国家 / 专业列表 */
  tagList: 32,
  tagItem: 24,
  /** 单个体系下的科目数上限 */
  courseList: 40,
  /** 整份档案序列化后的字节上限，兜住任何「没想到的字段被塞爆」 */
  payload: 20000,
};

/**
 * 空档案 —— `POST /v1/academic/profile/reset` 写入的就是它。
 *
 * ⚠️ 字段清单必须与 `data/content.js` 的 `defaultAcademic` **逐字段一致**，
 *    由 `tools/test-cloud-handlers.js` 第 9 节比对看住。
 *    这里刻意**不** require content.js：api 云函数包里没有内容层，
 *    为了复用而把它再拷一份进来，就是第三份影子副本
 *    （见 tools/sync-data-copies.js 的清单）。字段少一个是不会报错的，
 *    只会让「重置」之后某块 UI 空掉。
 *
 * ⚠️ 刻意**不含 `courses`** —— 它是 `coursesMap[curriculum]` 的派生镜像，
 *    由 `buildAcademic` / `shapeAcademic` 现算。放进模板里就会有两个真源。
 */
const EMPTY_ACADEMIC = {
  curriculum: 'AP',
  coursesMap: { AP: [], AL: [], IB: [], NONE: [] },
  gpa: null,
  gpaScale: 100,
  ielts: null,
  toefl: null,
  sat: null,
  countries: [],
  majors: [],
};

/* ---------------- 基础取值器 ---------------- */

/** 取一个干净字符串。非字符串 / 非有限数一律当「没传」 */
function str(v, max, label) {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    throw bizError(400, label + '格式不正确');
  }
  const s = v.trim();
  if (cpLength(s) > max) throw bizError(400, label + '最多 ' + max + ' 个字');
  return s;
}

/**
 * 取一个数值或 null。
 * ⚠️ 空值（'' / undefined / null）→ **null**，不是 0。
 *    「没填」与「填了 0 分」在成绩档案里是完全不同的两件事，
 *    把前者折成 0 会凭空给用户造出一个分数（本项目的数据真实性红线）。
 */
function num(v, min, max, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw bizError(400, label + '必须是数字，未知请留空');
  if (n < min || n > max) throw bizError(400, label + '应在 ' + min + ' – ' + max + ' 之间');
  return n;
}

/** 取一个字符串数组（去重、去空、限量） */
function strList(v, max, itemMax, label) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw bizError(400, label + '必须是数组');
  if (v.length > max) throw bizError(400, label + '最多 ' + max + ' 项');
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') throw bizError(400, label + '的每一项都必须是文本');
    const s = raw.trim();
    if (!s) continue;
    if (cpLength(s) > itemMax) throw bizError(400, label + '单项最多 ' + itemMax + ' 个字');
    if (out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

/** 取一条国际课程成绩 `{ name, date, score, max }` */
function course(v, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bizError(400, label + '格式不正确');
  const name = str(v.name, LIMIT.courseName, label + '的科目名');
  if (!name) throw bizError(400, label + '需要填写科目名');
  // 得分留空 = 尚未出分 → null。列表里显示「—」，不是 0。
  const score = num(v.score, 0, 1000, label + '的得分');
  const max = num(v.max, 0.0001, 1000, label + '的满分');
  return {
    name,
    date: str(v.date, LIMIT.courseDate, label + '的考试时间') || '',
    score,
    max: max === null ? 5 : max,
  };
}

/** 取一个体系下的科目列表 */
function courseList(v, label) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw bizError(400, label + '必须是数组');
  if (v.length > LIMIT.courseList) throw bizError(400, label + '最多 ' + LIMIT.courseList + ' 项');
  return v.map((c, i) => course(c, label + '第 ' + (i + 1) + ' 条'));
}

/** 取各体系的科目表，缺的键补空数组 —— 保证入库结构与 EMPTY_ACADEMIC 同形 */
function coursesMap(v) {
  const raw = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const out = {};
  for (const k of CURRICULA) out[k] = courseList(raw[k], k + ' 课程');
  return out;
}

/** 取雅思成绩：整体可以是 null（未考），单项缺失按 0 处理 */
function ielts(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw bizError(400, '雅思成绩格式不正确');
  const overall = num(v.overall, 0.1, 9, '雅思总分');
  if (overall === null) return null; // 总分都没填 → 视为未考，不造一个 0 分记录
  return {
    overall,
    l: num(v.l, 0, 9, '雅思听力') || 0,
    r: num(v.r, 0, 9, '雅思阅读') || 0,
    w: num(v.w, 0, 9, '雅思写作') || 0,
    s: num(v.s, 0, 9, '雅思口语') || 0,
  };
}

/* ---------------- 对外形态 ---------------- */

/** 把入库的档案整形为契约 4.3 的响应对象（字段一个不多一个不少） */
function shapeAcademic(a) {
  if (!a) return null;
  const map = {};
  for (const k of CURRICULA) map[k] = Array.isArray(a.coursesMap && a.coursesMap[k]) ? a.coursesMap[k] : [];
  return {
    curriculum: a.curriculum || 'AP',
    coursesMap: map,
    // 镜像字段：与 coursesMap[当前体系] 恒等（见本文件头部说明）
    courses: map[a.curriculum] || map.AP,
    gpa: a.gpa === undefined ? null : a.gpa,
    gpaScale: a.gpaScale === undefined ? 100 : a.gpaScale,
    ielts: a.ielts || null,
    toefl: a.toefl === undefined ? null : a.toefl,
    sat: a.sat === undefined ? null : a.sat,
    countries: Array.isArray(a.countries) ? a.countries : [],
    majors: Array.isArray(a.majors) ? a.majors : [],
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
  };
}

/**
 * 校验并构造一份可入库的档案（**全量覆盖**语义，契约 4.3）。
 *
 * ⚠️ 只有请求里**出现过的键**才会被采用，其余键回落到空档案的默认值 ——
 *    也就是说这是一次完整替换，不是部分更新。客户端 match 页每次
 *    `persist()` 传的都是整份档案，与之匹配；若将来要做部分更新，
 *    必须另开端点，不能把这个函数改造成「有就更新、没有就保留」——
 *    那样「清空某个字段」就永远表达不出来了。
 *
 * @param {object} raw 请求体
 * @param {string} nowIso 服务端盖章的时间（客户端传什么都不采信）
 */
function buildAcademic(raw, nowIso) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  let serialized;
  try {
    serialized = JSON.stringify(d);
  } catch (e) {
    throw bizError(400, '成绩档案无法序列化');
  }
  if (serialized.length > LIMIT.payload) throw bizError(400, '成绩档案过大');

  const curriculum = (str(d.curriculum, 16, '课程体系') || EMPTY_ACADEMIC.curriculum).toUpperCase();
  const map = coursesMap(d.coursesMap);

  /**
   * 兼容旧版客户端 / 历史数据：只传了 `courses` 而没有 `coursesMap`。
   * 判定条件是「coursesMap 四个体系全空、但 courses 非空」——
   * 不能只看 `d.coursesMap === undefined`，因为客户端可能传了个空 map。
   */
  const mapEmpty = CURRICULA.every((k) => map[k].length === 0);
  if (mapEmpty && Array.isArray(d.courses) && d.courses.length) {
    map[curriculum] = courseList(d.courses, '课程');
  }

  const out = {
    curriculum,
    coursesMap: map,
    courses: map[curriculum] || [],
    gpa: num(d.gpa, 0.1, 100, '高中均分'),
    gpaScale: num(d.gpaScale, 1, 1000, '满分制') || EMPTY_ACADEMIC.gpaScale,
    ielts: ielts(d.ielts),
    toefl: num(d.toefl, 0, 120, '托福成绩'),
    // ⚠️ SAT 上限取 2400 而不是 1600：旧分制（阅读+写作+数学各 800）
    //    仍有学生在用，卡在 1600 会让他们的真实成绩被判非法。
    sat: num(d.sat, 0, 2400, 'SAT 成绩'),
    countries: strList(d.countries, LIMIT.tagList, LIMIT.tagItem, '目标国家'),
    majors: strList(d.majors, LIMIT.tagList, LIMIT.tagItem, '目标专业'),
  };
  // updatedAt 由服务端盖章：客户端传什么都不采信（它是审计信息，不是用户输入）
  out.updatedAt = nowIso;
  return out;
}

module.exports = {
  CURRICULA,
  LIMIT,
  EMPTY_ACADEMIC,
  shapeAcademic,
  buildAcademic,
};
