/**
 * 消息通知
 * ==================================================================
 * 入口：「我的 > 偏好与其他 > 消息通知」。
 * 用途：反馈工单被受理后，用微信「服务通知」主动告知用户结果。
 *
 * ── 为什么这一页不是一个 switch ───────────────────────────────────
 * 小程序给用户的主动触达通道只有「订阅消息」一条，而个人主体只能申请到
 * **一次性订阅**：授权一次 = 可下发一条。做成常驻开关的后果是
 * 「开关显示为开、而额度早已用尽、消息根本发不出去、且没有任何地方报错」——
 * 那是本项目最反对的「界面在撒谎」。所以这里如实呈现五态。
 *
 * ── 三条不能破的纪律 ──────────────────────────────────────────────
 * ① **状态没读到 ≠ 状态是没有**。`getNotify()` 拿不到云端状态时返回
 *    `{unavailable:true}` 哨兵，页面据此显示「状态读取失败」，
 *    **不得**显示成「未开启」——那是把「不知道」说成「没有」，
 *    与匹配页「`tier === undefined` 不渲染」是同一条纪律。
 * ② **授权必须在用户点击的同步上下文里发起**。`wx.requestSubscribeMessage`
 *    中途夹一个 await / 网络请求就会被微信判成「非用户手势触发」而 fail。
 *    所以 tmplIds 只能取自本地内容层，网络上报一律放到 success 回调里。
 * ③ **不谎报成功**。用户点了「允许」之后写服务端失败时，必须如实报错：
 *    否则界面显示「已开启」而服务端没有记录，后台受理时不会给他发通知，
 *    双方都会以为是对方的问题。
 *
 * ⚠️ 所有文案取自内容层 `c.notify`，本文件不写死一个字。
 */
const api = require('../../utils/api');
const share = require('../../utils/share');

/**
 * 状态 → 底部按钮的动作键。没有动作（unavailable）就不渲染按钮。
 * ⚠️ `ready` 给的是「关闭」而不是「再开一次」：本模型里授权是布尔量
 *    （见上方「为什么不是一个 switch」），重复授权不会攒出第二条额度，
 *    所以「已开启」态唯一有意义的动作是撤销。
 */
const ACTION_KEY = { off: 'on', used: 'again', ready: 'revoke', unknown: 'retry' };

