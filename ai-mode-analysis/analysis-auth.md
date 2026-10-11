# analysis-auth — 鉴权与请求链路事实

> ⚠️ **状态（2026-09-24）：本文的「独立分包」前提已失效，产物已被整体摘除。**
> `miniprogram/skills/university-match`（微信 AI 独立分包）已删除，
> 原因见 `版本备注.md` §三.6：提审被驳回，「Skill 能力尚处于灰度测试阶段，暂未开放提审」。
> 文中「独立分包」相关约束（如禁止 `getApp()`）**现在没有适用对象**，主包侧结论仍然有效。
> 本文件从 `miniprogram/` 移到仓库根目录，是为了不带进上传包；
> 保留它是为将来官方开放后重新接入时不必重新扫源码。

源项目：`/Users/odycai/WorkBuddy/微信小程序大赛2026/miniprogram`（含 `project.config.json`，appid `wxefe0ace9d00e5b32`）
阶段：1.2 产出 · 落盘后即为后续阶段 3 / 5.6 的**可信事实**，不再重读同一函数

> ⚠️ 本项目的特殊性：`CONFIG.baseUrl` 当前为**空串**，全项目**零 `wx.request` 实际调用**、
> 零云开发。业务层走 `utils/api.js` 的**双适配器**（local / remote），
> `request.isReady()` 为 false 时一律走 local。因此「鉴权」在本项目里**当前不生效**，
> 但封装层的完整链路必须逐字复刻 —— 后端填入 baseUrl 后立即接管。

---

## 第一节 · 鉴权事实（结构化）

### 2.1 元信息

| 项 | 值 | 说明 |
|----|----|----|
| `hasCentralWrapper` | **true** | `utils/request.js` 是唯一网络入口，统一注入 header / 拆包 / 错误归一 / 重试 |
| `confidence` | high | 封装层短小完整，无压缩无混淆，事实逐行可核 |

### 2.2 host 体系

| id | 完整 base（含路径）| 来源 |
|----|----|----|
| `api` | `''`（**当前为空**，待部署后端时填写）| `utils/request.js:15` |

**host 解析规则**：业务层全部写**相对路径**（`/v1/...`），由封装层拼接 ——
`CONFIG.baseUrl + url`（`utils/request.js:102`）。
`baseUrl` 为空时**提前 reject**，不发起任何请求（`utils/request.js:84-88`）：
`ApiError('NO_BACKEND', '后端尚未配置，当前运行在本地模式')`。

> 上线前置（源码注释原文，`utils/request.js:7-10`）：baseUrl 域名必须 ① 已 ICP 备案
> ② 在微信公众平台配置为 request 合法域名，否则真机全部请求被拦截。

### 2.3 通用参数

| name | channel | 值来源（kind）| 表达式/值 | 何时生效 | 注入方式 | 来源 |
|------|---------|-------------|----------|---------|---------|------|
| `content-type` | header | `literal` | `'application/json'` | 全部请求 | wrapper | `utils/request.js:93` |
| `Authorization` | header | `dynamic` | `'Bearer ' + getToken()` | `auth !== false` **且** token 非空 | wrapper | `utils/request.js:94-97` |
| `timeout` | wx.request 参数 | `literal` | `15000` | 全部请求 | wrapper | `utils/request.js:16,106` |

- 业务层**没有任何手抄的通用参数**（`manual-repeat` 为空）：所有 header 由 `request()` 统一注入。
- `auth` 默认 `true`（`utils/request.js:82`）；`auth: false` 仅用于登录换取、内容配置、元配置：
  `utils/api.js:238,321,264`。

### 2.4 content-type 规则

| 方法 | content-type | 来源 |
|------|-------------|------|
| GET / POST / PUT / DELETE（全部）| `application/json`（写在 header 里，不区分方法）| `utils/request.js:93` |

> 源码**未**按 method 区分 content-type，封装层统一一个值 —— 生成侧照此复刻，不要"优化"成按方法分支。

### 2.5 登录 / token

**token 来源**（取值用）：

