#!/usr/bin/env node
/**
 * 数据与代码副本同步 / 一致性校验
 * ==================================================================
 * 这个项目有多处「影子副本」，改一处不改另一处就会出现
 * 「不同入口看到的结果不一样」—— 最难查的一类事故：
 *
 *   1) miniprogram/data/universities.js
 *      → cloudfunctions/admin/data/schools.json          （后台管理端）
 *      ⚠️ 差一份 = 用户在小程序里看到的院校数据与后台管理端不是同一份
 *
 *   2) miniprogram/data/content.js
 *      → cloudfunctions/admin/data/content.js
 *
 *   3) admin/{index.html,styles.css,app.js}
 *      → miniprogram/cloudfunctions/admin/static/*
 *      ⚠️ 管理台是「页面与函数同一个包」，静态页必须进函数包才会上线。
 *         此前只写在 README 的一条 `cp` 命令里，没有任何脚本看守 ——
 *         2026-09-22 加入本清单，漏同步会被 `--check` 直接抓出来。
 *
 * ⚠️ 2026-09-24：**微信 AI 独立分包（`miniprogram/skills/`）已整体移除** ——
 *   提审被驳回，审核答复为「Skill 能力尚处于灰度测试阶段，暂未开放提审，
 *   建议移除 Skill 相关代码后重新提交」（见 `版本备注.md`）。
 *    因此 `utils/{match,api,request,store}.js` 现在只剩主包一份，
 *    `content.js` / `universities.js` 只剩「主包 + 管理台」两处。
 *    **若将来恢复分包，本脚本与 `test-cloud-transport.js` 第 8 节、
 *    `test-insight-templates.js` 第 6 节、`test-feedback-api.js` 第 11 节
 *    必须一并把「分包拷贝」加回来**，否则会重演
 *    「页面里看到的和微信 AI 答出来的不是同一份数据」。
 *
 * 用法：
 *   node tools/sync-data-copies.js           同步全部
 *   node tools/sync-data-copies.js --check   只校验不写入（上传前 / CI）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const ADMIN = path.join(MP, 'cloudfunctions', 'admin');

const checkOnly = process.argv.includes('--check');
let fail = 0;

/** 逐字同步 */
function syncExact(src, dst, label) {
  if (!fs.existsSync(src)) {
    console.error(`✗ 源文件不存在：${src}`);
    fail++;
    return;
  }
  const a = fs.readFileSync(src, 'utf8');
  const b = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
  if (a === b) {
    console.log(`  ✓ ${label}`);
    return;
  }
  if (checkOnly) {
    console.log(`  ✗ ${label} 不一致 → 跑 node tools/sync-data-copies.js`);
    fail++;
    return;
  }
  fs.writeFileSync(dst, a, 'utf8');
  console.log(`  ✓ ${label} 已同步`);
}

/* ---------------- 1. 院校数据（先由 build 产出） ---------------- */
const UNI = path.join(MP, 'data', 'universities.js');
if (!fs.existsSync(UNI)) {
  console.error('✗ 缺少 miniprogram/data/universities.js，先跑 node data-source/build.js');
  process.exit(1);
}
console.log('院校数据：');

// 后台存的是 SCHOOLS 数组本身（纯 JSON）
const srcText = fs.readFileSync(UNI, 'utf8');
const m = srcText.match(/const SCHOOLS = (\[[\s\S]*?\n\]);/);
if (!m) {
  console.error('✗ 无法从编译产物中解析 SCHOOLS');
  process.exit(1);
}
const schools = JSON.parse(m[1]);
const adminJson = JSON.stringify(schools, null, 2) + '\n';
const adminPath = path.join(ADMIN, 'data', 'schools.json');
const curAdmin = fs.existsSync(adminPath) ? fs.readFileSync(adminPath, 'utf8') : null;
const same = curAdmin !== null && curAdmin.replace(/\s+$/, '') === adminJson.replace(/\s+$/, '');
if (same) {
  console.log(`  ✓ 后台 schools.json（${schools.length} 所）`);
} else if (checkOnly) {
  console.log('  ✗ 后台 schools.json 不一致 → 跑 node tools/sync-data-copies.js');
  fail++;
} else {
  fs.writeFileSync(adminPath, adminJson, 'utf8');
  console.log(`  ✓ 后台 schools.json 已同步（${schools.length} 所）`);
}

/* ---------------- 2. 代码副本 ---------------- */
console.log('代码副本：');
syncExact(path.join(MP, 'data', 'content.js'), path.join(ADMIN, 'data', 'content.js'), 'admin/data/content.js');

/* ---------------- 3. 管理台静态页 ---------------- */
/**
 * ⚠️ 这一对（`admin/` → `cloudfunctions/admin/static/`）此前**只靠 README 里
 *    一条手工 `cp` 命令**维持同步，没有任何脚本看守：
 *    改了 `admin/` 却忘记 cp，函数包里跑的还是旧页面，
 *    表现为「后台明明改了、线上还是老样子」—— 与院校数据影子副本同源的事故。
 *    加进本清单后由 `--check` 看守，漏同步会直接变红。
 */
console.log('管理台静态页：');
for (const f of ['index.html', 'styles.css', 'app.js']) {
  syncExact(path.join(ROOT, 'admin', f), path.join(ADMIN, 'static', f), 'admin/' + f);
}

if (fail) {
  console.log(`\n有 ${fail} 项未通过`);
  process.exit(1);
}
console.log(checkOnly ? '\n全部一致' : '\n同步完成');
