/**
 * 业务接口层（页面唯一数据入口）
 * ------------------------------------------------------------------
 * 页面只调用 api.xxx()，不关心数据来自本地还是后端。
 * 后端就绪后，只需在 utils/request.js 里填上 `baseUrl`（自建后端）
 * 或 `env`（微信云开发）其中之一，全部接口自动切到远端，页面代码零改动。
 *
 * 接口契约见项目根目录 `API接口契约.md`。
 *
 * ⚠️ 2026-09-24：本文件曾与一个**已下线的独立分包**共用一份整文件拷贝（分包读不到主包，只能复制）。
 *    该分包已整体移除，本文件现在**全项目唯一一份**，不需要再手工 cp。
 *    移除原因与恢复须知见仓库文档 `版本备注.md` §三.6（issue 记录属于仓库文档，不随包发布）。
 *    若将来恢复分包，务必把拷贝与 `tools/sync-data-copies.js` 的清单一起加回。
 */
const request = require('./request');
const store = require('./store');
const uni = require('../data/universities');
const matchEngine = require('./match');
const DEFAULT_CONTENT = require('../data/content');

/* ==================================================================
   本地适配器 —— 后端未部署时的完整实现
   ------------------------------------------------------------------
   ⚠️ 铁律：本地适配器**不得伪造任何用户身份**。
   这里曾经为了「演示好看」写死过一个 nickName，导致真机上直接显示出
   一个跟用户无关的账号名 —— 那是编造数据，已全部移除。
   本地模式下用户对象只有两种状态：
     a) 用户自己填过头像/昵称 → 返回真实填写的内容
     b) 从未填写过 → 返回空昵称 + isLocal 标记，页面显示「未设置昵称」
   ================================================================== */

/**
 * 规则版「个性化建议」
 * ------------------------------------------------------------------
 * 这是唯一的建议生成实现：从匹配结果的维度短板里推导出可执行建议。
 *
 * ⚠️ 运行期不接大模型 —— 本项目刻意不使用「文本生成合成」能力，
 *    因此无需算法备案与「深度合成-AI问答」类目（个人主体也申请不了）。
 *    边界依据与替代方案见根目录 `AI接入边界方案.md`。
 *    任何想在这里加模型调用的改动，都是把项目推向违规，先读那份文档。
 *
 * 文案一律取自内容层 `content.ai.templates`，**不在这里写死** ——
 * 预置文本同属运营内容，应能远程下发、能加句式，改文案不该发版。
 * 输出结构与「AI 版」保持兼容（数组 + title/detail），页面不必区分来源。
 */
function ruleSuggestions(result) {
  if (!result || !result.list || !result.list.length) return [];

  const scored = result.list.filter((s) => s.match !== null && s.dims && s.dims.length);
  if (!scored.length) return [];

  // 按维度求平均，找出最短的那块板。
  // ⚠️ 课程维度在「院校不拿 AP 当录取依据」或「考生没填 AP」时 value 为 null，必须跳过：
  //    直接相加会得到 NaN，整个建议列表算废；拿它当 0 又会把一个不适用的维度
  //    排成「最大短板」，让用户看到一条根本不存在的短板建议。
  const sum = { academic: 0, language: 0, curriculum: 0 };
  const cnt = { academic: 0, language: 0, curriculum: 0 };
  for (const s of scored) {
    for (const d of s.dims) {
      if (d.value === null || d.value === undefined) continue;
      sum[d.key] += d.value;
      cnt[d.key] += 1;
    }
  }
  const avg = {};
  Object.keys(sum).forEach((k) => {
    if (cnt[k]) avg[k] = Math.round(sum[k] / cnt[k]);
  });

  const ranked = Object.keys(avg).sort((a, b) => avg[a] - avg[b]);

  const T = (content().ai || {}).templates || {};
  const byDim = T.byDim || {};
  const structure = T.structure || {};
  const tiers = result.tiers || {};
  const out = [];

  // 短板建议：取均分最低的维度
  const weakest = byDim[ranked[0]];
  if (weakest) {
    const vars = { score: avg[ranked[0]], dim: ranked[0] };
    out.push({ title: tpl(weakest.title, vars), detail: tpl(weakest.detail, vars) });
  }

  // 结构性建议：短板与次短板差距 ≥12 分视为偏科明显，否则视为梯度已均衡
  const picked = avg[ranked[0]] < avg[ranked[1]] - 12 ? structure.gap : structure.balanced;
  if (picked) {
    out.push({ title: tpl(picked.title, tiers), detail: tpl(picked.detail, tiers) });
  }

  return out;
}

/**
 * 本地模式下的用户对象：从不预置身份信息。
 *
 * ⚠️ 返回的对象**恒带 `isLocal: true`**，它是本适配器的「送达语义」标记：
 *    与 feedback 的 `delivered` 是同一套约定 —— 本地实现可以「存下来」，
 *    但必须让调用方一眼看出**这份数据只在本机**（没同步到任何账号）。
 *    漏了这个标记，页面就会把「写进本机」显示成「已保存」。
 *    （同理：服务端 shapeUser 永远不带这个字段，两边不会撞。）
 */
function localUser() {
  const u = store.getUser();
  if (u && u.id) return Object.assign({}, u, { isLocal: true });
  return {
    id: 'local-' + Date.now(),
    nickName: '',
    avatarUrl: '',
    email: '',
    plan: '',
    isLocal: true,
  };
}

function activeSchools() {
  const overrides = (content().schoolOverrides && typeof content().schoolOverrides === 'object') ? content().schoolOverrides : {};
  return uni.SCHOOLS
    .map((school) => deepMerge(school, overrides[school.id] || {}))
    .filter((school) => school.visible !== false);
}

function activeSchool(id) {
  return activeSchools().find((school) => school.id === id) || null;
}

