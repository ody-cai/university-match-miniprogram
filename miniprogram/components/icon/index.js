/**
 * 图标组件
 * ------------------------------------------------------------------
 * ⚠️ 真机踩坑记录（v3 修正）
 *   v1 用 WXSS 的 background-image + SVG data URI，**真机完全不显示**。
 *   v2 改为 <image> + PNG data URI，能显示了，但**图标位置会飘** ——
 *      根因有二：
 *      1) 组件根节点（:host）默认是 inline，带行高与基线空隙，
 *         在容器里看起来整体下坠；
 *      2) 外部传进来的 `extra` 被加在**内部 image** 上，外层占位盒子没动，
 *         于是「样式改了但位置没跟着走」，与外部布局对不上。
 *
 *   v3 的约定（重要，别再改回去）：
 *      · :host 统一 blockify 并清掉行高（见 index.wxss）
 *      · 图标的占位尺寸 = size，根节点天然就是 size × size
 *      · 外部要加边距 / 定位 / 旋转，**直接在标签上写 class 或 style** ——
 *        它们作用在 :host（即真实占位盒），不会出现内外两层对不上的错位
 *
 * 图标资源来自 data/icons.js（tools/gen-icons.js 构建，路径取自 lucide）。
 * 取图规则：先找 `名称-颜色`，找不到再回退别名表，因此
 * `<icon name="star-line" color="line" />` 不会因为缺 `star-line-line` 而空白。
 */
const { getIcon } = require('../../data/icons');

/** 解析出 data URI；找不到时返回空串，组件渲染占位块而不是报错 */
function resolve(name, color) {
  if (!name) return '';
  if (color) {
    const withColor = getIcon(name + '-' + color);
    if (withColor) return withColor;
  }
  return getIcon(name);
}

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 图标名，见 tools/gen-icons.js */
    name: { type: String, value: '' },
    /** 尺寸（px），正方形。占位盒与图片尺寸都取这个值 */
    size: { type: null, value: 24 },
    /** 颜色变体 key：ink / blue / white / mute / sub / line / warn / green */
    color: { type: String, value: '' },
  },

  data: {
    src: '',
  },

  observers: {
    'name, color': function (name, color) {
      this.setData({ src: resolve(name, color) });
    },
  },
});
