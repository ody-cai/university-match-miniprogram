/**
 * 匹配中（04）
 * ------------------------------------------------------------------
 * ⚠️ 重做原因（用户质疑：「匹配时不应该唤醒 AI 评估吗？为什么直接给结果了」）
 *   旧版是**假进度**：进度条随机涨到 92%，轮换文案写着「正在核验语言成绩…」，
 *   但实际只是本地毫秒级算术，没有任何 AI 参与 —— 属于虚假呈现。
 *
 * 新版把流程拆成**真实阶段**，进度只在阶段真正完成时前进：
 *   ① 校验成绩档案
 *   ② 规则引擎比对院校录取要求（确定性算法，可解释、可复现）
 *   ③ 计算冲刺 / 匹配 / 保底梯度
 *   ④ 生成个性化解读 —— 这一环才是 AI 的位置
 *
 * AI 与规则的分工（诚实划分）：
 *   · 匹配分数 = 规则引擎。这是优点不是缺点：申请工具的分档必须可审计、可复现，
 *     交给大模型反而会每次算出不同结果。
 *   · 个性化解读 = AI 的用武之地。后端未接入时回落到规则模板，
 *     并在结果页**明确标注**解读由谁生成，不冒充 AI。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

Page(share.withShare({
  data: {
    c: api.content(),
    /** 当前阶段序号 */
    phase: 0,
    phaseLabel: '',
    caption: '',
    progress: 0,
    /** 已完成的阶段数，用于指示点 */
    phases: [],
    /** 解读来源：ai | rule，结果页据此标注 */
    insightBy: 'rule',
  },

  onLoad() {
    api.loadContent().then((c) => {
      this.setData({
        c,
        phases: c.matching.phases,
        minDuration: c.match.minDuration || 1200,
      });
      this.start();
    });
  },

  start() {
    this.startedAt = Date.now();
    this.runPipeline();
  },

  /**
   * 真实流水线：每一步 await 真实工作，进度随实际完成推进
   */
  async runPipeline() {
    try {
      // ---- 阶段 1：读档案 ----
      this.enterPhase(0);
      const profile = await api.getAcademic();

      // ---- 前置校验：档案不全就明确提示，不跑无意义的匹配 ----
      const ready = api.checkProfile(profile);
      if (!ready.ok) {
        this.setData({ progress: 100 });
        wx.showModal({
          title: this.data.c.match.cta,
          content: this.data.c.result.needProfileTip,
          showCancel: false,
          success: () => this.back(),
        });
        return;
      }

      await this.pace(0);

      // ---- 阶段 2 + 3：规则引擎算分（同步完成，但如实展示两个阶段） ----
      // ⚠️ 顺序是「先算、再播阶段 2」，为的是拿到**真实的比对规模**：
      //    阶段 2 的文案是「正在比对 {count} 所院校的录取要求…」，这里的 count
      //    必须是规则引擎实际比对的院校数（= result.total，按目标国家过滤后的池子）。
      //    此处曾写死 `{ count: 26 }` —— 那是设计稿的版式示例数字，界面早就 99 所了，
      //    于是屏幕上出现了一个编出来的数（与曾经的「默认收藏 1 所」「已匹配 26 所」同类）。
      //    规则引擎是毫秒级的，先算后播不改变用户看到的阶段顺序。
      const result = await api.runMatch(profile);
      this.enterPhase(1, { count: result.total });
      await this.pace(1);

      this.enterPhase(2);
      await this.pace(2);

      // ---- 阶段 4：生成解读（AI 或规则模板） ----
      this.enterPhase(3);
      const insight = await api.getInsight(profile, result);
      this.setData({ insightBy: insight.generatedBy || 'rule' });

      // 把解读写回结果，供结果页展示
      if (insight.text) {
        result.insight = insight.text;
        result.insightBy = insight.generatedBy || 'rule';
      }
      if (insight.suggestions && insight.suggestions.length) {
        result.suggestions = insight.suggestions;
      }
      await api.saveResult(result);

      await this.pace(3, true);
      this.finish();
    } catch (e) {
      wx.showModal({
        title: '匹配失败',
        content: '暂时无法完成匹配，请稍后重试。',
        showCancel: false,
        success: () => this.back(),
      });
    }
  },

  /**
   * 切到第 i 个阶段：文案与进度都对应到该阶段的真实语义。
   * @param {number} i    阶段序号
   * @param {object} [vars] 阶段文案里占位符的取值（如 {count}），缺省则原样保留
   */
  enterPhase(i, vars) {
    const p = this.data.phases[i];
    if (!p) return;
    this.setData({
      phase: i,
      phaseLabel: p.label,
      caption: api.tpl(p.caption, vars || {}),
      progress: Math.max(this.data.progress, p.progress - 18),
    });
    // 进度条向该阶段的目标值平滑推进
    setTimeout(() => this.setData({ progress: p.progress }), 60);
  },

  /**
   * 阶段之间的最短停留。
   * 本地规则引擎是毫秒级的，若完全按真实耗时，页面会一闪而过、
   * 用户根本来不及读到「正在做什么」。这里只做**最低可感知时长**的补齐，
   * 不伪造进度数值本身。
   */
  pace(i, last) {
    return new Promise((resolve) => {
      const elapsed = Date.now() - this.startedAt;
      const target = (this.data.c.match.minDuration || 1200) * ((i + 1) / 4);
      const wait = Math.max(220, target - elapsed);
      setTimeout(resolve, last ? Math.max(180, wait) : wait);
    });
  },

  finish() {
    this.setData({ progress: 100 });
    setTimeout(() => wx.redirectTo({ url: '/pages/result/result' }), 280);
  },

  onCancel() {
    this.cancelled = true;
    this.back();
  },

  back() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/match/match' }) });
  },
}, { pageId: 'matching' }));
