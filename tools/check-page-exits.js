#!/usr/bin/env node
/**
 * 页面出口校验（二级页必须有返回键）
 * ==================================================================
 * 为什么需要它 —— 2026-09-22 新建「我的收藏」页时踩到：
 *
 *   `nav-bar` 组件的返回箭头**只在你显式传 `back` 时才渲染**。
 *   页面写了 `<nav-bar title="..." />` 就编译通过、正常显示标题，
 *   **只是少一个箭头** —— 没有报错、没有告警、所有测试全绿。
 *   真机上用户点进「我的收藏」后，除了系统手势就没有任何出口。
 *
 * 这是「静默缺陷」家族里最容易被放过的一类：它不表现为坏掉，
 * 只表现为「少了一个东西」，而少的东西没有任何断言会去数。
 *
 * 校验四类：
 *   1) 非 tab 页、非启动页 → nav-bar 必须渲染返回箭头（back）或文本返回（backText）
 *   2) 传了 back/backText 的页面 → 必须给「没有历史栈」时的兜底
 *      （fallbackUrl / backUrl，或自己 bind:back 处理，如 matching 的「取消」）
 *   3) 启动页不放返回箭头（无历史栈可回，箭头是死 UI）
 *   4) nav-bar 标题必须来自内容层，不得在 WXML 里写死中文
 *
 * ⚠️ 判定前先剥掉 WXML 注释：这些页面的注释里大量出现「back」「返回」等词，
 *    不剥的话注释会把断言喂绿（本文件自己的注释就是例子）。
 *
 * 用法：node tools/check-page-exits.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'miniprogram');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`);
  }
}
const head = (t) => console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
const read = (p) => fs.readFileSync(p, 'utf8');

const appJson = JSON.parse(read(path.join(PROJECT, 'app.json')));
const tabPages = ((appJson.tabBar && appJson.tabBar.list) || []).map((x) => x.pagePath);
const launchPage = appJson.pages[0];

/** 取出该页 nav-bar 标签的原始文本（已剥注释） */
function navBarTag(page) {
  const wxml = read(path.join(PROJECT, page + '.wxml')).replace(/<!--[\s\S]*?-->/g, '');
  const m = /<nav-bar[\s\S]*?\/>/.exec(wxml);
  return m ? m[0] : '';
}

/**
 * 取该页 js 的源码（已剥块注释 + 行注释）
 *
 * 为什么要剥注释再判？
 *   这份脚本守的是「真的注册了 onShareAppMessage」，但页面 js 的注释里
 *   大量出现「onShareAppMessage / onShareTimeline」字样 —— 不剥就会把
 *   注释喂绿。WXML 注释走 &lt;!-- --&gt;；JS 块注释与行注释都得剥。
 *
 *   注意：本注释里不能出现形如「斜杠 + 星号 ... 星号 + 斜杠」的连续 4 字符，
 *   不然 JS 解析器会把它当作块注释结束符提前闭合（不支持嵌套），导致下面的
 *   函数定义裸露在块注释之外，触发 SyntaxError。
 */
