/**
 * 个人资料（10）
 * ==================================================================
 * 入口两处，都在账号管理页（08）：顶部资料卡 与「账号与安全 → 个人资料」。
 * 可编辑字段与契约 4.2 `PUT /v1/user/profile` 一一对应：
 * 头像 / 昵称 / 邮箱 / 年级 / 城市。
 *
 * ⚠️ 四条不可回退的约定（改之前先读，每条都有踩过的坑）：
 *
 *  1. **不打登录墙**。未登录也进得来、看得到、填得动。
 *     - 本地模式（无后端）：填写**真的**存到本机，提示「已保存到本机」；
 *     - 远端模式：未登录保存必然 401，所以**前置拦下**并提示去登录。
 *     两条分支的文案必须分开 —— 本机保存不能显示成「已同步」。
 *
 *  2. **空值不预填**。昵称/邮箱/城市为空就是空，年级显示「未选择」。
 *     本项目曾把设计稿里的演示值（示例昵称 / GPA 86 / 雅思 5.0）当成默认值内置，
 *     真机上显示出与用户无关的姓名 —— 那是编造用户身份，红线。
 *
 *  3. **只提交改动过的字段**（diff patch）。契约 4.2 的原文是
 *     「请求体为部分字段，只提交需要修改的项」；整份 PUT 会把服务端其他字段
 *     一起冲掉，也会让「什么都没改」看起来像一次修改。
 *
 *  4. **头像只有真的落地成永久地址才允许写进账号**。
 *     `bindchooseavatar` 给的是临时路径（重启即失效），本地要 `saveFile` 转存、
 *     远端要上传。远端模式下若上传失败仍把它 PUT 上去，
 *     账号里就存了一个只有本机认得的地址 —— 换设备即裂图。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

/**
 * 编辑态字段 → 契约字段名的映射。
 * 昵称在本地叫 nickname（与 wxml 的字段名对齐），提交时必须写成 `nickName`。
 */
const FIELD_MAP = { nickname: 'nickName', email: 'email', grade: 'grade', city: 'city' };