const local = {
  'auth.login': () => {
    const user = localUser();
    return Promise.resolve({
      // 本地模式的登录态只是「本机已建档」的标记，不代表任何真实身份
      token: 'local-' + user.id,
      user,
      mode: 'local',
      /** 页面据此提示：当前未接入后端，资料仅存本机 */
      offline: true,
    });
  },

  'auth.logout': () => {
    store.setSignedIn(false);
    return Promise.resolve({ ok: true });
  },

  'auth.session': () =>
    Promise.resolve(
      store.isSignedIn() ? { user: localUser(), mode: 'local', offline: true } : null
    ),

  /**
   * 读取用户资料
   * ------------------------------------------------------------------
   * ⚠️ **未登录必须返回 null**，与契约 4.2「未登录返回 data:null，不返回 401」逐字对齐。
   *
   *    这里曾经无条件返回 `localUser()`（Storage 里缓存的用户对象），压根不看登录态 ——
   *    于是「退出登录」之后账号页照样读得到昵称与头像：卡片上顶着你的名字，
   *    下面却没有「退出登录」按钮，界面同时在说「你是谁」和「你没登录」。
   *    云函数上的 `/v1/user/profile` 当时还没部署（501 → 静默回落本地）把这个 bug
   *    直接暴露在真机上；而它本身也违反了「双适配器语义一致」这条铁律 ——
   *    远端说「未登录没有资料」，本地却说「有」，两边不可能同时是对的。
   *
   *    注意：**不删 Storage 里的用户对象**。登出只是结束登录态，
   *    已填的昵称/头像属于「本机档案」，重新登录即可恢复（logoutConfirm 的承诺）。
   */
  'user.profile': () => Promise.resolve(store.isSignedIn() ? localUser() : null),

  'user.updateProfile': (patch) => {
    /**
     * ⚠️ 未登录一律 401 —— 与契约 4.2 的服务端行为同语义。
     *    没有这一条，就会写出「读的时候说没有资料、写的时候却写进了本机」这种自相矛盾：
     *    用户以为自己保存成功了，回到页面却什么都看不到（读取路径按登录态返回 null）。
     *    ⚠️ 登出后**不再**靠登录态是否被顺手点亮来兜底，见下方注释。
     */
    if (!store.isSignedIn()) {
      return Promise.reject(request.ApiError(401, '登录状态已失效，请重新登录'));
    }

    const next = Object.assign({}, localUser(), patch || {}, { isLocal: true });
    // ⚠️ 只写用户对象，**不顺手点亮登录态**。
    //    登录态属于 `login()` 的职责（那里已经 setSignedIn(true, user)）。
    //    这里曾经写成 `store.setSignedIn(true, next)`，后果是：
    //    用户在**未登录**状态下在个人资料页改了个昵称，本机就静默变成「已登录」——
    //    账号管理页随即出现「退出登录」，而用户从未登录、也没有任何账号。
    //    这是伪造状态，与「本地适配器不得伪造身份」是同一条红线。
    //    现在保持当前登录态不变（走到这里必然已登录）。
    store.setSignedIn(store.isSignedIn(), next);
    return Promise.resolve(next);
  },

  'user.stats': () => {
    const r = store.getResult();
    return Promise.resolve({
      /**
       * ⚠️ 没有匹配结果时必须是 **0**。
       *    这里曾经写的是 `26` —— 那是设计稿上「已匹配院校 26」这个**版式示意数字**，
       *    于是用户一次匹配都没跑过，账号页就显示「已匹配院校 26」。
       *    与「defaultAcademic 曾写死设计稿的 GPA 86」是同一类错误：
       *    设计稿只是版式模板，里面的数值不是产品默认值。
       */
      matched: r ? r.total : 0,
      favorites: store.favoriteCount(),
      // 文书功能尚未上线，恒为 0 —— 不要为了界面好看编一个数字
      documents: 0,
    });
  },

  'academic.get': () => Promise.resolve(store.getProfile()),
  'academic.save': (p) => {
    store.setProfile(p);
    return Promise.resolve(p);
  },
  'academic.reset': () => {
    store.resetProfile();
    return Promise.resolve(store.getProfile());
  },

  'favorites.list': () => Promise.resolve(store.getFavorites()),
  /**
   * ⚠️ 返回 `ids`（**有序**的完整列表），而不是只回 `{id, favorite}`。
   *    客户端的其它页面（收藏页的顺序、院校库的置顶）都以整份列表为准，
   *    让服务端返回完整列表可以省掉一次回读，也避免「本地算一遍、
   *    服务端又算一遍」两份口径。
   *    `isLocal: true` 是送达语义标记，与 localUser / feedback 同一套约定。
   */
  'favorites.toggle': (id) => {
    const added = store.toggleFavorite(id);
    return Promise.resolve({
      id,
      favorite: added,
      ids: store.getFavorites(),
      isLocal: true,
    });
  },

  'match.run': (profile) => {
    const r = matchEngine.run(profile || store.getProfile(), { schools: activeSchools(), content: content() });
    store.setResult(r);
    return Promise.resolve(r);
  },
  'match.latest': () => Promise.resolve(store.getResult()),
  'match.save': (result) => {
    store.setResult(result);
    return Promise.resolve(result);
  },

  /**
   * 个性化解读（规则模板实现）
   * ------------------------------------------------------------------
   * ⚠️ 本项目在**运行期不接大模型**（依据见根目录 `AI接入边界方案.md`）。
   *    所以这里永远返回 generatedBy:'rule' —— 那是事实，不是降级。
   *    绝不能改成 'ai'：页面会把该字段当来源标注展示给用户，
   *    虚标既是欺骗，也等于对外宣称自己在提供生成合成服务。
   *
   * 为什么不让模型算匹配分：
   *    分档必须可审计、可复现 —— 同一份成绩每次都要得到同样的结论。
   *    规则引擎负责算分与出建议，用户看到的每个字都来自内容层预置文案。
   */
  'ai.insight': (payload) => {
    const result = (payload && payload.result) || store.getResult();
    return Promise.resolve({
      text: (result && result.insight) || '',
      suggestions: ruleSuggestions(result),
      generatedBy: 'rule',
    });
  },

  'schools.list': (q) => {
    const query = q || {};
    let list = activeSchools().filter((school) => !query.region || query.region === 'all' || school.region === query.region);

    // 关键词：匹配中文名 / 英文名 / 城市
    const kw = (query.keyword || '').trim().toLowerCase();
    if (kw) {
      list = list.filter(
        (s) =>
          s.nameCn.indexOf(kw) > -1 ||
          s.nameEn.toLowerCase().indexOf(kw) > -1 ||
          s.cityCn.indexOf(kw) > -1 ||
          s.countryCn.indexOf(kw) > -1
      );
    }

    const sort = query.sort || 'default';
    if (sort === 'qs') list = list.slice().sort((a, b) => a.qs - b.qs);
    else if (sort === 'default') list = list.slice().sort((a, b) => a.qs - b.qs);

    return Promise.resolve({ total: list.length, list });
  },

  'schools.detail': (id) => {
    const s = activeSchool(id);
    if (!s) return Promise.reject(request.ApiError(404, '院校不存在'));
    const r = store.getResult();
    const scored = r ? r.list.find((x) => x.id === id) : null;
    return Promise.resolve({
      school: s,
      // ⚠️ 必须把 needData / reason / partialData 一并透出：
      //    详情页要据此区分「尚未采集」「官方不公布」与「部分维度无数据」三种情况，
      //    只传 score 会让三种情况在界面上长得一模一样。
      match: scored
        ? {
            score: scored.match,
            tier: scored.tier,
            dims: scored.dims,
            needData: !!scored.needData,
            reason: scored.reason || '',
            partialData: !!scored.partialData,
            missingDims: scored.missingDims || [],
          }
        : null,
      favorite: store.isFavorite(id),
      recommend: matchEngine.recommend(s, undefined, { schools: activeSchools(), content: content() }),
    });
  },

  /**
   * 运行期元信息（**职责已收窄**，契约见 API接口契约.md 4.7）
   * ------------------------------------------------------------------
   * ⚠️ 此处曾重复下发 season / countdownTarget / featureFlags ——
   *    与 /v1/content 的 home.season / home.countdownTarget / featureFlags
   *    是**同一事实的两份定义**，值还完全一样。
   *    两个接口的变更节奏不同，后端只改一处就会出现
   *    「以为生效了、实际没生效」的静默漂移；而本接口当时**零消费方**，
   *    漂移了也没人会发现。
   *    现已收窄为只返回真正属于「运行期元信息」的字段：
   *    申请季 / 倒计时目标日 / 功能开关**一律以 /v1/content 为唯一来源**。
   */
  'meta.config': () =>
    Promise.resolve({
      /** 院校数据编译时间，客户端可据此判断是否需要刷新本地数据 */
      dataVersion: uni.META.compiledAt,
    }),

  /**
   * 意见反馈
   * ------------------------------------------------------------------
   * ⚠️ 本地模式**收不到反馈** —— 这里只把它存进本机 Storage，并如实返回
   *    `delivered: false`，由页面提示「已保存到本机，尚未送达团队」。
   *
   *    绝不能返回一个看起来像提交成功的响应：那会让用户以为反馈已经发出去了，
   *    与「本地适配器不得伪造业务数据」是同一条红线。
   *
   *    校验规则与 API接口契约.md 4.8 保持一致 —— 否则本地能过、上线后被后端打回，
   *    变成只有真机才暴露的差异。
   */
  'feedback.submit': (d) => {
    const data = d || {};
    const cfg = content().feedback;

    const types = (cfg.types || []).map((t) => t.key);
    if (!data.type || (types.length && types.indexOf(data.type) < 0)) {
      return Promise.reject(request.ApiError(400, cfg.needType));
    }
    const text = String(data.content || '').trim();
    if (!text) return Promise.reject(request.ApiError(400, cfg.needDesc));
    if (text.length > cfg.descMax) {
      return Promise.reject(
        request.ApiError(400, tpl(cfg.descTooLong, { max: cfg.descMax }))
      );
    }

    const now = new Date();
    const ticketId = 'local-' + now.getTime();

    store.addFeedback({
      id: ticketId,
      type: data.type,
      content: text,
      /**
       * ⚠️ v1.0.3 起客户端**不再采集联系方式**（反馈页的输入卡已按平台审核意见删除），
       *    所以这里恒为空串。
       *    仍然保留该键是刻意的：契约 4.8 的 `contact` 字段还在（历史工单兼容），
       *    本地存档结构与云端保持一致，避免出现「有的条目没有这个键」的两种形状。
       *    ⚠️ 不要从别处把联系方式补回这个字段。
       */
      contact: String(data.contact || '').trim(),
      images: (data.images || []).slice(0, cfg.imageMax),
      schoolId: data.schoolId || '',
      /** 明确标记：本条只在本机，未送达 */
      delivered: false,
      createdAt: now.toISOString(),
    });

    return Promise.resolve({
      ticketId,
      createdAt: now.toISOString(),
      replyWithin: cfg.replyWithin,
      delivered: false,
    });
  },
};

/* ==================================================================
   远端适配器 —— 后端契约的真实调用
   ================================================================== */
