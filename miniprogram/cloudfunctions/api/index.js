/**
 * 聚合云函数 `api`（微信云开发）
 * ==================================================================
 * 为什么是「一个函数 + 路径路由」，而不是「每个 REST 端点一个云函数」
 * ------------------------------------------------------------------
 * 契约 2.2 早先写的是「同名云函数，一一映射」，实践下来那个方案不划算：
 *
 *   · 19 个云函数 = 19 次上传部署，每改一处公共逻辑要动 19 个地方
 *   · wx-server-sdk 及其依赖（约 10 MB）要在每个函数里各打一份
 *   · 冷启动各自独立，且无法共享
 *   · 本地调试要在 19 个目录间切换
 *
 * 而路由表本身只有十几行。⇒ 改成单入口，**对客户端完全透明**：
 * 客户端传的是 REST 路径（`{path, method, data}`），收到的仍是契约 2.4 的
 * 统一响应。也就是说，从自建 REST 切到云开发不需要改前端任何一行代码。
 *
 * ⚠️ 校验逻辑放在 lib/response.js 而不是本文件 —— 否则 index ⇄ handler
 *    会形成循环 require，表现为偶发的 `ok is not a function`。
 *
 * ── 权限说明（别把匿名身份当成「用户登录」） ──────────────────────
 * `cloud.getWXContext().OPENID` 是微信下发的、**无需用户授权**的匿名标识，
 * 不含姓名/手机号等个人信息。用它做数据归属不构成收集个人信息，
 * 也不需要用户点同意 —— 这与「要求用户登录」是两件事，不要混为一谈。
 *
 * ── 红线（违反即不可上线） ────────────────────────────────────────
 * ⛔ 本云函数内**不得调用任何大模型 API**。
 *    运行期出现模型生成的文本，不论中间转发几层，都构成「向公众提供
 *    生成合成服务」；个人主体申请不到「深度合成-AI问答」类目。
 *    依据见项目根目录 `AI接入边界方案.md`（含 2026-09-15 网信办处罚案例）。
 *    ⚠️ 云开发控制台会主动推荐接入混元模型 / 领取 AI 资源包 —— **不要领**。
 *
 * ── 部署 ──────────────────────────────────────────────────────────
 * 开发者工具中右键本目录 →「上传并部署：云端安装依赖」
 * ⚠️ 不要选「上传并部署：所有文件」—— 那要求本地先 npm install，
 *    会把 node_modules 一并传上去，慢且容易版本不一致。
 * 环境 ID 必须与小程序端 utils/request.js 的 CONFIG.env 一致。
 */
const cloud = require('wx-server-sdk');

// 用动态环境：云函数部署到哪个环境就操作哪个环境的数据库，
// 不必把环境 ID 硬编码进服务端代码（换环境时不用改代码重传）。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { fail } = require('./lib/response');
const feedback = require('./handlers/feedback');
const content = require('./handlers/content');
const auth = require('./handlers/auth');
const user = require('./handlers/user');
const academic = require('./handlers/academic');
const favorites = require('./handlers/favorites');
const notify = require('./handlers/notify');

/* ==================================================================
   路由表 —— 键为「方法 + 路径」，与 API接口契约.md 的端点一一对应
   ------------------------------------------------------------------
   未实现的端点**不要**在这里写占位，让它自然落到 501 分支：
   客户端收到 501 会静默回落到本地实现（utils/api.js 的 call()），
   功能不退化。这样后端可以按优先级逐个补，不必凑齐再上线。
   ================================================================== */
const ROUTES = {
  'POST /v1/feedback': feedback.submit,
  'GET /v1/content': content.get,
  'POST /v1/auth/login': auth.login,
  'GET /v1/auth/session': auth.session,
  'POST /v1/auth/logout': auth.logout,
  /**
   * 个人资料（契约 4.2）。
   * ⚠️ 这两个端点此前缺失，`api.updateProfile()` 一直落到 501 → 回落本地实现。
   *    而个人资料页上写着「资料会同步到你的账号」—— 那句话在当时是假的。
   *    新增端点时请顺带想一遍：页面上有没有哪句话是**依赖它真的实现**才成立的。
   */
  'GET /v1/user/profile': user.profile,
  'PUT /v1/user/profile': user.updateProfile,
  /**
   * 成绩档案（契约 4.3）与收藏（契约 4.4）。
   * ⚠️ 这两组在此前一律 501 → 客户端静默回落本机，于真机上表现为
   *    「换台手机成绩就没了」「收藏只在这台机上」，而且**没有任何提示**。
   *    它们上云之后，`users` 文档同时承载了资料 / 成绩 / 收藏三块数据，
   *    所以这三个 handler 都只能走 `.update()` 局部写入，绝不能 `.set()` ——
   *    整份覆盖会互相清空（详见 handlers/academic.js 的边界说明）。
   */
  'GET /v1/academic/profile': academic.profile,
  'PUT /v1/academic/profile': academic.save,
  'POST /v1/academic/profile/reset': academic.reset,
  'GET /v1/favorites': favorites.list,
  /**
   * 订阅消息（反馈受理通知）—— 契约 4.9。
   * ⚠️ 「页面上哪句话依赖它真的实现」在这里的答案是：消息通知页会显示
   *    「已开启」。而客户端**刻意不做 501 回落**（见 utils/api.js 的
   *    「订阅消息」一节）—— 这两条没上云时页面会如实显示「状态读取失败」，
   *    而不是回落到本地假装开好了、让用户在后台受理时收不到通知。
   */
  'GET /v1/notify': notify.get,
  'PUT /v1/notify': notify.save,
};

