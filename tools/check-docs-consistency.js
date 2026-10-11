#!/usr/bin/env node
/**
 * 文档 ↔ 代码一致性校验
 * ==================================================================
 * 为什么需要这个脚本 —— 2026-09-22 一次性发现五份文档里的**数字全是过期的**：
 *
 *   · `版本备注.md` 写「12 个页面 / 36 所 QS / 26 所录取要求 / 223 条断言」，
 *     实际是 13 个页面 / 99 所 / 89 所 / 516 条
 *   · `README.md` 写「本项目零网络请求，不需要正式 AppID、不需要云开发」，
 *     而云开发已经上线、`loadContent()` 每次启动都会拉一次 `GET /v1/content`
 *   · `小程序简介.md`（参赛材料 + 后台介绍来源）同样写着「运行期零网络请求」
 *   · `API接口契约.md` 通篇像「全部端点已实现」，实际云端只登记了 7 条
 *
 * 这些错误的共同点：**没有任何测试会因此变红**。文档不是代码，
 * 改了代码不会让文档失败；而文档恰恰是唯一会被评委、审核员、协作者读到的东西。
 * 尤其「运行期零网络请求」这一句写在提审材料里，是实打实的**不实陈述**。
 *
 * 本脚本把「文档里声明的可验证事实」与「代码里的真相」钉在一起：
 *   1. 云函数 ROUTES ↔ 契约「端点实现状态」表（✅ 与 ⛔ 都不能错）
 *   2. 院校库规模（总数 / 各区域 / 有录取要求数 / 缺口数）↔ 四份文档
 *   3. 页面数 ↔ app.json
 *   4. 文档里点名的每个校验脚本都必须真实存在
 *
 * ⚠️ 数字写错就先改代码以外的**事实**，再回来改文档 —— 不要为了让脚本变绿去改断言。
 *
 * 用法：node tools/check-docs-consistency.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

let pass = 0;
const fails = [];

function ok(msg) {
  pass++;
  console.log('  ✓ ' + msg);
}
function bad(msg) {
  fails.push(msg);
  console.log('  ✗ ' + msg);
}
function assert(cond, msg) {
  if (cond) ok(msg);
  else bad(msg);
}

/* ==================================================================
   1. 云函数 ROUTES ↔ 契约「端点实现状态」表
   ================================================================== */
console.log('\n1. 云函数已登记端点 ↔ 契约状态表');

const apiIndex = read('miniprogram/cloudfunctions/api/index.js');
const routeBlock = /const ROUTES = \{([\s\S]*?)\n\};/.exec(apiIndex);
assert(!!routeBlock, '能定位云函数的 ROUTES 表');

const routes = [];
if (routeBlock) {
  const re = /'([A-Z]+)\s+(\/v1\/[^']*)'\s*:/g;
  let m;
  while ((m = re.exec(routeBlock[1]))) routes.push(m[1] + ' ' + m[2]);
}

/**
 * 带路径参数的路由（PATTERNS）也要一起核对。
 * ------------------------------------------------------------------
 * 只数静态 ROUTES 是不够的：`/v1/favorites/{schoolId}` 那两条是通配路由，
 * 若它们不被纳入，契约表里这两行就只能标 ⛔（而实际是通的），
 * 或者标 ✅ 却没人验证 —— 两种都是在文档里说假话。
 * 这也是 cloudfunctions/api/index.js 把 PATTERNS 写成**声明式 path**
 * 而不是正则字面量的原因（正则没法这么解析）。
 */
const patternBlock = /const PATTERNS = \[([\s\S]*?)\n\]\.map/.exec(apiIndex);
assert(!!patternBlock, '能定位云函数的 PATTERNS 表');
if (patternBlock) {
  const re = /method:\s*'([A-Z]+)',\s*path:\s*'(\/v1\/[^']*)'/g;
  let m;
  while ((m = re.exec(patternBlock[1]))) routes.push(m[1] + ' ' + m[2]);
}

/**
 * 路径归一化：把路径参数统一成 `:param`。
 * 契约里写 `{schoolId}`、代码里写 `:schoolId` —— 两者必须能对上，
 * 否则「文档说的端点」与「代码里的端点」永远差一个字符，
 * 而这类差别最容易被误读成「还没实现」。
 */
