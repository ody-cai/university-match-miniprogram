#!/usr/bin/env node
/**
 * 个性化解读 · 模板化与合规边界验证台
 * ==================================================================
 * 背景：结果页的「个性化建议」原本把文案写死在 `utils/api.js` 里，
 * 2026-09-17 迁到了内容层 `content.ai.templates`（改文案不该发版）。
 *
 * 这个迁移有三个必须守住的性质，测不出来就不算改完
 * （见项目铁律「未执行的代码分支 = 未验证的代码」）：
 *   ① 文案必须**真的来自内容层**，改了远端 patch 就得变
 *   ② 占位符必须被正确插值，不能把 `{score}` 原样漏到用户屏幕上
 *   ③ 模板被远程下发清空时要降级为空数组，不能抛错、更不能显示变量名
 *
 * 同时守住一条**合规红线**（不可回退）：
 *   `getInsight()` 的 `generatedBy` 恒为 `'rule'`。返回 `'ai'` 会被页面
 *   当作来源标注展示给用户，既属虚标，也等于对外宣称自己在提供生成合成服务
 *   —— 那是「深度合成-AI问答」类目的判定要件，个人主体申请不了。
 *   依据见根目录 `AI接入边界方案.md`。
 *
 * 用法：node tools/test-insight-templates.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

/* ---------------- mock wx 运行时（与 test-cloud-transport.js 同一套最小集） ---------------- */
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
// 模板测试自行选择传输模式，生产云环境配置不能污染测试。
API.request.CONFIG.env = '';
API.request.CONFIG.baseUrl = '';
const CONTENT = require(path.join(MP, 'data', 'content.js'));

/* ---------------- 断言工具 ---------------- */
let pass = 0;
let fail = 0;

