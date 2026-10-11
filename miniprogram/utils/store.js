/**
 * 本地持久化
 * ------------------------------------------------------------------
 * 本机 Storage 现在有两种角色，读代码时务必分清：
 *
 *   · **离线缓存 / 未登录时的数据源**：成绩档案、收藏、匹配结果
 *   · **同步元数据**：档案与收藏的归属账号（owner）与未同步标记（dirty），
 *     见文件末尾「同步状态」一节
 *
 * ⚠️ 不要再写「小程序运行期零网络请求」这句话 —— 已不成立：
 *    登录后成绩档案与收藏会真的上云（`/v1/academic/profile`、`/v1/favorites`），
 *    换设备登录时会拉回来。匹配结果仍然只在本机（规则引擎在客户端跑）。
 *    这句话曾出现在提审材料与多份文档里，是**不实陈述**，已一并订正。
 */
const content = require('../data/content');

const KEY = {
  agreed: 'sp_agreed_terms',
  agreedAt: 'sp_agreed_at',
  signIn: 'sp_sign_in',
  user: 'sp_user',
  profile: 'sp_profile',
  favorites: 'sp_favorites',
  result: 'sp_match_result',
  feedbacks: 'sp_feedbacks',
  feedbackDraft: 'sp_feedback_draft',
  feedbackResult: 'sp_feedback_result',
  /**
   * 成绩档案 / 收藏的归属与未同步标记（见下方「同步状态」一节）
   * ------------------------------------------------------------------
   * 这四个键是**纯本机**的同步元数据，不会上传、也不属于任何契约字段。
   * 它们是「换设备登录时该信谁」的唯一判据 —— 没有它们，
   * 客户端只能在「云端覆盖本机（可能丢本机刚填的）」和
   * 「本机覆盖云端（可能丢掉另一台设备的数据）」之间瞎猜。
   */
  profileOwner: 'sp_profile_owner',
  profileDirty: 'sp_profile_dirty',
  favOwner: 'sp_fav_owner',
  favDirty: 'sp_fav_dirty',
  /** 本地存储结构版本，见 migrate()。改动老数据的语义时才需要动它 */
  ver: 'sp_storage_ver',
};

/**
 * 本地存储结构版本
 * ------------------------------------------------------------------
 * ⚠️ 只有「会影响**已落库的老数据**的默认值 / 结构」的改动才 +1，并同步补一条迁移。
 *    纯粹新增一个键（老设备上没有它，走 get() 的 fallback 即可）**不需要**升版本。
 */
const STORAGE_VERSION = 2;

/**
 * 第 1 版种下的「默认收藏」（历史 bug，见下方 DEFAULT_FAVORITES 注释）。
 * 只在 migrate() 里用于识别并清理老设备上的残留。
 */
const SEEDED_FAVORITES = ['toronto'];

/* ---------------- 默认成绩档案 ----------------
 * 初始档案取自内容层 `content.defaultAcademic`，不在这里写死数值 ——
 * 运营/后端可以调整示例值而无需改代码。
 *
 * coursesMap：按课程体系分别保存已录科目。
 * 学生可能同时考了 AP 与 IB，切换分段控件时不应互相清空，
 * 因此以 coursesMap 为存储真源，courses 只是「当前体系」的镜像，
 * 便于匹配算法与后端契约直接使用。
 */
const DEFAULT_PROFILE = (function () {
  const base = JSON.parse(JSON.stringify(content.defaultAcademic));
  // 用默认体系填充 courses 镜像，保证首次进入即可直接匹配
  base.courses = (base.coursesMap && base.coursesMap[base.curriculum]) || [];
  return base;
})();

/* ---------------- 默认收藏 ----------------
 * ⚠️ 必须是**空数组**。此前是 `['toronto']` —— 于是一个从未收藏过任何院校的
 *    新用户，账号页就显示「我的收藏 1」，院校库里还挂着一颗已点亮的星。
 *    这是**编造用户数据**，与「空档案曾经自带 GPA 86」是同一条红线。
 *    空态就是空态。
 */