const norm = (r) => r.replace(/\{[^}]+\}/g, ':param').replace(/:[A-Za-z0-9_]+/g, ':param');
const routeNorm = routes.map(norm);
assert(routes.length > 0, 'ROUTES 解析出至少一条端点（实得 ' + routes.length + ' 条）');

const contract = read('API接口契约.md');
const statusSec = /#### 端点实现状态[\s\S]*?(?=\n⚠️ \*\*`GET \/v1\/user\/stats`)/.exec(contract);
assert(!!statusSec, '契约里有「端点实现状态」小节');

const tableUp = [];   // 标记为 ✅ 的端点
const tableDown = []; // 标记为 ⛔ 的端点
if (statusSec) {
  const rows = statusSec[0]
    .split('\n')
    .filter((l) => /^\|\s*`/.test(l));
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    const status = cells[2] || '';
    const paths = [];
    const re = /`([A-Z]+)\s+(\/v1\/[^`]*)`/g;
    let m;
    while ((m = re.exec(cells[1] || ''))) paths.push(m[1] + ' ' + m[2]);
    if (/^✅/.test(status)) tableUp.push(...paths);
    else if (/^⛔/.test(status)) tableDown.push(...paths);
    else bad('状态表有一行状态列既不是 ✅ 也不是 ⛔：' + row.slice(0, 60));
  }
}
assert(tableUp.length > 0, '状态表解析出 ✅ 端点（实得 ' + tableUp.length + ' 条）');

const tableUpNorm = tableUp.map(norm);
const tableDownNorm = tableDown.map(norm);

// ① ROUTES / PATTERNS 里的每一条都必须被标为 ✅
for (const r of routes) {
  assert(tableUpNorm.indexOf(norm(r)) > -1, '契约状态表把 `' + r + '` 标为已上云');
}
// ② 标 ✅ 的必须真的登记在 ROUTES / PATTERNS 里（否则文档在替一个不存在的实现作证）
for (const r of tableUp) {
  assert(routeNorm.indexOf(norm(r)) > -1, '契约标 ✅ 的 `' + r + '` 真的登记在云函数路由里');
}
// ③ 标 ⛔ 的绝不能出现在路由表里
for (const r of tableDown) {
  assert(routeNorm.indexOf(norm(r)) === -1, '契约标 ⛔ 的 `' + r + '` 确实没登记进云函数路由');
}
assert(
  tableUp.length === routes.length,
  '✅ 条数（' + tableUp.length + '）与云函数已登记端点数（' + routes.length + '）一致'
);

// ⛔ 里不该混进方法相同的别的路径（防手写错路径）
const dupInBoth = tableUpNorm.filter((r) => tableDownNorm.indexOf(r) > -1);
assert(dupInBoth.length === 0, '同一端点没有被同时标成 ✅ 和 ⛔');

/* ==================================================================
   2. 院校库规模 ↔ 各文档
   ================================================================== */
console.log('\n2. 院校库规模 ↔ 文档');

const schools = readJson('miniprogram/cloudfunctions/admin/data/schools.json');
const list = Array.isArray(schools) ? schools : schools.schools;
const total = list.length;
const byRegion = {};
let withReq = 0;
const reqByRegion = {};
for (const s of list) {
  byRegion[s.region] = (byRegion[s.region] || 0) + 1;
  if (s.require) {
    withReq++;
    reqByRegion[s.region] = (reqByRegion[s.region] || 0) + 1;
  }
}
const missing = total - withReq;
console.log(
  '  · 实况：共 ' + total + ' 所；' +
  Object.keys(byRegion).sort().map((r) => r + ' ' + byRegion[r]).join(' / ') +
  '；有录取要求 ' + withReq + ' 所，缺 ' + missing + ' 所'
);

assert(withReq === Object.values(reqByRegion).reduce((a, b) => a + b, 0), '有录取要求数按区域可加总');
assert(byRegion.us + byRegion.ca + byRegion.au + byRegion.uk === total, '四区域之和等于总数');

// —— README §六
const readme = read('README.md');
assert(
  new RegExp('院校库 \\*\\*' + total + ' 所\\*\\*').test(readme),
  'README 写「院校库 ' + total + ' 所」'
);
assert(
  new RegExp('美国 ' + byRegion.us + ' / 加拿大 ' + byRegion.ca + ' / 澳大利亚 ' + byRegion.au + ' / 英国 ' + byRegion.uk).test(readme),
  'README 写对四区域分布'
);
assert(
  new RegExp('✅ ' + withReq + ' 所（加 ' + reqByRegion.ca + ' \\+ 澳 ' + reqByRegion.au + ' \\+ 美 ' + reqByRegion.us + '）').test(readme),
  'README 写对「有录取要求 ' + withReq + ' 所」及其区域构成'
);
assert(
  new RegExp('缺 ' + missing + ' 所（英 ' + (byRegion.uk - (reqByRegion.uk || 0)) + ' \\+ 美 ' + (byRegion.us - (reqByRegion.us || 0)) + '）').test(readme),
  'README 写对「缺 ' + missing + ' 所」及其区域构成'
);

// —— 小程序简介 §2.2
const intro = read('小程序简介.md');
const introLine = new RegExp(
  '共 ' + total + ' 所，其中 ' + withReq + ' 所已采集官方录取要求'
);
assert(introLine.test(intro), '小程序简介完整版写对「共 ' + total + ' 所，其中 ' + withReq + ' 所有要求」');
assert(
  new RegExp('美国 ' + byRegion.us + ' 所、加拿大 ' + byRegion.ca + ' 所、澳大利亚 ' + byRegion.au + ' 所、英国 ' + byRegion.uk + ' 所').test(intro),
  '小程序简介完整版写对四区域分布'
);

// —— 版本备注 §1.1
const ver = read('版本备注.md');
assert(
  new RegExp('数据：' + total + ' 所院校库（美 ' + byRegion.us + ' / 加 ' + byRegion.ca + ' / 澳 ' + byRegion.au + ' / 英 ' + byRegion.uk + '），其中 ' + withReq + ' 所有官方录取要求').test(ver),
  '版本备注 1.1 写对院校库规模'
);

// —— 契约 §六
assert(
  new RegExp('← QS World University Rankings 2027[^\\n]*· ' + total + ' 所').test(contract),
  '契约 §六 写对 QS 文件规模（' + total + ' 所）'
);
assert(
  new RegExp('admission-us\\.json[^\\n]*美国 ' + reqByRegion.us + ' 校').test(contract),
  '契约 §六 写对美国采集文件规模（' + reqByRegion.us + ' 校）'
);
assert(
  new RegExp('admission-ca\\.json[^\\n]*加拿大 ' + reqByRegion.ca + ' 校').test(contract),
  '契约 §六 写对加拿大采集文件规模（' + reqByRegion.ca + ' 校）'
);
assert(
  new RegExp('admission-au\\.json[^\\n]*澳大利亚 ' + reqByRegion.au + ' 校').test(contract),
  '契约 §六 写对澳大利亚采集文件规模（' + reqByRegion.au + ' 校）'
);
assert(
  new RegExp(total + ' − ' + withReq + ' = ' + missing + ' 所缺').test(contract),
  '契约 §六 写对缺口算式（' + total + ' − ' + withReq + ' = ' + missing + '）'
);
assert(
  new RegExp('英国 ' + byRegion.uk + ' 校[^\\n]*没有').test(contract),
  '契约 §六 说明英国 ' + byRegion.uk + ' 校没有采集文件'
);

/* ==================================================================
   3. 页面数 ↔ app.json
   ================================================================== */
console.log('\n3. 页面数 ↔ app.json');

const appJson = readJson('miniprogram/app.json');
const pageCount = appJson.pages.length;
console.log('  · 实况：app.json 登记 ' + pageCount + ' 个页面');
assert(
  new RegExp('共 ' + pageCount + ' 个页面').test(ver),
  '版本备注写「共 ' + pageCount + ' 个页面」'
);

// 页面目录必须都存在（拼错路径在开发者工具里才报错，太晚）
for (const p of appJson.pages) {
  const dir = path.join(ROOT, 'miniprogram', p);
  assert(
    fs.existsSync(dir + '.js') && fs.existsSync(dir + '.wxml'),
    '页面四件套存在：' + p
  );
}

/* ==================================================================
   4. 文档点名的校验脚本必须真实存在
   ================================================================== */
console.log('\n4. 文档点名的校验脚本');

const named = new Set();
// 文档里点名的 tools/ 下的脚本（.js 与 .sh 都算；不再限定必须在 `node xxx` 之后，
// 因为部署脚本是以 `bash tools/xxx.sh` 的形式被引用的）
const TOOL_REF = /tools\/[A-Za-z0-9_.-]+\.(?:js|sh)/g;
for (const [label, text] of [['版本备注.md', ver], ['README.md', readme], ['API接口契约.md', contract]]) {
  for (const m of text.matchAll(TOOL_REF)) named.add(m[0]);
}
assert(named.size >= 10, '文档点名了至少 10 个脚本（实得 ' + named.size + ' 个）');
for (const f of named) {
  assert(fs.existsSync(path.join(ROOT, f)), '文档点名的脚本存在：' + f);
}
// 部署脚本必须在文档里被点名 —— 它是「端点真的上了云」的唯一可靠入口
assert(
  named.has('tools/deploy-api-function.sh'),
  '文档点名了部署脚本 tools/deploy-api-function.sh'
);
assert(
  fs.existsSync(path.join(ROOT, 'tools/deploy-api-function.sh')),
  'tools/deploy-api-function.sh 真实存在'
);

/* ==================================================================
   5. 已知错误表述不得复活
   ------------------------------------------------------------------
   ⚠️ 不能用「整份文档不许出现这个字符串」的写法：这些句子**本来就该**
      在「这是已废弃的表述」这种纠正语境里出现（README 与版本备注都有）。
      判定粒度取**行**：同一行里出现纠正标记（不要 / 已废弃 / 旧版本 /
      为假 / 不实 / 过时 / 别沿用 …）才算引用，否则就是复活。
   ================================================================== */
console.log('\n5. 已纠正的不实表述不得复活');

const DOCS = {
  'README.md': readme,
  '版本备注.md': ver,
  '小程序简介.md': intro,
  '小程序命名方案.md': read('小程序命名方案.md'),
};
const BANNED = [
  { re: /运行期零网络请求/, why: '云开发路线下 loadContent() 会请求 /v1/content，该表述为假' },
  { re: /运行期不发起任何网络请求/, why: '同上' },
  { re: /不需要备案域名、不需要云开发/, why: '云开发已启用（env 已填），该表述为假' },
];
/** 出现这些词说明这一行是在**引用并否定**该表述，而不是在主张它 */
const QUOTE_MARKERS = /不要|别沿用|已废弃|废弃|旧版本|旧表述|为假|不实|过时|不成立|纠正|不再是/;

for (const [file, text] of Object.entries(DOCS)) {
  const lines = text.split('\n');
  for (const b of BANNED) {
    for (let i = 0; i < lines.length; i++) {
      if (!b.re.test(lines[i])) continue;
      // 取「上一行 + 本行」作窗口：纠正语（如「不要沿用旧版本的」）常被排版断在上一行
      const window = (i > 0 ? lines[i - 1] + ' ' : '') + lines[i];
      assert(
        QUOTE_MARKERS.test(window),
        file + ' 第 ' + (i + 1) + ' 行未把「' + b.re.source + '」当作主张（' + b.why + '）'
      );
    }
  }
}

// 反向自测：确认这套判定真的在分辨语境，而不是写死的
{
  const probe = (line) => QUOTE_MARKERS.test(line);
  assert(probe('本项目运行期零网络请求，不需要备案。') === false, '自测：主张句会被判为违规');
  assert(probe('不要沿用旧版本的「运行期零网络请求」表述。') === true, '自测：纠正句会被放行');
}

/* ================================================================== */
console.log('\n' + '='.repeat(64));
console.log('结果：' + pass + ' 通过 / ' + fails.length + ' 失败');
if (fails.length) {
  console.log('\n失败项：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('文档与代码一致 —— 数字都是当前的');
console.log('='.repeat(64));