const remote = {
  'auth.login': (payload) => request({ url: '/v1/auth/login', method: 'POST', data: payload, auth: false }),
  'auth.logout': () => request({ url: '/v1/auth/logout', method: 'POST' }),
  'auth.session': () => request({ url: '/v1/auth/session', method: 'GET' }),

  'user.profile': () => request({ url: '/v1/user/profile', method: 'GET' }),
  'user.updateProfile': (patch) => request({ url: '/v1/user/profile', method: 'PUT', data: patch }),
  'user.stats': () => request({ url: '/v1/user/stats', method: 'GET' }),

  'academic.get': () => request({ url: '/v1/academic/profile', method: 'GET' }),
  /**
   * ⚠️ `PUT /v1/academic/profile` 是**全量覆盖**（契约 4.3），幂等，允许重试。
   *    这三个端点此前没登记进云函数的 ROUTES，云开发路线上一直 501 →
   *    静默回落本地，于是「成绩只存本机」在真机上没人察觉。
   */
  'academic.save': (p) =>
    request({ url: '/v1/academic/profile', method: 'PUT', data: p, idempotent: true }),
  'academic.reset': () =>
    request({ url: '/v1/academic/profile/reset', method: 'POST', idempotent: true }),

  /**
   * 收藏
   * ------------------------------------------------------------------
   * ⚠️ `list` 必须把「云端没有这份数据 / 未登录」原样透出成 **null**，
   *    不能写成 `.then(d => d.ids || [])`：
   *    · `[]` 是「登录了、一所都没收藏」—— 这是权威答案；
   *    · `null` 是「拿不到云端数据」—— 此时必须回落本机。
   *    两者在同步逻辑里走**完全不同**的分支。把前者当后者，
   *    换设备登录时云端就会把本机收藏判成「空」，然后清掉。
   *
   * ⚠️ `toggle` 的方向由调用方传入（`adding`），不要在这一层猜。
   *    远端适配器此前只发 POST（只增不减、幂等），而本地实现是**真切换** ——
   *    这是契约 2.2 登记在案的已知偏离。收藏上云后它会变成
   *    「点一下没反应、再点还是收藏着」的静默缺陷（取消永远不会生效），
   *    所以随本次上云一并修掉：POST 收藏、DELETE 取消，两者都幂等。
   */
  'favorites.list': () =>
    request({ url: '/v1/favorites', method: 'GET' }).then((d) => (d && d.ids) || null),
  'favorites.toggle': (id, adding) =>
    request({
      url: '/v1/favorites/' + encodeURIComponent(id),
      method: adding ? 'POST' : 'DELETE',
      idempotent: true,
    }),

  'match.run': (profile) => request({ url: '/v1/match/run', method: 'POST', data: { profile }, idempotent: false }),
  'match.latest': () => request({ url: '/v1/match/latest', method: 'GET' }),
  'match.save': (result) => request({ url: '/v1/match/save', method: 'POST', data: { result }, idempotent: false }),

  /** AI 解读：走真实模型。prompt 由后端持有，前端只传结构化输入 */
  'ai.insight': (payload) =>
    request({ url: '/v1/ai/insight', method: 'POST', data: payload, idempotent: false }),

  'schools.list': (q) => request({ url: '/v1/schools', method: 'GET', data: q || {} }),
  'schools.detail': (id) => request({ url: '/v1/schools/' + id, method: 'GET' }),

  'meta.config': () => request({ url: '/v1/meta/config', method: 'GET', auth: false }),
  'feedback.submit': (d) => request({ url: '/v1/feedback', method: 'POST', data: d, idempotent: false }),

  /**
   * 订阅消息（反馈受理通知）。
   * `auth: false`：订阅按**微信身份（openid）**记录，不要求业务登录 ——
   * 与 `POST /v1/feedback` 同一条纪律（反馈是用户遇到问题时才会用的功能，
   * 而「登录不上」本身就是最高频的反馈类型，把最该收到的那批人挡在门外是错的）。
   */
  'notify.get': () => request({ url: '/v1/notify', method: 'GET', auth: false }),
  'notify.save': (d) => request({ url: '/v1/notify', method: 'PUT', data: d, auth: false, idempotent: true }),
};

/* ==================================================================
   内容与配置：远端下发 → 深合并到本地默认值
   ------------------------------------------------------------------
   页面上所有文案、列表、阈值都从这里取，因此运营改文案、
   开功能、调匹配权重都不需要重新发版。
   ================================================================== */

/**
 * 远端内容补丁在本地 Storage 中的存放位置。
 * ⚠️ 注意：这只是一个**存储键名**，不是密钥，也没有任何敏感值。
 *    （静态扫描工具曾因为它含 "KEY" 字样误报为硬编码凭据，故改名以示区分。）
 */
const CONTENT_PATCH_STORE = 'sp_content_patch';
let contentCache = null;

/** 深合并：对象递归、数组整体替换、标量覆盖 */
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = Object.assign({}, base || {});
    for (const k of Object.keys(patch)) {
      const b = base ? base[k] : undefined;
      const p = patch[k];
      const bothPlain =
        p && typeof p === 'object' && !Array.isArray(p) &&
        b && typeof b === 'object' && !Array.isArray(b);
      out[k] = bothPlain ? deepMerge(b, p) : p;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

function readPatch() {
  try {
    return wx.getStorageSync(CONTENT_PATCH_STORE) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 同步读取当前生效的内容（未加载过则用内置默认值）。
 *
 * ⚠️ 各页面 `data.c` 的初始值**必须**写成 `api.content()`，不要写 `{}`。
 *    写 `{}` 时首帧拿不到任何文案，界面要一直空等到 `loadContent()` 的远端
 *    请求返回（transport 为 cloud 时是真实网络往返，弱网/离线就是「白屏若干秒」），
 *    期间 nav-bar 的 `{{c.nav.x}}` 还会因求值为 undefined 触发类型不兼容告警。
 *    用本函数则首帧即有完整本地文案，远端补丁随后到达时由页面自行 setData 覆盖。
 *    本函数纯同步，只读内置默认值与本地缓存补丁，**不发任何请求**。
 */
function content() {
  if (!contentCache) contentCache = deepMerge(DEFAULT_CONTENT, readPatch() || {});
  return contentCache;
}

/** 从后端拉取内容配置并合并；后端不可用时静默回落到本地默认值 */
function loadContent() {
  if (!request.isReady()) {
    contentCache = deepMerge(DEFAULT_CONTENT, readPatch() || {});
    return Promise.resolve(contentCache);
  }
  return request({ url: '/v1/content', method: 'GET', auth: false })
    .then((remote) => {
      const patch = remote || {};
      try {
        wx.setStorageSync(CONTENT_PATCH_STORE, patch);
      } catch (e) {
        /* 缓存失败不影响本次生效 */
      }
      contentCache = deepMerge(DEFAULT_CONTENT, patch);
      return contentCache;
    })
    .catch(() => content());
}

/**
 * 模板插值：tpl('共 {count} 所院校', {count: 36})
 * 保证文案里的变量占位由后端可配，而不是前端拼字符串。
 */
function tpl(str, vars) {
  if (typeof str !== 'string') return str || '';
  return str.replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}

/** 功能开关 */
function flag(key) {
  const f = content().featureFlags || {};
  return f[key] !== false;
}

/* ==================================================================
   统计工具（页面共用）
   ================================================================== */

/**
 * 距目标日还有几天（目标日当天按 23:59:59 计，过期返回 0）。
 *
 * ⚠️ 目前**没有调用方** —— 首页那个「全局申请季倒计时」已刻意移除
 *    （各国各校截止时间不同，全局倒数日是假精度，详见 data/content.js 的 home.season 注释）。
 *    **保留此函数是有意的**：将来要做倒计时，正确的挂法是在院校详情页按
 *    「具体院校 × 具体申请轮次」算，那时直接复用这里，不必重写日期逻辑。
 *    若要清理，请连同这条注释一起删，别让它变成没人知道来历的死代码。
 */
function daysUntil(target) {
  if (!target) return 0;
  const end = new Date(String(target).replace(/-/g, '/') + ' 23:59:59');
  const diff = Math.ceil((end - new Date()) / 86400000);
  return diff > 0 ? diff : 0;
}

/**
 * 把提交反馈时的错误映射到内容层 `feedback.result.reasons` 的键。
 * 永远会返回一个键（兜底 `default`）—— 结果页必须有一句能看的失败原因，
 * 不能出现空白格子。
 */
function feedbackReasonKey(err) {
  const code = err && err.code;
  if (code === 'TIMEOUT') return 'TIMEOUT';
  if (code === 'NETWORK' || code === 'NO_BACKEND') return 'NETWORK';
  if (typeof code === 'number' && code >= 500) return 'SERVER';
  // 400：页面已做前置校验，正常流程不该走到这里；真走到就如实说「内容不符合要求」
  if (typeof code === 'number' && code === 400) return 'INVALID';
  return 'default';
}

/**
 * ISO 时间 → `YYYY-MM-DD HH:mm`（取本机时区）。
 * 刻意不引入日期库：小程序对体积敏感，而这里只需要一种固定格式。
 * 无法解析时返回空串，由页面回落到占位文案，不抛错。
 */
function formatDateTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) +
    ':' + p(d.getMinutes())
  );
}

/**
 * 头像落地：把 `bindchooseavatar` 给的**临时路径**变成可以长期使用的地址
 * ------------------------------------------------------------------
 * 为什么必须有这一步（而不是直接把回调里的路径存下来）：
 *   chooseAvatar 返回的是 `http://tmp/...` 这类**临时文件路径**，
 *   小程序重启后即失效 —— 头像会变白。用户会认为「我明明设过头像，它自己丢了」。
 *
 * 两条路线的落点不同，语义**也不同**，必须如实区分：
 *   · 远端：走 `wx.uploadFile`（REST）或 `wx.cloud.uploadFile`（云开发）上传，
 *          拿永久地址。契约 4.8 的 `POST /v1/upload` **不走统一响应包装**，
 *          直接返回 `{ fileId, url, width, height }`；
 *          云开发路线走 `request.upload` 的 cloud 分支，只返回 `{ fileId }`
 *          （cloud:// 的 fileID 本身就能直接喂给 `<image src>`，故两者都可作 url）。
 *   · 本地：没有后端可传，用 `saveFile` 转存到小程序用户目录 ——
 *          永久，但**只在本机**，换设备不会有。
 *
 * 返回 `{ url, mode, volatile }`：
 *   mode === 'remote' → url 是可同步的永久地址，可以写进账号；
 *   mode === 'local'  → url 只在本机有效，**不要**把它当成能同步的地址（会污染云端数据）；
 *   volatile === true → 连转存都失败了（url 仍是临时路径），
 *                       页面必须如实提示「仅本次有效」，不能假装保存成功。
 */
