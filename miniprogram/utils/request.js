/**
 * 网络请求底座
 * ------------------------------------------------------------------
 * 统一封装出网调用：注入登录态、归一化错误、超时与重试、并发去重。
 * 业务层不直接调用本文件，统一走 utils/api.js。
 *
 * 支持两种后端传输，**只需填 CONFIG 里对应的一个字段即可切换**，
 * 契约语义（统一响应 2.4、鉴权 2.3）两端完全一致：
 *
 *   ┌─ rest  ── baseUrl 已填 → wx.request
 *   └─ cloud ── env     已填 → wx.cloud.callFunction（微信云开发）
 *
 * ⚠️ 二者**只填一个**。同时填时以 rest 优先（本文件会按 rest 走），
 *    因为这代表「自建后端已就绪」，是一个明确的、更有意图的配置。
 *
 * ── rest 路线的上线前置条件 ──────────────────────────────────────
 * baseUrl 域名必须
 *   1) 已 ICP 备案
 *   2) 在微信公众平台「开发 → 开发管理 → 服务器域名」配置为 request 合法域名
 * 否则真机上所有请求都会被拦截（开发者工具勾选「不校验合法域名」可绕过）。
 *
 * ── cloud 路线的上线前置条件 ────────────────────────────────────
 *   1) 云开发环境已创建，env 填环境 ID（形如 cloud1-xxxxxxxxxxxx）
 *   2) app.js 已执行 wx.cloud.init（否则 callFunction 直接 fail）
 *   3) 云函数 api 已上传并部署（本地调试可右键「上传并部署：云端安装依赖」）
 * ⚠️ 云开发**不免除小程序本身的 ICP 备案** —— 它只免除「请求域名备案」。
 *    两件事在不同层面，详见 API接口契约.md 2.2。
 */

const PRIVATE = require('../private/config.js');

const CONFIG = {
  /**
   * REST 后端地址，留空表示未部署自建后端。
   * 形如 'https://api.example.com'，**不带**结尾斜杠。
   */
  baseUrl: '',

  /**
   * 微信云开发环境 ID，从运行期私有配置读取（`miniprogram/private/config.js`，
   * 已加入 .gitignore，不进入公开仓库）。
   * 形如 'cloud1-xxxxxxxxxxxx'。
   *
   * ⚠️ 这个值是**部署配置**，不是业务内容 —— 所以它和 baseUrl 一样放在
   *    部署配置里，而不是放进 `data/content.js`。内容层是给运营改文案用的，
   *    环境 ID 改错了会让整个后端失联，两者不该是同一套变更节奏。
   */
  env: PRIVATE.cloudEnvId || '',

  timeout: 15000,
  /** 失败自动重试次数（仅幂等请求） */
  retry: 1,
};

/**
 * 云函数名。聚合为一个入口而非每个端点一个函数，理由见 API接口契约.md 2.2：
 * 独立云函数各自冷启动、19 次部署、依赖包重复打包，对一个两人项目是纯负担。
 * 路由在云函数内部的 ROUTES 表里，与本文档的 REST 端点一一对应。
 */
const CLOUD_FUNCTION = 'api';

/**
 * 当前传输层。
 * @returns {'rest'|'cloud'|'none'} none 表示后端完全未配置（本地模式）
 *
 * 这是**唯一**的判定入口 —— request / upload / isReady / api.js 都读它，
 * 避免「谁来判断后端可用」这件事在多个文件里各写一遍而漂移。
 */
function transport() {
  if (CONFIG.baseUrl) return 'rest';
  if (CONFIG.env) return 'cloud';
  return 'none';
}

/** 内存中的登录态，避免每次请求都读 Storage */
let tokenCache = null;

function getToken() {
  if (tokenCache !== null) return tokenCache;
  try {
    tokenCache = wx.getStorageSync('sp_token') || '';
  } catch (e) {
    tokenCache = '';
  }
  return tokenCache;
}

