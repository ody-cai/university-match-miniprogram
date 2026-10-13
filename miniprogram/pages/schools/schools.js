/**
 * 院校库（06）
 * ==================================================================
 * 职责：搜索 + 地区筛选 + 排序 + 院校行列表，行右侧星标收藏。
 *
 * 几个刻意的设计决定：
 *   · 搜索做了 **300ms 防抖**：不防抖的话每敲一个字都会触发一次过滤，
 *     输入快时列表会持续重排、观感很卡。
 *   · 收藏状态与列表数据**分两次取**（listSchools + getFavorites），
 *     因为收藏是用户数据、院校是公共数据，来源可能不同（本地 vs 后端），
 *     合并放在前端做，避免让接口耦合。
 *   · 行副文案（国家 · 城市 · 类型）用模板拼，模板在内容层，
 *     想改成「城市 · 国家」这类顺序不需要改代码。
 *   · **已收藏院校置顶**。开关在内容层 `schools.favoritesFirst`，可远程关掉。
 *     排序刻意放在**页面层**，不下沉到 `schools.list`：
 *     一旦数据层开始读收藏，就等于把「用户数据」焊进了「公共数据」的查询里，
 *     上面那条「分两次取」的设计也就废了。
 *   · 行本身抽成 `components/school-row`，与「我的收藏」（11）共用同一份
 *     标记与样式，避免同一所学校在两个页面长得不一样。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),
    /**
     * 首帧即渲染：chips / 排序条来自打包内置的内容层，同步可读。
     * 曾经初始为空、等 loadContent() 网络回来才渲染 —— 首帧只有搜索框，
     * 筛选条整排突入并顶开下方列表（布局跳变）。
     */
    regions: api.content().enums.regions,
    sorts: api.content().schools.sorts,
    region: 'all',
    sort: 'qs',
    keyword: '',
    list: [],
    favorites: [],
    total: 0,
    /** 列表骨架行数：与首屏可见行数相当即可，数据到达后原位填充 */
    skelRows: [0, 1, 2, 3, 4, 5],
    /**
     * 结果统计文案（如「共 99 所院校」）。
     * ⚠️ 内容层给的是**带占位符的模板** `共 {count} 所院校`，必须 `api.tpl()` 插值后再绑。
     *    直接把 `c.schools.totalTemplate` 绑到 WXML 上，屏幕上就是一行字面量
     *    「共 {count} 所院校」—— WXML 不会替你替换占位符（架构铁律 3）。
     */
    totalLabel: '',
    /** 置顶提示（如「已收藏 2 所，已置顶」）；无置顶项时为空串，整行不渲染 */
    pinnedLabel: '',
    loading: true,
  },

  /**
   * 分享文案
   * 院校库 99 所全量名头在圈内几乎是固定的，写 default 也无伤大雅；
   * 但**用户当前筛选**（如「美国 · 6 所」）可作为标题后缀，更对朋友胃口。
   * ⚠️ regionKey 在数据层是枚举 key（us/ca/au/uk），需用 enums.regions 反查 label
   *    才能展示出「美国」而不是「us」。
   */
  buildShare() {
    const c = this.data.c;
    if (!c || !c.share) return null;
    const defaults = c.share.default || { title: '升学规划', sub: '' };
    const regionKey = this.data.region || 'all';
    const region = (c.enums && c.enums.regions || []).find((r) => r.key === regionKey);
    const regionLabel = region ? region.label : '';
    const total = this.data.total || (this.data.list || []).length;
    const tpl = regionKey === 'all'
      ? defaults.title
      : `升学规划｜${regionLabel}院校 ${total} 所，国际课程升学参考`;
    return { title: tpl, sub: '' };
  },

  onLoad() {
    // 列表数据与远端内容补丁并行拉取（曾经串行：等完补丁才发列表请求，
    // 弱网下骨架屏白白多等一个网络往返）
    this.refresh();
    api.loadContent().then((c) => {
      this.setData({
        c,
        regions: c.enums.regions,
        sorts: c.schools.sorts,
      });
      this.contentReady = true;
    });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    /**
     * ⚠️ 这一条以前**完全没有**，是一个真实缺口：
     *    在院校详情页点收藏 → 返回院校库，星标和置顶顺序都还是旧的，
     *    因为 onShow 只切了 tabBar 高亮，从不重读收藏。
     *    （详情页也会改收藏状态，所以不能只在 onLoad 读一次。）
     *
     * 首次进入不走这里：onLoad 的 refresh() 会连院校列表一起取，
     * 再由 onShow 补一次就是重复请求。判据用「内容是否加载完」而不是
     * 「data.c 是否为空」—— 页面 data 的 c 初始化就是本地内容，永远非空。
     */
    if (this.contentReady) this.syncFavorites();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  refresh() {
    /**
     * 序号守卫：首帧渲染后筛选/排序立即可点，用户可能在一次请求在途时
     * 又触发新的筛选 —— 没有守卫的话，慢的旧响应会后到、把新的结果覆盖掉
     * （列表闪回旧筛选）。只认最后一次请求的结果。
     */
    this._refreshSeq = (this._refreshSeq || 0) + 1;
    const seq = this._refreshSeq;
    return Promise.all([
      api.listSchools({ region: this.data.region, keyword: this.data.keyword, sort: this.data.sort }),
      api.getFavorites(),
    ]).then(([res, favorites]) => {
      if (seq !== this._refreshSeq) return;
      const view = res.list.map((s) => this.toRow(s, favorites));
      this.setData({
        list: this.order(view),
        favorites,
        total: res.total,
        // 统计文案随筛选结果走：清空关键词/切换地区后要跟着变，不能只在 onLoad 算一次
        totalLabel: api.tpl(this.data.c.schools.totalTemplate, { count: res.total }),
        pinnedLabel: this.pinnedLabel(view),
        loading: false,
      });
    });
  },

  /**
   * 只重取收藏状态，不重查院校列表。
   * 用在「从别的页面回来」这一路径上：列表本身没变，只有星标和置顶顺序可能变了。
   */
  syncFavorites() {
    return api.getFavorites().then((favorites) => {
      const view = this.data.list.map((s) =>
        Object.assign({}, s, { favorite: favorites.indexOf(s.id) > -1 })
      );
      this.setData({
        list: this.order(view),
        favorites,
        pinnedLabel: this.pinnedLabel(view),
      });
    });
  },

  /** 接口数据 → 行组件需要的扁平结构（crest 拆成两个字段，见组件头部说明） */
  toRow(s, favorites) {
    return {
      id: s.id,
      nameCn: s.nameCn,
      nameEn: s.nameEn,
      qsLabel: s.qsLabel,
      crestColor: s.crest && s.crest.color,
      crestShape: s.crest && s.crest.shape,
      favorite: favorites.indexOf(s.id) > -1,
      meta: api.tpl(this.data.c.schools.metaTemplate, {
        country: s.countryCn,
        city: s.cityCn,
        type: s.type,
      }),
    };
  },

  /**
   * 已收藏置顶。
   * ------------------------------------------------------------------
   * ⚠️ 用「分组拼接」而不是 `sort()`：
   *    `Array.prototype.sort` 的稳定性在旧 JS 引擎上**不保证**
   *    （小程序在不同安卓版本上内核不同），不稳定就会把用户选的排序
   *    （按 QS）在收藏组内部打乱 —— 而且不报错，用户只会觉得
   *    「这排序怎么怪怪的」。分组拼接一定稳定。
   * ⚠️ 本函数是**幂等**的：置顶后的列表再跑一遍，顺序不变。
   *    所以 onShow 里可以放心重复调用。
   */
  order(list) {
    if (!this.data.c.schools.favoritesFirst) return list;
    const pinned = [];
    const rest = [];
    list.forEach((s) => (s.favorite ? pinned : rest).push(s));
    return pinned.concat(rest);
  },

  /**
   * 置顶提示文案。
   * ⚠️ 数量取的是**当前筛选结果里**被置顶的条数，不是收藏总数 ——
   *    用户收藏了 3 所但筛到「澳洲」只剩 0 所时，不能还在说「已收藏 3 所，已置顶」。
   *    为 0 时返回空串，由 wxml 整行不渲染（不显示「已收藏 0 所」这种废话）。
   */
  pinnedLabel(view) {
    const cfg = this.data.c.schools;
    if (!cfg.favoritesFirst) return '';
    const n = view.filter((s) => s.favorite).length;
    return n ? api.tpl(cfg.favoritesPinnedTemplate, { count: n }) : '';
  },

  onInput(e) {
    // 防抖：停止输入 300ms 后再查，避免逐字触发
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      this.setData({ keyword: e.detail.value });
      this.refresh();
    }, 300);
  },

  onRegion(e) {
    this.setData({ region: e.currentTarget.dataset.key });
    this.refresh();
  },

  onSort(e) {
    this.setData({ sort: e.currentTarget.dataset.key });
    this.refresh();
  },

  onOpenSchool(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.detail.id });
  },

  /**
   * 收藏 / 取消收藏。
   * ⚠️ 这里不再手工改 `list` 里那一行的 favorite —— 切完就整份重读收藏
   *    （syncFavorites）。手工改的写法在引入置顶后就漏了「顺序」和
   *    「置顶提示条数」两件事，只有单一数据源才不会再漏。
   */
  onToggleFavorite(e) {
    const id = e.detail.id;
    // 返回 promise：验证台要 await 它才能断言置顶结果，不返回就只能靠 sleep 猜
    return api.toggleFavorite(id).then((r) => {
      const tip = this.data.c.schools.favoriteTip;
      /**
       * `r.isLocal === true` = 这次只写到了本机（未登录 / 云端写失败），
       * 登录后会自动补传上去。此时用另一条文案如实说明，
       * **不显示一句让人以为已经同步了的「已收藏」** ——
       * 与个人资料的「已保存」/「已保存到本机」是同一条纪律。
       */
      const key = r.favorite ? (r.isLocal ? 'localOn' : 'on') : (r.isLocal ? 'localOff' : 'off');
      wx.showToast({ title: tip[key], icon: 'none' });
      return this.syncFavorites();
    });
  },
}, { pageId: 'schools' }));