function saveAvatar(tempPath) {
  if (!tempPath) return Promise.reject(request.ApiError(400, '缺少头像文件'));

  if (!request.isReady()) {
    return new Promise((resolve) => {
      wx.getFileSystemManager().saveFile({
        tempFilePath: tempPath,
        success: (res) => resolve({ url: res.savedFilePath, mode: 'local', volatile: false }),
        fail: () => resolve({ url: tempPath, mode: 'local', volatile: true }),
      });
    });
  }

  return request.upload(tempPath, { url: '/v1/upload', dir: 'avatar' }).then((r) => ({
    // 云开发只回 fileId、REST 回 url，取到哪个用哪个（两者都能作 image 的 src）
    url: (r && (r.url || r.fileId)) || '',
    mode: 'remote',
    volatile: false,
  }));
}

/**
 * 生成个性化解读
 * ------------------------------------------------------------------
 * ⚠️ 当前实现**恒走规则模板**：`content.ai.enabled` 被刻意钉死为 false
 *    （见 `data/content.js` 的边界声明），下面的远端分支不可达。
 *    这是设计，不是遗漏 —— 不要「顺手修一下」。
 *
 * 为什么把这个分支留着而不是删掉：
 *    「规则引擎 vs 大模型」在本项目里是**主体资质问题**，不是技术选型 ——
 *    个人主体申请不了「深度合成-AI问答」类目，所以只能走规则模板。
 *    将来若升级企业主体并完成算法备案，打开开关即可启用，前端零改动。
 *
 * ⚠️ 启用前必读根目录 `AI接入边界方案.md`，那里列了备案、内容标识、
 *    审核留痕、安全评估的全部前置条件。条件未齐就把 enabled 改成 true，
 *    等于把项目直接推到违规状态。
 *
 * 无论走哪条路，返回结构一致，页面不关心来源，但**必须展示来源标注**。
 */
function getInsight(profile, result) {
  const c = content();
  const aiCfg = c.ai || {};

  if (!aiCfg.enabled || !request.isReady()) {
    return local['ai.insight']({ profile, result });
  }

  const timeout = aiCfg.timeout || 20000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(request.ApiError('AI_TIMEOUT', 'AI 解读超时')), timeout)
  );

  return Promise.race([
    remote['ai.insight']({ profile, result }),
    timeoutPromise,
  ]).catch(() => {
    // AI 不可用时静默回落，用户不会看到空白
    return local['ai.insight']({ profile, result });
  });
}

/* ==================================================================
   门面：按后端可用性自动路由；远端失败时可选择回落本地
   ================================================================== */
/** 只读类接口：网络故障时回落本地内置数据，保证弱网可用 */
/**
 * 只读接口失败时，能不能安全地回落到本机缓存？
 * ------------------------------------------------------------------
 * ⚠️ **401 不能**。会话失效是「登录态问题」，不是「读不到数据」：
 *    必须把它暴露给上层去引导重新登录，拿本机缓存掩盖过去，
 *    用户会以为自己还登着、还在同步，实际下一次写就全落到 401。
 *    `call()` 自己的降级判定也写着 `err.code !== 401`，这里沿用同一口径 ——
 *    同一个文件里两套判据迟早会漂。
 *
 * 其余失败（网络超时 / 500 / 云端故障）都算「这次读不到」：
 * 本机就是写路径的落地（saveAcademic 每次先写本机），
 * 回落到它不会丢任何东西，也不会像 syncAcademic 那样
 * 把「读不到」误判成「云端是空的」去做覆盖决策 —— 本函数只读不写。
 */
function canFallbackRead(err) {
  return !err || err.code !== 401;
}

const FALLBACK_LOCAL = ['schools.list', 'schools.detail', 'meta.config'];

function call(name, payload, arg) {
  if (!request.isReady()) {
    return local[name](payload, arg);
  }
  return remote[name](payload, arg).catch((err) => {
    // ① 后端尚未实现该端点（501）
    //    —— 在云开发路线上这是**常态**：云函数按业务优先级逐个补，
    //    没轮到的先由本地实现兜住。没有这一条，接入过程就是「全有或全无」：
    //    只要有一个端点没写完，对应功能就会从「能用」变成「报错」。
    //
    //    ⚠️ 回落时必须保留本地实现的原样语义，**不要在这里补 delivered / ok 之类的字段**。
    //       本地实现返回 delivered:false 是有意的（只存本机、团队收不到），
    //       补成 true 就是在骗用户，踩项目的数据真实性红线。
    if (request.transport() === 'cloud' && err && err.code === 501 && typeof local[name] === 'function') {
      return local[name](payload, arg);
    }
    // ② 只读类接口允许降级到内置数据，保证弱网/后端故障时功能可用
    if (FALLBACK_LOCAL.indexOf(name) > -1 && err && err.code !== 401) {
      return local[name](payload, arg);
    }
    throw err;
  });
}

/* ==================================================================
   订阅消息（反馈受理通知）
   ==================================================================
   微信给小程序留的主动触达通道只有「订阅消息」一条，而个人主体只能申请到
   **一次性订阅** —— 规则是「授权一次 = 可下发一条」。所以这里没有
   「长期开关」，只有「当前有没有一条待用的授权」。

   ⚠️ 这两个接口**刻意不走 `call()`**，与成绩 / 收藏的同步是同一条纪律：
      `call()` 收到 501 会静默回落到本地实现，于是一个**尚未部署**的端点
      会被界面显示成「已开启」—— 用户以为开好了，服务端却一无所知，
      后台受理时根本没有收件人。这是「界面在撒谎」，而且**没有任何报错**。
      ⇒ 拿不到就如实说拿不到，宁可显示「暂未开放」。

   ⚠️ 也**不写本机缓存**：订阅状态是「微信身份维度的服务端事实」（授权额度
      在微信那边，不在我们手里），在本机缓存一份只会制造
      「本机说开着、服务端说没有」的第二种真相。离线时如实显示不可用即可。
   ================================================================== */

/**
 * 「这次拿不到云端订阅状态」的哨兵。
 * ⚠️ 刻意不用 `null` —— `null` 是「问到了，你没有订阅记录」这个**有效答案**，
 *    两者在页面上是两种状态（未开启 vs 暂未开放），合并会把
 *    「端点没部署」伪装成「你还没开启」。
 */
const NOTIFY_UNAVAILABLE = { unavailable: true };

/**
 * 订阅状态推导 —— **全项目唯一口径**（消息通知页与「我的」列表共用）。
 * ------------------------------------------------------------------
 * ⚠️ 判定顺序不能换，五态不能合并成「开 / 关」两态：
 *    · 能力没配好（模板未申请 / 运营关闭）→ `unavailable`
 *    · 能力有、但这次没读到              → `unknown` ←「不知道」≠「没有」
 *    · 授权过、还没用掉                  → `ready`   ← 这才是「开着」
 *    · 额度已随某次通知用掉              → `used`
 *    · 问到了、没有任何记录              → `off`
 *
 *    把 `unknown` 说成 `off`，等于把「不知道」谎报成「没有」；
 *    把 `used` 说成 `off`，用户会以为自己从没开过。
 *    （与匹配页「`tier === undefined` 不得渲染」是同一条纪律。）
 *
 * @param {object|null} remote 云端状态；`null` = 问到了但没有记录，
 *                             `{unavailable:true}` = 没问到
 * @param {object} cfg 内容层 `content().notify`
 * @returns {'off'|'ready'|'used'|'unavailable'|'unknown'}
 */
function resolveNotifyStatus(remote, cfg) {
  const usable =
    !!cfg && cfg.enabled !== false && Array.isArray(cfg.tmplIds) && cfg.tmplIds.length > 0;
  if (!usable) return 'unavailable';
  if (!remote) return 'off';
  if (remote.unavailable) return 'unknown';
  if (remote.accepted === true) return 'ready';
  if (remote.usedAt) return 'used';
  return 'off';
}

/**
 * 读取订阅状态。
 * @returns {Promise<{unavailable:true}|{accepted:boolean,acceptedAt:string,usedAt:string,usedTicketId:string}|null>}
 *   `null`          —— 问到了，没有订阅记录 → 页面显示「未开启」
 *   `{unavailable}` —— 没问到（未接后端 / 网络失败 / 端点 501）→ 页面显示「暂未开放」
 */
function getNotify() {
  if (!request.isReady()) return Promise.resolve(NOTIFY_UNAVAILABLE);
  return remote['notify.get']().catch(() => NOTIFY_UNAVAILABLE);
}

