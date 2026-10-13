/**
 * 自定义标签栏
 * ------------------------------------------------------------------
 * 采用 custom: true 的原因：
 *   1. 原生 tabBar 的 iconPath 只接受位图，而设计稿要求图标一律矢量；
 *      自定义后可复用同一套 SVG 图标体系，选中态直接换色，无需两套 PNG。
 *   2. 设计稿的标签栏需要叠加设备底部安全区，自定义更容易精确控制。
 *
 * 标签项文案来自 data/content.js 的 tabBar，可由后端下发覆盖，
 * 但**新增 / 删除标签页需要同步修改 app.json 的 tabBar.list**，
 * 属于发版级改动 —— 后端只应调整文案与顺序。
 * 微信官方规范约束：标签项 ≤ 5，这里为 4 项。
 */
const api = require('../utils/api');

Component({
  options: { styleIsolation: 'apply-shared' },

  data: {
    selected: 0,
    /** 标签项内容高度（设计稿实测 44 + 安全区 34 = 78） */
    barHeight: 44,
    safeBottom: 0,
    /**
     * 首帧即渲染：内容层是打包内置数据，api.content() 纯同步可读，
     * 不必等 attached 再填（曾经 list 初始为空、attached 才 setData，
     * 标签栏区域会先空一帧再整块出现）。
     */
    list: (api.content().tabBar || []).slice(0, 5),
  },

  lifetimes: {
    attached() {
      const app = getApp();
      const g = (app && app.globalData) || {};
      /**
       * 选中项在这里按**当前页面路由**直接定好，而不是先落默认值 0
       * （首页高亮）再等页面 onShow 来纠偏 —— 后者在切到非首页的 tab 时
       * 会闪一帧「首页被选中」。各页 onShow 仍保留同步调用作兜底
       * （attached 与 onShow 的先后顺序框架不保证），两处写的是同一个值。
       */
      const pages = getCurrentPages();
      const route = pages.length ? '/' + pages[pages.length - 1].route : '';
      const idx = this.data.list.findIndex((it) => it.pagePath === route);
      this.setData({
        safeBottom: g.safeBottom || 0,
        selected: idx > -1 ? idx : 0,
      });
    },
  },

  methods: {
    onTap(e) {
      const index = Number(e.currentTarget.dataset.index);
      if (index === this.data.selected) return;
      const item = this.data.list[index];
      if (!item || !item.pagePath) return;
      wx.switchTab({ url: item.pagePath });
    },
  },
});