/**
 * 带路径参数的路由（契约 4.4 的 `/v1/favorites/{schoolId}`）。
 * ------------------------------------------------------------------
 * 这里用**声明式**的 `path`（`:name` 表示参数）而不是直接写正则字面量，
 * 有两个很实际的理由：
 *   ① 路径一眼可读，且能直接与契约对照（`/v1/favorites/:schoolId` ⇄
 *      `/v1/favorites/{schoolId}`）；写错路径会变成一条永不匹配的正则，
 *      而**不会报错** —— 表现为该端点悄悄回落到 501。
 *   ② `tools/check-docs-consistency.js` 能把它们**和静态 ROUTES 一起**
 *      与契约的端点状态表交叉核对。写成正则字面量就没法解析，
 *      于是「文档写着已上云、实际永远 501」这类问题没人守得住。
 *
 * ⚠️ 匹配顺序是「先静态表、再按本数组顺序」。新增通配路由时必须
 *    同时校验 method 与 path，否则 `/v1/user/profile` 这类静态端点
 *    可能被某条通配规则抢走（抢占是静默的）。
 */
const PATTERNS = [
  { method: 'POST', path: '/v1/favorites/:schoolId', handler: favorites.add },
  { method: 'DELETE', path: '/v1/favorites/:schoolId', handler: favorites.remove },
].map(compilePattern);

/**
 * 把声明式的 `path` 编译成正则 + 参数名列表。
 * `:name` → `([^/]+)`；参数名按出现顺序收集，与捕获组一一对应。
 * ⚠️ 参数值还要再 `decodeURIComponent`（见 safeDecode）—— 正则只负责切分。
 */
function compilePattern(p) {
  const keys = [];
  const src = String(p.path).replace(/:([A-Za-z0-9_]+)/g, (m, name) => {
    keys.push(name);
    return '([^/]+)';
  });
  return {
    method: p.method,
    path: p.path,
    keys,
    re: new RegExp('^' + src + '$'),
    handler: p.handler,
  };
}

/**
 * 解码路径参数。
 * ⚠️ 必须 try/catch：`decodeURIComponent('%')` 会抛 URIError，
 *    不接住就把「一个畸形 URL」变成 500 + 一条无意义堆栈，
 *    而它本质上是 400 级别的输入问题。
 */
function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch (e) {
    return v;
  }
}

/**
 * 解析路由：先精确查静态表，再依次试动态规则。
 * @returns {{handler: Function, params: object}|null} null = 未登记（→ 501）
 */
function matchRoute(method, path) {
  const flat = ROUTES[method + ' ' + path];
  if (flat) return { handler: flat, params: {} };

  for (const p of PATTERNS) {
    if (p.method !== method) continue;
    const m = p.re.exec(path);
    if (!m) continue;
    const params = {};
    p.keys.forEach((k, i) => {
      params[k] = safeDecode(m[i + 1]);
    });
    return { handler: p.handler, params };
  }
  return null;
}

/**
 * 云函数入口
 * @param {object} event
 * @param {string} event.path    以 / 开头的 REST 路径，如 '/v1/feedback'
 * @param {string} [event.method] GET | POST | PUT | DELETE，默认 GET
 * @param {object} [event.data]  请求体
 */
exports.main = async (event) => {
  const path = event && event.path;
  const method = String((event && event.method) || 'GET').toUpperCase();

  if (!path) return fail(400, '缺少接口路径');

  const route = matchRoute(method, path);
  if (!route) return fail(501, '该接口尚未在云端实现');

  let wxContext = {};
  try {
    wxContext = cloud.getWXContext() || {};
  } catch (e) {
    // 理论上不会失败；真失败也不该让整个请求挂掉，只是拿不到身份
    console.error('[api] getWXContext 失败', e);
  }

  try {
    return await route.handler({
      data: (event && event.data) || {},
      // 路径参数（如 favorites 的 schoolId），无参数时是空对象
      params: route.params,
      // 小程序侧调用云函数时 OPENID 必然存在（这是微信下发的，不依赖用户授权），
      // 因此它是可靠的身份与限流维度 —— 不再采集 IP。
      // 刻意不取 CLIENTIP：IP 属于个人信息，存它要在「用户隐私保护指引」里
      // 多声明一项，而它带来的区分度在这里并不会比 openid 更好。
      openid: wxContext.OPENID || '',
    });
  } catch (e) {
    if (e && e.bizCode) return fail(e.bizCode, e.message);
    console.error('[api] 未捕获异常', method, path, e);
    return fail(500, '服务器开小差了，请稍后再试');
  }
};