/**
 * 上报一次订阅授权结果。
 * ------------------------------------------------------------------
 * ⚠️ **不吞错**。它是在用户于微信授权框里点过「允许」之后才调用的，
 *    写不上去必须让用户知道 —— 否则界面显示「已开启」而服务端没有记录，
 *    后台受理时不会给他发通知，双方都会以为是对方的问题。
 *    （与 `saveAcademic` 的「写失败也要暴露」同理。）
 */
function saveNotify(patch) {
  if (!request.isReady()) {
    return Promise.reject(request.ApiError(503, '通知服务暂未开放'));
  }
  return remote['notify.save'](patch);
}

/* ==================================================================
   跨设备同步（成绩档案 / 收藏）
   ==================================================================
   目标：用户换一台设备登录后，看到的是**自己账号里**的成绩与收藏。

   ── 判据：本机这份数据「属于谁」 ──────────────────────────────────
   每个数据块在本机带两个标记（见 utils/store.js 的「同步状态」一节）：
     owner —— 上次成功同步给哪个账号（'' = 无主，还没同步给任何人）
     dirty —— 本机有**尚未成功推到云端**的改动

   登录那一刻的仲裁规则：

   | 云端          | 本机              | 动作            | 为什么这么定 |
   |---|---|---|---|
   | 没有数据      | 有内容            | 本机**上传**    | 否则「先试用、后登录」的用户一登录就发现自己填的成绩没了 |
   | 没有数据      | 也空              | 什么都不做      | 写一份空档案上去会让「从未填写」变成一条记录，管理台凭空多一个用户数据 |
   | 有数据        | owner 是别人      | 云端**覆盖**    | 这台设备上次登的是别的账号，绝不能把 A 的成绩带给 B —— 这是隐私边界，不是体验问题 |
   | 有数据        | dirty / 有改动    | **合并**后回写  | 整份用云端会丢掉本机离线改的内容 |
   | 有数据        | 干净、同一主人    | 云端**覆盖**    | 常规的「换设备登录」走这条 |

   合并口径统一为一条原则：**dirty 说明「本机刚改过」，那本机就是更新的
   那一份**。
     · 档案：按**字段**合并 —— 本机有值的字段用本机，本机为空的用云端补；
     · 收藏：**本机整份为准**，并把差异同步到云端（包括删掉云端多出来的）。
   两侧都遵循「宁可多不可少，但绝不让用户的删除动作复活」。

   ⚠️ 两条铁律，违反任何一条都会静默丢数据：
   ① **同步直连远端，不走 `call()`**。`call()` 会把 501 静默回落成本地，
      那样「云端没有这份数据」与「端点还没实现」就分不开了 ——
      前者该把本机推上去，后者该什么都不做。搞反就是数据事故。
   ② 云端读不到（501 / 网络失败 / 401）时**立刻放弃本次同步，本机一个字节
      都不动**。绝不能把「读不到」当成「云端是空的」。
   ================================================================== */

/** 「这次拿不到云端数据」的哨兵。刻意不用 null/undefined —— 那两者是有效答案 */
const SYNC_UNAVAILABLE = { unavailable: true };

/**
 * 当前账号标识。
 * ⚠️ `local-…` 是本机适配器编的占位 id（见 localUser），每次登录都会变，
 *    不是账号。拿它当 owner 会让归属判定永远不匹配，进而每次登录都走
 *    「云端覆盖本机」——用户本机刚填的东西会被清掉。
 */
function currentUserId() {
  const u = store.getUser();
  const id = (u && u.id) || '';
  return id && id.indexOf('local-') !== 0 ? id : '';
}

/** 值算不算「空的」。嵌套对象全空也算空（如 coursesMap 四个体系都为空） */
function isEmptyValue(v) {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).every((k) => isEmptyValue(v[k]));
  return false;
}

/**
 * 本机档案里有没有用户**真实填写**的内容。
 * ⚠️ 刻意不看 `curriculum` / `gpaScale` —— 那是初始态就有的值。
 *    把「从未填过」的档案判成有内容，首次登录就会把一份空档案推上云端，
 *    覆盖掉另一台设备上的真实成绩。
 */
function hasAcademicData(p) {
  if (!p) return false;
  if (!isEmptyValue(p.gpa) || !isEmptyValue(p.ielts) || !isEmptyValue(p.toefl) || !isEmptyValue(p.sat)) return true;
  if (!isEmptyValue(p.countries) || !isEmptyValue(p.majors)) return true;
  return !isEmptyValue(p.coursesMap);
}

/**
 * 档案合并：**本机优先，本机为空的字段用云端补**。
 * ------------------------------------------------------------------
 * 方向为什么是「本机优先」：这个函数只在**本机 dirty**（有没成功推上去的
 * 改动）时被调用，而 dirty 的含义正是「用户在这台设备上刚改过」。
 * 若反过来让云端优先，用户刚填的均分会被另一台设备的旧值盖回去 ——
 * 那正是这个分支要防的事。
 * 而本机没填的字段从云端补回来，保证也不会因为「本机比较旧」而丢数据。
 *
 * ⚠️ 已知取舍：用户在本机**清空**某个字段、且这次清空没推上去就登录时，
 *    该字段会从云端被补回来（清空「看起来没生效」）。
 *    这是「宁可多不可少」的必然代价 —— 用户重新清一次即可，而丢数据
 *    是找不回来的。（正常的清空路径是 saveAcademic 直推云端，不经过这里。）
 */
function mergeAcademic(localP, cloudP) {
  const out = Object.assign({}, cloudP || {});
  const base = localP || {};
  for (const k of Object.keys(base)) {
    if (!isEmptyValue(base[k])) out[k] = base[k];
  }
  return out;
}

/** 把云端档案落到本机并标好归属 */
function adoptAcademic(uid, academic) {
  const clean = Object.assign({}, academic || {});
  // `updatedAt` 是服务端盖的审计时间戳，不属于用户数据 —— 不写进本机档案，
  // 否则它会随下次 PUT 原样回传（服务端会忽略，但本机多了一个没人消费的字段）
  delete clean.updatedAt;
  store.setProfile(clean);
  store.setProfileOwner(uid);
  store.setProfileDirty(false);
  return academic;
}

/** 把云端收藏列表落到本机并标好归属 */
function adoptFavorites(uid, ids) {
  store.setFavorites(ids || []);
  store.setFavoritesOwner(uid);
  store.setFavoritesDirty(false);
  return store.getFavorites();
}

/** 推送档案到云端。失败时保持 dirty（本机那一份已经写好了） */
function pushAcademic(p, uid) {
  return remote['academic.save'](p).then(
    (saved) => {
      adoptAcademic(uid, saved || p);
      return { ok: true };
    },
    () => {
      store.setProfileDirty(true);
      return { ok: false };
    }
  );
}

/**
 * 让**云端的收藏列表等于** `ids`（差异同步：该加的加、该删的删）。
 * ------------------------------------------------------------------
 * ⚠️ 不只是「把缺的补上」—— **还要删掉多余的**。否则用户在这台设备上
 *    取消的收藏会在下次同步时从云端「复活」（云端还留着它），
 *    而这个缺陷不会报错，用户只会觉得「我明明取消了，怎么又回来了」。
 *
 * ⚠️ 服务端只有「逐条收藏 / 取消」（契约 4.4），没有整份替换端点，
 *    所以这里逐条发。收藏是低频操作、数量很小，不值得为同步新增契约端点。
 *    串行发送：并发写同一份用户文档会互相覆盖（服务端用事务挡住了丢更新，
 *    但顺序会乱），而这里连顺序都不重要 —— 只关心最终集合对不对。
 *
 * @param {string[]} ids      目标列表
 * @param {string[]} have     云端当前的列表（用于算差异）
 * @param {string} action     记在返回值里，仅供测试与诊断
 */
function syncFavoritesTo(ids, uid, have, action) {
  const want = (Array.isArray(ids) ? ids : []).slice();
  const cur = (Array.isArray(have) ? have : []).slice();

  // 先把云端多出来的删掉，再补上缺的 —— 顺序反过来会让「取消」被后面的
  // 「新增」盖住（同一所既在 want 又不在 cur 时不会冲突，但可读性更差）
  //
  // ⚠️ 新增项要**逆序**发送：服务端每收一条就把它前插（unshift），
  //    正序发会让最终顺序整体颠倒 —— 而本机的顺序是「最近收藏在前」，
  //    颠倒了就会让「首次上云」后的收藏页顺序整个反过来。
  const steps = cur
    .filter((id) => want.indexOf(id) < 0)
    .map((id) => () => remote['favorites.toggle'](id, false))
    .concat(
      want
        .filter((id) => cur.indexOf(id) < 0)
        .reverse()
        .map((id) => () => remote['favorites.toggle'](id, true))
    );

  const run = (i) => {
    if (i >= steps.length) return Promise.resolve(true);
    return steps[i]().then(
      () => run(i + 1),
      () => false
    );
  };

  return run(0).then((allOk) => {
    if (allOk) {
      // 以**目标列表**为准，而不是最后一条响应的 ids —— 逐条发送时
      // 每条响应的 ids 都只是当时的快照，拿最后一条会漏掉前面的。
      adoptFavorites(uid, want);
      return { action, ok: true };
    }
    store.setFavoritesDirty(true);
    return { action, ok: false };
  });
}