const DEFAULT_FAVORITES = [];

function get(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    if (v === '' || v === null || v === undefined) return fallback;
    return v;
  } catch (e) {
    return fallback;
  }
}

function set(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

module.exports = {
  KEY,
  DEFAULT_PROFILE,

  /**
   * 一次性存储迁移
   * ==================================================================
   * 为什么需要它：代码里的默认值只对「Storage 里根本没有这个键」生效（见 get()）。
   * 一个键一旦被写过，改代码**不会**把它改回来 —— 老设备会一直留着旧行为。
   * 所以「默认值写错了」这类缺陷，光改默认值只能救新装用户，救不了已经跑过的设备。
   * 由 app.onLaunch 调一次；重复调用是幂等的（靠 sp_storage_ver 门闩）。
   *
   * v2：清掉第 1 版种下的「默认收藏 = 多伦多」。
   *   判定条件刻意收得很紧 —— 收藏列表必须**恰好等于**种子值（长度相同、内容相同）。
   *   用户只要自己多收藏了任何一所、或取消过任何一所，列表就不等于种子值，一律不碰。
   *   代价：若某人真的只收藏了多伦多这一所，也会被清掉。这是为消除
   *   「所有人都凭空多一所收藏」的假数据所做的取舍 —— 他再点一次星即可恢复，而假数据会一直骗人。
   */
  migrate() {
    const seen = Number(get(KEY.ver, 0)) || 0;
    if (seen >= STORAGE_VERSION) return seen;

    if (seen < 2) {
      const fav = this.getFavorites();
      const isSeed =
        Array.isArray(fav) &&
        fav.length === SEEDED_FAVORITES.length &&
        SEEDED_FAVORITES.every((id) => fav.indexOf(id) > -1);
      if (isSeed) set(KEY.favorites, []);
    }

    set(KEY.ver, STORAGE_VERSION);
    return STORAGE_VERSION;
  },

  /* ---- 条款同意 ---- */
  isAgreed() {
    return !!get(KEY.agreed, false);
  },
  agree() {
    set(KEY.agreed, true);
    set(KEY.agreedAt, new Date().toISOString());
  },
  revokeAgreement() {
    set(KEY.agreed, false);
  },

  /* ---- 登录态 ---- */
  isSignedIn() {
    return !!get(KEY.signIn, false);
  },
  setSignedIn(v, user) {
    set(KEY.signIn, !!v);
    if (user) set(KEY.user, user);
  },
  getUser() {
    return get(KEY.user, null);
  },

  /* ---- 成绩档案 ---- */
  getProfile() {
    const p = get(KEY.profile, null);
    if (!p) return clone(DEFAULT_PROFILE);
    // 与默认档案做浅合并，避免历史版本缺字段导致页面报错
    return Object.assign(clone(DEFAULT_PROFILE), p);
  },
  setProfile(p) {
    return set(KEY.profile, p);
  },
  resetProfile() {
    return set(KEY.profile, clone(DEFAULT_PROFILE));
  },

  /* ---- 收藏 ---- */
  getFavorites() {
    return get(KEY.favorites, DEFAULT_FAVORITES.slice());
  },
  /**
   * 整份覆盖收藏列表。
   * 同步与远端写入后都用它，**不要**逐条 toggle —— 那会丢掉「最近收藏在前」
   * 的顺序（服务端返回的 ids 已经是有序的，逐条重放会把顺序打乱）。
   */
  setFavorites(ids) {
    const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x);
    return set(KEY.favorites, list);
  },
  isFavorite(id) {
    return this.getFavorites().indexOf(id) > -1;
  },
  toggleFavorite(id) {
    const list = this.getFavorites();
    const i = list.indexOf(id);
    if (i > -1) list.splice(i, 1);
    else list.unshift(id);
    set(KEY.favorites, list);
    return i === -1; // true = 新增收藏
  },
  favoriteCount() {
    return this.getFavorites().length;
  },

  /* ---- 匹配结果 ---- */
  getResult() {
    return get(KEY.result, null);
  },
  setResult(r) {
    return set(KEY.result, r);
  },
  clearResult() {
    return set(KEY.result, null);
  },

  /* ---- 意见反馈 ----
   * ⚠️ 本地模式下反馈**只落在本机，团队收不到**（见 api.js 的 feedback.submit）。
   *    因此这里刻意只做「追加 + 读取」，不记录任何「已送达」标记 ——
   *    送达与否由 api 层按当前运行模式如实告知用户，不在存储层假装成功。
   */
  getFeedbacks() {
    return get(KEY.feedbacks, []);
  },
  /** 追加一条本机反馈存档；只保留最近 20 条，避免 Storage 无限增长 */
  addFeedback(item) {
    const list = get(KEY.feedbacks, []);
    list.unshift(item);
    if (list.length > 20) list.length = 20;
    return set(KEY.feedbacks, list);
  },

  /* ---- 反馈草稿 ----
   * 用途：提交失败、或用户在填写途中退出时，把已写内容保住 ——
   *      失败结果页上那句「已暂存到本地，不会丢失」就是靠它兑现的，
   *      不能只是一句安抚话术。
   */
  getFeedbackDraft() {
    return get(KEY.feedbackDraft, null);
  },
  setFeedbackDraft(d) {
    return set(KEY.feedbackDraft, d);
  },
  clearFeedbackDraft() {
    return set(KEY.feedbackDraft, null);
  },

  /* ---- 最近一次反馈结果 ----
   * 结果页是独立页面，工单号/类型/时间不适合塞进 URL 传参
   * （有长度与编码问题），因此落地一次再读。
   */
  getFeedbackResult() {
    return get(KEY.feedbackResult, null);
  },
  setFeedbackResult(r) {
    return set(KEY.feedbackResult, r);
  },

  /* ==================================================================
     同步状态（成绩档案 / 收藏）—— 换设备登录时「该信谁」的判据
     ==================================================================
     owner ：这份本机数据**属于哪个账号**（空串 = 无主，即还没同步给任何人）
     dirty ：本机有**尚未成功推到云端**的改动

     为什么需要它们（每一条都对应一个真实会丢数据的场景）：

     ① `owner === ''`（无主）
        = 用户还没登录时在本机留下的数据。登录时它应当被**认领**给这个账号，
        而不是被云端覆盖掉 —— 否则「先试用、后登录」的用户会发现
        自己填的成绩在登录的一瞬间消失了。

     ② `owner !== 当前账号`
        = 这台设备上上次登录的是别人。此时**必须让云端覆盖本机**，
        否则会把 A 的成绩与收藏带到 B 的账号里。这是隐私问题，不是体验问题。

     ③ `dirty === true`
        = 本机改过但没推成功（离线、超时、或该端点尚未上云）。
        此时「云端覆盖本机」会丢掉用户的真实改动 → 必须走并集 / 合并。

     登出**不清**这些值，也不清数据 —— 与「登出不删已填资料」一致。
     ================================================================== */

  /** 成绩档案的归属账号 id（'' = 无主） */
  getProfileOwner() {
    return String(get(KEY.profileOwner, '') || '');
  },
  setProfileOwner(id) {
    return set(KEY.profileOwner, String(id || ''));
  },
  isProfileDirty() {
    return !!get(KEY.profileDirty, false);
  },
  setProfileDirty(v) {
    return set(KEY.profileDirty, !!v);
  },

  /** 收藏的归属账号 id（'' = 无主） */
  getFavoritesOwner() {
    return String(get(KEY.favOwner, '') || '');
  },
  setFavoritesOwner(id) {
    return set(KEY.favOwner, String(id || ''));
  },
  isFavoritesDirty() {
    return !!get(KEY.favDirty, false);
  },
  setFavoritesDirty(v) {
    return set(KEY.favDirty, !!v);
  },
};
