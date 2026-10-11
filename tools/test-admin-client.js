#!/usr/bin/env node
/**
 * 后台院校数据 → 小程序生效 · 验证台
 * ==================================================================
 * 要守住的命题只有一句：**后台改了院校，小程序里真的变了。**
 *
 * 回归背景（真实缺口，不是假设）：此前 `utils/match.js` 直接
 * `require('../data/universities')` 与 `require('../data/content')`，
 * 而 `utils/api.js` 的院校列表也走 `uni.listByRegion`。于是后台发布的
 * `content.schoolOverrides`（改名 / 下架）与远程 `matchConfig`（权重、阈值）
 * **完全不影响本地匹配**：面板显示「发布成功」，小程序里却一切照旧。
 * 这类「以为生效了、实际没生效」的静默漂移是本项目最难排查的一类缺陷。
 *
 * 本台验证四件事：
 *   1. 无补丁时行为**不变**（不能为了支持动态数据而改变既有结果）
 *   2. 院校改名 → 列表 / 详情同步生效
 *   3. 院校下架（visible:false）→ 列表不显示、详情 404、不参与匹配与推荐
 *   4. 远程 matchConfig 生效 → 同一份成绩得到不同的分档
 *
 * 用法：node tools/test-admin-client.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MP = path.join(__dirname, '..', 'miniprogram');

/* ---------------- mock wx 运行时（与其它验证台同一套最小集） ---------------- */
const mem = {};
global.wx = {
  getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''),
  setStorageSync: (k, v) => {
    mem[k] = v;
  },
  removeStorageSync: (k) => {
    delete mem[k];
  },
  login: () => {},
  request: () => {},
};

const API = require(path.join(MP, 'utils', 'api.js'));
// 强制本地模式：验证台自行决定内容来源，生产云环境配置不得污染测试
API.request.CONFIG.env = '';
API.request.CONFIG.baseUrl = '';

/** 内容补丁的 Storage 键（与 utils/api.js 的 CONTENT_PATCH_STORE 一致） */
const PATCH_KEY = 'sp_content_patch';

/** 覆盖当前生效的内容补丁并重新加载 */
function applyPatch(patch) {
  if (patch) wx.setStorageSync(PATCH_KEY, patch);
  else wx.removeStorageSync(PATCH_KEY);
  return API.loadContent();
}

let pass = 0;
let fail = 0;
function check(title, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + title);
  } else {
    fail++;
    console.log('  ✗ ' + title + (detail !== undefined ? '\n      ' + detail : ''));
  }
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}

/** 足够支撑评分的档案：高中均分 + 雅思（公共门槛） */
const profile = {
  curriculum: 'AP',
  gpa: 86,
  ielts: { overall: 6.0, l: 6, r: 6, w: 6, s: 6 },
  courses: [],
  countries: ['ca'],
};

/**
 * 被操作的目标院校：多伦多大学（ca 区）。
 * ⚠️ id 用主数据里的 `toronto`，**不是**数据分片文件里的 `utoronto` ——
 *    两套 id 不一致是老问题，编译层用「id → nameEn → 别名表」三级回退吸收，
 *    但后台与测试必须用主数据这一套，否则会拿到 404。
 */
const TARGET = 'toronto';