function syncAcademic(uid) {
  return remote['academic.get']().then(
    (cloud) => {
      const localP = store.getProfile();
      const owner = store.getProfileOwner();
      const dirty = store.isProfileDirty();

      // ① 云端还没有这份档案
      if (cloud === null || cloud === undefined) {
        if (!hasAcademicData(localP)) {
          store.setProfileOwner(uid);
          store.setProfileDirty(false);
          return { action: 'none' };
        }
        return pushAcademic(localP, uid).then((r) => ({ action: r.ok ? 'push' : 'deferred' }));
      }

      // ② 本机这份属于**另一个账号** → 云端覆盖，不做任何合并（隐私边界）
      if (owner && owner !== uid) {
        adoptAcademic(uid, cloud);
        return { action: 'replace' };
      }

      // ③ 本机有未上云的改动 → 合并后回写，两边都不丢
      if (dirty) {
        return pushAcademic(mergeAcademic(localP, cloud), uid).then((r) => ({
          action: r.ok ? 'merge' : 'deferred',
        }));
      }

      // ④ 常规：干净的同主人档案，云端为准（换设备登录走这条）
      adoptAcademic(uid, cloud);
      return { action: 'pull' };
    },
    () => SYNC_UNAVAILABLE
  );
}

function syncFavorites(uid) {
  return remote['favorites.list']().then(
    (cloudIds) => {
      const localIds = store.getFavorites();
      const owner = store.getFavoritesOwner();
      const dirty = store.isFavoritesDirty();

      // ① 云端还没有这份列表 → 把本机这一份认领上去
      if (cloudIds === null || cloudIds === undefined) {
        if (!localIds.length) {
          store.setFavoritesOwner(uid);
          store.setFavoritesDirty(false);
          return { action: 'none' };
        }
        return syncFavoritesTo(localIds, uid, [], 'push');
      }

      // ② 属于另一个账号 → 云端覆盖（不把上个账号的收藏带过来）
      if (owner && owner !== uid) {
        adoptFavorites(uid, cloudIds);
        return { action: 'replace' };
      }

      // ③ 本机有未同步的改动（离线收藏过 / 上次推送失败）→ **本机为准**，
      //    并把差异同步到云端（含「删掉云端多出来的」）。与档案合并同一原则：
      //    dirty 意味着本机刚改过，本机就是更新的那一份。
      if (dirty) {
        return syncFavoritesTo(localIds, uid, cloudIds, 'replace-dirty');
      }

      // ④ 常规：云端为准（换设备登录走这条）
      adoptFavorites(uid, cloudIds);
      return { action: 'pull' };
    },
    () => SYNC_UNAVAILABLE
  );
}

/**
 * 登录后做一次跨设备同步（成绩档案 + 收藏）。
 * ------------------------------------------------------------------
 * 由 `login()` 在登录成功后自动调用，**不需要页面各自记得调**。
 *
 * ⚠️ 永不 reject：任何失败都已经在内部被降级成 `SYNC_UNAVAILABLE`
 *    或某个数据块自己的兜底分支。同步是「登录的一个附加动作」，
 *    它失败不该让用户看到「登录失败」—— 那会让人以为账号出问题了。
 *
 * @returns {Promise<{skipped: string, academic?: object, favorites?: object}>}
 *   skipped 取值：'' 正常执行 / 'not-signed-in' 未登录 / 'no-backend' 没配后端
 */
function syncUserData() {
  if (!request.isReady()) return Promise.resolve({ skipped: 'no-backend' });
  const uid = currentUserId();
  // 拿不到账号标识就什么都不做 —— 这不是「跳过同步」的小事：
  // uid 为空时 rules 表里的「owner 是别人」分支会被误判，可能清掉本机数据
  if (!uid) return Promise.resolve({ skipped: 'not-signed-in' });

  return Promise.all([syncAcademic(uid), syncFavorites(uid)]).then(
    ([academic, favorites]) => ({ skipped: '', academic, favorites }),
    () => ({ skipped: '', academic: SYNC_UNAVAILABLE, favorites: SYNC_UNAVAILABLE })
  );
}

/* ==================================================================
   成绩档案的写回队列
   ------------------------------------------------------------------
   为什么需要它：match 页每改一个选项（切课程体系、改均分、点一个
   目标国家…）都会 `persist()` 一次，也就是说**连点三下就是三个并发 PUT**。
   云开发的 PUT 是全量覆盖，网络乱序返回时后到的旧值会盖掉新值 ——
   云端停在某个中间状态，而本机看着是对的。更糟的是此时 dirty 已被清掉，
   下次登录「云端覆盖本机」，用户最后那次改动就凭空没了。
   所以这里做「单飞 + 合并」：飞行中只保留最新一份，落地后再发它。
   ================================================================== */
let acadPending = null;
let acadFlush = null;

function drainAcademic(uid) {
  if (!acadPending) return Promise.resolve(null);
  const job = acadPending;
  acadPending = null;

  return remote['academic.save'](job.profile).then(
    (saved) => {
      adoptAcademic(uid, saved || job.profile);
      if (acadPending) return drainAcademic(uid); // 期间又改了 → 继续发最新的
      store.setProfileDirty(false);
      return Object.assign({}, job.profile, { isLocal: false });
    },
    () => {
      if (acadPending) return drainAcademic(uid);
      /**
       * 云端这次没成功：本机那一份已经在 saveAcademic 里写好，标 dirty 等下次同步。
       * ⚠️ 这一步**必须真的标**。少了它，这次失败会被彻底遗忘 ——
       *    下次登录时走「云端覆盖本机」，用户刚改的分数就丢了，
       *    而且不留任何痕迹（没有报错、没有提示，甚至没有脏标记）。
       *    tools/test-cloud-sync.js 场景 6 就是用来守住它的。
       */
      store.setProfileDirty(true);
      return Object.assign({}, job.profile, { isLocal: true });
    }
  );
}

/**
 * 保存成绩档案（门面）—— 「本机先落地，云端随后追」
 * ------------------------------------------------------------------
 * ① **永不丢数据**：云端写失败（离线 / 超时 / 端点尚未部署）时，本机这一份
 *    照常写成功并标 dirty，下次登录同步会被推上去。
 *    直接 reject 的话，match 页的 `persist()`（fire-and-forget）会产生
 *    未处理的 rejection，而用户的改动**只在内存里**、一退出就没了。
 * ② 本机只是**缓存**：写成功后本机与云端同值，未登录/离线时读本机仍有数据。
 * ③ 返回值里的 `isLocal` 与 localUser / feedback 同一套「送达语义」约定。
 */
function saveAcademic(p) {
  local['academic.save'](p); // 本机先落地

  /**
   * ⚠️ 未登录时**不要**发这一次 PUT：服务端必定回 401，
   *    而我们已经知道结果，白跑一趟只是多一次往返与一条错误。
   *    语义也更干净 —— 未登录时本机就是唯一数据源。
   */
  if (!request.isReady() || !store.isSignedIn()) {
    store.setProfileDirty(true);
    return Promise.resolve(Object.assign({}, p, { isLocal: true }));
  }

  const uid = currentUserId();
  acadPending = { profile: p, uid };
  if (acadFlush) return acadFlush; // 已在处理中，等它把这一份一起带走

  acadFlush = drainAcademic(uid).then((r) => {
    acadFlush = null;
    return r || Object.assign({}, p, { isLocal: false });
  });
  return acadFlush;
}

/**
 * 重置成绩档案（门面）。频率极低，不需要队列。
 * ⚠️ 未登录 / 云端不可用时回落本机重置 —— 用户点「重置」就该看到表单清空，
 *    而不是一个错误提示（本机清空是**真实**发生的，不是假成功）。
 */
function resetAcademic() {
  if (!request.isReady() || !store.isSignedIn()) {
    const v = local['academic.reset']();
    store.setProfileDirty(true);
    return Promise.resolve(Object.assign({}, v, { isLocal: true }));
  }
  return remote['academic.reset']().then(
    (saved) => {
      const v = saved || local['academic.reset']();
      local['academic.save'](v);
      store.setProfileOwner(currentUserId());
      store.setProfileDirty(false);
      return v;
    },
    () => {
      const v = local['academic.reset']();
      store.setProfileDirty(true);
      return Object.assign({}, v, { isLocal: true });
    }
  );
}

/**
 * 收藏 / 取消收藏（门面）
 * ------------------------------------------------------------------
 * ⚠️ **方向必须在客户端定**（本机现在是收藏着还是没有），再决定发 POST
 *    还是 DELETE。服务端两个端点都是幂等的「设定为目标状态」，
 *    不能让它自己 toggle —— 那在重试时会把「收藏」翻成「取消」。
 *
 * ⚠️ 云端写失败时**不抛错**，而是回落本机并标 dirty：
 *    四个调用方（院校库 / 收藏页 / 详情页 / 首页）写的都是
 *    `.then(r => r.favorite)`，抛出去只会得到一个未处理的 rejection 与
 *    「点了没反应」——用户既不知道成功也不知道失败。
 *    回落本机是**真实**发生的（本机确实收藏了），并会在下次同步时并上云端，
 *    因此不构成「假成功」；返回值里的 `isLocal` 让页面可以如实区分文案。
 */
