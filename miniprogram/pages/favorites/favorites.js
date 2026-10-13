/**
 * 我的收藏（11）
 * ==================================================================
 * 只列已收藏院校。与院校库（06）的分工：
 *   院校库 = **发现**（99 所 + 搜索 + 地区筛选 + 排序）
 *   本页   = **清单**（只有自己挑出来的那几所）
 * 挤在一个页面里的话，用户每次点「我的收藏」都得先在一百行里把自己的学校找出来 ——
 * 那正是「点我的收藏却跳进院校库」被报为缺陷的原因。
 *
 * 几个刻意的决定：
 *   · 顺序 = **最近收藏在前**。存储层 `toggleFavorite` 用 `unshift` 新增，
 *     `sp_favorites` 数组本身就是这个顺序，页面**不再二次排序** ——
 *     刚收藏的学校出现在第一条，是「我的清单」最合理的默认顺序；
 *     若改成「按 QS」，用户就找不到刚收的那所了。
 *   · 收藏 id 在院校库里找不到时**跳过**，且计数按**真实渲染的行数**算。
 *     直接拿 `favorites.length` 当数字，一旦出现过期 id（院校库调整过 id），
 *     页面就会说「共 3 所」却只画 2 行 —— 界面上凭空多出一所并不存在的学校。
 *   · 取消收藏后**不重排**：这里没有「置顶」概念，重排只会让刚点掉的那一行
 *     从手指底下溜走。只刷新计数与空态。
 *   · 行复用 `components/school-row`，与院校库同一份标记与样式。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),
    list: [],
    /** 统计文案（内容层给的是模板，必须 api.tpl() 插值后再绑） */
    totalLabel: '',
    loading: true,
    /** 列表骨架行数（与 school-row 同几何的 .sk-row，见 app.wxss） */
    skelRows: [0, 1, 2],
  },

  /**
   * 分享文案
   * 收藏数量按**渲染行数**算（list.length），不是 sp_favorites 长度 —— 与页面顶部
   * 「共 N 所」的 N 同源，避免标题里说「5 所」实际只画 3 行。
   * 收藏为 0 时仍分享 default，不冒充「我收藏了 0 所」。
   */
  buildShare() {
    const c = this.data.c;
    if (!c || !c.share) return null;
    const defaults = c.share.default || { title: '升学规划', sub: '' };
    const r = c.share.favorites || {};
    const n = (this.data.list || []).length;
    if (!n) return { title: defaults.title, sub: '' };
    return {
      title: api.tpl(r.titleTpl || defaults.title, { n }),
      sub: '',
    };
  },

  onLoad() {
    api.loadContent().then((c) => {
      this.setData({ c });
      this.contentReady = true;
      this.refresh();
    });
  },

  onShow() {
    /**
     * 从院校详情页返回时收藏可能已经变了（详情页也能收藏/取消），
     * 必须重读。首次进入交给 onLoad 的 refresh，避免重复请求 ——
     * 判据用「内容是否加载完」而不是「data.c 是否为空」：
     * 页面 data 的 c 初始化就是本地内容，永远非空。
     */
    if (this.contentReady) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  refresh() {
    return Promise.all([api.getFavorites(), api.listSchools({})]).then(([ids, res]) => {
      const byId = {};
      res.list.forEach((s) => {
        byId[s.id] = s;
      });

      /**
       * ⚠️ 按 `ids` 的顺序取，取不到的**跳过**（见文件头）。
       *    这里刻意不用 `res.list.filter(s => ids.indexOf(s.id) > -1)` ——
       *    那样顺序会变成院校库的顺序（按 QS），而不是「最近收藏在前」。
       */
      const list = ids
        .map((id) => byId[id])
        .filter((s) => !!s)
        .map((s) => this.toRow(s));

      this.setData({
        list,
        // 计数用 list.length（真实渲染行数），不是 ids.length
        totalLabel: api.tpl(this.data.c.favorites.totalTemplate, { count: list.length }),
        loading: false,
      });
    });
  },

  /** 接口数据 → 行组件需要的扁平结构（与院校库同一套，见 school-row 头部说明） */
  toRow(s) {
    return {
      id: s.id,
      nameCn: s.nameCn,
      nameEn: s.nameEn,
      qsLabel: s.qsLabel,
      crestColor: s.crest && s.crest.color,
      crestShape: s.crest && s.crest.shape,
      // 本页列出的必然都是已收藏的；星标在这里的语义是「取消收藏」的出口
      favorite: true,
      meta: api.tpl(this.data.c.schools.metaTemplate, {
        country: s.countryCn,
        city: s.cityCn,
        type: s.type,
      }),
    };
  },

  onOpenSchool(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.detail.id });
  },

  /**
   * 取消收藏。
   * ⚠️ 成功后整份重读（refresh），不手工从 list 里 splice ——
   *    手工改就要同时维护「行数组、计数文案、空态」三处，漏一处就会
   *    出现「行没了但还写着共 3 所」这类不一致。
   */
  onRemove(e) {
    const id = e.detail.id;
    // 返回 promise：验证台要 await 它才能断言「行真的消失了」，不返回就只能靠 sleep 猜
    return api.toggleFavorite(id).then((r) => {
      const tip = this.data.c.schools.favoriteTip;
      // isLocal = 只写到了本机（未登录 / 云端写失败），登录后会自动补传 ——
      // 用对应的文案如实说明，不冒充「已同步」（同个人资料的 savedLocal 口径）
      const key = r.favorite ? (r.isLocal ? 'localOn' : 'on') : (r.isLocal ? 'localOff' : 'off');
      wx.showToast({ title: tip[key], icon: 'none' });
      return this.refresh();
    });
  },

  /** 空态出口：去院校库挑学校 */
  onGoSchools() {
    wx.switchTab({ url: '/pages/schools/schools' });
  },
}, { pageId: 'favorites' }));
