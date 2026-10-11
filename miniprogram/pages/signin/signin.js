/**
 * 登录页（00b）
 * ==================================================================
 * ⚠️ 合规红线（不可协商）
 *   依据《小程序内用户帐号登录规范》，本页**不得**在启动时自动打开。
 *   必须先让用户清楚知悉小程序功能，由用户主动点击才可要求登录，
 *   且必须提供「暂不登录，先浏览」出口 —— 点击后要有真实响应。
 *   因此启动路径是「条款页 → 首页」，不经过本页。
 *
 * ⚠️ 真机问题修正（用户反馈「没有唤醒，直接跳到某个账号」）
 *   旧版本地模式的 auth.login 返回了一个**写死的用户对象**（含姓名邮箱），
 *   真机上就显示出那个跟用户毫无关系的账号 —— 属于编造用户身份，已删除。
 *   现在本地模式只返回空档案，头像昵称必须由用户自己填写。
 *
 * 真实登录流程（两步，与微信现行能力一致）：
 *   ① wx.login 拿 code → 换自定义登录态
 *      后端未接入时跳过换取，标记为「本地模式」
 *   ② 完善资料：微信自 2022 年起回收了 getUserProfile，
 *      头像昵称只能通过 chooseAvatar / nickname 输入由用户主动提供
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),
    /** 步骤：'intro' 未登录 ｜ 'profile' 完善资料 */
    step: 'intro',

    /** 登录态相关 */
    loading: false,
    /** 是否已连接后端（决定提示语与后续能力） */
    remote: false,

    /** 资料表单 */
    avatarUrl: '',
    /**
     * 头像是否已落地成「可以写进账号」的地址。
     * ⚠️ 远端模式下这个标记必须是 true 才允许把 avatarUrl 提交上去 ——
     *    否则会把本机临时路径存进账号（换设备即裂图）。
     *    本地模式没有这个问题：本机档案本来就只在本机有效。
     */
    avatarPermanent: false,
    nickname: '',
    saving: false,

    /** 手机号登录是否可用（默认关闭，见 featureFlags） */
    showPhone: false,
  },

  onLoad() {
    api.loadContent().then((c) => {
      this.setData({
        c,
        showPhone: api.flag('phoneLogin'),
        remote: api.mode() === 'remote',
      });
    });
  },

  /* ================================================================
     第一步：唤起微信登录
     ================================================================ */
  onWechatLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    // wx.login 是**静默**的，不会弹授权框 —— 这是微信的设计，
    // 只有手机号 / 头像昵称这类敏感信息才需要用户显式授权。
    api
      .login()
      .then((res) => {
        this.setData({
          loading: false,
          step: 'profile',
          remote: !!(res && res.mode === 'remote'),
          // 已有资料的直接带出来，避免重复填写
          avatarUrl: (res && res.user && res.user.avatarUrl) || '',
          nickname: (res && res.user && res.user.nickName) || '',
        });
      })
      .catch(() => {
        this.setData({ loading: false });
        wx.showToast({ title: this.data.c.signin.loginFailed, icon: 'none' });
      });
  },

  /* ================================================================
     第二步：完善资料
     ================================================================ */

  /**
   * 选择头像
   * ------------------------------------------------------------------
   * `open-type="chooseAvatar"` 就是微信的**原生能力**：点它会唤起官方面板，
   * 里面同时提供「从微信头像选择」与「从相册选择 / 拍照」，
   * 用户既能直接用微信头像，也能自己上传 —— 一个入口覆盖两种需求。
   *
   * ⚠️ 落地逻辑收敛在 `api.saveAvatar`（个人资料页用同一份），原因有二：
   *    1) 回调给的是**临时路径**，重启即失效，必须先落地；
   *    2) 远古写法是「本地 saveFile 转持久」，在**远端模式下会把
   *       `wxfile://...` 这种只有本机认得的路径 PUT 进账号** ——
   *       换设备就是一张裂图，而且云端存了一个永远解析不了的地址。
   *       现在远端走上传拿永久 URL，本地才转存。两种模式语义不同，不能共用一个分支。
   */
  onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) return;

    // 先乐观更新，避免等转存/上传造成点击无反馈
    this.setData({ avatarUrl: tempPath });

    api
      .saveAvatar(tempPath)
      .then((r) => {
        if (r && r.url) this.setData({ avatarUrl: r.url });
        this.setData({ avatarPermanent: !!(r && r.mode === 'remote' && r.url) });
        // 连转存都失败：如实告知「仅本次有效」，不假装存住了
        if (r && r.volatile) {
          wx.showToast({ title: this.data.c.profile.avatarVolatile, icon: 'none' });
        }
      })
      .catch(() => {
        // 上传失败：保留乐观更新的临时路径，本次会话仍可用
        this.setData({ avatarPermanent: false });
        wx.showToast({ title: this.data.c.profile.avatarVolatile, icon: 'none' });
      });
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  onSaveProfile() {
    const nickname = String(this.data.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: this.data.c.signin.nicknameRequired, icon: 'none' });
      return;
    }
    this.setData({ saving: true });

    const patch = { nickName: nickname };
    // 只有「已落地到远端」的头像才写进账号；本机临时路径不上传
    // （失败时已经提示过「仅本次有效」，这里不重复打扰，但也绝不把它当有效头像存下去）
    if (api.mode() !== 'remote' || this.data.avatarPermanent) {
      patch.avatarUrl = this.data.avatarUrl || '';
    }

    api
      .updateProfile(patch)
      .then((res) => {
        this.setData({ saving: false });
        /**
         * ⚠️ 文案判据是**这次写到了哪里**（返回值的 `isLocal`），不是运行模式：
         *    云开发路线上若 PUT /v1/user/profile 还没实现，`call()` 会静默回落到
         *    本地实现 —— 那时资料只在本机，显示「已保存」就成了「已同步」的暗示。
         *    与个人资料页、与反馈链路的 delivered 是同一条纪律。
         */
        const onlyLocal = !!(res && res.isLocal);
        wx.showToast({
          title: onlyLocal ? this.data.c.signin.savedLocal : this.data.c.signin.saved,
          icon: 'success',
          duration: 800,
        });
        setTimeout(() => this.back(), 800);
      })
      .catch(() => {
        this.setData({ saving: false });
        wx.showToast({ title: this.data.c.common.networkError, icon: 'none' });
      });
  },

  /* ================================================================
     手机号快捷登录（二期，默认关闭）
     ================================================================ */
  onPhoneLogin(e) {
    if (!e.detail || !e.detail.code) {
      wx.showToast({ title: '已取消授权', icon: 'none' });
      return;
    }
    wx.showToast({ title: '手机号登录即将开放', icon: 'none' });
  },

  /* ================================================================
     出口：取消 / 暂不登录 —— 必须有真实响应，否则同样违规
     ================================================================ */
  onCancel() {
    this.back();
  },

  back() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) });
    } else {
      wx.switchTab({ url: '/pages/home/home' });
    }
  },
}, { pageId: 'signin' }));