function setToken(t) {
  tokenCache = t || '';
  try {
    wx.setStorageSync('sp_token', tokenCache);
  } catch (e) {
    /* 存储失败不阻断流程 */
  }
}

function clearToken() {
  setToken('');
}

/** 业务错误对象，页面可直接读 code / message */
function ApiError(code, message, extra) {
  const e = new Error(message || '请求失败');
  e.code = code;
  e.extra = extra || null;
  return e;
}

const ERROR_TEXT = {
  400: '请求参数有误',
  401: '登录已过期，请重新登录',
  403: '没有访问权限',
  404: '接口不存在',
  429: '操作过于频繁，请稍后再试',
  500: '服务器开小差了，请稍后再试',
  502: '服务暂时不可用',
  503: '服务维护中',
};

/** 401 回调，由 api.js 注入（触发重新登录） */
let onUnauthorized = null;
function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/**
 * 网络层失败归一化
 * ------------------------------------------------------------------
 * ⚠️ 必须打上 `networkErr` 标记：重试逻辑只认这个标记。
 *    不加标记、改用「catch 到就重试」会让**业务错误也被重试** ——
 *    例如服务端明确返回 400 参数错误，重试一次还是同样的 400，
 *    白白多一次请求与 400ms 延迟，还会让限流计数翻倍。
 */
function normalizeFail(err) {
  const msg = (err && err.errMsg) || '';
  const isTimeout = /timeout/i.test(msg);
  // 云函数未部署 / 执行时抛错，callFunction 走 fail 且 errMsg 带 -5040xx 一类错误码。
  // 这属于服务端问题，提示「请检查网络」会把人带偏到错误方向。
  const isServerSide = /-5040\d\d/.test(msg) || /not found/i.test(msg);

  const e = isServerSide
    ? ApiError(500, ERROR_TEXT[500])
    : ApiError(
        isTimeout ? 'TIMEOUT' : 'NETWORK',
        isTimeout ? '网络较慢，请稍后重试' : '网络连接失败，请检查网络'
      );
  e.networkErr = true;
  return e;
}

/**
 * 响应归一化 —— rest 与 cloud **共用同一段代码**。
 * ------------------------------------------------------------------
 * 两条传输的契约是同一个（2.4 的统一响应），各写一份迟早会漂：
 * 典型漂移是 REST 分支认 `code === 401` 而 cloud 分支忘了认，
 * 于是云开发模式下登录态过期不会触发重新登录，用户看到的是「请求失败」而无所适从。
 *
 * 成功返回 data；失败一律 throw（带 code / message / extra）。
 */
function handleResponse(statusCode, body) {
  if (statusCode >= 200 && statusCode < 300) {
    // 约定：后端统一返回 { code: 0, data: {...}, message: '' }
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data;
      if (body.code === 401 || body.code === 10401) {
        clearToken();
        if (onUnauthorized) onUnauthorized();
        throw ApiError(401, body.message || ERROR_TEXT[401]);
      }
      throw ApiError(body.code, body.message || '请求失败', body);
    }
    // 云函数忘记 return 时 result 为 undefined —— 如实报错，不要伪装成成功，
    // 否则页面会拿到一个空对象当数据用（数据真实性问题，见项目红线）。
    if (body === undefined || body === null) throw ApiError(500, ERROR_TEXT[500]);
    return body;
  }

  if (statusCode === 401) {
    clearToken();
    if (onUnauthorized) onUnauthorized();
  }
  throw ApiError(
    statusCode,
    (body && body.message) || ERROR_TEXT[statusCode] || `请求失败(${statusCode})`,
    body
  );
}

/**
 * 单次发送（不含重试）—— rest 与 cloud 在此分流
 */
