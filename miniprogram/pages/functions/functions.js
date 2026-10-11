/**
 * 全部功能（02）
 * ------------------------------------------------------------------
 * 16 个功能入口分 4 组展示，支持按名称搜索。
 * 分组与文案全部来自 data/content.js 的 functions 配置，后端可整组替换。
 * ready=false 的入口点击后如实提示「开发中」，不制造假的可用状态。
 */
/**
 * 全部功能（02）
 * ==================================================================
 * 职责：把 16 个功能入口按 4 组展示，并支持按名称搜索。
 *
 * 几个刻意的设计决定：
 *   · 分组、组内条目、组标题全部来自 content.functions.groups，
 *     后端可整组替换 —— 增删入口、调整分组顺序都不需要发版。
 *   · 搜索时**空分组会被过滤掉**，避免出现「有组标题但下面没条目」的空壳。
 *   · ready=false 的入口点击后如实提示「开发中」，图标与文字同步降级为灰色，
 *     不给用户「这个能用」的错觉。
 *   · 搜索是本地过滤（数据量小，无需请求），因此不需要防抖。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),
    groups: [],
    keyword: '',
    total: 0,
    hit: 0,
    /**
     * 底部统计文案（如「共 16 项功能 · 内容持续更新」）。
     * ⚠️ 内容层给的是模板 `共 {count} 项功能 · 内容持续更新`，必须插值后再绑 ——
     *    直接绑 `c.functions.footer` 会在屏幕上原样显示 `{count}`（院校页踩过同一个坑）。
     */
    footerText: '',
  },

  onLoad() {
    api.loadContent().then((c) => {
      this.allGroups = c.functions.groups || [];
      let total = 0;
      this.allGroups.forEach((g) => (total += g.items.length));
      this.setData({ c, total });
      this.applyFilter('');
    });
  },

  onInput(e) {
    this.applyFilter(e.detail.value);
  },

  onClear() {
    this.applyFilter('');
  },

  /** 按功能名过滤；空关键词展示全部分组 */
  applyFilter(keyword) {
    const kw = String(keyword || '').trim();
    let hit = 0;

    const groups = this.allGroups
      .map((g) => {
        const items = kw ? g.items.filter((it) => it.label.indexOf(kw) > -1) : g.items;
        hit += items.length;
        return Object.assign({}, g, { items });
      })
      .filter((g) => g.items.length > 0);

    // 统计口径跟着列表走：搜索时数「筛出来的」，没搜时数「目录里的」。
    // 两种情况都是真数 —— 不要为了省事写死一个常量。
    this.setData({
      keyword: kw,
      groups,
      hit,
      footerText: api.tpl(this.data.c.functions.footer, { count: kw ? hit : this.data.total }),
    });
  },

  onTap(e) {
    const { url, tab, ready, label } = e.currentTarget.dataset;
    if (!ready || !url) {
      wx.showToast({
        title: api.tpl(this.data.c.home.comingSoon, { name: label }),
        icon: 'none',
      });
      return;
    }
    if (tab) wx.switchTab({ url });
    else wx.navigateTo({ url });
  },
}, { pageId: 'functions' }));