/**
 * 邮箱格式校验（选填，但填了就得像样）。
 * 刻意宽松：`a@b.co` 这类就要能过。真正的可用性由后端的下发/回执判断，
 * 前端卡太死只会把合法邮箱判成非法。
 * （对照：反馈页原先也出于同样理由完全不校验联系方式，但那张卡因平台审核
 *   要求已在 v1.0.3 整卡移除 —— 这里的邮箱是**账号资料**，与本页账号体系绑，
 *   不属于「非合理场景收集」，不要因为反馈页的改动顺手把邮箱一起删掉。）
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Page(share.withShare({
  data: {
    c: api.content(),
    /** 是否已连接后端（决定提示语与「保存到哪里」） */
    remote: false,
    signedIn: false,

    /**
     * 编辑态。**单一真源**：所有输入都先落到这里，保存时与 original 比对出 patch。
     * avatarUrl 也放在同一份里，这样「只提交改动过的字段」只需要一套 diff 逻辑。
     */
    form: { nickname: '', email: '', grade: '', city: '', avatarUrl: '' },
    /** 读取时的快照，用于算 diff 与显示「没有改动」 */
    original: { nickname: '', email: '', grade: '', city: '', avatarUrl: '' },

    /** 头像是否已落地成「可以写进账号」的地址（本地模式不区分） */
    avatarPermanent: false,
    avatarUploading: false,

    /** 年级选择器。grades 来自内容层 enums.grades，页面不写死 */
    grades: [],
    gradeIndex: 0,

    /** 只读账号信息（仅在**远端模式**下生成，见 buildMeta） */
    meta: [],
    hasMeta: false,

    dirty: false,
    saving: false,
  },

  onLoad() {
    // 首帧就用本地内容渲染（各页 data.c 一律初始化为 api.content()）
    this.setData({ grades: this.gradesOf(api.content()) });

    api.loadContent().then((c) => {
      this.setData({
        c,
        grades: this.gradesOf(c),
        remote: api.mode() === 'remote',
      });
      this.contentReady = true;
      this.refresh();
    });
  },

  onShow() {
    // ⚠️ 闸门不能用「this.data.c 非空」判断：data.c 首帧就有本地内容，
    //    拿它判会让首次 onLoad→onShow 立刻重复请求一次。
    //    另外**有未保存改动时不要重读**，否则从登录页返回会把用户刚填的内容冲掉。
    if (this.contentReady && !this.data.dirty) this.refresh();
  },

  gradesOf(c) {
    return ((c || {}).enums || {}).grades || [];
  },

  /* ================================================================
     读取
     ================================================================ */
  refresh() {
    return api.getProfile().then((user) => {
      /**
       * ⚠️ 已有未保存改动时不重读。
       *    远端模式下这次读取是一次真实网络往返（几百毫秒），用户完全可能
       *    在返回值到达前就开始打字 —— 直接覆盖会把他刚敲的字吃掉。
       *    宁可不刷新，也不能替用户改回他认为已经填好的内容。
       */
      if (this.data.dirty) return;

      const u = user || {};
      const form = {
        nickname: u.nickName || '',
        email: u.email || '',
        grade: u.grade || '',
        city: u.city || '',
        avatarUrl: u.avatarUrl || '',
      };

      const meta = this.buildMeta(u);
      this.setData({
        signedIn: api.isSignedIn(),
        form,
        original: Object.assign({}, form),
        // 已存在的头像默认视为可用：本地模式写回本机路径没问题，
        // 远端模式它本来就是服务端下发的地址
        avatarPermanent: !!form.avatarUrl,
        gradeIndex: Math.max(0, this.data.grades.indexOf(form.grade)),
        meta,
        hasMeta: meta.length > 0,
        dirty: false,
      });
    });
  },

  /**
   * 只读账号信息（账号 ID / 注册时间）。
   * ⚠️ **只在远端模式下生成**：本地模式的本机档案 id 是 `local-<时间戳>`，
   *    它既不是账号也不是标识，摆出来会让用户误以为「我有账号了」。
   *    宁可这一节整块不出现，也不给一个看起来像账号的假编号。
   */
  buildMeta(u) {
    if (api.mode() !== 'remote') return [];
    const labels = ((this.data.c || {}).profile || {}).meta || {};
    const rows = [];
    if (u && u.id) rows.push({ key: 'id', label: labels.id, value: u.id });
    if (u && u.createdAt) {
      rows.push({ key: 'createdAt', label: labels.createdAt, value: api.formatDateTime(u.createdAt) });
    }
    return rows;
  },

  /* ================================================================
     编辑
     ================================================================ */
  onNicknameInput(e) {
    this.setField('nickname', e.detail.value);
  },
  onEmailInput(e) {
    this.setField('email', e.detail.value);
  },
  onCityInput(e) {
    this.setField('city', e.detail.value);
  },

  setField(key, value) {
    const patch = {};
    patch['form.' + key] = value;
    this.setData(patch);
    this.recomputeDirty();
  },

  onGradeChange(e) {
    const idx = Number(e.detail.value);
    const grades = this.data.grades || [];
    // 越界时回落空串（而不是编一个年级出来）
    const value = grades[idx] || '';
    this.setData({ gradeIndex: idx, 'form.grade': value });
    this.recomputeDirty();
  },

  /**
   * 选择头像
   * ------------------------------------------------------------------
   * `open-type="chooseAvatar"` 是微信的**原生能力**：唤起官方面板，
   * 里面同时提供「从微信头像选择」与「从相册选择 / 拍照」。
   * 微信 2022 年已回收 getUserProfile，这是**唯一**合法的头像获取途径。
   *
   * 落地交给 `api.saveAvatar`（登录页用同一份实现）：本地转存 / 远端上传。
   */
  onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) return;

    // 乐观更新：先让用户看到自己选的头像，不必等转存/上传
    this.setData({ 'form.avatarUrl': tempPath, avatarUploading: true });
    this.recomputeDirty();

    api
      .saveAvatar(tempPath)
      .then((r) => {
        const url = (r && r.url) || tempPath;
        this.setData({
          'form.avatarUrl': url,
          // 只有远端上传成功才算「可写进账号」
          avatarPermanent: !!(r && r.mode === 'remote' && r.url),
          avatarUploading: false,
        });
        this.recomputeDirty();
        // 转存也失败：如实告知「仅本次有效」，不假装存住了
        if (r && r.volatile) this.toast(this.data.c.profile.avatarVolatile);
      })
      .catch(() => {
        // 上传失败：保留临时路径供本次会话使用，但**不标记为可写进账号**
        this.setData({ avatarPermanent: false, avatarUploading: false });
        this.toast(this.data.c.profile.avatarFailed);
      });
  },

  /** 编辑态与快照是否有差异（含头像） */
  recomputeDirty() {
    this.setData({ dirty: Object.keys(this.buildPatch()).length > 0 });
  },

  /**
   * 生成 diff patch —— 只包含**真的改了**的字段，且字段名符合契约 4.2。
   * 这个方法同时是「是否有改动」的判据，因此不许把它写成返回全部字段。
   */
  buildPatch() {
    const f = this.data.form;
    const o = this.data.original;
    const patch = {};

    for (const k of Object.keys(FIELD_MAP)) {
      if (f[k] !== o[k]) patch[FIELD_MAP[k]] = f[k];
    }

    // 头像：远端模式下，上传失败（仍是本机临时路径）时**不提交** ——
    // 宁可这次不改头像，也不往账号里写一个别人解析不了的地址。
    if (f.avatarUrl !== o.avatarUrl && (api.mode() !== 'remote' || this.data.avatarPermanent)) {
      patch.avatarUrl = f.avatarUrl;
    }

    return patch;
  },

  /* ================================================================
     保存
     ================================================================ */
  onSave() {
    if (this.data.saving) return;
    const c = this.data.c;
    const cfg = c.profile;

    // ---- 校验：全部提示文案来自内容层 ----
    const nickname = String(this.data.form.nickname || '').trim();
    if (!nickname) return this.toast(cfg.needNickname);
    if (nickname.length > cfg.nicknameMax) {
      return this.toast(api.tpl(cfg.nicknameTooLong, { max: cfg.nicknameMax }));
    }

    const email = String(this.data.form.email || '').trim();
    if (email) {
      if (email.length > cfg.emailMax) {
        return this.toast(api.tpl(cfg.emailTooLong, { max: cfg.emailMax }));
      }
      if (!EMAIL_RE.test(email)) return this.toast(cfg.invalidEmail);
    }

    const city = String(this.data.form.city || '').trim();
    if (city.length > cfg.cityMax) {
      return this.toast(api.tpl(cfg.cityTooLong, { max: cfg.cityMax }));
    }

    /**
     * 未登录一律拦下，**不分运行模式**。
     * ------------------------------------------------------------------
     * 两种模式的语义在这件事上是一致的（也是必须一致的）：
     *   · 远端：服务端 PUT /v1/user/profile 未登录返回 401；
     *   · 本地：api 的本地适配器同样 reject(401) —— 因为读取路径在未登录时
     *     返回 null（与契约「未登录返回 data:null」对齐），
     *     此时若还允许写入，就成了「写进去了但读不出来」：用户以为保存成功，
     *     回到页面却是一片空白。
     * 前置拦下比让用户吃一个 401 友好，也给得出可执行的下一步（登录）。
     */
    if (!api.isSignedIn()) return this.toast(cfg.needLogin);

    // 先落归一化后的值（trim），再算 diff：
    // 否则「只在首尾多打了个空格」会被判成有改动，提交一次等于什么都没改。
    this.setData({
      'form.nickname': nickname,
      'form.email': email,
      'form.city': city,
    });

    const patch = this.buildPatch();
    if (!Object.keys(patch).length) return this.toast(cfg.noChange);

    this.setData({ saving: true });
    api
      .updateProfile(patch)
      .then((res) => {
        this.setData({
          saving: false,
          original: Object.assign({}, this.data.form),
          dirty: false,
        });
        /**
         * ⚠️ 文案判据是**这次到底写到了哪里**（`isLocal`），不是运行模式。
         *    云开发模式下 `call()` 会把未实现的端点静默回落到本地实现 ——
         *    此时若按「mode === remote」显示「已保存」，就是在说资料上了云，
         *    而它其实只写进了这台手机。这与反馈链路里 `delivered` 是同一条纪律。
         */
        const onlyLocal = !!(res && res.isLocal);
        wx.showToast({
          title: onlyLocal ? cfg.savedLocal : cfg.saved,
          icon: 'success',
          duration: 900,
        });
      })
      .catch(() => {
        this.setData({ saving: false });
        // 失败不跳走、不清空：用户填的内容还在原地，可直接重试
        wx.showToast({ title: c.common.networkError, icon: 'none' });
      });
  },

  /* ================================================================
     未登录时的登录入口
     ================================================================ */
  /** 由用户主动点击触发，符合微信「不得一进来就要求登录」的规范 */
  onSignIn() {
    wx.navigateTo({ url: '/pages/signin/signin' });
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },
}, { pageId: 'profile' }));