function sendOnce(opt) {
  const { url, method, data, header } = opt;

  if (transport() === 'cloud') {
    return new Promise((resolve, reject) => {
      if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
        return reject(ApiError('NO_CLOUD', '当前微信版本不支持云开发，请升级后重试'));
      }
      wx.cloud.callFunction({
        name: CLOUD_FUNCTION,
        // 传的是 REST 路径而不是 action 名：这样契约里的端点清单就是唯一的接口定义，
        // 不必再维护一张「路径 → action 名」的映射表（那是 SSOT 违规）。
        data: { path: url, method, data },
        success: (res) => resolve({ statusCode: 200, body: res && res.result }),
        fail: (err) => reject(normalizeFail(err)),
      });
    });
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: CONFIG.baseUrl + url,
      method,
      data,
      header,
      timeout: CONFIG.timeout,
      success: (res) => resolve({ statusCode: res.statusCode, body: res.data }),
      fail: (err) => reject(normalizeFail(err)),
    });
  });
}

/**
 * 发起请求
 * @param {object} opt
 * @param {string} opt.url      以 / 开头的路径，如 '/v1/user/profile'
 * @param {string} [opt.method] GET | POST | PUT | DELETE
 * @param {object} [opt.data]
 * @param {boolean} [opt.auth]  是否携带登录态，默认 true
 * @param {boolean} [opt.idempotent] 失败是否可重试，GET 默认 true
 */
function request(opt) {
  const { url, method = 'GET', data = {}, auth = true, idempotent } = opt;

  if (transport() === 'none') {
    return Promise.reject(
      ApiError('NO_BACKEND', '后端尚未配置，当前运行在本地模式')
    );
  }

  const canRetry = idempotent === undefined ? method === 'GET' : idempotent;
  const attempts = canRetry ? CONFIG.retry + 1 : 1;

  const header = { 'content-type': 'application/json' };
  if (auth) {
    const t = getToken();
    if (t) header.Authorization = 'Bearer ' + t;
  }

  const fire = (left) =>
    sendOnce({ url, method, data, header })
      .then(({ statusCode, body }) => handleResponse(statusCode, body))
      .catch((err) => {
        if (left > 1 && err && err.networkErr) {
          // 轻量退避后重试
          return new Promise((r) => setTimeout(r, 400)).then(() => fire(left - 1));
        }
        throw err;
      });

  return fire(attempts);
}

/**
 * 上传文件（反馈截图等）
 * ------------------------------------------------------------------
 * ⚠️ 与 request 的三个关键差异，不要照抄 request 的写法：
 *   1) REST 路线下 wx.uploadFile 走 `multipart/form-data`，契约 4.8 的 `/v1/upload`
 *      **不走 2.4 的统一响应包装**，所以这里不做 `code === 0` 判断；
 *   2) 它返回的 `res.data` 是**字符串**，需要自己 JSON.parse；
 *   3) 没有 `data` 参数，业务字段走 `formData`。
 *
 * ⚠️ REST 路线上传域名要单独配到小程序后台的「uploadFile 合法域名」——
 *    它与 request 合法域名不是同一栏，是最容易漏配的一项。
 *    （cloud 路线没有这一项：云存储走微信自己的通道，无需配置域名。）
 *
 * ── cloud 路线 ──────────────────────────────────────────────────
 * 契约 4.8 已写明：云开发路线直接改用 `wx.cloud.uploadFile`，**不需要云函数**。
 * 入参从 `formData` 变成 `cloudPath`，返回值从 `{fileId,url,width,height}`
 * 收窄为 `{fileId}` —— 页面只消费 fileId（见 pages/feedback/feedback.js
 * 的 uploadImages），因此收窄不影响调用方，不需要为它编造 url/width/height。
 *
 * local 模式下直接 reject(NO_BACKEND)：调用方据此改用本地临时路径，
 * 不要把「上传失败」伪装成成功。
 */
