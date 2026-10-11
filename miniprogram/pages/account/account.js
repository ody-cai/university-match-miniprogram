/**
 * 账号管理（08）
 * ------------------------------------------------------------------
 * 未登录时不强制登录：顶部显示「登录后同步」入口，其余功能照常可用。
 * 退出登录需二次确认 —— 这是明确的用户动作，不做静默清数据。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),
    user: null,
    signedIn: false,
    stats: { matched: 0, favorites: 0, documents: 0 },
    /** 资料卡展示文案，在 refresh 里按「是否填过昵称 / 是否登录」推导 */
    profileName: '',
    profileSub: '',
    /** 服务端下发的版本徽标（如「备考版」）；为空则整块不渲染 */
    plan: '',
    /** 设置项：文案与跳转来自内容层，ready=false 如实提示 */
    security: [],
    preference: [],
  },

  onLoad() {
    this.setData({
      security: [
        // 「个人资料」原先 url 为空、ready=false，点下去只提示「开发中」——
        // 是典型的「入口有、落地页没有」的半截功能，现补齐（10）
        { key: 'profile', url: '/pages/profile/profile', ready: true },
        { key: 'academic', url: '/pages/match/match', tab: true, ready: true },
        { key: 'binding', url: '', ready: false },
      ],
      preference: [
        /**
         * 「消息通知」此前是 `url:'' + ready:false` —— 点了只弹一句「开发中」，
         * 是典型的「入口有、落地页没有」。现在接上真实页面。
         * 行右侧的状态标签由 refresh() 按 `/v1/notify` 的真实返回重算，
         * **不在 onLoad 里预设一个值** —— 预设就是替服务端编一个答案。
         */
        { key: 'notify', url: '/pages/notify/notify', ready: true, value: '' },
        { key: 'locale', url: '', ready: false },
        // 「帮助与反馈」的目标页已实现（09 意见反馈），此前是入口有、落地页没有的半截功能
        { key: 'help', url: '/pages/feedback/feedback', ready: true },
      ],
    });

    api.loadContent().then((c) => {
      this.setData({ c });
      this.contentReady = true;
      this.refresh();
    });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    // ⚠️ 闸门不能再写成「this.data.c 非空」：页面 data 的 c 现在首帧就有本地内容
    //    （各页 data.c 初始化为 api.content()），拿它判断会让首次 onLoad→onShow
    //    立刻重复请求一次。改用「onLoad 的内容加载是否已完成」来区分
    //    「首次进入」与「从其他页返回」，语义与改动前一致。
    if (this.contentReady) this.refresh();
  },

  refresh() {
    /**
     * ⚠️ 第三个是订阅状态。`api.getNotify()` **不会 reject**（拿不到时返回
     *    `{unavailable:true}` 哨兵，见 api.js 的「订阅消息」一节），
     *    所以放进 Promise.all 不会把整页拖垮。
     */
    Promise.all([api.getProfile(), api.getStats(), api.getNotify()]).then(
      ([user, stats, notify]) => {
      const c = this.data.c;
      const signedIn = api.isSignedIn();
      const nick = (user && user.nickName) || '';

      this.setData({
        user: user || null,
        signedIn,
        stats: stats || { matched: 0, favorites: 0, documents: 0 },
        /**
         * ⚠️ 第一层闸门是 **signedIn**，不是「有没有值」。
         *    昵称/头像/徽标都属于「账号身份」，未登录就必须整块回到未登录态 ——
         *    否则会出现「卡片上顶着你的名字，下面却没有退出登录按钮」这种
         *    自相矛盾的画面（2026-09-20 用户报的就是这个）。
         *    数据层已经保证未登录时读不到资料（api 的 user.profile 返回 null），
         *    这里是第二道闸门：**任何一层单独失守，都不能让身份漏到屏幕上**。
         */
        profileName: signedIn
          ? nick || c.account.profileNoNickname
          : c.account.profileNotSignedIn,
        profileSub: signedIn
          ? (user && user.email) || c.account.profileNoEmail
          : c.signin.sub,
        /**
         * 版本徽标（设计稿里名字右侧的「备考版」）由服务端 `user.plan` 下发。
         * 没有就整块不渲染 —— 绝不用内置默认值顶上，那就是编造。
         * 同样只在已登录时展示（它描述的是账号，不是本机）。
         */
        plan: (signedIn && user && user.plan) || '',
        preference: this.buildPreference(notify),
      });
      }
    );
  },

  /**
   * 重建「偏好与其他」列表（只有「消息通知」行带状态标签）。
   * ------------------------------------------------------------------
   * ⚠️ 状态标签是**真实状态**，由 `/v1/notify` 的返回经 api 层的唯一口径
   *    （`api.notifyStatus`）推导。读不到就**不显示标签**，绝不猜一个：
   *    猜「已开启」会让用户以为后台发得出通知，猜「未开启」会让他白点一次。
   *    五种状态的完整解释在详情页，不在这一行里展开。
   */
  buildPreference(notify) {
    const cfg = (this.data.c && this.data.c.notify) || {};
    const status = api.notifyStatus(notify, cfg);
    return [
      {
        key: 'notify',
        url: '/pages/notify/notify',
        ready: true,
        value: (cfg.rowLabel && cfg.rowLabel[status]) || '',
      },
      { key: 'locale', url: '', ready: false },
      { key: 'help', url: '/pages/feedback/feedback', ready: true },
    ];
  },

  /**
   * 点击资料卡 → 个人资料页（10）
   * ------------------------------------------------------------------
   * 为什么两处入口（资料卡 / 账号与安全 → 个人资料）收敛到同一个页面：
   * 同一个卡片在「已登录去编辑、未登录去登录」两种行为之间分叉，
   * 用户猜不出点下去会发生什么。现在统一进个人资料页，
   * 而那一页在未登录时自带醒目的「微信一键登录」入口 ——
   * 登录路径没有丢，只是少了一层语义分叉。
   */
  onProfileCard() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  /**
   * 三项统计的点击。
   * ------------------------------------------------------------------
   * ⚠️ 跳转目标取自内容层 `account.stats[].link`，页面里**不写死路由** ——
   *    入口要改（比如收藏页换路径）时不必重新发版。
   *    这里曾经硬编码 `switchTab('/pages/schools/schools')`：点「我的收藏」
   *    会被扔进一百行的院校库首页，用户根本找不到自己收藏的那几所。
   *    没有 `link` 的统计项点了**什么都不做** —— 不假装有反应，
   *    也不猜一个「大概是那里」的落点（与「未上线入口如实提示」同一条约束）。
   */
  onStat(e) {
    const key = e.currentTarget.dataset.key;
    const item = (this.data.c.account.stats || []).filter((s) => s.key === key)[0];
    if (!item || !item.link) return;
    if (item.tab) wx.switchTab({ url: item.link });
    else wx.navigateTo({ url: item.link });
  },

  onRow(e) {
    const { url, tab, ready } = e.currentTarget.dataset;
    if (!ready || !url) {
      // 未上线的入口如实告知，不做假跳转
      wx.showToast({ title: this.data.c.common.comingSoon, icon: 'none' });
      return;
    }
    if (tab) wx.switchTab({ url });
    else wx.navigateTo({ url });
  },

  onLogout() {
    wx.showModal({
      title: this.data.c.account.logout,
      content: this.data.c.account.logoutConfirm,
      confirmText: this.data.c.account.logout,
      cancelText: this.data.c.common.cancel,
      success: (r) => {
        if (!r.confirm) return;
        api.logout().then(() => this.refresh());
      },
    });
  },
}, { pageId: 'account' }));
