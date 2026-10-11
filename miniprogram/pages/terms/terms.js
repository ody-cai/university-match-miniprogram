/**
 * 服务条款与隐私（00a）—— 启动页
 * ==================================================================
 * 职责：在进入功能前取得用户对「服务协议 / 隐私政策 / 免责声明」的知情同意。
 *
 * 几个刻意的设计决定：
 *   · 本页是 app.json 的第一页（启动页）。**这与「登录页不得前置」并不冲突**：
 *     协议同意属《个人信息保护法》要求的知情同意，微信自 2023-09 起也强制
 *     小程序弹隐私协议；而账号登录是另一回事，见 pages/signin 顶部说明。
 *   · 已同意过则 onLoad 直接 switchTab 进首页，不重复索取同意（一人只问一次）。
 *
 * ⚠️ 2026-09-20 修：用户反馈「我已经登录过了，却每次打开都要再看一遍条款页」。
 *    根因是**同意态判定被挂在了网络回调上** —— 旧代码把 `api.isAgreed()`
 *    写在 `api.loadContent().then()` 内部。isAgreed 只是同步读本地 Storage，
 *    与内容配置毫无关系，却要等一次 `/v1/content` 云函数往返
 *    （CONFIG.timeout = 15s，冷启动常态 1~3s）才决定跳不跳。
 *    于是已同意的用户每次都完整看到一遍条款页。三条修正：
 *      ① `isAgreed()` 提到最前，**同步判定**，不等任何请求；
 *      ② 跳转收敛到 `goHome()`，统一带 `reLaunch` 兜底
 *         （旧代码只在 onAgree 里写了兜底，onLoad 里漏了 —— 冷启动首屏
 *          switchTab 一旦失败就是静默停住）；
 *      ③ `agreeTerms()` 的返回值必须检查：写入失败时**不得**放行，
 *         否则用户进了首页、下次启动又被要求同意，表现为「同意过但记不住」。
 *    `tools/verify-terms-page.js` 以 31 条断言守住这三条。
 *   · 「不同意」必须有**真实响应**（弹确认框 → 退出小程序）。点了没反应
 *     与强制同意一样属于违规。
 *   · 条款正文放在 data/legal.js，入口文案放在内容层 terms.docs ——
 *     分开是为了让正文（法律文本）与列表（可调整的展示项）各自维护。
 *   · 同意状态通过 api 读写，页面不直接引用 store：
 *     以后若改成「同意状态存后端」，只需改 api 一层。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');
const legal = require('../../data/legal');

/** 首页是 tab 页，只能用 switchTab 进；所有跳转都走这一处，避免漏掉兜底 */
const HOME = '/pages/home/home';

Page(share.withShare({
  data: {
    c: api.content(),
    /**
     * 是否已完成「同意态」判定。
     * false = 还没判定完，正文一律不渲染 —— 已同意的用户不该看到条款页闪一下。
     */
    ready: false,
    /** 是否已勾选「我已阅读并同意」 */
    checked: false,
    /** 当前展开的条款文档，null = 浮层关闭 */
    doc: null,
    /** 浮层里的「更新日期 xxxx-xx-xx」，在 JS 里拼好（WXML 不能调函数） */
    docMeta: '',
    /**
     * 三份文档入口。**必须首帧就位**，不能写 `[]` ——
     * 写空数组时首帧整块空白，要等 loadContent 的远端补丁回来才出现（版式跳动）。
     * `api.content()` 是同步的（内置内容 + 本地缓存补丁，不发请求），
     * 与上面 c 取到的是同一个对象，不存在两处不一致的风险。
     */
    docs: (api.content().terms || {}).docs || [],
  },

  onLoad() {
    // ① 同步判定，**刻意放在 loadContent 之前**。
    //    isAgreed() 只读本地 Storage，跟内容配置无关；
    //    若等网络返回再判，已同意用户每次启动都要干看一遍条款页（旧版即此 bug）。
    //    这一句必须留在所有异步之前。
    if (api.isAgreed()) {
      this.goHome();
      return;
    }

    // ② 未同意：正文就位，再拉一次内容配置（远端补丁到了覆盖即可）
    this.setData({ ready: true });
    api.loadContent().then((c) => {
      const t = (c && c.terms) || null;
      this.setData({
        c,
        // 后端补丁可能没带 docs，缺了就保留内置的三项，不能渲染成空
        docs: (t && t.docs) || this.data.docs,
      });
    });
  },

  /**
   * 进首页。首页是 tab 页，必须 switchTab；冷启动首屏调用有失败可能，
   * 失败则用 reLaunch 兜底 —— 静默停住会让用户以为必须重新同意一遍。
   */
  goHome() {
    wx.switchTab({ url: HOME, fail: () => wx.reLaunch({ url: HOME }) });
  },

  /** 勾选框：未勾选时主按钮为禁用态 */
  onToggle() {
    this.setData({ checked: !this.data.checked });
  },

  /* ---------------- 条款正文浮层 ---------------- */

  /** 打开某份文档（正文按 key 从 legal.js 取） */
  onOpenDoc(e) {
    const key = e.currentTarget.dataset.key;
    const doc = legal.DOCS[key] || null;
    this.setData({
      doc,
      docMeta: doc
        ? api.tpl(this.data.c.terms.docUpdated, { date: doc.updatedAt })
        : '',
    });
  },

  onCloseDoc() {
    this.setData({ doc: null });
  },

  /** 阻止浮层内部点击穿透到遮罩导致误关闭 */
  noop() {},

  /* ---------------- 同意 / 拒绝 ---------------- */

  onAgree() {
    if (!this.data.checked) {
      wx.showToast({ title: this.data.c.terms.needCheck, icon: 'none' });
      return;
    }
    // ⚠️ 必须吃返回值。Storage 写入失败（配额满 / 异常）时若照样放行，
    //    用户看着进了首页，下次启动又被要求同意 —— 就是「同意过但记不住」。
    //    宁可他这次看到提示重试，也不要制造一个查不出来的死循环。
    if (!api.agreeTerms()) {
      wx.showToast({ title: this.data.c.terms.saveFailed, icon: 'none' });
      return;
    }
    this.goHome();
  },

  /**
   * 拒绝：提供「再想想」与「退出」两个选择，两个都有响应。
   * 直接静默或点了没反应，与强制登录同属违规。
   */
  onDecline() {
    const t = this.data.c.terms;
    wx.showModal({
      title: t.declineTitle,
      content: t.declineContent,
      confirmText: t.declineConfirm,
      cancelText: t.declineCancel,
      success: (res) => {
        if (!res.confirm) return;
        wx.exitMiniProgram({
          fail: () => {
            // 非「从聊天/桌面进入」的场景下 exitMiniProgram 会失败，
            // 此时给出明确反馈，而不是让用户以为按钮坏了
            wx.showToast({ title: t.exitTip, icon: 'none' });
          },
        });
      },
    });
  },
}, { pageId: 'terms' }));
