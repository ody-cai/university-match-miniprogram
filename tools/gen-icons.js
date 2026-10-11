#!/usr/bin/env node
/**
 * 图标构建器 v2
 * ==================================================================
 * 变更原因（真机调试发现）：
 *   v1 把 SVG 源码编成 base64 塞进 WXSS 的 `background-image`。
 *   在开发者工具（Chromium 内核）里能显示，但**真机上不显示** ——
 *   小程序 WebView 对 CSS background-image 里的 SVG data URI 支持不可靠。
 *
 * v2 方案：
 *   1. 图标路径取自 **lucide 官方图标库**（lucide-static），
 *      不再手写近似路径 —— 形状、线宽、圆角都与其他小程序/网页端一致。
 *      （morphicons 本身不含图标资源，它消费的就是 lucide 的图标数据）
 *   2. 用 sharp 把 SVG 光栅化成 **PNG**，再转 base64。
 *      PNG 的 data URI 在小程序的 `image` 组件与 background-image 中都是官方支持的。
 *   3. 颜色变体在构建期展开，运行时不需任何字符串处理。
 *
 * 产物：miniprogram/data/icons.js（键为 `名称` 或 `名称-颜色`）
 * 用法：node tools/gen-icons.js      （需 NODE_PATH 指向装了 sharp 的目录）
 */
const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('✗ 找不到 sharp。请先安装并用 NODE_PATH 指定模块目录：');
  console.error('  cd ~/.workbuddy/binaries/node/workspace && npm install sharp lucide-static');
  console.error('  NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node tools/gen-icons.js');
  process.exit(1);
}

/* ---------------- 调色板（与设计稿 token 一致） ---------------- */
const COLORS = {
  ink: '#0A1317',   // 墨蓝 · 主文本
  sub: '#5A6470',   // 次级文本
  mute: '#8A96A3',  // 三级文本 / 未选中
  line: '#C8D2DD',  // 描边
  blue: '#0064E0',  // 钴蓝 · 品牌主色
  white: '#FFFFFF',
  warn: '#E08A00',  // 待提升
  green: '#07C160', // 微信绿 / 达标
  red: '#D0342C',
};

/** 光栅化尺寸 = 24 × 该倍数。图标最大显示 26px，3x 足够清晰 */
const SCALE = 3;
const BOX = 24;
const PX = BOX * SCALE;

/* ---------------- 图标定义 ----------------
 * lucide  : lucide-static 中的文件名
 * colors  : [默认色, 变体色...]；首个颜色还会登记为不带后缀的别名
 * fill    : true 时用实心填充（用于星标、校徽符号等）
 * custom  : 自定义 SVG body（lucide 没有的图标，如微信 logo）
 *
 * ⚠️ 内容层驱动的图标（功能入口 / 标签栏）必须用 CONTENT_COLORS 全套配色：
 *    首页宫格常态用 ink、按下用 white；功能页未上线用 mute；标签栏选中用 blue。
 *    曾因只给了 mute/blue 两种，宫格在真机上渲染成虚线占位块。
 */

/** 内容层驱动展示的图标统一配色：常态 / 主色 / 反白 / 未启用 */
const CONTENT_COLORS = ['ink', 'blue', 'white', 'mute'];

