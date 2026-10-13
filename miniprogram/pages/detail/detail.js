/**
 * 大学详情（07 首屏 + 续屏，同一页滚动）
 * ------------------------------------------------------------------
 * 内容：Hero / 录取可能性 / 录取方式 / QS 排名 / 优势专业 / 相关院校
 * 底部固定操作栏：收藏 + 加入申请清单。
 *
 * 数据来自 api.getSchool(id)，一次拿到 school + match + favorite + recommend。
 * 「录取可能性」是**我方算法估算**，页面必须展示口径说明，
 * 否则会被误认为院校官方数据，参赛存在合规风险。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),
    id: '',
    school: null,
    match: null,
    favorite: false,
    recommend: [],
    loading: true,
    /** 较上年的位次变化文案；无数据则留空 */
    rankChangeText: '',
    /** 录取方式：由院校 pathways 推导，标注哪条当前可行 */
    pathways: [],
    /**
     * 无法给出匹配度时显示的文案。
     * ⚠️ 「尚未采集」与「官方明确不公布」必须用不同句子 ——
     *    前者是我们的进度问题，后者是院校的政策，混用会让用户误判。
     */
    admissionEmptyText: '',
    /** 部分维度走了占位分时的口径说明；无此情况则留空 */
    admissionPartialText: '',
    /** 语言未达直录线、档位被封顶时的说明；无此情况则留空 */
    admissionCappedText: '',
    /** 整页骨架的卡片块数（wxml wx:elif="{{loading}}" 分支用） */
    skelCards: [0, 1, 2],
  },

  /**
   * 分享文案
   * 院校未加载完（school===null）时回落到 default 文案；
   * 加载完则按 c.share.school.titleTpl / subTpl 拼。
   *
   * ⚠️ 标题里的 qsLabel / countryCn 由学校对象带 ——**没有手动写「QS 21」
   * 之类的硬码**（榜单会变，且对真实用户不准确）。
   * ⚠️ 路径不带 query：体验版分享出去别人会因权限拦截打不开，统一回首页。
   */
  buildShare() {
    const c = this.data.c;
    const s = this.data.school;
    if (!c || !c.share || !s) return null;
    const defaults = c.share.default || { title: '升学规划', sub: '' };
    const tpl = c.share.school || {};
    const title = api.tpl(tpl.titleTpl || defaults.title, {
      name: s.nameCn || '',
      qs: s.qsLabel || '—',
      country: s.countryCn || '',
    });
    return { title, sub: '' };
  },

  onLoad(query) {
    this.setData({ id: query.id || '' });
    api.loadContent().then((c) => {
      this.setData({ c });
      this.refresh();
    });
  },

  refresh() {
    if (!this.data.id) return;
    api
      .getSchool(this.data.id)
      .then((d) => {
        this.setData({
          school: d.school,
          match: d.match,
          favorite: d.favorite,
          recommend: d.recommend,
          loading: false,
        });
        this.derive(d);
      })
      .catch(() => {
        this.setData({ loading: false });
        wx.showToast({ title: '院校信息加载失败', icon: 'none' });
      });
  },

  /**
   * 派生展示字段
   * 1) 位次变化文案
   * 2) 录取方式列表：直录 + 该校已有 pathway；并标出「当前可行」
   */
  derive(d) {
    const { c, school, match } = { c: this.data.c, school: d.school, match: d.match };
    const detail = c.detail;

    // ---- 位次变化 ----
    let rankChangeText = '';
    const ch = school.qsChange;
    if (ch !== null && ch !== undefined) {
      if (ch > 0) rankChangeText = api.tpl(detail.rankUp, { n: ch });
      else if (ch < 0) rankChangeText = api.tpl(detail.rankDown, { n: Math.abs(ch) });
      else rankChangeText = detail.rankFlat;
    }

    // ---- 录取方式 ----
    // 规则：语言未达标但该校有语言/预科/双录路径 → 该路径「当前可行」；
    //       语言与学术均达标 → 直录可行；否则直录「暂不可行」。
    const req = school.require;
    const pathways = [];

    if (req) {
      const ieltsOk = match && match.dims && match.dims.some(
        (x) => x.key === 'language' && x.met
      );
      const gpaOk = match && match.dims && match.dims.some(
        (x) => x.key === 'academic' && x.met
      );
      const directOk = ieltsOk && gpaOk;

      pathways.push({
        name: '直升录取（Direct Entry）',
        type: 'direct',
        status: directOk ? 'current' : 'blocked',
        statusText: directOk ? detail.pathwayStatus.current : detail.pathwayStatus.blocked,
        desc: req.gpaNote || (req.gpa ? `均分不低于 ${req.gpa}，雅思 ${req.ielts || '—'}` : '按专业竞争录取，每年浮动'),
      });

      for (const p of req.pathways || []) {
        let status = 'consider';
        if (!ieltsOk) status = 'current';       // 语言未达标时，桥梁课程才是当前可行路径
        else if (!directOk) status = 'consider';
        else status = 'consider';

        pathways.push({
          name: p.name,
          type: p.type,
          status,
          statusText: detail.pathwayStatus[status],
          desc: p.desc || (p.ielts ? `语言入学要求 雅思 ${p.ielts}` : ''),
        });
      }
    }

    // ---- 录取可能性缺失 / 不完整的口径文案 ----
    // 三种情况必须区分开（默认文案 = 尚未采集）：
    //   ① match 为空或 score 为空 + reason='insufficientRequirement'
    //      → 官方明文不公布最低分（美国顶尖私校常见），不是我们没采
    //   ② score 有值但**语言维度**缺数据 → 语言分走了占位值，必须说明
    //   ③ 其余 → 尚未采集
    // ⚠️ ② 只针对语言维度：均分缺失是美加院校的普遍政策，
    //    且每个维度条下方已单独写明，再挂通栏提示会变成噪音。
    let admissionEmptyText = detail.admissionNoData;
    if (match && match.score === null && match.reason === 'insufficientRequirement') {
      admissionEmptyText = detail.admissionNoMinimum;
    }
    const missing = (match && match.missingDims) || [];
    const admissionPartialText =
      match && match.score !== null && missing.indexOf('language') > -1
        ? detail.admissionPartial
        : '';

    /**
     * 语言未达直录线 → 档位被封顶为「冲刺」，必须说明原因。
     * 不解释的话，「77% 却标冲刺」看起来就是算错了 —— 而它恰恰是本算法
     * 少数几条**按事实硬约束**得出的结论。
     */
    const admissionCappedText =
      match && match.capped
        ? api.tpl(detail.admissionCapped, { need: (req && req.ielts) || '—' })
        : '';

    this.setData({
      rankChangeText,
      pathways,
      admissionEmptyText,
      admissionPartialText,
      admissionCappedText,
    });
  },

  onToggleFavorite() {
    api.toggleFavorite(this.data.id).then((r) => {
      this.setData({ favorite: r.favorite });
      /**
       * `r.isLocal === true` = 这次只写到了本机（未登录 / 云端写失败），
       * 登录后会自动补传上去。收藏成功时用另一条文案如实说明，
       * **不显示一句让人以为已经同步了的「已收藏」**。
       */
      const d = this.data.c.detail;
      const title = r.favorite ? (r.isLocal ? d.collectedLocal : d.collected) : d.collect;
      wx.showToast({ title, icon: 'none' });
    });
  },

  onAddToList() {
    // 申请清单属二期功能，这里给出明确反馈而不是假成功
    wx.showToast({ title: '已加入申请清单（示例）', icon: 'none' });
  },

  onOpenSchool(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.redirectTo({ url: '/pages/detail/detail?id=' + id });
  },
}, { pageId: 'detail' }));
