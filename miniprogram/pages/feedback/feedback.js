/**
 * 意见反馈（09）
 * ------------------------------------------------------------------
 * 职责：收集 反馈类型 / 问题描述 / 相关截图，交给 api.submitFeedback。
 * 文案与校验阈值全部来自 content.feedback，后端可经 /v1/content 调整而不发版。
 *
 * 提交后的结果**不在本页展示**，而是跳到独立的「反馈结果」页（09b / 09c）：
 *   成功 → redirectTo（替换本页：表单已完成使命，不该再回得去）
 *   失败 → navigateTo（保留本页：内容还在，用户可直接重试）
 * 这个差异是刻意的 —— 失败后被迫把内容重写一遍是最让人恼火的体验。
 *
 * 其他刻意的设计决定（改动前先读）：
 *
 *  1. **类型默认选中「院校数据有误」**（来自内容层 defaultType）。
 *     本产品的院校录取数据是自采的，纠错通道最有价值、也最可能被真实使用。
 *
 *  2. **按钮保持可点，只是视觉上分主/灰两态**。灰掉的按钮如果不说明缺什么，
 *     用户只会以为小程序坏了；所以点击时一律明确告知缺哪一项。
 *
 *  3. ⚠️ **本地模式没有后端，反馈只存本机、团队收不到**。
 *     结果页会据此换成如实文案（见 feedback-result.js），本页不做这个判断 ——
 *     判断散在多个页面里迟早会漏。
 *
 *  4. ⚠️ **v1.0.3 起不再采集联系方式**（原「联系方式」输入卡已删）。
 *     平台审核驳回原话：「涉嫌在非合理场景下收集、存储用户密码或个人敏感信息」。
 *     因此本页**不得**再出现任何 contact 相关的 data / 事件 / 提交字段。
 *     契约 4.8 的 `contact` 字段仅为历史工单兼容而保留，客户端一律不传。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

/**
 * 客户端环境信息，用于定位兼容性问题。
 * 取不到就留空 —— 不编造字段，也不因为个别机型不支持某个 API 就让提交失败。
 */
function clientInfo() {
  const out = {};
  try {
    const a = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : null;
    if (a) {
      out.version = a.version || '';
      out.platform = a.platform || '';
    }
  } catch (e) {
    /* 老基础库无此 API，忽略 */
  }
  try {
    const d = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : null;
    if (d) out.system = d.system || '';
  } catch (e) {
    /* 同上 */
  }
  return out;
}

