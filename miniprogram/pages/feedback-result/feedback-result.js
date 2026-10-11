/**
 * 反馈结果（09b 成功 / 09c 失败）
 * ------------------------------------------------------------------
 * 一个页面承载两态，靠本机最近一次提交结果分流，**不用 URL 传参** ——
 * 工单号、反馈类型、时间戳塞进 query 会有长度与编码问题。
 *
 * 三个刻意的设计决定：
 *
 *  1. **成功走 redirectTo、失败走 navigateTo**（由反馈页决定）。本页据此设置
 *     返回行为：成功态的返回键回首页（表单页已被替换掉，本来也回不去）；
 *     失败态走 navigateBack，回到**还留着内容**的表单页直接重试。
 *
 *  2. **本地模式（无后端）绝不复用「反馈已提交」的文案**。此时反馈只落在
 *     本机、团队收不到，必须换成 successLocal 那套如实说明，
 *     工单号位也不能显示 `local-<时间戳>` 那个本机编号。
 *
 *  3. **拿不到结果时如实说「没有可展示的结果」**，不编造一个成功态出来。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),
    /** success | fail | stale */
    status: 'stale',
    heroMotion: 'none',
    heroMood: 'sad',
    badgeIcon: 'alert-mark',
    /** 导航返回行为：成功态回首页，失败态回表单页 */
    backUrl: '/pages/home/home',
    backTab: true,
    /** 标题 / 描述 / 主按钮 / 副文案 */
    view: {},
    /** 回执卡的行 { k, v, tone } */
    info: [],
  },

  onLoad() {
    api.loadContent().then((c) => {
      this.setData({ c });
      this.build(c);
    });
  },

  /** 按本机最近一次提交结果分流渲染 */
  build(c) {
    const R = c.feedback.result;
    const rec = api.getFeedbackResult();

    if (!rec) return this.renderStale(R);
    if (rec.ok) return this.renderSuccess(R, rec);
    return this.renderFail(R, rec);
  },

  /* ================= 成功 ================= */
  renderSuccess(R, rec) {
    // delivered=false 表示本地模式：反馈只落在本机，文案必须换成如实版本
    const local = !rec.delivered;
    const v = local ? R.successLocal : R.success;

    this.setData({
      status: 'success',
      heroMotion: 'celebrate',
      heroMood: 'happy',
      badgeIcon: 'check',
      backUrl: '/pages/home/home',
      backTab: true,
      view: {
        // v1.0.3：success.desc 已改为不含占位符的感谢语，故不再做模板插值
        title: v.title,
        desc: v.desc,
        primary: v.primary,
        again: v.again,
        foot: '',
      },
      info: [
        {
          k: R.rows.ticket,
          v: local ? R.noTicketLocal : rec.ticketId,
          tone: local ? 'mute' : '',
        },
        { k: R.rows.type, v: this.typeLabel(rec.type), tone: '' },
        { k: R.rows.createdAt, v: api.formatDateTime(rec.createdAt), tone: '' },
      ],
    });
  },

  /* ================= 失败 ================= */
  renderFail(R, rec) {
    const reasons = R.reasons || {};
    this.setData({
      status: 'fail',
      heroMotion: 'none',
      heroMood: 'sad',
      badgeIcon: 'alert-mark',
      // 空 backUrl ⇒ 走 navigateBack，回到还留着内容的表单页
      backUrl: '',
      backTab: false,
      view: {
        title: R.fail.title,
        desc: R.fail.desc,
        primary: R.fail.primary,
        again: '',
        foot: R.fail.foot,
      },
      info: [
        { k: R.rows.reason, v: reasons[rec.reason] || reasons.default, tone: '' },
        // 「已暂存到本地」用品牌色 —— 这是失败页里唯一的好消息，值得被看见
        { k: R.rows.draft, v: R.draftKept, tone: 'brand' },
        { k: R.rows.ticket, v: R.noTicket, tone: 'mute' },
      ],
    });
  },

  /* ================= 兜底：本机没有结果可读 ================= */
  renderStale(R) {
    this.setData({
      status: 'stale',
      heroMotion: 'none',
      heroMood: 'sad',
      badgeIcon: 'alert-mark',
      backUrl: '/pages/home/home',
      backTab: true,
      view: {
        title: R.stale.title,
        desc: R.stale.desc,
        primary: R.stale.primary,
        again: '',
        foot: '',
      },
      info: [],
    });
  },

  /* ================= 交互 ================= */

  onPrimary() {
    const s = this.data.status;

    // 失败：回到表单页（草稿已恢复），让用户直接再提交一次
    if (s === 'fail') {
      const pages = getCurrentPages();
      if (pages.length > 1) return wx.navigateBack({ fail: () => {} });
      return wx.redirectTo({ url: '/pages/feedback/feedback' });
    }

    if (s === 'stale') return wx.redirectTo({ url: '/pages/feedback/feedback' });

    // 成功：首页是标签页，必须用 switchTab（navigateTo 会失败）
    wx.switchTab({ url: '/pages/home/home', fail: () => {} });
  },

  /** 再提一条：redirectTo 替换掉本页，避免返回时又看到上一次的结果 */
  onAgain() {
    wx.redirectTo({ url: '/pages/feedback/feedback' });
  },

  /** 反馈类型 key → 展示名；取不到时如实显示「未选择」 */
  typeLabel(key) {
    const fb = this.data.c.feedback || {};
    const types = fb.types || [];
    for (let i = 0; i < types.length; i++) {
      if (types[i].key === key) return types[i].label;
    }
    return (fb.result || {}).noType || '';
  },
}, { pageId: 'feedback-result' }));
