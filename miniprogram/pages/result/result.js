/**
 * 匹配结果（05）
 * ------------------------------------------------------------------
 * 深色汇总卡 + 档位筛选 + 结果卡片列表。
 * 结果来自上一次匹配（storage），进入本页若没有结果则引导去填写成绩。
 *
 * 档位筛选按 tier 分组，支持「全部 / 冲刺 / 匹配 / 保底」切换。
 * 每张卡片右侧的匹配度 / 档位标签配色来自 TIER_META（content 层）。
 */
/**
 * 匹配结果（05）
 * ==================================================================
 * 职责：汇总卡 + 行动建议 + 档位筛选 + 结果列表。
 *
 * 几个刻意的设计决定：
 *   · 结果读的是**上一次匹配的存档**（storage / 后端），不是当场重算 ——
 *     用户从结果页返回再进来，看到的应该还是同一份结果，而不是「又算了一次」。
 *   · 筛选项只列「全部 / 冲刺 / 匹配 / 保底」，**刻意不含 unknown**：
 *     给一个点了果然是空的筛选项，是纯粹的体验浪费。
 *   · 「解读来源」必须如实展示：规则引擎生成的就写规则引擎，
 *     不能因为「AI 听起来更高级」就默认标注成 AI 生成。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');
const match = require('../../utils/match');

Page(share.withShare({
  data: {
    c: api.content(),
    result: null,
    tierMeta: {},
    filter: 'all',
    filters: [],
    filtered: [],
    hasResult: false,
    disclaimer: '',
    /** 解读来源标注文案（AI / 规则引擎），必须展示 */
    insightByLabel: '',
  },

  /**
   * 分享文案
   * · 没结果时用 c.share.result.empty（避免「冲刺 0 所」的零计数分享）。
   * · 有结果时按 reach / match / safe 三个档位**实际条数**拼标题 —— 不冒充「冲刺 5 所」
   *   这种没算过的数字。
   */
  buildShare() {
    const c = this.data.c;
    if (!c || !c.share) return null;
    const defaults = c.share.default || { title: '升学规划', sub: '' };
    const r = c.share.result || {};
    if (!this.data.hasResult || !this.data.result || !this.data.result.list) {
      return { title: r.empty || defaults.title, sub: '' };
    }
    const list = this.data.result.list || [];
    const counts = { reach: 0, match: 0, safe: 0 };
    list.forEach((s) => { if (counts[s.tier] !== undefined) counts[s.tier] += 1; });
    return {
      title: api.tpl(r.titleTpl || defaults.title, {
        reach: counts.reach, match: counts.match, safe: counts.safe,
      }),
      sub: '',
    };
  },

  onLoad() {
    api.loadContent().then((c) => {
      // 档位筛选项：固定「全部」+ 三种实际档位（不含 unknown，避免空筛选）
      const tierMeta = match.TIER_META;
      const filters = [
        { key: 'all', label: c.result.filterAll },
        { key: 'reach', label: c.result.tierShort.reach },
        { key: 'match', label: c.result.tierShort.match },
        { key: 'safe', label: c.result.tierShort.safe },
      ];
      this.setData({ c, tierMeta, filters, disclaimer: c.result.disclaimer });
      this.loadResult();
    });
  },

  loadResult() {
    api.getLatestMatch().then((result) => {
      if (!result || !result.list) {
        this.setData({ hasResult: false });
        return;
      }
      this.setData({
        result,
        hasResult: true,
        // 解读来源标注：规则引擎生成的不冒充 AI 生成
        insightByLabel:
          (this.data.c.result.insightBy || {})[result.insightBy || 'rule'] || '',
      });
      this.applyFilter('all');
    });
  },

  onFilter(e) {
    this.applyFilter(e.currentTarget.dataset.key);
  },

  applyFilter(key) {
    this.setData({ filter: key });
    const { result, c } = this.data;
    const list = result.list;
    const filtered =
      key === 'all' ? list : list.filter((s) => s.tier === key);

    // 给每张卡片补上展示所需的短标签与档位色
    const view = filtered.map((s) => ({
      id: s.id,
      nameCn: s.nameCn,
      nameEn: s.nameEn,
      countryCn: s.countryCn,
      cityCn: s.cityCn,
      qsLabel: s.qsLabel,
      crest: s.crest,
      match: s.match,
      tier: s.tier,
      tierLabel: s.match !== null ? c.result.tierShort[s.tier] : c.result.tierShort.unknown,
      top: s.matched ? true : false,
    }));
    this.setData({ filtered: view });
  },

  onOpenSchool(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  onGoMatch() {
    wx.switchTab({ url: '/pages/match/match' });
  },
}, { pageId: 'result' }));
