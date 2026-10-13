/**
 * 首页（01）
 * ==================================================================
 * 职责：品牌 Hero + 功能入口宫格 + 推荐院校。
 *
 * 几个刻意的设计决定：
 *   · 倒计时目标日、Hero 文案、功能入口、推荐条数全部来自内容层 content.home，
 *     后端可下发覆盖 —— 换季（如「2028 申请季」）不需要发版。
 *   · 推荐院校优先取最近一次匹配结果，**没有匹配结果时回落到按 QS 排序**，
 *     这样新用户一进来也有内容可看，而不是一片空白。
 *   · 已收藏的院校排在推荐位前面 —— 用户收藏过说明关心，应该优先看到。
 *   · ready=false 的功能入口点击后如实提示「开发中」，不做假跳转。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),               // 内容配置（文案 / 列表 / 开关）
    season: api.content().home.season,
    /** Hero chip 的成品文案（内容层模板经 {season} 插值后的结果） */
    chipText: api.tpl(api.content().home.hero.chip, { season: api.content().home.season }),
    features: (api.content().home.features || []).filter((f) => f.ready || true),
    recommend: [],
    mode: 'local',
    loading: true,
    /**
     * 推荐区骨架行数与推荐条数一致：骨架消失、真实行原位填入时布局零跳变。
     * 数量取内置内容层的 recommendCount（同步可读），远端补丁若改条数，
     * 下一次加载会按新条数重算。
     */
    skelRows: Array.from({ length: api.content().home.recommendCount || 3 }, (_, i) => i),
  },

  onLoad() {
    /**
     * 首帧即渲染（与 match.js 同一纪律）：内容层是打包内置数据，
     * api.content() 同步可得 —— Hero / 宫格 / chip 先按本地内容画出来，
     * 远端补丁到达后只换文案，不再「整块突入」。
     * 推荐列表是真实用户数据，用骨架屏占位（wxml 的 skelRows），到点原位填充。
     *
     * 曾经这里等 loadContent()  resolve 才渲染 anything：弱网下首屏空等
     * 一个网络往返，然后所有区块同时突入 —— 正是「割裂感」的来源。
     */
    this.c = api.content();
    this.setData({ mode: api.mode() });
    // 远端内容补丁与推荐数据**并行**拉取（曾经串行：等完补丁才发推荐请求）
    api.loadContent().then((c) => {
      this.c = c;
      this.setData({
        c,
        season: c.home.season,
        features: (c.home.features || []).filter((f) => f.ready || true),
      });
      this.initSeasonChip();
    });
    this.refreshRecommend();
  },

  onShow() {
    // 自定义标签栏需要页面主动同步选中项，否则切页后高亮不跟随
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    // 从其他页返回时刷新推荐：用户可能刚收藏了院校、或刚跑完匹配
    if (!this.data.loading && this.c) this.refreshRecommend();
  },

  onPullDownRefresh() {
    this.refreshRecommend().then(() => wx.stopPullDownRefresh());
  },

  /**
   * Hero chip：只显示申请季。
   * ------------------------------------------------------------------
   * ⚠️ 这里曾经算过一个「距 2027-01-15 还有 N 天」的全局倒计时，已**刻意移除**：
   *    每所大学、每个国家/地区的申请截止时间都不同（还有滚动录取与多轮次），
   *    一个全局倒数日是**假精度**，会让用户误以为所有学校同一天截止。
   *    真要做倒计时，得挂在具体院校的具体轮次上（院校详情页），不是这一层。
   *
   * chip 是**内容层模板**（'{season}'），必须在这里插值后再绑：
   * 直接绑 `{{c.home.hero.chip}}` 会把占位符原样显示成「{season}」——
   * 曾经真机上就是这个样子。用 api.tpl 而不是前端拼串，
   * 是为了让后端仍能通过 /v1/content 调整语态或加后缀。
   */
  initSeasonChip() {
    this.setData({
      chipText: api.tpl(this.c.home.hero.chip, { season: this.c.home.season }),
    });
  },

  /** 推荐院校：优先用最近一次匹配结果，否则按 QS 排名；已收藏者优先展示 */
  refreshRecommend() {
    // 四个数据源并行取，避免串行等待
    return Promise.all([
      api.getLatestMatch(),
      api.listSchools({ region: 'all' }),
      api.getFavorites(),
    ]).then(([res, schools, favs]) => {
      /**
       * ⚠️ 这里曾经取「用户档案里的目标专业」拼成推荐行副标题的中间一段
       *    （`国家 · 专业 · QS`），2026-09-24 移除。理由见 home.wxml 的注释：
       *    那是**院校属性位**，放用户自己的专业会被读成「这所学校的专业」，
       *    而该字段既不是院校数据、也从未参与推荐筛选。
       *    顺带把 `api.getAcademic()` 从并行请求里去掉了 —— 它之前只服务于
       *    这一段标签，白白多打一次网络（`getAcademic` 是纯读，无副作用）。
       *    要在那里显示真正的院校专业，先把院校库 `strengths` 补齐
       *    （当前 63/99，澳 0/11、英 0/6）。
       */

      let pool;
      if (res && res.list && res.list.length) {
        // 有匹配结果就用结果里的（已带 match / tier）
        pool = res.list.filter((s) => s.match !== null);
        if (!pool.length) pool = res.list;
      } else {
        // 新用户还没匹配过：回落到目标国家按 QS 排序，保证首屏不空白
        pool = schools.list
          .filter((s) => s.region === 'ca' || s.region === 'au')
          .sort((a, b) => a.qs - b.qs);
      }

      // 打上收藏标记；已收藏的排前面（用户收藏过说明关心）
      const withFav = pool.map((s) =>
        Object.assign({}, s, { favorite: favs.indexOf(s.id) > -1 })
      );
      this.pool = withFav
        .filter((s) => s.favorite)
        .concat(withFav.filter((s) => !s.favorite));

      this.setData({ cursor: 0, loading: false });
      this.sliceRecommend();
    });
  },

  /** 从候选池里切出当前这一批推荐（「换一批」靠移动游标实现，不重新请求） */
  sliceRecommend() {
    const pool = this.pool || [];
    const n = (this.c && this.c.home.recommendCount) || 3;
    const out = [];
    // 取模保证游标越界后回到开头，形成循环
    const start = (this.data.cursor || 0) % Math.max(pool.length, 1);
    for (let i = 0; i < n && i < pool.length; i++) {
      out.push(pool[(start + i) % pool.length]);
    }
    this.setData({ recommend: out });
  },

  onNextBatch() {
    const pool = this.pool || [];
    if (!pool.length) return;
    const n = this.c.home.recommendCount || 3;
    this.setData({ cursor: (this.data.cursor + n) % pool.length });
    this.sliceRecommend();
    wx.vibrateShort({ type: 'light', fail: () => {} });
  },

  onFeature(e) {
    const item = this.data.features[e.currentTarget.dataset.index];
    if (!item) return;

    if (!item.ready || !item.url) {
      wx.showToast({
        title: api.tpl(this.c.home.comingSoon, { name: item.label }),
        icon: 'none',
      });
      return;
    }
    if (item.tab) wx.switchTab({ url: item.url });
    else wx.navigateTo({ url: item.url });
  },

  onAllFunctions() {
    wx.navigateTo({ url: '/pages/functions/functions' });
  },

  onStartMatch() {
    wx.switchTab({ url: '/pages/match/match' });
  },

  onSearch() {
    wx.switchTab({ url: '/pages/schools/schools' });
  },

  onOpenSchool(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  onToggleFavorite(e) {
    const id = e.currentTarget.dataset.id;
    api.toggleFavorite(id).then((r) => {
      const tip = this.c.schools.favoriteTip;
      this.setData({
        recommend: this.data.recommend.map((s) =>
          s.id === id ? Object.assign({}, s, { favorite: r.favorite }) : s
        ),
      });
      // isLocal = 只写到了本机（未登录 / 云端写失败），如实说明，不冒充「已同步」
      const key = r.favorite ? (r.isLocal ? 'localOn' : 'on') : (r.isLocal ? 'localOff' : 'off');
      wx.showToast({ title: tip[key], icon: 'none' });
    });
  },
}, { pageId: 'home' }));