Page(share.withShare({
  data: {
    c: api.content(),

    /** 'off' | 'ready' | 'used' | 'unavailable' | 'unknown' */
    status: 'off',
    /** 状态文案（预先算好：WXML 里不做函数调用，求值失败且不报错） */
    statusText: '',
    statusDesc: '',
    /** 底部按钮文案；空串 = 整条按钮不渲染 */
    actionText: '',
    /** 上次通知关联的工单号；仅 used 态回显，空串则该行不渲染 */
    usedTicketId: '',
    /** 未登录时显示「不需要先登录」的说明（订阅按微信身份记录） */
    showGuestTip: false,
    /** 能力未开放时的脚注 */
    footTip: '',
    /** 授权 / 写入进行中：只用于禁用按钮，**不**用于等网络后再发授权 */
    pending: false,
  },

  onLoad() {
    /**
     * ⚠️ 两条并行、互不依赖的加载，**不要串成 await 链**：
     *    · 内容层（`tmplIds` 可能由 `/v1/content` 远端下发）
     *    · 云端订阅状态
     *    串起来会让首次进入多等一个完整往返，而它们之间没有数据依赖。
     */
    api.loadContent().then((c) => {
      this.setData({ c });
      this.apply();
    });
    this.refresh();
  },

  onShow() {
    /**
     * ⚠️ 首次 onLoad→onShow 会连着触发，必须区分「首次进入」与「从别处返回」——
     *    不加这道闸门就会立刻重复请求一次（account.js 用的是 contentReady
     *    标志，同理）。返回时重读是必要的：额度可能刚被一次通知消耗掉。
     */
    if (this.entered) this.refresh();
    this.entered = true;
  },

  /** 读云端订阅状态。失败时 api 层已折成 {unavailable:true} 哨兵，不会 reject */
  refresh() {
    api.getNotify().then((state) => {
      this.remote = state;
      this.loadedRemote = true;
      this.setData({ showGuestTip: !api.isSignedIn() });
      this.apply();
    });
  },

  /**
   * 把「云端状态 + 内容层配置」算成屏幕上的字。
   * ⚠️ 远端还没回来时**直接返回**，不要先画一个「未开启」——
   *    「还没问到」与「问到了、没有」是两件事，先画后者就是编造。
   */
  apply() {
    if (!this.loadedRemote) return;

    const cfg = (this.data.c && this.data.c.notify) || {};
    const r = this.remote || null;
    // ⚠️ 状态推导走 api 层的**唯一口径**（「我的」列表读的也是它）——
    //    本页再写一份判定，两边迟早对不上，而且不会有任何报错。
    const status = api.notifyStatus(r, cfg);

    // used 的描述里有 {extra}：工单号可能没有，没有就整句不拼，
    // 不要留下一个孤零零的「（）」
    const extra =
      r && r.usedTicketId
        ? String(cfg.usedTicket || '').replace('{ticket}', r.usedTicketId)
        : '';
    const desc = String((cfg.statusDesc && cfg.statusDesc[status]) || '')
      .replace('{time}', api.formatDateTime(r && r.usedAt))
      .replace('{extra}', extra);

    const actionKey = ACTION_KEY[status];

    this.setData({
      status,
      statusText: (cfg.status && cfg.status[status]) || '',
      statusDesc: desc,
      actionText: actionKey ? (cfg.action && cfg.action[actionKey]) || '' : '',
      // 工单号只在 used 态回显：ready / off 时它属于「上一次」的历史，
      // 摆在「已开启」下面会让人以为这单已经处理完了
      usedTicketId: status === 'used' ? (r && r.usedTicketId) || '' : '',
      footTip: status === 'unavailable' ? cfg.unavailableFoot || '' : '',
    });
  },

  /**
   * 底部唯一的按钮。三个动作各走各的，**不做成一个开关**：
   *   unknown → 重新读状态（网络问题，别把用户引到授权框上）
   *   ready   → 关闭通知
   *   其余    → 发起微信订阅授权
   */
  onPrimary() {
    if (this.data.pending) return;
    const s = this.data.status;
    if (s === 'unknown') return this.refresh();
    if (s === 'ready') return this.persist(false);
    return this.requestSubscribe();
  },

  /**
   * 发起微信订阅授权。
   * ------------------------------------------------------------------
   * ⚠️ **必须在用户点击的同步上下文里调用**，中途一个 await 都不能有，
   *    否则微信判成「非用户手势触发」直接 fail。所以 tmplIds 只从本地
   *    内容层取，网络上报全部放到 success 回调里。
   * ⚠️ 一次最多 3 个模板（微信限制），这里再兜一道 slice。
   */
  requestSubscribe() {
    const cfg = (this.data.c && this.data.c.notify) || {};
    const T = cfg.toast || {};
    const ids = Array.isArray(cfg.tmplIds) ? cfg.tmplIds.slice(0, 3) : [];

    if (!ids.length) {
      this.toast(T.unavailable);
      return;
    }

    this.setData({ pending: true });

    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: (res) => {
        /**
         * `res[tmplId]` ∈ 'accept' | 'reject' | 'ban' | 'filter'。
         * ⚠️ **逐值判、不要只认 accept** —— 这四种结果用户该做的事完全不同，
         *    合并成一句「开启失败」等于什么都没说（见内容层 toast 的注释）。
         */
        const vals = ids.map((id) => ((res || {})[id] || ''));
        const has = (v) => vals.indexOf(v) > -1;

        if (has('accept')) {
          /**
           * 把**实际被接受的那个**模板 ID 一并上报：服务端要拿它跟内容层
           * 白名单核对（见 cloudfunctions/api/handlers/notify.js 的 save）。
           * 多个模板同时被接受时只记第一个 —— 本地模型是布尔量，
           * 记多个会让人误以为攒下了多条额度（见本文件头注）。
           */
          const tid = ids.filter((id) => ((res || {})[id] || '') === 'accept')[0] || '';
          return this.persist(true, tid);
        }

        this.setData({ pending: false });
        if (has('ban')) return this.toast(T.banned);
        if (has('filter')) return this.toast(T.filtered);
        return this.toast(T.denied);
      },
      fail: (err) => {
        this.setData({ pending: false });
        /**
         * `fail` 基本都是配置 / 环境问题，两种最常见：
         *   20004 = 模板已被停用（再点也没用，是运营侧要改配置）
         *   10004 = 调用时没有用户手势上下文（是代码问题，不该发生）
         * ⚠️ 不要一律说成「请稍后再试」—— 那会让用户一直重试一个必败的操作。
         */
        const code = (err && err.errCode) || 0;
        if (code === 20004) return this.toast(T.banned);
        return this.toast(T.failed);
      },
    });
  },

  /**
   * 把订阅状态写进服务端。
   * @param {boolean} granted  true = 本轮授权生效；false = 用户主动关闭
   * @param {string}  [templateId] 用户实际授权的模板 ID（仅 granted=true 需要；
   *                   服务端要用它核对内容层白名单，缺了会被 400 拒绝）
   * ------------------------------------------------------------------
   * ⚠️ **不谎报成功**。它是在用户已经于微信授权框里点过「允许」之后调用的，
   *    写不上去就必须让用户看到失败 —— 否则页面显示「已开启」而服务端没有
   *    这条记录，后台受理时根本不会给他发通知，双方都会以为是对方的问题。
   *    （与保存成绩档案「写失败必须暴露」是同一条纪律。）
   */
  persist(granted, templateId) {
    const cfg = (this.data.c && this.data.c.notify) || {};
    const T = cfg.toast || {};
    this.setData({ pending: true });

    const payload = granted
      ? { accepted: true, templateId: templateId || '' }
      : { accepted: false };

    api
      .saveNotify(payload)
      .then(() => {
        this.setData({ pending: false });
        this.toast(granted ? T.accepted : T.revoked);
        this.refresh();
      })
      .catch(() => {
        this.setData({ pending: false });
        this.toast(T.failed);
      });
  },

  toast(msg) {
    if (msg) wx.showToast({ title: msg, icon: 'none' });
  },
}, { pageId: 'notify' }));
