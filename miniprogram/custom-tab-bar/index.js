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
    list: [],
  },

  lifetimes: {
    attached() {
      const app = getApp();
      const g = (app && app.globalData) || {};
      this.setData({
        safeBottom: g.safeBottom || 0,
        list: (api.content().tabBar || []).slice(0, 5),
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
