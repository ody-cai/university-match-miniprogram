/**
 * utils/share.js
 * ============================================================================
 * 给 Page({...}) 对象注入 onShareAppMessage / onShareTimeline 的统一工具。
 *
 * 历史背景（2026-10-11）：
 *   原 15 个页面没有任何 onShareAppMessage，右上角「转发给朋友 / 分享到朋友圈」
 *   均置灰。微信官方 Page.onShareAppMessage 文档原话：「**只有定义了此事件处理
 *   函数，右上角菜单才会显示「转发」按钮**」—— 与实测一致。
 *
 * 为什么**不**重写 Page 构造器（在 app.js 里 Page = function(cfg){...}）：
 *   · 微信小程序的 Page 是全局函数，重写后可能与小程序框架内部的 page 注册
 *     流程发生不可预期的交互（官方文档未明示是否允许重写）。
 *   · 本项目 15 个页面逐个注入的工作量可控（每页 ~5 行），且更易于真机逐页
 *     验证；同时某页需要定制分享文案时不会影响其它页。
 *
 * 为什么文案走 content.share 而不写死在页面里：
 *   · 项目铁律：文案走内容层（详见 README.md §5.2），后端可通过 /v1/content
 *     调整语序 / 加后缀，不必发版。
 *
 * ⚠️ 平台层注：转发在外部用户打得开，**必须先发布正式版**。体验版分享出去
 *    后页面提示「无权限」（官方文档「分享到朋友圈」注意事项第 5 条）。
 *    本次只解决「代码层菜单置灰」的问题，平台层需用户发审。
 *
 * 用法（在每个 pages/<x>/<x>.js 的 Page({...}) 内）：
 *
 *   const api = require('../../utils/api');
 *   const share = require('../../utils/share');
 *
 *   Page(share.withShare({
 *     data: { c: api.content() },
 *     onLoad() { ... },
 *     // 自定义分享文案（可选；不传则用 c.share.default）：
 *     buildShare() {
 *       return {
 *         title: api.tpl(this.data.c.share.school.titleTpl,
 *           { name: this.data.school.nameCn, qs: this.data.school.qsLabel, country: this.data.school.countryCn }),
 *         sub:   api.tpl(this.data.c.share.school.subTpl,
 *           { country: this.data.school.countryCn }),
 *       };
 *     },
 *   }, { pageId: 'detail' }));
 *
 * 第二个参数是页面路径，传 'detail' → path = '/pages/detail/detail'。
 */

/**
 * 计算页面路径（不带 query）
 *
 * 输入 'home' → '/pages/home/home'
 * 输入 '/pages/detail/detail' → '/pages/detail/detail'（原样返回）
 *
 * 注意：path 必须是「/ 开头的完整路径」，这是微信官方硬约束。
 * —— 写成 '/pages/home/home'，不带参数，分享出去别人打开后进的就是首页。
 *
 * 对 detail / matching / result / schools / favorites 这些「**带 id 进入**」
 * 的页面，**不能**给分享路径带 query —— 体验版分享出去会因权限拦截而打
 * 不开，且正式版也会先看到 loading 再跳。统一回首页，是最安全的选择。
 */
function pageRoute(pageId) {
  if (!pageId) return '/pages/home/home';
  // 已经包含 /pages/ → 原样
  if (pageId.indexOf('/pages/') === 0) return pageId.replace(/\.js$/, '');
  // 否则补 /pages/<id>/<id>
  return '/pages/' + pageId + '/' + pageId;
}

/**
 * 给一个 Page config 对象注入 onShareAppMessage / onShareTimeline
 *
 * @param {object}   cfg         Page({}) 原本的配置
 * @param {object}   opts
 *   @param {string}  opts.pageId     页面 id（不含 .js），如 'home'
 *   @param {Function} [opts.c]      内容层对象；若未传，会从 cfg.data.c 取
 *
 * 不强制要求 cfg 上有 buildShare —— 有则用，没有就回落到 c.share.default。
 * 文案构建**延迟到 onShareAppMessage 被调用时**（用户点转发那一刻），
 * 这样拿到的是当时页面 data 的真实值（而非 ctor 时已固化的快照）。
 */
function withShare(cfg, opts) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const pageId = opts && opts.pageId;
  const c = (opts && opts.c) || (cfg.data && cfg.data.c);
  if (!pageId || !c) return cfg;

  const route = pageRoute(pageId);
  const fallback = (c.share && c.share.default) || { title: '升学规划' };

  /**
   * 取标题
   * 1) cfg.buildShare 存在 → 调它拿 {title, sub}
   * 2) 否则用 c.share.default
   * 3) 取 title 时**忽略** sub：微信只接受 title，不接受 sub
   */
  function resolveTitle(self) {
    if (typeof cfg.buildShare === 'function') {
      try {
        const r = cfg.buildShare.call(self);
        if (r && typeof r.title === 'string' && r.title) return r.title;
      } catch (e) { /* 异常不影响转发主流程 */ }
    }
    return fallback.title;
  }

  // 已定义 → 不覆盖，尊重页面级的精确控制
  if (typeof cfg.onShareAppMessage !== 'function') {
    cfg.onShareAppMessage = function () {
      return {
        title: resolveTitle(this),
        path: route,
        /**
         * ⚠️ 不返回 imageUrl：用默认截图，避免引用未在 downloadFile
         *    合法域名里的图片导致分享卡片裂图。包里目前也没有可用的
         *    分享图资源（find 无 png/jpg）。
         */
      };
    };
  }

  if (typeof cfg.onShareTimeline !== 'function') {
    cfg.onShareTimeline = function () {
      return {
        title: resolveTitle(this),
        /**
         * 官方 share-timeline 文档：「不支持在小程序页面内直接发起分享」、
         * 「自定义分享内容时不支持自定义页面路径」。
         * query 为空 → 朋友圈打开进首页（onLoad 自行判定）。
         */
        query: '',
      };
    };
  }

  return cfg;
}

module.exports = { withShare, pageRoute };