const ICONS = {
  /* ---- 底部标签栏（内容层 tabBar 引用） ---- */
  'tab-home': { lucide: 'house', colors: CONTENT_COLORS },
  'tab-match': { lucide: 'target', colors: CONTENT_COLORS },
  'tab-school': { lucide: 'school', colors: CONTENT_COLORS },
  'tab-me': { lucide: 'user-round', colors: CONTENT_COLORS },

  /* ---- 通用（页面里写死引用的） ---- */
  'search': { lucide: 'search', colors: ['mute', 'sub', 'ink'] },
  'chevron-right': { lucide: 'chevron-right', colors: ['mute', 'blue', 'line'] },
  'chevron-left': { lucide: 'chevron-left', colors: ['ink', 'blue', 'mute', 'white', 'sub'] },
  'arrow-right': { lucide: 'arrow-right', colors: ['white', 'blue'] },
  /* 用途：反馈页的上传框（mute）、截图删除角标（white，旋转 45° 当 × 用） */
  'plus': { lucide: 'plus', colors: ['blue', 'ink', 'mute', 'white'] },

  /* 用途：匹配页「我的课程成绩」每一行右侧的删除键。
   * 颜色用 danger 红（#D0342C，即 app.wxss 的 --danger）而不是 warn 橙 ——
   * 橙在本项目里已固定表示「待提升 / 警示」（如雅思未达 6.5 的分数值），
   * 删除属于破坏性操作，混用会让用户分不清「这个数字要提升」与「这里能删」。
   * 也刻意不用 chevron 之类的箭头：箭头在本项目里一律代表「可进入 / 可展开」。 */
  'trash': { lucide: 'trash-2', colors: ['red', 'mute', 'white'] },

  /* ---- 星标：实心 / 描边两种用法 ----
   * 注意：`star` 不能包含 line 色，否则会生成 `star-line` 键，
   * 与下面独立的描边星图标撞名（后者会被覆盖）。
   */
  'star': { lucide: 'star', colors: ['blue', 'warn'], fill: true },
  'star-line': { lucide: 'star', colors: ['line', 'white', 'mute', 'blue'] },

  /* ---- 条款页 ---- */
  'shield-check': { lucide: 'shield-check', colors: ['blue'] },
  'alert-triangle': { lucide: 'triangle-alert', colors: ['warn'] },

  /* 反馈结果页的失败徽标：**橙色圆底 + 白色感叹号**。
   * 不直接用 lucide 的 alert-circle —— 它自带一圈轮廓，与外层橙圆底会打架。
   * 这里只画感叹号本体：竖线 + 圆点（圆点用极短线段 + round 线帽实现，这是 lucide 的惯用手法）。 */
  'alert-mark': { custom: '<path d="M12 8v4"/><path d="M12 16h.01"/>', colors: ['white'] },
  'doc-contract': { lucide: 'file-text', colors: ['blue'] },
  'check': { lucide: 'check', colors: ['blue', 'white', 'green'] },

  /* ---- 内容层：首页宫格 + 全部功能页 ----
   * 名称必须与 data/content.js 里 `icon:` 的取值完全一致。
   * 每次改这里，务必跑 `node tools/check-icons.js` 复核。
   */
  'school': { lucide: 'school', colors: CONTENT_COLORS },
  'doc': { lucide: 'file-text', colors: CONTENT_COLORS },
  'compass': { lucide: 'compass', colors: CONTENT_COLORS },
  'calendar': { lucide: 'calendar', colors: CONTENT_COLORS },
  'medal': { lucide: 'medal', colors: CONTENT_COLORS },
  'globe': { lucide: 'globe', colors: CONTENT_COLORS },
  'chart': { lucide: 'chart-column', colors: CONTENT_COLORS },
  'clipboard': { lucide: 'clipboard-list', colors: CONTENT_COLORS },
  'report': { lucide: 'file-check', colors: CONTENT_COLORS },
  'sliders': { lucide: 'sliders-horizontal', colors: CONTENT_COLORS },
  'compare': { lucide: 'arrow-left-right', colors: CONTENT_COLORS },
  'planner': { lucide: 'users', colors: CONTENT_COLORS },
  'quiz': { lucide: 'message-circle-question', colors: CONTENT_COLORS },
  'exchange': { lucide: 'arrow-up-down', colors: CONTENT_COLORS },
  'feedback': { lucide: 'message-square', colors: CONTENT_COLORS },

  /* ---- 详情页 Hero ---- */
  'grad-cap': { lucide: 'graduation-cap', colors: ['blue', 'white'] },

  /* ---- 微信 logo（lucide 无此图标，自绘实心路径） ---- */
  'wechat': {
    colors: ['white', 'ink', 'green'],
    fill: true,
    custom:
      '<path d="M9.06 2.8C4.66 2.8 1.1 5.68 1.1 9.23c0 2.02 1.13 3.83 2.9 5.03-.14.83-.5 1.86-.98 2.5 1.05.13 2.3-.36 3.03-.84.95.28 1.96.43 3.01.43.25 0 .5-.01.74-.03a5.66 5.66 0 0 1-.25-1.64c0-3.4 3.4-6.14 7.6-6.14.25 0 .49.01.73.03C17.5 5.2 13.65 2.8 9.06 2.8zM6.5 6.6a1.02 1.02 0 1 1 0 2.04 1.02 1.02 0 0 1 0-2.04zm5.1 0a1.02 1.02 0 1 1 0 2.04 1.02 1.02 0 0 1 0-2.04z"/>' +
      '<path d="M22.9 15.35c0-2.85-2.79-5.16-6.23-5.16s-6.24 2.31-6.24 5.16 2.8 5.16 6.24 5.16c.73 0 1.43-.11 2.08-.3l1.9 1.03-.5-1.72c1.06-.94 1.75-2.3 1.75-3.87-.01-.1 0-.2 0-.3zm-8.24-1.32a.86.86 0 1 1 0-1.72.86.86 0 0 1 0 1.72zm4.02 0a.86.86 0 1 1 0-1.72.86.86 0 0 1 0 1.72z"/>',
  },

  /* ---- 校徽符号（crest 组件内部的白色图形层） ---- */
  'sym-building': { lucide: 'landmark', colors: ['white'], fill: true },
  'sym-shield': { lucide: 'shield', colors: ['white'], fill: true },
  'sym-blocks': { lucide: 'layout-grid', colors: ['white'], fill: true },
  'sym-wave': { lucide: 'waves', colors: ['white'] },
  'sym-arch': { lucide: 'warehouse', colors: ['white'], fill: true },
  'sym-cap': { lucide: 'graduation-cap', colors: ['white', 'blue'], fill: true },
  'sym-leaf': { lucide: 'leaf', colors: ['white'], fill: true },
  'sym-star': { lucide: 'star', colors: ['white'], fill: true },
};