function toggleFavorite(id) {
  const adding = !store.isFavorite(id);

  /**
   * ⚠️ 未登录时同样不必发请求：服务端必然回 401，
   *    而「未登录时收藏写在本机」本来就是正确语义（登录后会补传上去）。
   */
  if (!request.isReady() || !store.isSignedIn()) {
    const r = local['favorites.toggle'](id);
    store.setFavoritesDirty(true);
    return r;
  }

  return remote['favorites.toggle'](id, adding).then(
    (r) => {
      // 服务端返回的是**它的完整列表**，直接采信 —— 本机自己算一遍
      // 就会出现两份口径（顺序、并发时的差异都会表现在这里）
      const ids = r && r.ids;
      if (ids) store.setFavorites(ids);
      else local['favorites.toggle'](id);
      store.setFavoritesOwner(currentUserId());
      store.setFavoritesDirty(false);
      return {
        id,
        favorite: !!(r && r.favorite),
        ids: store.getFavorites(),
        isLocal: false,
      };
    },
    () => {
      const r = local['favorites.toggle'](id);
      store.setFavoritesDirty(true);
      return {
        id,
        favorite: r.favorite,
        ids: store.getFavorites(),
        isLocal: true,
      };
    }
  );
}

/* ------------------------------------------------------------------
   登录态管理
   ------------------------------------------------------------------ */
request.setUnauthorizedHandler(() => {
  store.setSignedIn(false);
});

/**
 * 微信登录
 * 流程：wx.login 取 code → 换取后端自定义登录态
 * 本地模式下直接签发占位 token，便于无后端时跑通全流程。
 */
function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) return reject(request.ApiError('WX_LOGIN_FAIL', '获取微信登录凭证失败'));
        call('auth.login', { code: res.code })
          .then((data) => {
            request.setToken(data.token);
            store.setSignedIn(true, data.user);
            /**
             * 登录成功后**立刻**做一次跨设备同步（成绩档案 + 收藏）。
             * ------------------------------------------------------------------
             * 放在这里而不是各个页面里：任何调用 api.login() 的入口（登录页、
             * 将来可能的手机号登录）都自动获得同步能力，不会漏。
             * 用户点完登录、进到匹配页，看到的就是**自己账号里**的成绩。
             *
             * ⚠️ 同步失败**不影响登录结果**。`syncUserData()` 内部已把所有失败
             *    降级处理、永不 reject；这里再兜一层 catch 是防止将来某个分支
             *    写漏 —— 那时用户会看到「登录失败」，而其实已经登录了。
             */
            return syncUserData()
              .catch(() => null)
              .then(() => data);
          })
          .then(resolve)
          .catch(reject);
      },
      fail: () => reject(request.ApiError('WX_LOGIN_FAIL', '微信登录已取消')),
    });
  });
}

function logout() {
  return call('auth.logout').then((r) => {
    request.clearToken();
    store.setSignedIn(false);
    return r;
  });
}

/**
 * 启动时恢复会话
 * ------------------------------------------------------------------
 * ⚠️ REST 与 cloud 两条路线的「有没有登录过」判据不同，不要统一成一句
 *    `if (!token) return null`：
 *
 *    · REST ：登录态是后端签发的自定义 token，没 token 就是没登录过，
 *             直接返回 null **省掉一次网络请求**；
 *    · cloud：根本没有 token（身份由云函数侧的 openid 承载，见
 *             cloudfunctions/api/handlers/auth.js 头部说明），
 *             若沿用 token 判据会**永远**判定为未登录 ——
 *             用户点过登录、下次进来又是未登录，且不会报任何错。
 *
 *    所以 cloud 路线必须真的问一次服务端（auth.session 未登录时返回
 *    data:null，不是 401，因此这次探测是静默的，不会弹「登录已过期」）。
 */
function restoreSession() {
  if (!request.isReady()) {
    return Promise.resolve(store.isSignedIn() ? store.getUser() : null);
  }
  if (request.transport() === 'rest' && !request.getToken()) {
    return Promise.resolve(null);
  }
  return call('auth.session').then((d) => {
    // 服务端明确无会话时清掉旧状态，不能让本机残留用户继续显示已登录。
    store.setSignedIn(!!(d && d.user), d && d.user);
    return d ? d.user : null;
  });
}