(async function main() {
  /* ============================================================
     1 · 无补丁：基线行为不变
     ============================================================ */
  head('1 · 无补丁时行为不变（回归前提）');
  await applyPatch(null);

  const baseList = await API.listSchools({ region: 'all' });
  const baseMatch = await API.runMatch(profile);
  const baseIds = baseList.list.map((s) => s.id).sort();
  check('院校总数与静态数据一致', baseList.total === baseList.list.length && baseList.total > 0, '实际 ' + baseList.total);
  check('列表包含目标院校', baseIds.indexOf(TARGET) > -1);
  check('匹配结果非空', baseMatch.list.length > 0, '实际 ' + baseMatch.list.length);
  const baseScoredTotal = baseMatch.total;
  const baseTargetScore = (baseMatch.list.find((s) => s.id === TARGET) || {}).match;
  check('目标院校已参与评分', typeof baseTargetScore === 'number', String(baseTargetScore));
  console.log('    基线：院校 ' + baseList.total + ' 所，匹配 ' + baseScoredTotal + ' 所，目标分 ' + baseTargetScore);

  /* ============================================================
     2 · 改名生效
     ============================================================ */
  head('2 · 后台改名 → 列表与详情同步生效');
  await applyPatch({ schoolOverrides: { [TARGET]: { id: TARGET, nameCn: '多伦多大学（联调改名）' } } });

  const renamedList = await API.listSchools({ region: 'all' });
  const renamedItem = renamedList.list.find((s) => s.id === TARGET);
  check('列表中出现新名称', !!renamedItem && renamedItem.nameCn === '多伦多大学（联调改名）', JSON.stringify(renamedItem && renamedItem.nameCn));
  check('改名不影响院校数量', renamedList.total === baseList.total, '实际 ' + renamedList.total);

  const renamedDetail = await API.getSchool(TARGET);
  check('详情页返回新名称', renamedDetail.school.nameCn === '多伦多大学（联调改名）', JSON.stringify(renamedDetail.school.nameCn));
  check('详情页未丢失录取要求', renamedDetail.school.require !== undefined);

  /* ============================================================
     3 · 下架生效
     ============================================================ */
  head('3 · 后台下架 → 列表 / 详情 / 匹配 / 推荐全部不出现');
  await applyPatch({ schoolOverrides: { [TARGET]: { id: TARGET, nameCn: '多伦多大学（联调改名）', visible: false } } });

  const hiddenList = await API.listSchools({ region: 'all' });
  check('列表中不再出现该院校', hiddenList.list.every((s) => s.id !== TARGET), JSON.stringify(hiddenList.list.map((s) => s.id).filter((x) => x === TARGET)));
  check('院校数量减 1', hiddenList.total === baseList.total - 1, '实际 ' + hiddenList.total + ' / 期望 ' + (baseList.total - 1));

  let detailRejected = false;
  try {
    await API.getSchool(TARGET);
  } catch (e) {
    detailRejected = true;
  }
  check('详情页访问已下架院校被拒绝', detailRejected);

  const hiddenMatch = await API.runMatch(profile);
  check('匹配结果不含已下架院校', hiddenMatch.list.every((s) => s.id !== TARGET));
  check('匹配总数同步减少', hiddenMatch.total === baseScoredTotal - 1, '实际 ' + hiddenMatch.total + ' / 期望 ' + (baseScoredTotal - 1));

  // 推荐位：取一所同区在架院校，确认推荐里不含已下架的那所
  const anchor = hiddenList.list.find((s) => s.region === 'ca');
  const anchorDetail = await API.getSchool(anchor.id);
  check(
    '详情页推荐位不含已下架院校',
    (anchorDetail.recommend || []).every((r) => r.id !== TARGET),
    JSON.stringify((anchorDetail.recommend || []).map((r) => r.id))
  );

  /* ============================================================
     4 · 远程 matchConfig 生效
     ============================================================ */
  head('4 · 远程算法口径生效（阈值提高后分档应变化）');
  await applyPatch(null);
  const cfgBaseline = API.content().matchConfig;
  const strictThresholds = Object.assign({}, cfgBaseline.thresholds, { safe: 101, match: 100 });
  await applyPatch({ matchConfig: { thresholds: strictThresholds } });

  const strictMatch = await API.runMatch(profile);
  check('远程阈值已被采用', API.content().matchConfig.thresholds.safe === 101, JSON.stringify(API.content().matchConfig.thresholds));
  check(
    '阈值拉高后不再出现「保底」档',
    strictMatch.tiers.safe === 0,
    JSON.stringify(strictMatch.tiers)
  );
  check(
    '同一份成绩的分数未变（只改口径不改算法）',
    (strictMatch.list.find((s) => s.id === TARGET) || {}).match === baseTargetScore,
    '实际 ' + (strictMatch.list.find((s) => s.id === TARGET) || {}).match + ' / 基线 ' + baseTargetScore
  );

  /* ============================================================
     4b · 静态守卫：口径下发必须真的被引擎采纳
     ============================================================
     动态断言只能在「恰好被测到的那条路径」上发现漏透传。真实事故就是
     scoreLanguage / evaluate 把 options 丢了 —— 语言维度与分档阈值收不到
     后台下发的口径，而学术维度和权重却生效了，表现为「改了一半」。
     这里直接盯住源码结构，任何一处退回无参 cfg() 都会立刻失败。
     ============================================================ */
  head('4b · 静态守卫：options 必须贯通到每一个维度与分档');
  const MATCH_SRC = fs.readFileSync(path.join(MP, 'utils', 'match.js'), 'utf8');
  const bareCfg = (MATCH_SRC.match(/cfg\(\s*\)/g) || []).length;
  check('不存在无参 cfg() 调用（有一处即代表该维度收不到后台口径）', bareCfg === 0, '发现 ' + bareCfg + ' 处 cfg()');
  for (const fn of ['scoreAcademic', 'scoreLanguage', 'scoreCurriculum']) {
    check(fn + ' 声明 options 参数', new RegExp('function ' + fn + '\\([^)]*options[^)]*\\)').test(MATCH_SRC));
  }
  check('evaluate 声明 options 参数', /function evaluate\([^)]*options[^)]*\)/.test(MATCH_SRC));
  check(
    'evaluate 把 options 转发给三个维度',
    /scoreAcademic\(profile, req, options\)/.test(MATCH_SRC) &&
      /scoreLanguage\(profile, req, options\)/.test(MATCH_SRC) &&
      /scoreCurriculum\(profile, req, options\)/.test(MATCH_SRC)
  );

  /* ============================================================
     5 · 清空补丁后回到基线
     ============================================================ */
  head('5 · 取消补丁后回到基线');
  await applyPatch(null);
  const finalList = await API.listSchools({ region: 'all' });
  const finalMatch = await API.runMatch(profile);
  check('院校数量回到基线', finalList.total === baseList.total, '实际 ' + finalList.total);
  check('目标院校重新出现', finalList.list.some((s) => s.id === TARGET));
  check('匹配总数回到基线', finalMatch.total === baseScoredTotal, '实际 ' + finalMatch.total);
  check(
    '分档回到基线',
    JSON.stringify(finalMatch.tiers) === JSON.stringify(baseMatch.tiers),
    JSON.stringify(finalMatch.tiers) + ' vs ' + JSON.stringify(baseMatch.tiers)
  );

  console.log('\n' + '─'.repeat(64));
  console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + '）');
  console.log('─'.repeat(64));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n验证台自身异常：', e);
  process.exit(2);
});