| 项 | 值 | 来源 |
|----|----|----|
| kind | `storage` | `utils/request.js:27` |
| key | `sp_token` | `utils/request.js:27` |
| guard | 内存缓存 `tokenCache !== null` 优先；未命中才读 Storage | `utils/request.js:24-32` |

**token 获取**（怎么换来）：

| 项 | 值 |
|----|----|
| kind | `exchange` |
| trigger | `wx.login`（**静默**，无弹窗） |
| 换取 URL + host | `/v1/auth/login` @ `api` |
| 请求字段名 | `code` = `wx.login` 回调的 `res.code` |
| method / content-type | `POST` / `application/json` |
| **响应取值路径** | `data.token`（`data` = 封装层拆包后的业务体，见 2.8）|
| successCondition | `res.code` 为真值；否则 reject `ApiError('WX_LOGIN_FAIL','获取微信登录凭证失败')` |
| `replicable` / `blockers` | `true` / `[]` |
| 来源 | `utils/api.js:422-438`（`login()`）、`utils/api.js:238`（remote 映射）|

> ⚠️ 本地模式下**不走上述链路**：`local['auth.login']` 直接签发
> `token = 'local-' + user.id`（`utils/api.js:100-110`），
> 且注释明确「本地模式的登录态只是『本机已建档』的标记，不代表任何真实身份」。

**鉴权错误的处置动作**（见 2.8 鉴权错误生命周期）。

### 2.6 签名 / 反爬

**空表** —— 源码中无 sign / timestamp / nonce / 设备指纹 / 加密依赖。
`utils/request.js` 全文没有任何签名相关代码，业务层也没有。

### 2.7 运行时动态值

| id | 取值方式 | ensureFn（取值函数名）| 来源 |
|----|---------|----------|------|
| `loginCode` | `wx.login` 异步取 code → 换取 token | `ensureLogin` | `utils/api.js:424-427` |

> 本项目**无定位、无设备信息、无手机号**参与请求参数，故无 `ensureLocation` 等。
> `wx.getWindowInfo` / `wx.getMenuButtonBoundingClientRect` 只用于**布局测量**
> （`app.js:26-60`），不进入任何请求参数，且属于主包 UI 职责，**不进分包**。

### 2.8 响应信封 + 鉴权错误 + storage 初始化

**响应信封**（`utils/request.js:107-122`）：

| 项 | 路径 | 来源 |
|----|------|------|
| successPath | `statusCode >= 200 && statusCode < 300` | `utils/request.js:110` |
| dataPath | 有 `code` 字段时 → `body.code === 0` ⇒ `resolve(body.data)`；**无 `code` 字段时 → `resolve(body)` 本体** | `utils/request.js:112-121` |
| errorMessagePath | `body.message` → 回落 `ERROR_TEXT[statusCode]` → 回落 `` `请求失败(${statusCode})` `` | `utils/request.js:130` |

> ⚠️ **两条 resolve 分支都要复刻**：后端可以返回裸对象（无信封），此时不能当成错误。

**鉴权错误生命周期**：

| 命中 | 动作 |
|------|------|
| `body.code === 401` 或 `body.code === 10401` | `clearToken()` → `onUnauthorized()` → reject `ApiError(401, body.message \|\| ERROR_TEXT[401])` |
| `statusCode === 401` | `clearToken()` → `onUnauthorized()` → reject `ApiError(401, …)` |
| 其他非 2xx | reject `ApiError(statusCode, …)`，**不清 token** |

- `onUnauthorized` 由 `utils/api.js:413-415` 注入 → 执行 `store.setSignedIn(false)`。
- `ERROR_TEXT` 映射表（400/401/403/404/429/500/502/503）逐字保留，见 `utils/request.js:55-64`。

**重试**：仅幂等请求（`idempotent` 未显式给出时 = `method === 'GET'`），
次数 `CONFIG.retry + 1 = 2`，退避 400ms（`utils/request.js:90-91,141-146`）。
非幂等接口（`idempotent: false`）**不重试** —— 业务层已标注：`match.run` / `match.save` / `ai.insight` / `feedback.submit`（`utils/api.js:253,255,259,265`）。

**storage 初始化清单**：