function pageJs(page) {
  const raw = read(path.join(PROJECT, page + '.js'));
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

head('1. 二级页必须有返回出口');
appJson.pages.forEach((page) => {
  const isTab = tabPages.indexOf(page) > -1;
  const isLaunch = page === launchPage;
  const tag = navBarTag(page);
  const name = page.replace('pages/', '');

  check(`${name} 渲染了 nav-bar`, !!tag || isTab, isTab ? '（tab 页可能不需要）' : '没有 nav-bar 就没有标题和出口');

  if (isTab || isLaunch) return;

  const hasArrow = /\bback="\{\{\s*true\s*\}\}"|\bback="true"|(?<![\w-])back(?=[\s/>])/.test(tag);
  const hasBackText = /\bback-text=|\bbackText=/.test(tag);
  check(
    `二级页 ${name} 有返回出口（箭头或文本）`,
    hasArrow || hasBackText,
    hasArrow ? '' : hasBackText ? '（文本返回）' : 'nav-bar 没传 back/backText —— 真机上没有任何返回按钮'
  );
});

head('2. 返回动作在没有历史栈时也要有落点');
appJson.pages.forEach((page) => {
  if (tabPages.indexOf(page) > -1 || page === launchPage) return;
  const tag = navBarTag(page);
  const name = page.replace('pages/', '');
  const hasExit = /\bback=|\bbackText=|\bback-text=/.test(tag);
  if (!hasExit) return; // 上一条已经报过了
  const hasFallback =
    /fallback-url=|fallbackUrl=|back-url=|backUrl=|bind:back=|bindback=/.test(tag);
  check(
    `${name} 提供了兜底落点（分享卡片直达时用得上）`,
    hasFallback,
    hasFallback ? '' : '既没有 fallbackUrl/backUrl，也没有 bind:back 自行处理'
  );
});

head('3. 启动页不放返回箭头');
{
  const tag = navBarTag(launchPage);
  const hasArrow = /\bback="\{\{\s*true\s*\}\}"|\bback="true"/.test(tag);
  check(
    `启动页 ${launchPage.replace('pages/', '')} 没有返回箭头（无历史栈可回，箭头是死 UI）`,
    !hasArrow
  );
}

head('4. 导航栏标题来自内容层');
appJson.pages.forEach((page) => {
  const tag = navBarTag(page);
  if (!tag) return;
  const name = page.replace('pages/', '');
  const titleAttr = (/\btitle="([^"]*)"/.exec(tag) || [])[1] || '';
  check(
    `${name} 的标题不是硬编码中文`,
    !/[\u4e00-\u9fa5]/.test(titleAttr),
    titleAttr ? `title="${titleAttr}"` : ''
  );
  check(
    `${name} 的标题绑定到内容层`,
    /\{\{\s*c\./.test(titleAttr),
    titleAttr
  );
});

/**
 * 5. 所有页面必须注册 onShareAppMessage + onShareTimeline
 * ------------------------------------------------------------------
 * 2026-10-11 排查发现：原 15 个页面**全部**没有 onShareAppMessage，
 * 微信官方 Page 文档原话「**只有定义了此事件处理函数，右上角菜单才会显示
 * 「转发」按钮**」—— 与用户报的「转发置灰」现象完全一致。
 *
 * 注入策略：utils/share.js 暴露 `withShare(cfg, { pageId })`，Page({...})
 * 改成 Page(share.withShare({...}, { pageId }))。onShareAppMessage / onShareTimeline
 * 由 withShare 自动注入（页面若已自己定义则不覆盖 —— 已通过 verify-home-page 等
 * 用例间接验证）。
 *
 * 本节守的是「页面确实接入了 share.withShare」，**不是**「页面真的写了
 * `onShareAppMessage` 字面量」（因为 share.withShare 是工具函数包裹层）。
 *
 * 判定：页面 js 里要么有 `share.withShare(` 调用，要么有自写的
 * `onShareAppMessage` 方法定义。两个有任何一个即视为已接入。
 *
 * ⚠️ 必须先剥注释再判：share.js 自身 + share.withShare 的注释 +
 * utils/share.js 的注释里都会出现 onShareAppMessage —— 不剥就判的话
 * 一段注释就让所有页都判绿。
 */
head('5. 所有页面必须注册 onShareAppMessage / onShareTimeline');
appJson.pages.forEach((page) => {
  const name = page.replace('pages/', '');
  const js = pageJs(page);
  const hasWrap = /share\.withShare\(/.test(js);
  const hasOwn = /^\s*onShareAppMessage\s*\(/m.test(js);
  check(
    `${name} 已接入 onShareAppMessage（share.withShare 或自写）`,
    hasWrap || hasOwn,
    hasWrap ? '（utils/share.js 注入）' : (hasOwn ? '（页面自写）' : '转发按钮将置灰 —— 官方 Page.onShareAppMessage 文档明确：未定义不渲染菜单')
  );
  const hasWrapTL = /share\.withShare\(/.test(js);
  const hasOwnTL = /^\s*onShareTimeline\s*\(/m.test(js);
  check(
    `${name} 已接入 onShareTimeline（share.withShare 或自写）`,
    hasWrapTL || hasOwnTL,
    hasWrapTL ? '（utils/share.js 注入）' : (hasOwnTL ? '（页面自写）' : '分享到朋友圈按钮将置灰')
  );
});

console.log('\n' + '═'.repeat(64));
console.log(`结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('═'.repeat(64));