function upload(filePath, opt) {
  const o = opt || {};

  if (transport() === 'none') {
    return Promise.reject(ApiError('NO_BACKEND', '后端尚未配置，当前运行在本地模式'));
  }

  if (transport() === 'cloud') {
    return new Promise((resolve, reject) => {
      if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
        return reject(ApiError('NO_CLOUD', '当前微信版本不支持云存储，请升级后重试'));
      }
      const m = /\.[a-zA-Z0-9]+$/.exec(filePath || '');
      const ext = m ? m[0].toLowerCase() : '.png';
      /**
       * 存放目录由调用方经 `opt.dir` 指定：反馈截图 → `feedback/`，头像 → `avatar/`。
       * ⚠️ 默认值必须是 `feedback` —— 云函数 handlers/feedback.js 会校验
       *    提交的截图 fileID 里含 `/feedback/`，改默认值会让历史截图在提交时被判非法。
       */
      const dir = String(o.dir || 'feedback').replace(/^\/+|\/+$/g, '') || 'feedback';
      wx.cloud.uploadFile({
        // cloudPath 必须唯一，否则会覆盖他人已上传的同名截图。
        // 用「时间戳 + 随机串」而不是用户标识：云存储文件可能被转发出去，
        // 文件名里不该带上任何身份信息。
        cloudPath:
          dir + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + ext,
        filePath,
        success: (res) => resolve({ fileId: (res && res.fileID) || '' }),
        fail: (err) => reject(normalizeFail(err)),
      });
    });
  }

  const header = {};
  if (o.auth !== false) {
    const t = getToken();
    if (t) header.Authorization = 'Bearer ' + t;
  }

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: CONFIG.baseUrl + (o.url || '/v1/upload'),
      filePath,
      name: o.name || 'file',
      formData: o.formData || {},
      header,
      timeout: CONFIG.timeout,
      success: (res) => {
        let body = res.data;
        try {
          body = typeof body === 'string' ? JSON.parse(body) : body;
        } catch (e) {
          return reject(ApiError(500, '上传返回格式异常', res.data));
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        reject(ApiError(res.statusCode, (body && body.message) || '上传失败', body));
      },
      fail: (err) => {
        const isTimeout = /timeout/i.test(err.errMsg || '');
        reject(
          ApiError(
            isTimeout ? 'TIMEOUT' : 'NETWORK',
            isTimeout ? '上传较慢，请稍后重试' : '上传失败，请检查网络'
          )
        );
      },
    });
  });
}

/* ------------------------------------------------------------------
   导出形态：**可调用模块**（函数本身 + 挂载属性）
   ------------------------------------------------------------------
   ⚠️ 这里必须导出**函数**，不能导出普通对象。
   因为 utils/api.js 里两种用法并存：

       request({ url, method, data })              ← 当函数调用（全部远端接口）
       request.isReady() / ApiError() / upload()   ← 当对象取属性

   历史上本文件导出的是 `{ CONFIG, request, ... }` 这样的**对象**，
   而 api.js 写的是 `const request = require('./request')` 后直接 `request({...})` ——
   两者对不上，一旦 baseUrl 填上、代码走到远端分支，就会抛
   `TypeError: request is not a function`。

   之所以长期没被发现：`CONFIG.baseUrl` 一直是空串，`call()` 永远走
   local 适配器，**全部 remote 分支从未被执行过**。直到为反馈接口
   补了远端用例（tools/test-feedback-api.js）才暴露。

   ⇒ 后端接入前务必先跑一遍验证台，它会在本机就拦下这类问题：
      · tools/test-feedback-api.js   —— REST 远端分支
      · tools/test-cloud-transport.js —— cloud 传输分支
   ------------------------------------------------------------------ */
request.CONFIG = CONFIG;
request.upload = upload;
request.getToken = getToken;
request.setToken = setToken;
request.clearToken = clearToken;
request.setUnauthorizedHandler = setUnauthorizedHandler;
request.ApiError = ApiError;
/**
 * 当前传输层：'rest' | 'cloud' | 'none'
 * 需要区分「后方是哪种后端」时读这里，不要各自去判断 CONFIG 的字段。
 */
request.transport = transport;
/** 后端是否已可用（rest 或 cloud 任一已配置即视为可用） */
request.isReady = function isReady() {
  return transport() !== 'none';
};

module.exports = request;