> ⚠️ 事实：`app.js` 的 `onLaunch` **只做布局测量**（`app.js:17-19`），
> **没有**任何 `wx.setStorageSync` 预写。所有 storage 都是**惰性默认值**
> —— 由各 `get` 的 fallback 提供。因此分包侧 `ensureStorageInit()` 的任务不是
> "重建主包预写的数据"，而是**复刻同一套默认值**。

| key | 默认值 | 写入方 | 来源 |
|-----|-------|-------|------|
| `sp_token` | `''` | `request.setToken` / `clearToken` | `utils/request.js:27,37` |
| `sp_agreed_terms` | `false` | `store.agree()` | `utils/store.js:10,65-70` |
| `sp_agreed_at` | 无（ISO 串）| `store.agree()` | `utils/store.js:11,70` |
| `sp_sign_in` | `false` | `store.setSignedIn` | `utils/store.js:12,80-82` |
| `sp_user` | 无 | `store.setSignedIn(v,user)` | `utils/store.js:13,82` |
| `sp_profile` | **`JSON.parse(JSON.stringify(content.defaultAcademic))`**，并用 `coursesMap[curriculum]` 填 `courses` 镜像 | `store.setProfile` / `resetProfile` | `utils/store.js:14,28-33,89-100` |
| `sp_favorites` | `['toronto']` | `store.toggleFavorite` | `utils/store.js:15,35,103-116` |
| `sp_match_result` | `null` | `store.setResult` | `utils/store.js:16,122-127` |
| `sp_content_patch` | `null` | `api.loadContent()` 远端成功后写 | `utils/api.js:280,324-328` |

**`store.getProfile()` 的合并语义（必须复刻）**：`Object.assign(clone(DEFAULT_PROFILE), p)`
—— 与默认档案**浅合并**，避免历史版本缺字段导致报错（`utils/store.js:89-94`）。

---

## 第二节 · 逐字代码片段（原样拷贝）

### snippets#token-cache — 内存 token 缓存与读写

来源：`utils/request.js:21-45`

```js
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
```

### snippets#header-inject — 封装层通用参数注入

来源：`utils/request.js:93-97`

```js
  const header = { 'content-type': 'application/json' };
  if (auth) {
    const t = getToken();
    if (t) header.Authorization = 'Bearer ' + t;
  }
```

### snippets#error-text — 状态码文案映射

来源：`utils/request.js:55-64`

```js
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
```

### snippets#login — 登录换取链路（本地 / 远端分流）

来源：`utils/api.js:422-438`

```js
function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) return reject(request.ApiError('WX_LOGIN_FAIL', '获取微信登录凭证失败'));
        call('auth.login', { code: res.code })
          .then((data) => {
            request.setToken(data.token);
            store.setSignedIn(true, data.user);
            resolve(data);
          })
          .catch(reject);
      },
      fail: () => reject(request.ApiError('WX_LOGIN_FAIL', '微信登录已取消')),
    });
  });
}
```

### snippets#deep-merge — 内容层深合并（远端补丁 → 本地默认值）

来源：`utils/api.js:283-299`

```js
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
```

---

## 第三节 · 生成侧要点（供阶段 5 直接引用）

1. **禁止 `getApp()`** —— 独立分包硬约束。`app.js` 的 `globalData` 只服务布局，
   与原子接口无关；分包内 `baseUrl` / storage 默认值**自行持有**（`utils/util.js`）。
2. **禁止 `require` 主包** —— 需要 `data/universities.js`、`data/content.js`、
   `utils/match.js`、`utils/store.js` 的等价能力，全部**整文件拷进分包**。
3. **`ensureStorageInit()`**：不预写 storage（源码也不预写），只在首次调用时
   提供与主包一致的默认值（`sp_profile` 的默认值来自 `content.defaultAcademic`，
   且要用 `coursesMap[curriculum]` 填 `courses` 镜像）。
4. **`ensureLogin()`**：复刻 `snippets#login` 整条链路；本地模式下走
   `local['auth.login']` 的分支（签发 `local-` 前缀占位 token），**不得伪造用户身份**。
5. **请求必过封装层**：`apis/*.js` 不得直接 `wx.request`、不得自拼 URL/header/query。