function check(title, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${title}`);
  } else {
    fail++;
    console.log(`  ✗ ${title}${detail ? '\n      ' + detail : ''}`);
  }
}

function head(t) {
  console.log('\n' + '─'.repeat(64));
  console.log(t);
  console.log('─'.repeat(64));
}

/** 剥掉注释再匹配，避免注释里提到的字样被误报（踩过两次的老坑） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---------------- 测试数据 ---------------- */
const profile = { curriculum: 'AP', gpa: 86, countries: ['ca', 'au'] };

/** 偏科：语言 72 明显低于学术 96 → 应命中 structure.gap */
const resultGap = {
  total: 26,
  tiers: { safe: 3, match: 18, reach: 5, unknown: 0 },
  list: [
    {
      id: 'toronto',
      match: 80,
      tier: 'match',
      dims: [
        { key: 'academic', value: 96 },
        { key: 'language', value: 72 },
        { key: 'curriculum', value: 100 },
      ],
    },
  ],
};

/** 均衡：三维度接近 → 应命中 structure.balanced */
const resultBalanced = {
  total: 26,
  tiers: { safe: 8, match: 17, reach: 1, unknown: 0 },
  list: [
    {
      id: 'ubc',
      match: 88,
      tier: 'match',
      dims: [
        { key: 'academic', value: 90 },
        { key: 'curriculum', value: 92 },
        { key: 'language', value: 95 },
      ],
    },
  ],
};

(async () => {
  /* ========== 1. 内容层模板完整性 ========== */
  head('1. 内容层模板结构');
  const T = ((CONTENT.ai || {}).templates) || {};
  const byDim = T.byDim || {};
  const structure = T.structure || {};

  check('ai.templates.byDim 存在', !!T.byDim);
  for (const k of ['academic', 'language', 'curriculum']) {
    check(`byDim.${k} 有 title + detail`, !!(byDim[k] && byDim[k].title && byDim[k].detail));
    check(`byDim.${k}.detail 含 {score} 占位符`, !!byDim[k] && byDim[k].detail.includes('{score}'));
  }
  check('structure.gap 存在', !!(structure.gap && structure.gap.title && structure.gap.detail));
  check('structure.balanced 存在', !!(structure.balanced && structure.balanced.title));
  check(
    'structure.balanced.detail 档位占位符齐全',
    ['{safe}', '{match}', '{reach}'].every((p) => structure.balanced.detail.includes(p))
  );

  /* ========== 2. 默认模板下的生成结果 ========== */
  head('2. 默认模板生成');
  const r1 = await API.getInsight(profile, resultGap);
  check('返回 2 条建议（短板 + 结构性）', r1.suggestions.length === 2, `实际 ${r1.suggestions.length}`);
  check('短板命中最弱的语言维度', r1.suggestions[0].title === '优先提升语言成绩', r1.suggestions[0].title);
  check('短板 detail 已插值出 72', r1.suggestions[0].detail.includes('72'), r1.suggestions[0].detail);

  const joined = r1.suggestions.map((s) => s.title + s.detail).join('');
  check('输出里不残留任何未插值占位符', !/\{\w+\}/.test(joined), joined);
  check('偏科时命中 structure.gap', r1.suggestions[1].title === '先补齐短板，再谈冲刺', r1.suggestions[1].title);

  const r2 = await API.getInsight(profile, resultBalanced);
  check('均衡时命中 structure.balanced', r2.suggestions[1].title === '梯度已经比较均衡', r2.suggestions[1].title);
  check(
    '均衡 detail 注入真实档位计数',
    r2.suggestions[1].detail.includes('8') && r2.suggestions[1].detail.includes('17'),
    r2.suggestions[1].detail
  );

  /* ========== 3. 证明文案来自内容层（关键用例） ========== */
  head('3. 文案确实由内容层驱动（非硬编码）');
  mem['sp_content_patch'] = {
    ai: {
      templates: {
        byDim: {
          language: { title: '【远程下发】优先攻语言', detail: '{score} 分，先冲雅思再谈其他。' },
        },
      },
    },
  };
  await API.loadContent();
  const r3 = await API.getInsight(profile, resultGap);
  check('远端 patch 生效后标题被替换', r3.suggestions[0].title === '【远程下发】优先攻语言', r3.suggestions[0].title);
  check('远端 patch 生效后正文被替换', r3.suggestions[0].detail === '72 分，先冲雅思再谈其他。', r3.suggestions[0].detail);
  check('未下发的 academic 模板仍保留内置值', !!byDim.academic);

  /* ========== 4. 模板缺失时的降级 ========== */
  head('4. 模板缺失的降级行为');
  mem['sp_content_patch'] = { ai: { templates: { byDim: null, structure: null } } };
  await API.loadContent();
  let degraded = null;
  let threw = null;
  try {
    degraded = await API.getInsight(profile, resultGap);
  } catch (e) {
    threw = e;
  }
  check('模板被清空时不抛错', !threw, threw && threw.message);
  check('模板被清空时返回空数组', Array.isArray(degraded && degraded.suggestions) && degraded.suggestions.length === 0);
  check('降级时仍返回 rule 来源', degraded && degraded.generatedBy === 'rule');

  /* ========== 5. 合规红线 ========== */
  head('5. 合规红线（不可回退）');
  mem['sp_content_patch'] = {};
  await API.loadContent();

  const cfg = API.content();
  check('content.ai.enabled 为 false', cfg.ai.enabled === false, String(cfg.ai.enabled));

  const rAll = await API.getInsight(profile, resultGap);
  check('getInsight 返回 generatedBy === "rule"', rAll.generatedBy === 'rule', rAll.generatedBy);
  check('本地适配器不存在 generatedBy: "ai"', !/generatedBy:\s*['"]ai['"]/.test(
    stripComments(fs.readFileSync(path.join(MP, 'utils', 'api.js'), 'utf8'))
  ));
  check('页面标注文案 rule 分支非空', !!(cfg.result.insightBy && cfg.result.insightBy.rule));

  // 扫描运行期代码里是否出现模型服务域名 —— 出现即意味着可能越过边界
  const MODEL_HOSTS = /(dashscope|aliyuncs|volces|volcengine|openai\.com|anthropic\.com|deepseek|hunyuan|qianfan|bigmodel\.cn|siliconflow)/i;
  const offenders = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === '.git') continue;
        walk(full);
      } else if (/\.(js|wxml|wxss|json)$/.test(name)) {
        const src = stripComments(fs.readFileSync(full, 'utf8'));
        if (MODEL_HOSTS.test(src)) offenders.push(path.relative(ROOT, full));
      }
    }
  })(MP);
  check('运行期代码未出现任何大模型服务域名', offenders.length === 0, offenders.join('\n      '));

  /* ========== 6. 页面首帧内容可用性 ========== */
  head('6. 页面首帧内容可用性（弱网/离线不白屏）');
  const pagesDir = path.join(MP, 'pages');
  const pageFiles = fs
    .readdirSync(pagesDir)
    .map((d) => path.join(pagesDir, d, `${d}.js`))
    .filter((f) => fs.existsSync(f));

  check('页面数量符合预期（>0）', pageFiles.length > 0, `实读 ${pageFiles.length}`);

  // 写 {} 的页面首帧没有任何文案：界面要空等到 loadContent() 的远端请求返回
  // （transport 为 cloud 时是真实网络往返），期间 nav-bar 的 {{c.nav.x}} 求值为
  // undefined，微信会以 null 传入并打印类型不兼容告警。历史缺陷，别回退。
  const emptyC = pageFiles.filter((f) => /^\s*c: \{\},/m.test(fs.readFileSync(f, 'utf8')));
  check(
    `${pageFiles.length} 个页面的 data.c 初始值均非空对象`,
    emptyC.length === 0,
    '以下页面会白屏等远端返回：\n      ' + emptyC.map((f) => path.relative(MP, f)).join('\n      ')
  );

  const useContent = pageFiles.filter((f) => /c: api\.content\(\),/.test(fs.readFileSync(f, 'utf8')));
  check(
    '每个页面都以 api.content() 初始化 data.c（首帧即有本地文案）',
    useContent.length === pageFiles.length,
    `${useContent.length}/${pageFiles.length}`
  );

  // 第二道防线：内容意外缺失时，导航栏标题不应把 null 透传给组件
  const navBar = fs.readFileSync(path.join(MP, 'components/nav-bar/index.js'), 'utf8');
  check(
    'nav-bar.title 对 null/undefined 有归一处理',
    /observer\(v\)/.test(navBar) && /v === null/.test(navBar),
    '缺少 observer，内容缺失时会打印类型不兼容告警'
  );

  /* ========== 8. 内容层模板不得裸绑到视图 ==========
   * 内容层里带 `{占位符}` 的字符串是**模板**，页面必须 api.tpl() 插值后再绑。
   * 直接把 `c.xxx.template` 写进 WXML，屏幕上是那行字面量本身（如「共 {count} 所院校」），
   * 而且不报错 —— 院校页就这么挂着一行 `共 {count} 所院校` 上线过。 */
  head('7. 内容层模板必须插值后再绑（WXML 不替换占位符）');

  const collectTemplatePaths = (obj, prefix = '', out = []) => {
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') {
        if (/\{[a-zA-Z_]+\}/.test(v)) out.push(p);
      } else if (v && typeof v === 'object') collectTemplatePaths(v, p, out);
    });
    return out;
  };
  const tplPaths = collectTemplatePaths(CONTENT);
  check('内容层确实存在带占位符的模板（扫描有效）', tplPaths.length > 5, `实读 ${tplPaths.length} 个`);

  const wxmlFiles = [];
  (function walk(d) {
    fs.readdirSync(d).forEach((n) => {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.wxml')) wxmlFiles.push(p);
    });
  })(path.join(MP, 'pages'));
  wxmlFiles.push(path.join(MP, 'components', 'nav-bar', 'index.wxml'));

  const naked = [];
  wxmlFiles.forEach((f) => {
    const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const re = /\{\{\s*c\.([A-Za-z0-9_.]+)\s*\}\}/g;
    let m;
    while ((m = re.exec(src))) {
      if (tplPaths.indexOf(m[1]) > -1) naked.push(`${path.relative(MP, f)} → c.${m[1]}`);
    }
  });
  check('没有任何 WXML 直接绑定内容层模板（占位符会被原样显示）', naked.length === 0, naked.join(' | '));

  /* 已修的两处 + 一处的「真数」断言，防止回退 */
  const schoolsJs = fs.readFileSync(path.join(MP, 'pages/schools/schools.js'), 'utf8');
  const functionsJs = fs.readFileSync(path.join(MP, 'pages/functions/functions.js'), 'utf8');
  const matchingJs = fs.readFileSync(path.join(MP, 'pages/matching/matching.js'), 'utf8');
  check(
    '院校页统计文案经 api.tpl 插值',
    /totalLabel: api\.tpl\(this\.data\.c\.schools\.totalTemplate, \{ count: res\.total \}\)/.test(schoolsJs) &&
      /\{\{totalLabel\}\}/.test(fs.readFileSync(path.join(MP, 'pages/schools/schools.wxml'), 'utf8'))
  );
  check(
    '全部功能页页脚经 api.tpl 插值',
    /footerText: api\.tpl\(this\.data\.c\.functions\.footer/.test(functionsJs) &&
      /\{\{footerText\}\}/.test(fs.readFileSync(path.join(MP, 'pages/functions/functions.wxml'), 'utf8'))
  );
  check(
    '匹配中的「比对 N 所院校」用的是规则引擎真数（不得写死 26）',
    /enterPhase\(1, \{ count: result\.total \}\)/.test(matchingJs) && !/count:\s*\d/.test(stripComments(matchingJs)),
    '曾写死 count: 26（设计稿示例值）｜注意：这里必须剥注释再匹配，否则注释里提到的旧写法会误报'
  );

  /* ========== 汇总 ========== */
  console.log('\n' + '═'.repeat(64));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('═'.repeat(64));
  process.exit(fail ? 1 : 0);
})();
