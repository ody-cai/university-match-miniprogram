/**
 * 自定义导航栏
 * 设计稿采用居中标题 + 右上胶囊预留的微信原生布局，因此全局使用
 * navigationStyle: custom，由本组件统一渲染状态栏与导航栏。
 * 右侧胶囊按钮由微信自行绘制，标题用绝对居中，天然避让。
 */
Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /**
     * ⚠️ 这里刻意用完整对象形态而不是简写，只为挂 observer。
     * 页面若在内容未就绪时渲染（历史上各页 data.c 初始值为 {}），
     * `{{c.nav.x}}` 求值为 undefined，微信会以 null 传入并打印
     * 「expected <String> but get null」告警。归一为空串即可消除噪声 ——
     * 标题本来就是「没有就空着」，不改变任何可见行为。
     * （各页 data.c 现已改为 api.content()，首帧即有值，此处是第二道防线。）
     */
    title: {
      type: String,
      value: '',
      observer(v) {
        if (v === null || v === undefined) this.setData({ title: '' });
      },
    },
    /** light | dark —— dark 用于深色 Hero 之上的导航栏 */
    theme: { type: String, value: 'light' },
    /** 左侧返回箭头 */
    back: { type: Boolean, value: false },
    /** 左侧文本按钮（如「取消」），设置后替代箭头 */
    backText: { type: String, value: '' },
    /** 是否固定定位 */
    fixed: { type: Boolean, value: true },
    /** 是否输出占位撑开文档流（fixed 时必须，否则内容会被压在栏下） */
    placeholder: { type: Boolean, value: true },
    /** 指定返回目标；不填则 navigateBack */
    backUrl: { type: String, value: '' },
    /** backUrl 是否为 tab 页 */
    backTab: { type: Boolean, value: false },
    /** 无历史可回退时的兜底目标 */
    fallbackUrl: { type: String, value: '' },
  },

  data: {
    sb: 44,
    nb: 44,
  },

  lifetimes: {
    attached() {
      const app = getApp();
      const g = (app && app.globalData) || {};
      this.setData({
        sb: g.statusBarHeight || 44,
        nb: g.navBarHeight || 44,
      });
    },
  },

  methods: {
    onBack() {
      const { backUrl, backTab, fallbackUrl } = this.data;
      this.triggerEvent('back');

      if (backUrl) {
        if (backTab) wx.switchTab({ url: backUrl, fail: () => {} });
        else wx.redirectTo({ url: backUrl, fail: () => {} });
        return;
      }
      // 无历史栈时（例如从分享卡片直达）回落到指定页面
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({ fail: () => {} });
      } else if (fallbackUrl) {
        wx.switchTab({ url: fallbackUrl, fail: () => {} });
      }
    },
  },
});