/* ---------------- 读取 lucide 图标 ---------------- */
const LUCIDE_DIR = path.join(
  process.env.LUCIDE_DIR || './node_modules/lucide-static/icons'
);

/** 从 lucide SVG 中抽出内部图形，并去掉其自带的 stroke 属性（改由外层统一控制） */
function readLucide(name) {
  const p = path.join(LUCIDE_DIR, name + '.svg');
  if (!fs.existsSync(p)) throw new Error(`lucide 图标不存在: ${name}`);
  const raw = fs.readFileSync(p, 'utf8');
  const m = raw.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  if (!m) throw new Error(`无法解析 lucide SVG: ${name}`);
  // 只保留几何元素，剥掉 stroke-width 等，便于外层统一指定
  return m[1].replace(/\s(stroke-width|stroke-linecap|stroke-linejoin)="[^"]*"/g, '').trim();
}

/* ---------------- 组装 SVG 字符串 ---------------- */
function buildSvg(def, hex) {
  const body = def.custom || readLucide(def.lucide);
  const paint = def.fill
    ? `fill="${hex}" stroke="${hex}"`
    : `fill="none" stroke="${hex}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BOX}" height="${BOX}" viewBox="0 0 ${BOX} ${BOX}" ` +
    `${paint} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}

/* ---------------- 主流程 ---------------- */
async function build() {
  const out = {};
  /** 别名表：`名称` → `名称-颜色`，避免同一份 base64 在产物里存两遍 */
  const alias = {};
  let count = 0;
  const stats = [];

  for (const [name, def] of Object.entries(ICONS)) {
    for (let i = 0; i < def.colors.length; i++) {
      const key = def.colors[i];
      const hex = COLORS[key];
      if (!hex) throw new Error(`未知颜色 ${key}（图标 ${name}）`);

      const svg = buildSvg(def, hex);
      // density 提高光栅化精度；resize 到目标像素；palette 压缩体积
      const png = await sharp(Buffer.from(svg), { density: 384 })
        .resize(PX, PX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9, palette: true, effort: 10 })
        .toBuffer();

      const uri = 'data:image/png;base64,' + png.toString('base64');

      // 每个颜色都落一个 `名称-颜色` 键；首个颜色额外登记别名，
      // 让 `<icon name="xxx" />`（不写颜色）也能取到图，且不重复存 base64
      out[`${name}-${key}`] = uri;
      if (i === 0) alias[name] = `${name}-${key}`;

      count++;
      stats.push(png.length);
    }
  }

  const banner = `/**
 * 自动生成，请勿手改。
 * 源：tools/gen-icons.js（图标路径取自 lucide 官方图标库）
 * 重新编译：NODE_PATH=<装有 sharp 的 node_modules> node tools/gen-icons.js
 *
 * 说明：小程序 WebView 对 CSS background-image 里的 SVG data URI 支持不可靠，
 * 真机上会不显示；因此这里统一光栅化为 PNG（${PX}×${PX}，即 24px 的 ${SCALE}x）。
 * 使用方式见 components/icon —— 走 <image> 组件，不要用 background-image。
 */`;

  const js = `${banner}
const ICONS = ${JSON.stringify(out, null, 0)};

/**
 * 别名表：名称 → 名称-颜色
 * 用途：调用方不写颜色时（<icon name="star-line" />）也能取到该图标的首个颜色版本，
 * 同时避免把同一份 base64 在产物里存两遍（省约 50 KB）。
 */
const ALIAS = ${JSON.stringify(alias, null, 0)};

/** 取图标 data URI；找不到时返回空串，组件会渲染占位而不报错 */
function getIcon(id) {
  return ICONS[id] || ICONS[ALIAS[id]] || '';
}

module.exports = { ICONS, ALIAS, getIcon };
`;

  const target = path.join(__dirname, '..', 'miniprogram', 'data', 'icons.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, js, 'utf8');

  const total = fs.statSync(target).size;
  const avg = Math.round(stats.reduce((a, b) => a + b, 0) / stats.length);
  console.log(`✓ 已生成 ${count} 个图标（${Object.keys(ICONS).length} 个图形，${PX}×${PX} PNG）`);
  console.log(`  单个平均 ${avg} B ｜ 产物 ${(total / 1024).toFixed(1)} KB`);
  console.log(`  → ${path.relative(process.cwd(), target)}`);
}

build().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
