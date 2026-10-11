const store = require('./utils/store');
const request = require('./utils/request');

App({
  globalData: {
    /** 状态栏高度（px），运行时由系统信息覆盖 */
    statusBarHeight: 44,
    /** 导航栏内容高度（px） */
    navBarHeight: 44,
    /** 胶囊按钮右侧预留宽度 = 胶囊宽 + 右边距 + 间距 */
    capsuleInset: 102,
    /** 底部安全区高度 */
    safeBottom: 0,
    /** 标签栏总高度 = 内容 50 + 安全区 */
    tabBarHeight: 84,
  },

  onLaunch() {
    // 迁移必须最先跑：它修正的是老设备 Storage 里已经落库的数据（见 store.migrate）。
    // 晚于任何读取都会让页面先看到旧值，再「自己变一次」，观感上像数据在跳。
    store.migrate();
    this.measureLayout();
    this.initCloud();
  },

  /**
   * 初始化微信云开发
   * ------------------------------------------------------------------
   * ⚠️ 环境 ID 的唯一来源是 utils/request.js 的 CONFIG.env —— **不要**在这里
   *    再写一份。两处一旦不一致，传输层会把请求发往 A 环境、数据却落在 B 环境，
   *    而且不会有任何报错（表现为「写进去了但读不到」，是最难查的一类问题）。
   *
   * ⚠️ traceUser 刻意保持关闭：开启后会把用户访问记录上报到云开发控制台的
   *    「用户管理」，那属于收集用户行为数据，需要在「用户隐私保护指引」里
   *    额外声明一项。本项目不需要这个能力，也就不该多担这项义务。
   */
  initCloud() {
    const env = request.CONFIG.env;
    if (!env) return; // 未配置云开发：正常运行在本地模式或自建后端模式
    if (!wx.cloud || typeof wx.cloud.init !== 'function') {
      // 基础库过低（< 2.2.3）。这里不抛错打断启动 ——
      // 真正的问题会在调用时由 request 层给出可读提示。
      console.warn('[app] 当前微信版本不支持云开发，后端能力不可用');
      return;
    }
    wx.cloud.init({ env, traceUser: false });
  },

  /**
   * 测量设备布局参数。
   * 设计稿以 iPhone X 类机型（状态栏 44 / 安全区 34）为基准，
   * 这里按实际机型换算，保证自定义导航栏与胶囊按钮不重叠。
   */
  measureLayout() {
    let win = {};
    try {
      // 基础库 2.20.1+ 已提供 getWindowInfo（statusBarHeight/screenHeight/safeArea 均覆盖）。
      // 不再回落已废弃的 getSystemInfoSync，避免 DevTools 弹废弃 API 提示。
      win = wx.getWindowInfo();
    } catch (e) {
      win = {};
    }

    const statusBarHeight = win.statusBarHeight || 44;
    const screenHeight = win.screenHeight || 812;
    const safeArea = win.safeArea || {};
    const safeBottom = Math.max(0, screenHeight - (safeArea.bottom || screenHeight));

    // 导航栏高度：以胶囊按钮为锚点上下等距
    let navBarHeight = 44;
    try {
      const cap = wx.getMenuButtonBoundingClientRect();
      if (cap && cap.height) {
        navBarHeight = (cap.top - statusBarHeight) * 2 + cap.height;
      }
    } catch (e) {
      /* 开发者工具早期版本可能不支持，回落 44 */
    }
    if (!navBarHeight || navBarHeight < 40 || navBarHeight > 60) navBarHeight = 44;

    this.globalData.statusBarHeight = statusBarHeight;
    this.globalData.navBarHeight = Math.round(navBarHeight);
    this.globalData.safeBottom = safeBottom;
    // 标签栏内容高 44 + 底部安全区（设计稿实测 44 + 34 = 78）
    this.globalData.tabBarHeight = 44 + safeBottom;

    return this.globalData;
  },

  /** 供页面在 onLoad 中读取，返回可直接绑定的内联样式 */
  layoutStyle() {
    const g = this.globalData;
    return {
      sb: `height:${g.statusBarHeight}px`,
      nav: `height:${g.navBarHeight}px`,
      tab: `height:${g.tabBarHeight}px`,
      pageVars: `--sb:${g.statusBarHeight}px;--nav:${g.navBarHeight}px;--tab:${g.tabBarHeight}px;`,
    };
  },

  store,
});