module.exports = {
  /** 底层，供特殊场景直接调用 */
  request,

  /* ---- 内容与配置（页面文案、枚举、阈值、开关的唯一来源） ---- */
  content,
  loadContent,
  tpl,
  flag,

  /* ---- 认证 ---- */
  login,
  logout,
  restoreSession,
  isSignedIn: () => store.isSignedIn(),

  /* ---- 条款同意 ----
   * 收敛到 api 层，页面不直接碰 store —— 以后改成「同意状态存后端」时
   * 只需改这里，页面无感。 */
  isAgreed: () => store.isAgreed(),
  agreeTerms: () => {
    store.agree();
    return store.isAgreed();
  },
  revokeAgreement: () => store.revokeAgreement(),

  /* ---- 用户 ---- */
  /**
   * 读取 / 保存用户资料。
   * ------------------------------------------------------------------
   * 返回值里 `isLocal === true` 表示**这份资料只在本机**：
   *   · 没配后端（本地模式），或
   *   · 云开发路线上该端点还没实现，被 501 静默回落到了本地实现。
   * 页面据此选文案（「已保存」vs「已保存到本机」）—— 别用运行模式去猜：
   * 云模式 ≠ 一定写到了云端，`call()` 的 501 回落会让这两件事分家。
   */
  getProfile: () => call('user.profile'),
  updateProfile: (patch) => call('user.updateProfile', patch),
  /**
   * 账号页顶部三宫格。
   * ------------------------------------------------------------------
   * ⚠️ 这个端点**刻意不登记到云函数 ROUTES**（至今仍 501 → 回落本机）。
   *    它要返回 `matched` / `favorites` / `documents` 三个数，而服务端
   *    只有 `favorites` 有真值：
   *      · `matched` 是最近一次匹配命中的院校数 —— 匹配在客户端跑
   *        （规则引擎与院校数据同包，离线可用），服务端根本没有这个数；
   *      · `documents` 是文书数量，功能未上线，恒 0。
   *    登记它就只能返回 `{matched:0,favorites:N,documents:0}` —— 比回落本机
   *    **更假**：回落至少显示的是用户自己的真实数据（本机三个数都准），
   *    恒 0 是凭空断言「你一次都没匹配过」。
   *    判据不是「收藏上没上云」，而是「这三个数服务端是不是全都有」。
   */
  getStats: () => call('user.stats'),
  /** 头像落地：临时路径 → 可长期使用的地址（远端上传 / 本机转存） */
  saveAvatar: (tempPath) => saveAvatar(tempPath),

  /* ---- 成绩档案 ---- */
  /**
   * 读取成绩档案。
   * ⚠️ 云端返回 `null`（未登录 / 从未填过）时**回落本机缓存**。
   *    未登录时本机就是唯一数据源，这不是降级而是正确语义；
   *    两个适配器的差别在这里被抹平 —— 页面永远拿到一份可渲染的档案。
   *    未登录时直接读本机、不发请求：云端的 GET 同样会返回 null，
   *    白跑一次往返再回落，只是把同一件事做两遍。
   *
   * ⚠️ **除 401 外永不 reject**（2026-09-25 修 P0）。
   * ------------------------------------------------------------------
   * 事故经过：`GET /v1/academic/profile` 只要失败一次（网络超时 / 500），
   * `call()` 就不会回落（501 之外不降级，且 `academic.get` 不在
   * `FALLBACK_LOCAL` 里）→ 这里 reject →
   * match 页的 `Promise.all` 当时没有第二个回调 → 档案装载流程整体中断，
   * `this.profile` 永远是 undefined → 用户在成绩页**能打开浮层、能输入，
   * 但点「确定」什么也不会发生**（浮层不关、无提示、控制台一条
   * `Cannot set properties of undefined`）→ 雅思/均分存不进去 → 匹配不出结果。
   * 一次网络抖动就能把「填写成绩」这条主链路彻底废掉，且全程静默。
   *
   * 为什么回落到本机缓存是**正确**的而不是降级：
   *   · 本机就是写路径的落地（`saveAcademic` 每次都先写本机），
   *     所以它必然持有用户最后一次填写的值；
   *   · 本方法**只读不写**，不会像 `syncAcademic` 那样拿「读不到」
   *     当成「云端是空的」去做覆盖决策 —— 那条纪律针对的是同步，不是这里。
   *   ⇒ 读不到就如实给本机那一份，页面永远拿得到档案，也就永远崩不了。
   *
   * ⚠️ **401 是唯一例外，必须让它抛出去**（详见 canFallbackRead）：
   *    会话失效是登录态问题，掩盖了用户会以为还登着、还在同步。
   *    这一条与 `tools/test-cloud-transport.js` 第 4 节的断言同源，
   *    由 `tools/test-cloud-sync.js` 场景 11 一并守住。
   *
   * 另一条同样重要：**本机有未推上去的改动时以本机为准**。
   *   `store.isProfileDirty()` 为真 = 用户刚改过、这次没写进云端
   *   （离线 / 云端失败）。此时云端那一份是**旧的**，若拿它渲染，
   *   用户会看到「刚填的雅思又变回未填写」，拿去匹配也匹配不到 ——
   *   与跨设备同步的五种裁决同一条口径：dirty ⇒ 本机就是更新的那一份。
   */
  getAcademic: () => {
    const cached = local['academic.get'];
    if (!request.isReady() || !store.isSignedIn()) return Promise.resolve(cached());
    // 本机有未同步的改动 → 不信云端那份旧的
    if (store.isProfileDirty()) return Promise.resolve(cached());
    return call('academic.get')
      .then((p) => (p === null || p === undefined ? cached() : p))
      .catch((err) => {
        // 401 例外：登录态失效要暴露出去，不能被本机缓存掩盖（见 canFallbackRead）
        if (!canFallbackRead(err)) throw err;
        return cached();
      });
  },
  /** 保存成绩档案：本机先落地、云端随后追（队列 + 合并，见 saveAcademic 的注释） */
  saveAcademic,
  resetAcademic,

  /* ---- 收藏 ---- */
  /**
   * 读取收藏 id 列表。未登录或云端 `null` 时回落本机缓存，理由同 getAcademic。
   *
   * ⚠️ 同样是**除 401 外永不 reject**、且 **dirty 时以本机为准**（2026-09-25）。
   *    `favorites.list` 也不在 `FALLBACK_LOCAL` 里，云端只要回一个非 501
   *    的错误就会让这个函数 reject —— 与 getAcademic 是同一处纪律、
   *    同一条 bug 家族（401 例外也一并沿用，理由见 canFallbackRead）。
   *    收藏页的即时性更敏感：用户刚点的星若因为一次读失败而消失，
   *    他会认为「收藏没生效」，然后再点一次把它取消掉。
   */
  getFavorites: () => {
    const cached = local['favorites.list'];
    if (!request.isReady() || !store.isSignedIn()) return Promise.resolve(cached());
    if (store.isFavoritesDirty()) return Promise.resolve(cached());
    return call('favorites.list')
      .then((ids) => (ids === null || ids === undefined ? cached() : ids))
      .catch((err) => {
        // 401 例外，同 getAcademic
        if (!canFallbackRead(err)) throw err;
        return cached();
      });
  },
  /**
   * 收藏 / 取消收藏。返回 `{ id, favorite, ids, isLocal }`。
   * `isLocal === true` 表示这次只写到了本机（未登录 / 没配后端 / 云端写失败），
   * 页面据此如实选文案 —— 与 getProfile 的 `isLocal`、反馈的 `delivered` 是同一套约定。
   */
  toggleFavorite,
  /** 本机判断（不走网络），院校详情页等即时渲染用 */
  isFavorite: (id) => store.isFavorite(id),

  /**
   * 登录后的跨设备同步（成绩档案 + 收藏）。
   * `api.login()` 内部已经自动调用，一般不需要页面再手动调；
   * 单独导出是为了让验证台能在不真正登录的情况下驱动它。
   */
  syncUserData,

  /* ---- 匹配 ---- */
  runMatch: (profile) => call('match.run', profile),
  getLatestMatch: () => call('match.latest'),
  /** 保存匹配结果（解读写回后调用） */
  saveResult: (r) => store.setResult(r),
  /** 生成个性化解读：AI 优先，未启用则规则模板，来源如实标注 */
  getInsight: (profile, result) => getInsight(profile, result),
  /** 档案是否足以支撑评分（高中均分 + 语言成绩为公共门槛） */
  checkProfile: (profile) => matchEngine.checkProfile(profile),

  /* ---- 院校 ---- */
  listSchools: (q) => call('schools.list', q),
  getSchool: (id) => call('schools.detail', id),

  /* ---- 其他 ---- */
  getMetaConfig: () => call('meta.config'),

  /**
   * 订阅消息（反馈受理通知）—— 入口在「我的 > 偏好与其他 > 消息通知」。
   * ⚠️ 这两个**不走 `call()`**（501 必须暴露，不能被静默回落掩盖），
   *    理由与取舍见本文件「订阅消息」一节的头注。
   */
  getNotify: () => getNotify(),
  saveNotify: (patch) => saveNotify(patch),
  /** 订阅状态推导（唯一口径）：页面与「我的」列表都读它，不要各写一份 */
  notifyStatus: (remote, cfg) => resolveNotifyStatus(remote, cfg),

  /**
   * 提交反馈
   * ------------------------------------------------------------------
   * ⚠️ **无论成功还是失败都不抛错**，统一返回：
   *     { ok, delivered, ticketId, createdAt, replyWithin, type, reason, message }
   *
   *    为什么不再抛错：本接口的唯一调用方是反馈页，而它无论是成是败都要
   *    跳到「结果页」展示结果 —— 失败不是异常，是两条正常分支之一。
   *    让页面再包一层 try/catch，只是把同一个判断写两遍。
   *
   * `delivered` 语义：remote 恒为 true（已送达后端）；local 恒为 false
   * （仅存本机，团队收不到）。结果页据此选用**不同的成功文案** ——
   * 本地模式绝不能显示「反馈已提交」。
   *
   * 结果会同时落到本机（store.feedbackResult）供结果页读取：
   * 工单号 / 类型 / 时间不适合塞进 URL 传参（有长度与编码问题）。
   */
  submitFeedback: (d) => {
    const cfg = content().feedback;
    const type = (d && d.type) || '';

    return call('feedback.submit', d)
      .then((r) => {
        const res = r || {};
        return {
          ok: true,
          delivered: res.delivered !== false,
          ticketId: res.ticketId || '',
          createdAt: res.createdAt || new Date().toISOString(),
          replyWithin: res.replyWithin || cfg.replyWithin,
          type,
          reason: '',
          message: '',
        };
      })
      .catch((err) => ({
        ok: false,
        delivered: false,
        ticketId: '',
        createdAt: new Date().toISOString(),
        replyWithin: cfg.replyWithin,
        type,
        reason: feedbackReasonKey(err),
        message: (err && err.message) || '',
      }))
      .then((record) => {
        store.setFeedbackResult(record);
        return record;
      });
  },

  /* ---- 反馈草稿与结果（页面不直接碰 store，一律走这里） ----
   * 草稿是失败结果页上那句「已暂存到本地，不会丢失」的**实际兑现**，
   * 不能只是一句安抚话术。 */
  getFeedbackDraft: () => store.getFeedbackDraft(),
  saveFeedbackDraft: (d) => store.setFeedbackDraft(d),
  clearFeedbackDraft: () => store.clearFeedbackDraft(),
  getFeedbackResult: () => store.getFeedbackResult(),

  /**
   * 落一条失败记录（供结果页读取）
   * ------------------------------------------------------------------
   * 用于**提交前置步骤**失败的情况 —— 最典型的是远端模式下截图上传失败：
   * 那时还没走到 submitFeedback，但用户看到的同样应该是「提交失败」结果页。
   * 由 api 统一落盘，页面不必自己拼记录结构，也不必接触 store。
   */
  markFeedbackFailed: (reason, type) => {
    const cfg = content().feedback;
    const record = {
      ok: false,
      delivered: false,
      ticketId: '',
      createdAt: new Date().toISOString(),
      replyWithin: cfg.replyWithin,
      type: type || '',
      reason: reason || 'default',
      message: '',
    };
    store.setFeedbackResult(record);
    return record;
  },

  /** 时间显示格式：2026-09-16 21:15 */
  formatDateTime: (iso) => formatDateTime(iso),

  /**
   * 上传反馈截图
   * ------------------------------------------------------------------
   * 走 wx.uploadFile（multipart/form-data），响应结构见契约 4.8 的
   * `POST /v1/upload` —— 注意它**不走统一响应包装**，直接返回
   * `{ fileId, url, width, height }`。
   *
   * 仅远端模式可用；本地模式会 reject(NO_BACKEND)，调用方应改用本地路径。
   * ⚠️ 上传域名要单独配到小程序后台的「uploadFile 合法域名」，
   *    与 request 域名不是同一栏，是最容易漏配的一项。
   */
  uploadImage: (filePath) => request.upload(filePath, { url: '/v1/upload' }),

  /* ---- 工具 ---- */
  daysUntil,

  /**
   * 当前运行模式，页面可据此显示「本地模式」角标。
   * 返回值刻意保持两态 —— 页面只关心「有没有后端」，不关心后端是
   * 自建 REST 还是微信云开发（那是实现细节，不该漏进 UI 层）。
   */
  mode: () => (request.isReady() ? 'remote' : 'local'),

  /** 'rest' | 'cloud' | 'none'：传输层实现细节，供调试与诊断使用 */
  transport: () => request.transport(),
};