Page(share.withShare({
  data: {
    c: api.content(),
    types: [],
    /** 当前选中的反馈类型 key */
    type: '',
    desc: '',
    /** [{ path, fileId }] —— fileId 仅在远端模式下上传成功后才有 */
    images: [],
    /** 字数计数文案，由内容层模板插值而来 */
    counterText: '',
    imagesHint: '',
    /** 仅控制按钮视觉态；点击始终可用，见 onSubmit */
    canSubmit: false,
    submitting: false,
    /** 当前是否已接入后端。false 时页面会显示「反馈不会送达」的提示条 */
    remote: false,
  },

  onLoad() {
    api.loadContent().then((c) => {
      const fb = c.feedback || {};
      // 草稿优先：上次填写中途退出、或提交失败被保住的内容
      const draft = api.getFeedbackDraft() || {};

      this.setData({
        c,
        types: fb.types || [],
        type: draft.type || fb.defaultType || '',
        desc: draft.desc || '',
        images: draft.images || [],
        imagesHint: api.tpl(fb.imagesHint, { max: fb.imageMax }),
        remote: api.mode() === 'remote',
      });
      this.syncCounter();
      this.syncSubmitState();
    });
  },

  /**
   * 离开页面时保一份草稿。
   * ⚠️ 只在确实写过内容时才存 —— 否则用户每次点进来再退出都会被恢复一份
   *    空白草稿，草稿本身反倒成了噪音。
   */
  onHide() {
    if (this.hasContent()) api.saveFeedbackDraft(this.snapshot());
  },

  /* ================================================================
     表单输入
     ================================================================ */

  onPickType(e) {
    this.setData({ type: e.currentTarget.dataset.key });
    this.syncSubmitState();
  },

  onInputDesc(e) {
    this.setData({ desc: e.detail.value });
    this.syncCounter();
    this.syncSubmitState();
  },

  /**
   * 字数计数。
   * 用内容层模板拼而不是前端写死 `n + '/' + max`，
   * 是为了后端还能改成「还可输入 {left} 字」这类**不同语序**的文案。
   */
  syncCounter() {
    const fb = this.data.c.feedback || {};
    this.setData({
      counterText: api.tpl(fb.counter, { n: this.data.desc.length, max: fb.descMax }),
    });
  },

  /** 类型与描述都齐了，按钮才变主色（但点击始终有效） */
  syncSubmitState() {
    const d = (this.data.desc || '').trim();
    this.setData({ canSubmit: !!this.data.type && !!d });
  },

  /** 是否写过东西 —— 决定要不要落草稿（v1.0.3 起不再把联系方式算作「写过」） */
  hasContent() {
    return !!String(this.data.desc || '').trim() || this.data.images.length > 0;
  },

  /** 表单快照，用于失败时落草稿 */
  snapshot() {
    return {
      type: this.data.type,
      desc: this.data.desc,
      images: this.data.images.map((i) => ({ path: i.path, fileId: i.fileId || '' })),
    };
  },

  /* ================================================================
     截图
     ================================================================ */

  onAddImage() {
    const max = (this.data.c.feedback || {}).imageMax || 3;
    const left = max - this.data.images.length;
    if (left <= 0) return;

    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const add = (res.tempFiles || []).map((f) => ({
          path: f.tempFilePath,
          fileId: '',
        }));
        this.setData({ images: this.data.images.concat(add).slice(0, max) });
      },
      fail: () => {
        /* 用户取消选图属正常操作，不打扰 */
      },
    });
  },

  onRemoveImage(e) {
    const i = Number(e.currentTarget.dataset.index);
    const list = this.data.images.slice();
    list.splice(i, 1);
    this.setData({ images: list });
  },

  /* ================================================================
     提交
     ================================================================ */

  onSubmit() {
    if (this.data.submitting) return;

    const fb = this.data.c.feedback || {};
    const desc = (this.data.desc || '').trim();

    // 校验失败要明确告知缺什么 —— 静默无响应等同于「按钮坏了」
    if (!this.data.type) return this.toast(fb.needType);
    if (!desc) return this.toast(fb.needDesc);
    if (desc.length > fb.descMax) {
      return this.toast(api.tpl(fb.descTooLong, { max: fb.descMax }));
    }

    this.setData({ submitting: true });

    this.prepareImages()
      .then((images) =>
        api.submitFeedback({
          type: this.data.type,
          content: desc,
          images,
          client: clientInfo(),
        })
      )
      .then((rec) => {
        this.setData({ submitting: false });
        this.goResult(!!rec.ok);
      })
      .catch(() => {
        // 能走到这里说明是**前置步骤**出错（最典型的是远端模式下截图上传失败），
        // 因为 submitFeedback 自身已改为不抛错。同样要给用户一个失败结果页，
        // 而不是只有一句 toast 就没了下文。
        this.setData({ submitting: false });
        api.markFeedbackFailed('NETWORK', this.data.type);
        this.goResult(false);
      });
  },

  /**
   * 跳转到结果页，并按成败选择跳转方式
   * ------------------------------------------------------------------
   * 成功 → redirectTo：表单已提交完毕，返回栈里留着它没有意义 ——
   *        用户从结果页返回时理应回到首页，而不是一张已提交的空表单。
   * 失败 → navigateTo：**保留本页**（文字与已选图片都还在），
   *        结果页的「重新提交」只要 navigateBack 就回到原样，不必重写。
   *        同时落一份草稿 —— 结果页那句「已暂存到本地，不会丢失」
   *        靠这一步兑现，它不能只是一句安抚话术。
   */
  goResult(ok) {
    const url = '/pages/feedback-result/feedback-result';

    if (ok) {
      // 提交成功，草稿使命结束：不清掉的话，下次进来会看到上一条已提交的内容
      api.clearFeedbackDraft();
      wx.redirectTo({ url });
      return;
    }

    api.saveFeedbackDraft(this.snapshot());
    wx.navigateTo({ url });
  },

  /**
   * 提交前准备图片
   * ------------------------------------------------------------------
   * 远端模式：逐张上传换取 fileId —— 契约 4.8 明确「不接受外链 URL」。
   * 本地模式：不上传，直接用本地临时路径存档。
   *           因为本地模式下反馈本身就只存本机，为了「看起来完整」去
   *           假装上传没有任何意义，反而多一条注定会失败的代码路径。
   */
  prepareImages() {
    const list = this.data.images;
    if (!list.length) return Promise.resolve([]);
    if (!this.data.remote) return Promise.resolve(list.map((i) => i.path));

    return Promise.all(
      list.map((i) =>
        i.fileId
          ? Promise.resolve(i.fileId)
          : api.uploadImage(i.path).then((r) => {
              i.fileId = r.fileId;
              return r.fileId;
            })
      )
    );
  },

  toast(title) {
    if (!title) return;
    wx.showToast({ title, icon: 'none' });
  },
}, { pageId: 'feedback' }));
