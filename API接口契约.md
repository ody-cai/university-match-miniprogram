# 升学规划小程序 · API 接口契约

> 版本 v1.0 ｜ 2026-09-15 制定；2026-09-22 两次校订（补「端点实现状态」表 + 云函数目录树；
> 同日随成绩档案与收藏上云，补齐 4.3 / 4.4 的未登录语义、字段真源与跨设备同步规则）
> 用途：小程序端已按本契约完成接口层封装（`miniprogram/utils/api.js`）。
> 后端按此实现后，只需在 `miniprogram/utils/request.js` 填入 `baseUrl` 即可切换，页面代码零改动。
>
> ⚠️ 本文件描述的是**目标接口**，不是当前实现。哪些端点真的在云端可用，
> 看 2.2 节的「**端点实现状态**」表 —— 未登记的端点一律返回 501 并由客户端静默回落本机。

---

## 一、运行模式

小程序端内置**双适配器**，同一套页面代码可在两种模式下运行：

| 模式 | 触发条件 | 数据来源 | 用途 |
|---|---|---|---|
| **local**（默认） | `baseUrl` 与 `env` 均为空 | 设备本地 Storage + 内置院校数据 | 无后端即可完整跑通全部功能；开发调试 |
| **rest**（自建后端） | `request.CONFIG.baseUrl` 已填写 | 本文档定义的 HTTP 接口，经 `wx.request` | 自建后端；**需要域名 ICP 备案** |
| **cloud**（微信云开发） | `request.CONFIG.env` 已填写 | 聚合云函数 `api`，经 `wx.cloud.callFunction` | 免服务器、免域名备案 |

三条路线的**接口语义、请求参数、响应结构完全一致**，区别只在传输层
（`wx.request` vs `wx.cloud.callFunction`），互相对齐见 2.2。

切换方式：

```js
// miniprogram/utils/request.js
const CONFIG = {
  baseUrl: '',                        // 自建后端地址；与 env 二选一
  env: '<cloud-env-id>',               // 云开发环境 ID；与 baseUrl 二选一
};
```

⚠️ **两个字段只填一个**。同时填写时以 `baseUrl`（rest）优先 —— 那代表
「自建后端已就绪」这个更明确的意图。判定逻辑集中在 `request.transport()`，
不要在别处另行判断。

⚠️ 填 `env` 还需确认 `app.js` 已执行 `wx.cloud.init()`（已实现，环境 ID 取自同一处配置）。

⚠️ 本文件**曾经**在主包与微信 AI 独立分包各有一份（分包读不到主包）。
该分包已于 2026-09-24 因「Skill 能力灰度测试中、暂未开放提审」整体摘除
（见 `版本备注.md` §三.6），现在全项目**唯一一份**。
若将来恢复分包，两处必须同步，否则会出现「AI 里问到的结果 ≠ 小程序内看到的结果」。

只读类接口（院校列表 / 院校详情 / 元配置）在远端模式下请求失败会自动回落到内置数据，保证弱网可用。

---

## 二、通用约定

### 2.1 传输

- 协议：**HTTPS**（强制）
- 编码：UTF-8，请求与响应均为 `application/json`
- 时间：ISO 8601 字符串，如 `2026-09-15T13:00:00+08:00`
- 字段命名：`camelCase`

### 2.2 ⚠️ 后端有两条路，备案要求完全不同

这是选型前必须先想清楚的一件事——**它直接决定你要不要办 ICP 备案**。

| | 路线 A：自建后端（REST） | 路线 B：微信云开发（云函数） |
|---|---|---|
| 调用方式 | `wx.request` | `wx.cloud.callFunction` |
| **域名 ICP 备案** | **必须**。域名要备案，且要配到微信后台的 request 合法域名 | **不需要**。使用默认腾讯云域名即可 |
| **小程序备案（平台侧）** | 必须 | **同样必须**，见下方警告框 |
| 需要什么 | 服务器 + 已备案域名 + SSL 证书 | 控制台开通环境即可 |
| 准备周期 | 备案通常 10–20 个工作日 | 无 |
| 数据库 | 自选（MySQL / PG 等） | 云数据库（文档型） |
| 成本 | 服务器月租 | 免费体验版 3000 资源点/月；个人版 ¥19.9/月（40000 点） |
| 生命周期 | 自主 | ⚠️ **免费环境在小程序发布后，到期时间变更为「上线后第 15 天」** |
| 归属 / 计费 | 备案主体 | 环境归属该 AppID 的主体，计费走其腾讯云账号 |
| 迁移性 | 高 | 平台绑定，迁出需改造 |

> ### ⚠️ 两个「备案」不要混为一谈（本项目最容易搞错的一处）
>
> | | 小程序备案（平台侧） | 域名 ICP 备案 |
> |---|---|---|
> | 谁要求 | 微信：2023-09 起**未备案不能提审上线** | 工信部：使用自有境内域名时 |
> | 云开发能否豁免 | ❌ **不能**，与后端在谁家无关 | ✅ 默认腾讯云域名可免 |
> | 本项目状态 | **仍是唯一的关键路径**（卡在主体侧） | 走云开发即绕过 |
>
> 另外，为云函数 HTTP 访问或云存储下载**绑定自有域名**时，该域名仍需 ICP 备案。
> 即：**默认调用 = 免备案；要自有品牌域名 = 照样要备案。**
>
> ⇒ **开通云开发不会让「备案」从关键路径上消失。** 它解决的是「后端放在哪」，
> 不解决「小程序能不能上线」。

**对本项目的影响**：院校数据是离线编译进包的，不依赖后端，
所以「先不备案也能上线完整功能」是成立的。
后端只承担「成绩同步、收藏同步、反馈收单」这类跨设备能力。

#### 云开发路线的实现方式：单入口 + 路径路由

⚠️ **本契约早期版本写的是「每个 REST 端点对应一个同名云函数」，该方案已废弃。**
实测不划算：19 个函数 = 19 次上传部署 + `wx-server-sdk`（含依赖约 10 MB）
重复打包 19 份 + 冷启动各自独立 + 本地调试要在 19 个目录间切换，
而路由表本身只有十几行。

现行方案：**一个聚合云函数 `api`，按 REST 路径路由**。

```
miniprogram/cloudfunctions/api/
├── index.js              # 入口：ROUTES（静态）+ PATTERNS（带路径参数）+ 统一响应 + 异常兜底
├── lib/
│   ├── response.js       # ok / fail / bizError / 码点计数
│   ├── users.js          # users 集合的共用读写（shapeUser / stableId / findActive / 院校 id 格式校验）
│   └── academic.js       # 成绩档案的形状与校验（纯函数，不依赖 SDK，便于直接测试）
└── handlers/
    ├── feedback.js       # POST /v1/feedback
    ├── content.js        # GET  /v1/content
    ├── auth.js           # POST /v1/auth/login、POST /v1/auth/logout、GET /v1/auth/session
    ├── user.js           # GET /v1/user/profile、PUT /v1/user/profile
    ├── academic.js       # GET / PUT /v1/academic/profile、POST /v1/academic/profile/reset
    ├── favorites.js      # GET /v1/favorites、POST / DELETE /v1/favorites/{schoolId}
    └── notify.js         # GET / PUT /v1/notify（订阅消息状态）
```

> ⚠️ 带路径参数的端点（`/v1/favorites/{schoolId}`）登记在 `index.js` 的
> **`PATTERNS`** 表，不在静态 `ROUTES` 里 —— 漏登记的表现是**静默回落到本机**，
> 而不会报错。所以 `tools/check-docs-consistency.js` 会把两张表**一起**
> 与 2.2 的端点状态表双向核对。新增通配路由时沿用声明式 `path: '/v1/xxx/:id'`
> （而不是直接写正则），否则那个脚本解析不出来、也就守不住。

> ⚠️ `lib/users.js` 的存在理由是**避免两份 `shapeUser` 漂移**：
> `auth.js` 与 `user.js` 都要「按 openid 找档」和「把数据库文档整形为契约 4.2 的对象」。
> 各写一份的下场不是报错，而是**登录返回的字段和资料页返回的字段不一样** ——
> 某个入口少一个字段，没有任何提示。

客户端传的是 **REST 路径**而不是 action 名：

```js
wx.cloud.callFunction({
  name: 'api',
  data: { path: '/v1/feedback', method: 'POST', data: { /* … */ } },
});
```

这样**契约里的端点清单就是唯一的接口定义**，不必再维护一张
「路径 → action 名」的映射表（那是 SSOT 违规，两边迟早漂移）。

#### 未实现端点返回 501，客户端静默回落本地

云函数**按业务优先级逐个补**，不必凑齐再上线：

- 云函数对未实现的路径返回 `{ code: 501, message: '该接口尚未在云端实现' }`
- 客户端 `utils/api.js` 的 `call()` 收到 501 后**静默回落到本地实现**，
  用户看不到报错，功能不退化
- ⚠️ 回落必须**保留本地实现的原样语义**。最典型的是反馈工单：本地实现的
  `delivered` 恒为 `false`（只存本机、团队收不到），回落时**不得**补成 `true`
  —— 那是骗用户，踩数据真实性红线
- ⚠️ `401` **不回落**：登录态问题必须暴露出来，不能被本地数据掩盖

#### 端点实现状态（2026-09-22 实况）

本契约描述的是**目标接口**。云函数当前登记了下表「已上云」的 15 条，
其余一律返回 501 → 客户端静默回落本机。**看这张表，不要靠猜。**

> 2026-09-22 已在云开发环境完成部署并逐条实测：
> 7 条全部不再返回 501（`GET /v1/user/profile` → `data: null`；未登录 `PUT` → `401`）。
> 部署与验证走 `bash tools/deploy-api-function.sh` ——
> ⚠️ **不要直接手敲 `tcb fn deploy`**：实测它会把整个项目打包、报「部署成功」却发上去旧代码，
> 且没有任何报错。
>
> 同日稍后补上成绩档案（3 条）与收藏（3 条）—— 「换台手机成绩就没了」
> 「收藏只在这台机上」这两个问题到此为止。这 6 条在云端**并非常规静态路由**：
> `GET /v1/favorites` 是静态键，而收藏 / 取消是带路径参数的
> `POST|DELETE /v1/favorites/{schoolId}`，走云函数 `index.js` 的 `PATTERNS` 表。
> ⚠️ 因此 `tools/check-docs-consistency.js` 会**同时**解析 `ROUTES` 与 `PATTERNS`，
> 与本表逐条双向核对；漏登记一条、或文档标错一格，脚本都会变红。

| 端点 | 状态 | 说明 |
|---|---|---|
| `POST /v1/auth/login` | ✅ 已上云 | 按 openid 建档 / 取档 |
| `POST /v1/auth/logout` | ✅ 已上云 | |
| `GET /v1/auth/session` | ✅ 已上云 | |
| `GET /v1/user/profile` | ✅ 已上云 | 未登录返回 `data: null` |
| `PUT /v1/user/profile` | ✅ 已上云 | 部分字段；未登录 401 |
| `GET /v1/content` | ✅ 已上云 | 内容补丁（`content` 集合） |
| `POST /v1/feedback` | ✅ 已上云 | 工单（`feedbacks` 集合） |
| `GET /v1/academic/profile` | ✅ 已上云 | 未登录 / 从未保存过都返回 `data: null` |
| `PUT /v1/academic/profile` | ✅ 已上云 | 全量覆盖；未登录 401 |
| `POST /v1/academic/profile/reset` | ✅ 已上云 | 重置为初始态；未登录 401 |
| `GET /v1/favorites` | ✅ 已上云 | 未登录 / 从未同步过都返回 `data: null` |
| `POST /v1/favorites/{schoolId}` | ✅ 已上云 | 幂等；返回 `{id, favorite:true, ids}` |
| `DELETE /v1/favorites/{schoolId}` | ✅ 已上云 | 幂等；返回 `{id, favorite:false, ids}` |
| `GET /v1/notify` | ✅ 已上云 | 订阅状态；没有记录返回 `data: null`（**不是 401**） |
| `PUT /v1/notify` | ✅ 已上云 | 上报 / 撤销订阅授权；**不要求业务登录**（与反馈同理），拿不到微信身份 400 |
| `GET /v1/user/stats` | ⛔ 仅本地 | 见下方 ⚠️ |
| `POST /v1/match/run`、`GET /v1/match/latest`、`POST /v1/match/save` | ⛔ 仅本地 | 匹配在客户端跑（规则引擎与院校数据同包，离线可用） |
| `GET /v1/schools`、`GET /v1/schools/{id}`、`GET /v1/meta/config` | ⛔ 仅本地 | 院校数据构建期随包发布，不受后端影响 |
| `POST /v1/upload` | ⛔ 云路线不需要 | 云开发下头像与反馈截图直接走 `wx.cloud.uploadFile`（**不经过云函数**）；只有自建后端（REST）路线才用这个端点 |
| `POST /v1/ai/insight` | ⛔ 不实现 | 见 4.5 的说明，**这是刻意的，不是欠债** |

⚠️ **`GET /v1/user/stats` 刻意不登记，判据不是「收藏上没上云」。**
它要返回 `matched` / `favorites` / `documents` 三个数，而其中**只有 `favorites`**
服务端有真值：
- `matched` 是最近一次匹配命中的院校数 —— 匹配在**客户端**跑（规则引擎与院校数据同包），
  服务端根本没有这个数；
- `documents` 是文书数量，功能未上线，恒 0（这个 0 是真的，但它撑不起整条接口）。

登记它就只能返回 `{matched:0, favorites:N, documents:0}` —— 比「回落本机」**更假**：
回落至少显示的是用户自己的真实数据（本机三个数都是准的），
恒 0 是凭空断言「你一次都没匹配过」。
⇒ 判据是「这三个数服务端是不是**全都有**」，而不是「收藏有没有上云」。

✅ **`favorites.toggle` 的双适配器语义已对齐（2026-09-22 随收藏上云一并修掉）。**
曾经的偏离：本地实现是**真切换**（已收藏则取消），而远端适配器只发 `POST`（只增不减）。
当时不会暴露，因为 501 一定回落到本地实现 —— 但收藏一上云，**取消收藏就会静默失效**
（点一下没反应、再点还是收藏着），且不报错。
现在的实现是：**方向由客户端根据本机现状决定**（已收藏 → `DELETE`，未收藏 → `POST`），
两个端点都是幂等的「设定为目标状态」，**不允许服务端自己 toggle** ——
那在重试时会把「收藏」翻成「取消」。
守住它的断言在 `tools/test-cloud-sync.js` 第 8 节。

⚠️ **两个响应体同形**：`POST` 与 `DELETE` 都返回 `{ id, favorite, ids }`
（`favorite` 表示**操作完成后**的状态，不是「这次有没有产生变化」——
重复收藏同一所时仍是 `favorite: true`，客户端拿它直接渲染星标）；
`GET` 返回 `{ ids, updatedAt }`，其中 `ids` 顺序为**最近收藏在前**。
客户端一律以 `ids` 整份覆盖本机，不要自己重算一份（两份口径迟早漂）。

#### 云开发路线下的鉴权语义差异

| | REST | 云开发 |
|---|---|---|
| openid 获取 | 后端调 `code2session` 换取 | 云函数内 `cloud.getWXContext()` **直接得到** |
| 自定义 token | 需要 | **不需要** |
| `POST /v1/auth/login` 的实际动作 | 换取凭据 | 按 openid **建档 / 取档** |
| 响应里的 `token` | 真实 token | 固定为空串（保持结构一致，客户端零改动） |

⚠️ 由此产生一处**必须**的客户端配合：`utils/api.js` 的 `restoreSession()`
不能再用「有没有 token」判断是否已登录 —— 云开发路线下没有 token，
沿用该判据会让**每次启动都判定为未登录**，且不报任何错。
现行实现已按传输层分流（rest 查 token，cloud 直接问服务端）。

⚠️ **不要把 openid 理解成「用户登录」**：它由微信静默下发，不弹窗、不需要授权，
也不含姓名/手机号等个人信息。用它做数据归属不构成收集个人信息，
与《小程序内用户账号登录规范》意义上的「要求用户登录」是两件事。

#### 云数据库集合与权限

| 集合 | 权限 | 说明 |
|---|---|---|
| `users` | 仅管理端可读写 | openid 唯一，**不返回给客户端**。文档里同时承载个人资料、成绩档案（`academic`）、收藏（`favorites`）三块数据 |
| `feedbacks` | 仅管理端可读写 | 工单，含联系方式，仅团队可见 |
| `content` | **所有用户可读，仅管理端可写** | 内容补丁 |
| `notify_subs` | 仅管理端可读写 | 订阅消息（反馈受理通知）的授权状态。主键 = `sha256('openid:' + openid)`，与 `users` 的 `_id` **同构**，所以可以直接拿用户列表里的 `_id` 去查，不需要额外关联字段；**文档里不存 openid 明文** |

> ⚠️ **`notify_subs` 为什么不能并进 `users`**（2026-09-24 定）：
> `POST /v1/feedback` 是全项目**唯一允许匿名**的写接口（见 4.8），
> 而「刚提交完反馈、还没登录」的用户恰恰最需要收到受理结果。
> 若把订阅状态放进 `users`，未登录用户就存不下来；而若允许给未登录者也
> 建 `users` 文档，管理台的「注册用户」计数**立刻被污染** —— 那是编造运营数据。
> ⇒ 两份数据分开，各按自己的维度存（一个是业务账号，一个是微信身份）。
>
> ⚠️ 云开发要求**集合先手动创建**。`notify_subs` 不存在时，
> `GET/PUT /v1/notify` 会返回 503 并明确提示「请先在云开发控制台建集合」，
> 而不是静默当成「这个用户没订阅」。
> 管理台发送侧的读表失败同样会 503（见下面对应的错误码说明）。

> ⚠️ **成绩与收藏不再另建集合**，而是作为 `users` 文档的 `academic` / `favorites` 字段
> （2026-09-22 上云时定的）。理由：
> · 身份判定直接复用 `findActive`（已登录 = 文档存在且 `activeSession === true`）——
>   另起一个集合就要把这套判据再实现一遍，两份实现迟早漂移，而**漂移不会报错**；
> · 云开发没有 JOIN，分集合读要多一次往返；
> · 数据规模本就是「一人一份」，合并进用户文档是文档型数据库的常规用法。
>
> 代价是这三个 handler 写的是**同一份文档**，所以一律只能走 `.update()` 局部写入：
> `.set()` 整份覆盖会让「保存成绩」把收藏和昵称一起清掉，**而且不会报错**。
> 边界说明见 `handlers/academic.js` 头部。
>
> 表里原来的 `favorites` / `academic_profiles` 两张表，描述的是
> 「将来改成**客户端直连数据库**」时的形态（那时没有云函数做归属校验，
> 只能靠集合权限兜底）。**现在不是直连，别照着建。**

> ⚠️ `content` 集合若误设成「仅创建者可读写」，普通用户将读不到任何补丁，
> 而 `loadContent()` 会**静默**回落到内置默认值 —— 表现为「后台改了文案但线上没变」，
> 且没有任何报错。这是一个只看日志查不出来的故障，配权限时务必核对。

### 2.3 REST 路线的上线硬性前置条件

若走路线 A，必须满足：
2. 在微信公众平台「开发管理 → 服务器域名」中配置为 **request 合法域名**
3. 证书有效且支持 TLS 1.2+
4. 未完成上述配置时，真机上所有请求会被拦截（开发者工具可勾选「不校验合法域名」临时绕过，**仅限调试**）

### 2.4 鉴权

登录后签发的自定义登录态通过 Header 传递：

```
Authorization: Bearer <token>
```

- 除 `auth.login`、`meta.config`、`feedback` 外，**所有接口都需要**该 Header
  - `feedback` 是**匿名可用**的写接口，理由见 4.8 —— 强制登录会把「登录不上」这类
    最需要收到的反馈挡在门外。未登录时服务端 `userId` 记 `null`，照常收单。
- token 建议有效期 7 天，续期通过 `auth.session` 静默刷新
- 服务端判定失效时返回 `HTTP 401` 或 `{code: 401}`，客户端会自动清除登录态并触发重新登录

### 2.5 统一响应结构

```json
{
  "code": 0,
  "message": "",
  "data": {}
}
```

| code | 含义 |
|---|---|
| `0` | 成功 |
| `400` | 参数校验失败（`message` 需为可直接展示给用户的中文） |
| `401` | 登录态失效 |
| `403` | 无权限 |
| `404` | 资源不存在 |
| `429` | 触发限流 |
| `500` | 服务端异常 |
| `501` | **该端点尚未在云端实现**（仅云开发路线，客户端据此静默回落本地实现，见 2.2） |

客户端 `data` 为 `null` 时按空对象处理。

⚠️ **`501` 不是错误码，是「还没做」的标记。** 它永远不会由自建后端返回
（实现了才上线），只在云开发路线下作为渐进式接入的通道出现。
客户端对它的处理与其它错误码不同：不提示、不重试、直接走本地实现。

### 2.6 分页

请求：`?page=1&size=20`（`page` 从 1 开始，`size` 默认 20、上限 100）

响应：

```json
{ "total": 36, "page": 1, "size": 20, "list": [] }
```

---

## 三、登录时序

```
小程序                                后端
  │                                    │
  ├─ wx.login() ──► code               │
  │                                    │
  ├─ POST /v1/auth/login {code} ──────►│
  │                                    ├─ code2session（AppID + Secret）
  │                                    ├─ 取 openid / unionid
  │                                    ├─ upsert 用户
  │◄──── {token, user, expiresIn} ─────┤
  │                                    │
  ├─ wx.setStorage('sp_token', token)  │
  │                                    │
  └─ 后续请求带 Authorization: Bearer  │
```

> **合规要求（重要）**：登录**不得**在启动时强制触发。
> 依据《小程序内用户帐号登录规范》，必须先让用户清楚知悉小程序功能，
> 由用户**主动点击**才可发起登录，且必须提供「暂不登录，先浏览」出口。
> 本小程序已将登录页（`pages/signin`）做成按需触发，启动路径为
> `条款同意页 → 首页`，不经过登录页。

> **说明**：`openid` 的换取在两条路线上方式不同——
> 路线 A 由后端调 `code2session`；路线 B 云函数内可直接通过
> `cloud.getWXContext()` 拿到 `OPENID`，无需手动换。**前端流程不变**。

### 3.1 手机号快捷登录（可选，二期）

微信「手机号快速验证组件」返回 `code`，前端提交：

```http
POST /v1/auth/phone
{ "code": "<phone-code>" }
```

服务端调用 `phonenumber.getPhoneNumber` 换取手机号。**仅当功能确有需要时申请**，
一进入小程序即弹窗索取手机号属违规。

---

## 四、接口定义

### 4.1 认证

#### POST `/v1/auth/login`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | string | ✅ | `wx.login()` 返回的临时凭证 |

**响应 `data`**

```json
{
  "token": "eyJhbGciOi...",
  "expiresIn": 604800,
  "user": {
    "id": "u_1024",
    "nickName": "示例用户",
    "avatarUrl": "https://...",
    "email": "user@example.com",
    "plan": "备考版",
    "createdAt": "2026-09-15T13:00:00+08:00"
  }
}
```

#### POST `/v1/auth/logout`
使当前 token 失效。响应 `data` 无内容。

#### GET `/v1/auth/session`
校验登录态并返回当前用户。

```json
{ "user": { "id": "u_1024", "nickName": "示例用户", "plan": "备考版" } }
```

未登录时返回 `data: null`（不返回 401，便于启动时静默探测）。

---

### 4.2 用户

#### GET `/v1/user/profile`

```json
{
  "id": "u_1024",
  "nickName": "示例用户",
  "avatarUrl": "",
  "email": "user@example.com",
  "plan": "备考版",
  "grade": "高三",
  "city": "某城市",
  "createdAt": "2026-09-15T13:00:00+08:00",
  "updatedAt": "2026-09-15T13:00:00+08:00"
}
```

**未登录返回 `data: null`，不返回 401** —— 与 `/v1/auth/session` 同一约定：
账号管理页与个人资料页在未登录时也要能正常渲染「登录后同步数据」的提示，
不该被一个错误挡住。

> ⚠️ `plan` 属**只读**字段（服务端下发，如「备考版」）。客户端无权修改，
> 见下方 PUT 的字段表。没有值就是空串，**不要**给一个默认档位 ——
> 那会让用户看到一个他从未选择过的身份。

#### PUT `/v1/user/profile`

请求体为**部分字段**，只提交需要修改的项：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `nickName` | string | ✖ | 昵称，≤ 20 字（按 **Unicode 码点**计） |
| `avatarUrl` | string | ✖ | 头像地址；只接受 `https://` 或 `cloud://` |
| `email` | string | ✖ | 邮箱，需校验格式；选填 |
| `grade` | string | ✖ | 年级，取自内容层 `enums.grades`（初三 / 高一 / 高二 / 高三 / 已毕业） |
| `city` | string | ✖ | 城市，≤ 20 字 |

响应：更新后的完整用户对象。

**未登录返回 401**（不是 200 + 空成功）—— 改写他人档案这种事不接受静默降级。

两条**必须两端一致**的口径：

1. **长度按码点计，不按 UTF-16 码元计**。`"🙂".repeat(20)` 是 20 个码点、
   40 个码元；用 `str.length` 判会让用户遇到「前端说没超、后端说超了」。
   客户端 `maxlength` 与 `data/content.js` 的 `profile.*Max`、服务端
   `handlers/user.js` 的 `WRITABLE` 上限必须同值。
2. **`avatarUrl` 白名单**。`wxfile://` / `http://tmp/...` 这类**本机临时路径
   一律拒绝**：`bindchooseavatar` 给的就是临时路径，存进账号只会得到一张
   换设备就裂的图，而且没有任何报错。客户端在上传失败时也不提交该字段
   （见 `utils/api.js` 的 `saveAvatar`），服务端这里再拦一道。

白名单之外的字段（`id` / `plan` / `openid` / `createdAt` / `activeSession`）
即使被提交也**一律忽略**（不报错）—— 报错会把「客户端多发了个字段」
变成用户可见的失败，而忽略既不泄露也不放权。

#### GET `/v1/user/stats`
账号管理页顶部三宫格。

```json
{ "matched": 26, "favorites": 12, "documents": 3 }
```

| 字段 | 说明 |
|---|---|
| `matched` | 最近一次匹配命中的院校数 |
| `favorites` | 收藏院校数 |
| `documents` | 文书数量 |

---

### 4.3 成绩档案

#### GET `/v1/academic/profile`

```json
{
  "curriculum": "AP",
  "coursesMap": {
    "AP": [{ "name": "AP Calculus BC", "date": "2026 年 5 月统考", "score": 5, "max": 5 }],
    "AL": [],
    "IB": [],
    "NONE": []
  },
  "courses": [{ "name": "AP Calculus BC", "date": "2026 年 5 月统考", "score": 5, "max": 5 }],
  "gpa": 86,
  "gpaScale": 100,
  "ielts": { "overall": 5.0, "l": 4.5, "r": 4.5, "w": 5.5, "s": 5.0 },
  "toefl": null,
  "sat": null,
  "countries": ["ca", "au"],
  "majors": ["cs"],
  "updatedAt": "2026-09-15T13:00:00+08:00"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `curriculum` | enum | `AP` / `AL` / `IB` / `NONE`，取值由内容层 `enums.curricula` 定义（服务端只校验长度，不校验枚举） |
| `coursesMap` | object | **存储真源**。按课程体系分别保存已录科目，四个键 `AP`/`AL`/`IB`/`NONE` 恒存在（空数组也写出来） |
| `courses` | array | `coursesMap[curriculum]` 的**派生镜像**，由服务端现算 |
| `gpa` | number\|null | 高中成绩单均分，取值 `(0, 100]`。**未填必须是 `null`，不是 0** |
| `gpaScale` | number | 满分制，默认 100 |
| `ielts` | object\|null | `{overall, l, r, w, s}`，各 0–9（`overall` > 0）。未考为 `null` |
| `toefl` | number\|null | 0–120，未考为 `null` |
| `sat` | number\|null | 0–**2400**，未考为 `null`（上限取 2400 而非 1600：旧分制仍有学生在用） |
| `countries` | string[] | 目标国家，去重 |
| `majors` | string[] | 目标专业方向，去重 |
| `updatedAt` | string | ISO 时间，**服务端盖章**；客户端传什么都不采信（它是审计信息，不是用户输入） |

> ⚠️ **`coursesMap` 才是真源，`courses` 只是镜像。** 学生可能同时考了 AP 与 IB，
> 切换分段控件不该互相清空（`utils/store.js` 的注释里写了这段历史）。
> 服务端**现算** `courses` 而不采信客户端传来的值 —— 镜像一旦采信，就会与
> `coursesMap` 漂移成「一份数据两个答案」，而且不会报错。

**未登录 / 从未保存过 → `data: null`，不返回 401。**
两种情形在服务端是同一个响应，但客户端要靠它决定「是否回落本机缓存」——
未登录时本机就是唯一数据源。
⚠️ 服务端**不返回默认档案**：内容层的 `defaultAcademic` 是产品初始态，
不是某个用户的数据。把它当成「这个用户的档案」发出去，就是编造用户数据。

#### PUT `/v1/academic/profile`

请求体同上（**全量覆盖**），响应为保存后的对象。
客户端 match 页每次 `persist()` 传的都是整份档案，与之匹配。
⚠️ 将来若要做**部分更新**，必须另开端点 —— 不能把本端点改成「有就更新、没有就保留」，
那样「清空某个字段」就永远表达不出来了。

**未登录 → 401**（同 `PUT /v1/user/profile`：写操作不接受静默降级）。

服务端的校验口径：只做**结构 / 范围**校验（类型、长度、数值区间），
**不校验取值枚举** —— 那些枚举在内容层可以远程下发，服务端硬编码一份就会出现
「后端说非法、前端说合法」，而两份枚举的变更节奏不同，漂移了不会报错。
白名单之外的字段（`openid` / `_id` / `activeSession` …）即使被提交也**忽略**（不报错）。

#### POST `/v1/academic/profile/reset`

重置为**初始态**（不是删除记录），响应为重置后的空档案。**未登录 → 401**。

⚠️ 初始档案的字段清单必须与内容层 `data/content.js` 的 `defaultAcademic` 逐字段一致，
由 `tools/test-cloud-handlers.js` 第 9 节比对看住 ——
少一个字段不会报错，只会让「重置」之后某块 UI 空掉。

---

### 4.4 收藏

#### GET `/v1/favorites`

```json
{ "ids": ["toronto", "ubc"], "updatedAt": "2026-09-15T13:00:00+08:00" }
```

`ids` 顺序为**最近收藏在前**。
**未登录 / 从未同步过 → `data: null`，不是 `{ids: []}`。**
⚠️ 这两者必须分开：`{ids: []}` 是「登录了、一所都没收藏」（权威答案），
`null` 是「拿不到云端数据」（客户端应回落本机缓存）。
混为一谈会在换设备登录时把本机收藏清空 —— 一个静默的数据丢失。

#### POST `/v1/favorites/{schoolId}`

收藏。**幂等**：已收藏时重复调用返回成功。

```json
{ "id": "toronto", "favorite": true, "ids": ["toronto", "ubc"] }
```

⚠️ `schoolId` 只做**格式**校验（`^[a-zA-Z0-9_-]{1,64}$`），**不做存在性校验**：
存在性校验需要一份院校 id 清单，把它拷进云函数包就是又一份影子副本
（见 `tools/sync-data-copies.js` 的清单），而且院校一旦下线，
用户的既有收藏会突然全部变成「非法」。院校在不在库里，由**读取侧**负责如实标记
（管理台就是这么做的）。

#### DELETE `/v1/favorites/{schoolId}`

取消收藏，同样幂等，响应与 POST 同形（`favorite: false`）。

**POST / DELETE 未登录 → 401。** 给未登录用户写一份没人认领的收藏列表，
等于把数据挂在一个不存在的账号上，谁也拿不回来。

#### 顺序与并发（两条都是「不报错但会错」的坑）

- **新增时前插**（最近收藏在前），与客户端 `store.toggleFavorite` 的 `unshift` 同序 ——
  两侧顺序不同会让收藏页在「本机 → 云端」切换时跳序。
- 服务端的「读列表 → 改 → 写回」包在**事务**里。
  ⚠️ 不能改写成两次原子更新（`_.pull` + `_.unshift`）：两次更新之间存在窗口，
  期间任何一次 GET 都会返回一份缺项的列表，而客户端拿到列表就整份覆盖本机 —— 项也就跟着丢了。
  守住它的断言在 `tools/test-cloud-handlers.js` 第 8.9 节（并发收藏 5 所，全部保留）。

#### 换设备登录时会发生什么（客户端同步规则）

登录成功后客户端会**自动**做一次同步（`api.login()` 内部调 `syncUserData()`），
不需要页面各自记得调。裁决依据是本机保存的两个标记
（`sp_profile_owner` / `sp_fav_owner` 与 `sp_profile_dirty` / `sp_fav_dirty`，见 `utils/store.js`）：

| 云端 | 本机 | 动作 | 为什么这么定 |
|---|---|---|---|
| 没有数据 | 有内容 | **本机上传** | 否则「先试用、后登录」的用户一登录就发现自己填的成绩没了 |
| 没有数据 | 也空 | 什么都不做 | 写一份空档案上去，会让「从未填写」变成一条真实记录 |
| 有数据 | `owner` 是**别人** | 云端**覆盖**本机 | 这台设备上次登的是别的账号，绝不能把 A 的成绩带给 B —— 这是隐私边界 |
| 有数据 | `dirty`（有未推送的改动） | **本机为准**，并把差异同步上去 | 整份用云端会丢掉用户在这台设备上刚改的内容 |
| 有数据 | 干净、同一主人 | 云端**覆盖**本机 | 常规的「换设备登录」走这条 |

合并口径统一为一条原则：**`dirty` 说明「本机刚改过」，那本机就是更新的那一份。**
- 档案：按**字段**合并 —— 本机有值的字段用本机，本机为空的用云端补；
- 收藏：**本机整份为准**，并把差异同步到云端（**包括删掉云端多出来的** ——
  否则用户取消掉的收藏会在下次同步时「复活」）。

⚠️ 两条铁律（违反任一条都会静默丢数据）：
1. **同步直连远端，不走 `call()`。** `call()` 会把 501 静默回落成本地，
   那样「云端没有这份数据」与「端点还没实现」就分不开了 ——
   前者该把本机推上去，后者该什么都不做。
2. 云端**读不到**（501 / 网络失败 / 401）时立刻放弃本次同步，**本机一个字节都不动**。
   绝不能把「读不到」当成「云端是空的」。

行为断言见 `tools/test-cloud-sync.js`（10 个场景，含「网络失败时本机不被改写」
「换账号不串数据」「连点保存不产生乱序覆盖」）。

---

### 4.5 匹配

#### POST `/v1/match/run`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `profile` | object | ✖ | 不传则使用服务端已保存的档案 |

**响应 `data`**

```json
{
  "generatedAt": "2026-09-15T13:00:00+08:00",
  "total": 26,
  "evaluated": 24,
  "tiers": { "safe": 3, "match": 18, "reach": 5, "unknown": 2 },
  "insight": "语言成绩是当前最明显的短板……",
  "disclaimer": "预估匹配度由本程序按自研规则计算，非院校官方录取概率，仅供参考。",
  "list": [
    {
      "id": "toronto",
      "nameCn": "多伦多大学",
      "nameEn": "University of Toronto",
      "region": "ca",
      "countryCn": "加拿大",
      "cityCn": "多伦多",
      "qs": 32,
      "qsLabel": "QS 32",
      "crest": { "color": "#0B4DA2", "shape": "building" },
      "match": 75,
      "tier": "reach",
      "capped": true,
      "needData": false,
      "dims": [
        { "key": "academic", "label": "学术成绩", "value": 96, "met": true, "detail": "均分 86 / 要求 85" },
        { "key": "language", "label": "语言成绩", "value": 48, "met": false, "detail": "雅思 5.0 / 需 6.5（单项 6），还差 1.5 分" },
        { "key": "curriculum", "label": "先修课程", "value": null, "met": false, "detail": "该校 AP 仅用于转学分（单科 4 分以上），不作为录取评估依据" }
      ]
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `total` | 目标国家范围内的院校总数 |
| `evaluated` | 已算出分数的数量 |
| `tiers` | 各档位计数；`unknown` = 录取要求数据不足，**不下结论** |
| `match` | 预估匹配度 0–100，`null` 表示数据不足 |
| `tier` | `safe` 保底 / `match` 匹配 / `reach` 冲刺 / `unknown` 待评估 |
| `dims[].value` | 该维度得分 0–100；**`null` 表示该维度对本校不适用**（当前只有「先修课程」会出现），未参与加权，页面只渲染 `detail` 说明、不画进度条 |
| `capped` | `true` = 因语言未达该校直录线，档位被封顶为「冲刺」（见下方口径） |
| `needData` | `true` = 本次未出分（缺院校要求或缺用户档案） |
| `reason` | 未出分的原因：`noRequirement`（未采集）/ `insufficientRequirement`（官方不公布）/ `noProfile`（档案不全） |
| `partialData` | `true` = 有分数，但至少一个维度取了中性占位分 |
| `missingDims` | 取占位分的维度键，取值 `academic` / `language` |

> **计算口径（客户端与服务端必须一致，否则结果会对不上）**
> 加权：`学术 42% + 语言 33% + 课程 25%`，四舍五入取整。
> **不适用的维度会把它的权重一起从分母里剔除**，剩下的按比例放大 ——
> 既不给占位分充数（那是「占位分堆出结论」），也不白送权重（那会让总分虚高）。
> 分档：`≥85 保底`、`70–84 匹配`、`<70 冲刺`。
> ⚠️ **语言未达该校直录线时，档位封顶为「冲刺」**（`matchConfig.capTierWhenLanguageShort`）：
> `require.ielts` 取自各校官网 English language requirements 页，是**直录最低要求**；
> 未达标拿不到直录 offer，只能走语言班 / 预科 / 双录，判成「匹配」是站不住的结论。
> 封顶时 `capped: true`，此时会出现「分数 ≥70 却是冲刺」的组合，详情页有对应说明。
> 学术：`学生均分 / 要求均分` 比值分档（≥1.06→100，≥1.00→96，≥0.97→88，≥0.94→78，≥0.90→64，≥0.85→50，其余 36）。
> 语言：总分与单项全部达标→100；未达标但该校有语言/预科/双录/国际大一路径时，
> 按**离目标线的差距**分档（差距取「总分差」与「单项差」中的较大者）：
> ≤0.5→88、≤1.0→68、≤1.5→48、更大→30；该校无任何衔接路径→38。
> ⚠️ **单项只在考生真的填了（>0）时才参与判定**：把没填的单项当 0 分，等于把「未知」判成「不达标」。
> 课程：两个**并列**约束 —— `require.apMin`（AP 单科最低分，1–5）与
> `require.apCoursesMin`（最少科目数，只有官网明文时才有值）。
> ⚠️ `apMin` **不是「需要几门 AP」的别称**，两者不可互相顶替。
> 院校不把 AP 用于录取（`ap: 'credit_only'`）、两个约束都没有值、
> 或考生没有已出分的 AP 科目时，该维度**不适用**（`dims[].value: null`，不参与加权）；
> 适用时取「分数达标比例」与「门数满足比例」的**较小值**，在 36–100 之间线性取值。
> 某维度**无官方数据**时取中性分 70，并把该维度记入 `missingDims`（此时 `partialData` 为 `true`）。
>
> ⚠️ **不出分的两种情形，不可混为一谈：**
> 1. `require` 整体缺失（`noRequirement`）—— 我们尚未采集到该校录取要求；
> 2. `require` 存在但**学术与语言两个主维度都没有官方数值**（`insufficientRequirement`）——
>    即该校官网明文不公布最低分（美国顶尖私校常见）。
>    此时若照常计算，两个主维度会双双取中性分 70、课程维度再白送 100，
>    加权后稳定产出 78 分 → 被判为「匹配」。**这是纯占位值堆出来的假结论**
>    （会让用户看到「普林斯顿 匹配度 78%」），因此一律返回 `match: null` + `tier: 'unknown'`。
>    ⚠️ 实现处见 `utils/match.js` 的 `evaluate()` 第 ② 步，**此闸门不可移除**；
>    `tools/check-admission-data.js` 第 8 节有对应断言守住。

#### GET `/v1/match/latest`
返回最近一次匹配结果，结构同上；无记录时 `data: null`。

#### POST `/v1/ai/insight` —— 个性化解读（**⛔ 当前不实现，请先读这段**）

> ⛔ **后端不要实现这个接口。**
>
> 本项目**刻意不在运行期接大模型**。原因不是成本，是资质：
> 个人主体小程序申请不了「深度合成-AI问答」类目，而一旦运行期出现模型生成的文本，
> 不论中间经过几层转发，都构成「向公众提供生成合成服务」，提审即被驳回。
> 完整依据与替代方案见根目录 **`AI接入边界方案.md`**。
>
> 客户端因此**恒走规则模板**：`content.ai.enabled` 被钉死为 `false`，
> 建议文案来自内容层 `content.ai.templates` + 占位符插值（`utils/api.js` 的 `ruleSuggestions`）。
> `utils/api.js` 里保留了本接口的调用分支，是**为将来升级企业主体预留的升级位**，
> 当前不可达 —— 这是设计，不是遗漏，请不要「顺手修一下」。
>
> 下面保留原设计说明，作为将来真要走这条路时的依据。

> **为什么分两个接口，而不是让 AI 直接算分？**
> 匹配分档必须**可审计、可复现** —— 同一份成绩每次都要得出同样的结论，
> 交给大模型反而不可靠，也无法向用户解释「为什么是 78 分」。
> 因此边界是：**规则引擎算分，AI 负责把结构化结果翻译成人话与行动建议。**
>
> 未接入 AI 时（`content.ai.enabled = false`）客户端会用规则模板本地生成，
> 并在结果页**如实标注「由本程序规则引擎生成」**，不会冒充 AI。

请求：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `profile` | object | ✅ | 成绩档案（结构同 4.3） |
| `result` | object | ✅ | 规则引擎产出的匹配结果（结构同 4.5） |

```json
{
  "profile": { "curriculum": "AP", "gpa": 86, "ielts": { "overall": 5.0 }, "countries": ["ca", "au"] },
  "result": { "total": 26, "tiers": { "safe": 8, "match": 17, "reach": 1, "unknown": 0 } }
}
```

响应 `data`：

```json
{
  "text": "语言成绩是当前最明显的短板……",
  "suggestions": [
    { "title": "优先提升语言成绩", "detail": "语言维度平均 58 分，是当前最低的一项……" },
    { "title": "梯度已经比较均衡", "detail": "可按「保底 2 : 匹配 4 : 冲刺 2」的比例精简申请清单。" }
  ],
  "generatedBy": "ai",
  "model": "…",
  "generatedAt": "2026-09-15T13:00:00+08:00"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 覆盖 `result.insight` 的一段总结 |
| `suggestions` | array | 行动建议，2–4 条；每条 `title` + `detail` |
| `generatedBy` | string | `ai` / `rule`。**客户端会原样展示这个来源，不要虚标** |

**服务端实现要求**

1. `prompt` 与模型选择由服务端持有，**不要下发给客户端**（避免被套取与刷量）
2. 超时建议 ≤ 20 秒；客户端超时会自动回落规则模板，不会出现空白
3. 输出必须是**结构化 JSON**，不要让模型返回自由文本再让客户端解析
4. 建议对同一 `profile + result` 的哈希做短时缓存，重复请求直接命中

#### POST `/v1/match/save`
把写入了解读的结果存档（客户端在拿到 AI 解读后调用，用于「最近一次结果」跨设备一致）。

---

### 4.6 院校

#### GET `/v1/schools`

| 参数 | 类型 | 说明 |
|---|---|---|
| `region` | string | `all` / `us` / `uk` / `ca` / `au`，默认 `all` |
| `keyword` | string | 匹配中文名 / 英文名 / 城市 / 国家 |
| `sort` | string | `default`（按 QS 升序）/ `qs` |
| `page` / `size` | number | 分页 |

响应：

```json
{
  "total": 36,
  "page": 1,
  "size": 20,
  "list": [
    {
      "id": "toronto",
      "nameCn": "多伦多大学",
      "nameEn": "University of Toronto",
      "region": "ca",
      "countryCn": "加拿大",
      "cityCn": "多伦多",
      "provinceCn": "安大略省",
      "qs": 32,
      "qsLabel": "QS 32",
      "qsTie": false,
      "qsChange": -3,
      "qsScore": 86.8,
      "nationalRank": 2,
      "founded": 1827,
      "type": "公立研究型",
      "crest": { "color": "#0B4DA2", "shape": "building" },
      "require": {
        "gpa": 85,
        "gpaNote": "需高中毕业证 + 三年成绩单",
        "ielts": 6.5,
        "ieltsSub": 6.0,
        "toefl": 100,
        "sat": "optional",
        "ap": "credit_only",
        "apMin": 3,
        "pathways": [
          { "name": "International Foundation Program", "type": "foundation", "ielts": 5.5, "desc": "一年制桥梁课程，完成后升大二" }
        ]
      }
    }
  ]
}
```

`require` 为 `null` 表示录取要求尚未采集 —— 客户端会显示「整理中」而**不会**编造结论。

⚠️ `require.apMin` 是 **AP 单科最低分数**（AP 考试为 1–5 分制），**不是「需要几门 AP」**。
它采集自各校的 AP 折算 / 转学分政策页（如滑铁卢 `ap-transfer-credit-chart`、
达尔豪斯 `specific-course-requirements/ap.html`），原文口径是
「a minimum final grade of 4」「national exam result of 4 or 5 are eligible for transfer credits」。
`require.ap === 'credit_only'` 表示**该校只把 AP 用于转学分，与录取评估无关**。

⚠️ `require.apCoursesMin` 是**最少 AP 科目数**，与 `apMin` 是两个**独立**约束：
`apMin` 管「每门至少几分」，`apCoursesMin` 管「至少要几门」。两者都没有时该维度不适用。
只有官网明文写了门数的院校才有值 —— 当前 3 所（NYU「需至少 3 门 AP」、
ANU / Macquarie「最少 / 通常 3 门」），其余为 `null`（未采集到 ≠ 没有要求）。
（2026-09-23 修正：此前该字段被当成门数使用，界面上出现了「AP 0 门 / 需 4 门」这种
各校官网从来没有的要求。`tools/check-admission-data.js` 的取值范围校验已由 0–10 收紧到 1–5。）

#### GET `/v1/schools/{id}`

```json
{
  "school": { "...": "同列表项" },
  "match": {
    "score": 89,
    "tier": "match",
    "dims": [],
    "needData": false,
    "reason": "",
    "partialData": true,
    "missingDims": ["academic"]
  },
  "favorite": true,
  "recommend": [
    { "id": "utm", "nameCn": "多伦多大学密西沙加校区", "badge": "分校区" }
  ]
}
```

`recommend` 排序规则：**本校分校区优先**，其后为同国家 QS 排名最接近的院校。

> ⚠️ `match` 里的口径字段（`needData` / `reason` / `partialData` / `missingDims`）**必须原样透出**，
> 不能只传 `score`/`tier`/`dims`。详情页要据此区分三种情况，只传分数会让它们长得一模一样：
> · `reason = 'insufficientRequirement'` → 显示「该校官方不公布统一最低分」（院校政策，不是我们没采）
> · `reason = 'noRequirement'` → 显示「录取要求整理中」（我们的采集进度）
> · `partialData` 且 `missingDims` 含 `language` → 在分数下补一句「该校未公布英语最低分，语言维度按中性值估算」
>
> 只对**语言维度**缺数据加这句说明：均分缺失是美加院校的普遍政策（89 所里 72 所不公布百分制均分），
> 而每个维度条下方已单独写明，再挂通栏提示会出现在绝大多数院校上，变成噪音。

---

### 4.7 内容与配置（新增，最重要的一项）

> **用途**：把页面上所有文案、列表、枚举、算法权重、功能开关都收到服务端，
> 使「改文案 / 调整匹配口径 / 灰度开关 / 增删功能入口」**不需要重新发小程序版本**。

#### GET `/v1/content`（无需鉴权）

响应体为**局部补丁**：只下发需要覆盖的字段，未下发的字段沿用小程序内置默认值
（`miniprogram/data/content.js`）。客户端按「对象递归合并、数组整体替换」的规则合并。

```json
{
  "version": "1.0.1",
  "minVersion": "1.0.0",
  "home": {
    "season": "2027 申请季",
    "hero": { "chip": "{season}", "title": ["输入成绩，3 秒匹配", "适合你的院校"] },
    "features": [
      { "key": "match", "icon": "tab-match", "label": "成绩匹配", "url": "/pages/match/match", "tab": true, "ready": true }
    ]
  },
  "enums": {
    "majors": [{ "key": "cs", "label": "计算机科学" }]
  },
  "matchConfig": {
    "weights": { "academic": 0.42, "language": 0.33, "curriculum": 0.25 },
    "thresholds": { "safe": 85, "match": 70 }
  },
  "featureFlags": { "phoneLogin": false, "feedback": true }
}
```

**一级字段清单**

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | 内容版本，客户端据此判断是否更新 |
| `minVersion` | string | 最低内容版本；客户端版本低于此值时提示升级 |
| `brand` | object | 品牌名与标语 |
| `nav` | object | 各页导航栏标题 |
| `tabBar` | array | 标签栏文案（**增删标签页仍需改 app.json，属发版级改动**） |
| `home` / `match` / `matching` / `result` / `schools` / `detail` / `account` / `signin` / `terms` / `functions` | object | 各页文案、分组、功能入口 |
| `common` | object | 通用文案（返回、加载中、网络错误等） |
| `defaultAcademic` | object | 首次进入时的示例成绩档案 |
| `enums` | object | 课程体系 / 国家 / 专业 / 地区枚举 |
| `matchConfig` | object | 匹配算法权重与分档阈值（口径见 4.5） |
| `featureFlags` | object | 功能开关 |

**合并规则（客户端实现见 `utils/api.js` 的 `deepMerge`）**

- 对象：递归合并，只覆盖服务端提交的字段
- 数组：整体替换（便于运营整批替换功能入口、枚举项）
- 标量：直接覆盖

**容错**：接口不可用时静默回落到内置默认值，不弹错、不阻塞页面；
响应体会缓存到 Storage，下次启动先渲染缓存再刷新。

#### GET `/v1/meta/config`（无需鉴权）

返回**运行期元信息**。⚠️ 本接口职责已刻意收窄，**不再下发任何业务配置**。

```json
{
  "dataVersion": "2026-09-15"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `dataVersion` | string | 院校静态数据的编译时间。客户端据此判断本地内置数据是否需要刷新 |

##### ⚠️ 单一事实来源（SSOT）约定 —— 不要在这里重复下发下面这些字段

| 字段 | 唯一来源 | 说明 |
|---|---|---|
| `season`（申请季） | `GET /v1/content` → `home.season` | 首页 Hero chip 由 `home.hero.chip` 模板插值而成 |
| `featureFlags`（功能开关） | `GET /v1/content` → `featureFlags` | 客户端读取实现见 `utils/api.js` 的 `flag()` |
| 其余全部文案 / 枚举 / 算法权重 | `GET /v1/content` | 见 4.7 上一节 |

**为什么必须坚持这条**：`season` / `countdownTarget` / `featureFlags` 曾在本接口与
`/v1/content` **各定义一份、值完全相同**。两个接口的变更节奏不同（内容按运营节奏改、
元信息按发版节奏改），后端只改其中一处时，另一处仍是旧值 ——
客户端只会读到先到的那一份，于是出现**「以为改了、实际没生效」的静默漂移**，
而且不会有任何报错。

##### ⚠️ 已废弃字段：`countdownTarget` / `countdownMaxDays`

**不要实现、也不要下发这两个字段。** 首页曾用它算一个「距 2027-01-15 还有 N 天」的
全局倒计时，现已**刻意移除**——理由如下（2026-09-16 确定）：

- 每所大学的申请截止时间不同，**每个国家/地区的周期也不一样**，同一所学校还可能有
  多轮次与滚动录取。用一个全局倒数日代表「申请季还剩几天」属于**假精度**，
  会让用户误以为所有学校同一天截止。
- 因此首页只显示申请季本身（`home.season`），不显示天数。

**若将来要做倒计时**：正确的位置是**院校详情页**，按「具体院校 × 具体申请轮次」算，
数据也应由院校侧的接口提供（而非一个全局配置项）。客户端已有的通用工具
`api.daysUntil(target)` 可直接复用，不必重写日期逻辑。

**历史包袱提示**：截至本文档修订时，客户端对 `/v1/meta/config` **零调用**
（首页读的是 `/v1/content` 的 `home.*`）。若后端已按旧契约实现了 `season` /
`countdownTarget` / `featureFlags` 三个字段，可直接删除 —— 无消费方，删除是安全的。

---

### 4.8 反馈

#### POST `/v1/feedback`

**⚠️ 本接口是本组唯一「允许匿名」的写接口 —— 不要给它加登录前置。**

理由：意见反馈恰恰是用户在**遇到问题**时才会用的功能，而「登录不上 / 授权失败」
本身就是最高频的反馈类型之一。强制登录会把最该收到的那批反馈挡在门外。
已登录用户由服务端自动关联 `userId`；未登录则 `userId` 为 `null`，照样收单。
（这也是《小程序内用户帐号登录规范》的精神：能用功能，就不要拦登录。）

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | string | ✅ | 反馈类型：`bug` 功能异常 / `data` 院校数据有误 / `idea` 功能建议 / `complaint` 投诉与举报 / `other` 其他 |
| `content` | string | ✅ | 问题描述，**1–200 字**（按 Unicode 码点计，前后端都要校验） |
| `contact` | string | ✖ | ⚠️ **已废弃（v1.0.3 起）**：小程序端**不再采集、也不再发送**该字段。保留是因为历史工单里有值、管理台仍要展示；新工单该字段恒为空串。**不要再在任何客户端界面加回填写入口** —— 这正是平台审核的驳回项（「非合理场景下收集、存储用户敏感信息」，见下方「审核合规」）。 |
| `images` | string[] | ✖ | 截图，最多 3 项。每项为 `POST /v1/upload` 返回的 `fileId`，**不接受外链 URL** |
| `schoolId` | string | ✖ | 当 `type=data` 时可选，指出出错院校，便于定向修正采集数据 |
| `client` | object | ✖ | 客户端环境 `{ version, platform, system }`，用于定位兼容性问题 |

```json
{
  "type": "data",
  "content": "多伦多大学详情页显示的语言要求是雅思 6.5，官网写的是 6.5（单项 6.0），单项没显示出来。",
  "images": [],
  "schoolId": "toronto",
  "client": { "version": "1.0.3", "platform": "ios", "system": "iOS 18.2" }
}
```

**响应 `data`**

```json
{
  "ticketId": "fb_20260916_0007",
  "createdAt": "2026-09-16T20:58:00+08:00",
  "replyWithin": 3
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `ticketId` | string | 工单号，需原样展示给用户（便于回访时对账） |
| `replyWithin` | number | 承诺回复天数。**由服务端下发**，不要在小程序里写死 —— 改 SLA 不该发版。⚠️ **v1.0.3 起界面不再展示它**：反馈页底部那句「我们会在 {days} 个工作日内通过微信回复你」已随联系方式卡删除（没有联系方式，这个承诺兑现不了）。字段保留仅为不改响应结构，结果页已不再对成功文案做 `{days}` 插值。 |

**审核合规（v1.0.3）**：平台曾以「涉嫌在非合理场景下收集、存储用户密码或
个人敏感信息，包括但不限于微信帐号、QQ 号码、银行账号等」驳回本小程序，
指向的正是反馈页的「联系方式」输入卡 ⇒ 已整卡移除，界面与提交体里都不再出现它。
任何新增的、会向用户索取账号类信息的表单，都要先过这一关。

> **为什么响应里没有 `ok: true`**：2.4 已约定 `code === 0` 即成功，
> 再加一个 `ok` 是**同一事实的第二个来源**（SSOT 违规），两边一旦不一致客户端无法裁决。

**幂等性**：**非幂等**。同一条内容重复提交应视为两张独立工单
（用户可能确实要补充说明）。防重靠客户端提交期间禁用按钮 + 服务端限流，不靠去重。

**限流**：同一 `openid`（未登录时按设备指纹）**60 秒内最多 3 次**，超出返回 `429`。
前端收到 `429` 时提示「提交过于频繁，请稍后再试」，**不要**自动重试。

**错误码**

| code | 触发场景 |
|---|---|
| `400` | `type` 缺失或不在枚举内；`content` 为空 / 超过 200 字；`images` 超过 3 项 |
| `429` | 提交过于频繁 |
| `500` | 服务端异常（客户端提示可重试） |

> ⚠️ `400` 的 `message` 必须是**可直接展示给用户的中文**（见 2.4），
> 不要返回 `invalid type` 这类英文串让前端自己翻译。

#### POST `/v1/upload`

供反馈截图上传。走 `multipart/form-data`（小程序侧用 `wx.uploadFile`），
**请求体不是 JSON**，故不走 2.4 的统一响应包装，直接返回：

```json
{ "fileId": "file_9f2c...", "url": "https://.../9f2c.png", "width": 750, "height": 1334 }
```

| 约束 | 值 |
|---|---|
| 单张大小 | ≤ 5 MB |
| 格式 | `jpg` / `png` |
| 每次反馈 | ≤ 3 张 |

**实现建议**：服务端落对象存储后**必须做一次客户端可信度检查**——
只接受图片 MIME，不允许通过改扩展名上传可执行内容；`fileId` 与上传者 `openid` 绑定，
防止他人的 `fileId` 被拼进自己的反馈里。

> **前端提示**：`wx.uploadFile` 的域名要单独配到小程序后台的
> 「uploadFile 合法域名」，与 request 域名不是同一栏，容易漏。

---

### 4.9 订阅消息（反馈受理通知）

**用途**：用户在「我的 > 偏好与其他 > 消息通知」里开启后，后台受理其反馈工单时
可以用微信「服务通知」主动告知结果，不必让他自己回小程序里翻。

#### 微信机制的硬约束（决定了这个功能只能长成现在这样）

| 约束 | 后果 |
|---|---|
| 小程序主动触达用户的通道**只有订阅消息** | 没有「发个站内信」这种替代品 |
| **个人主体只能申请一次性订阅**（长期订阅仅开放给政务民生 / 医疗 / 金融等类目） | 授权一次 = **只能下发一条** |
| 微信**没有**提供查询剩余额度的接口 | 任何「剩余 3 条」的显示都是编的；我们只维护「当前有没有一条待用」 |

> ⇒ 因此它**不做成常驻开关**。一个显示为「开」、而额度早已用尽、
> 消息根本发不出去、且不报错的开关，就是「界面在撒谎」。
> 消息通知页如实呈现**五态**：未开启 / 已开启待使用 / 已使用 / 暂未开放 / 状态读取失败。
>
> ⚠️ 五态的判定顺序与口径是**唯一的**（`utils/api.js` 的 `resolveNotifyStatus`），
> 消息通知页与「我的」列表都读它，**不允许各写一份** ——
> 两份判定漂移不会报错，只会让两处对同一件事给出不同说法。

#### GET `/v1/notify`

无需鉴权（`auth: false`），**不要求业务登录** —— 与 4.8 的反馈同理。

```json
// 有订阅记录
{ "code": 0, "message": "", "data": { "accepted": true, "acceptedAt": "2026-09-24T02:11:00.000Z", "usedAt": "", "usedTicketId": "" } }
// 没有记录（从未订阅过）
{ "code": 0, "message": "", "data": null }
```

| 字段 | 语义 |
|---|---|
| `accepted` | **当前是否有一条待用的授权**（`true` = 页面上显示「已开启」） |
| `acceptedAt` | 最近一次授权时间 |
| `usedAt` | 最近一次**因发送而消耗**的时间（**不是**「用户关闭」的时间） |
| `usedTicketId` | 那次消耗落在哪张工单上 |

> ⚠️ 返回 `null` 与返回 `{"accepted": false}` 是**两件事**：
> 前者是「从未订阅」，后者是「订阅过、现在没有额度」。客户端据此显示不同的状态文案。
> 拿不到 openid 时同样返回 `null` —— 此时用户能做的事（去授权）依然有效，
> 没必要用一个 401 把唯一有用的入口挡掉。

#### PUT `/v1/notify`

```json
{ "accepted": true,  "templateId": "AbCdEf123..." }   // 用户点了「允许」
{ "accepted": false }                                  // 用户在设置页主动关闭
```

| 情况 | 响应 |
|---|---|
| 成功 | `{ code: 0, data: { accepted, acceptedAt, usedAt, usedTicketId } }` |
| `accepted` 不是布尔值 | `400` |
| `templateId` 缺失 / 不在内容层白名单里 | `400` |
| 拿不到微信身份 | `400` |
| `notify_subs` 集合未创建 | `503` + 明确提示去云开发控制台建集合 |

> ⚠️ **`accepted` 只接受真正的布尔值。** 传 `'true'` / `1` / `{}` 一律 400，
> **不做静默转换** —— 转换会把「客户端写错了」变成「用户以为开好了」，
> 而我们这边没有任何日志能发现。
>
> ⚠️ **主动关闭 = 回到初始态**：`accepted` / `acceptedAt` / `usedAt` / `usedTicketId`
> 一起清空。只置 `accepted=false` 而留下 `usedAt`，状态推导会把它判成
> `used`（「额度已用掉」）—— 那是把用户的主动动作说反了。
>
> ⚠️ **服务端无法验证客户端真的授权过**，只做格式与白名单校验（防脏数据）。
> 真正的把关在发送侧：微信自己会校验这个用户有没有可用额度，没有就返回错误码。
> 如实记录能力边界，不假装做了防伪。

#### 客户端**刻意不做 501 回落**（与成绩 / 收藏的同步同一条纪律）

`utils/api.js` 的 `call()` 收到 501 会静默回落到本地实现。这两个接口**不走它**。
理由：回落会把「端点尚未部署」伪装成「已开启」—— 用户以为开好了，服务端一无所知，
后台受理时根本没有收件人，而**没有任何报错**。
⇒ 拿不到就如实说拿不到，页面上显示「状态读取失败」。
`tools/deploy-api-function.sh` 会把这两条也真 invoke 一遍。

#### 管理台发送 —— `POST /admin-api/tickets/{ticketId}/notify`

| | |
|---|---|
| 请求体 | `{ "revision": <工单当前 revision> }` |
| 成功 | `{ code: 0, data: { ...工单字段, "notifyResult": { "sentAt": "...", "errCode": 0, … } } }` |
| 已发送过 | `409`（**同一张工单只发一次** —— 每发一次都会消耗用户一条额度） |
| 用户无可用额度 | `400` |
| 内容层未配模板 / 未配字段映射 | `503` + 具体缺哪一项 |
| 版本冲突 | `409`（乐观锁，与 `PATCH` 工单同一把） |

> ⚠️ 它是**独立的显式动作**，不是「状态改成 `resolved` 就自动发」：
> 订阅消息不可逆（消耗额度、发出去收不回），而运营改状态是高频小动作 ——
> 「补个备注顺手把状态往前挪一格」不该让用户手机响一下。
> 管理台在发送前有二次确认。

工单详情多出 `notify` 字段，用于把三种状态**分开渲染**：
`null`（从未尝试）/ 有 `attemptedAt` 无 `sentAt`（发过但失败，可重试）/
有 `sentAt`（成功，不可重复发）。合并成「已通知 / 未通知」两态，
「失败」会看起来像「没发过」—— 运营要么反复点，要么以为已经通知过了。

#### 订阅消息模板约定

两条**必须对齐**的配置，都在内容层 `notify` 段（可由管理台发布，不必发版）：

| 配置 | 谁读 | 说明 |
|---|---|---|
| `notify.tmplIds` | 客户端 + 服务端 | 微信公众平台「功能 → 订阅消息」里申请的模板 ID，**最多 3 个**。留空 = 界面显示「暂未开放」 |
| `notify.tmplData` | 仅服务端 | 发送时的字段映射。**留空 = 后台拒绝发送**并说明原因，不会拿猜的字段名去试 |

`notify.tmplData` 每项为 `{ key, source }`：

| `source` | 取值 |
|---|---|
| `title` | `notify.push.title`（固定标题） |
| `ticketId` | 工单号 |
| `status` | 处理状态的中文名（服务端 `STATUS_LABEL`） |
| `time` | 受理时间，**已转成北京时间** |
| `reply` | 处理回复；为空时用 `notify.push.noReply` |

> ⚠️ `source` 是**白名单枚举，不是反射**（不写 `ticket[source]`）。
> 反射会把工单里的任意字段发到用户手机上，包括 `userId`（那正是 openid）
> 与内部备注 `note`，**而且不会有任何报错**。
>
> ⚠️ 云函数的运行时区是 **UTC**，`time` 由 `handlers.js` 的 `fmtTimeCST`
> 显式 +8 后再格式化。直接 `getHours()` 写出来会少 8 小时，且不会有任何报错。

**推荐申请的模板关键词结构**（四段，顺序可变）：

```
反馈内容  {{thing1.DATA}}              ← source: title
工单编号  {{character_string2.DATA}}   ← source: ticketId
处理进度  {{thing3.DATA}}              ← source: status
受理时间  {{time4.DATA}}               ← source: time
```

对应配置：

```json
"tmplData": [
  { "key": "thing1", "source": "title" },
  { "key": "character_string2", "source": "ticketId" },
  { "key": "thing3", "source": "status" },
  { "key": "time4", "source": "time" }
]
```

> ⚠️ 微信对字段类型有**硬限制**（`thing` ≤ 20 字符、`time` 有固定格式……）。
> 服务端按字段名前缀安全截断（`handlers.js` 的 `shapeField`），但**字段名本身写错**
> （把 `thing1` 写成 `thing`）会让整条发送以 47003 失败。
>
> ⚠️ 字段取值**不能为空**：服务端遇到空值会**拒绝发送并报错**，
> 而不是塞一个编造的占位 —— 发一条内容空洞的通知给用户是收不回的。

#### 部署要求：云调用权限**不由 tcb CLI 登记**

发送走云调用（`cloud.openapi.subscribeMessage.send`），需要在
`cloudfunctions/admin/config.json` 声明：

```json
{ "permissions": { "openapi": ["subscribeMessage.send"] } }
```

> ⚠️ 微信官方原文：「在每次使用**微信开发者工具**上传云函数时均会根据配置更新权限，
> 该配置有 10 分钟左右的缓存」。
> ⇒ **tcb CLI 部署只发代码，不登记这个权限。**
> 首次启用前必须在微信开发者工具里右键上传一次 `admin` 云函数，否则发送返回 `-604101`。
> `tools/deploy-admin-function.sh` 会校验声明文件存在并在结束时提醒这一步；
> 但**权限是否真的登记成功，只有真发一次才知道**（这也是为什么错误码必须原样显示）。

常见发送错误码（管理台会原样显示，**不要吞**）：

| 错误码 | 含义 | 处置 |
|---|---|---|
| `-604101` / `-604100` | 云调用权限未登记 | 用微信开发者工具上传一次 `admin` 云函数，等最长 10 分钟 |
| `43101` | 用户未订阅 / 额度已用掉 | 让用户在消息通知页重新开启 |
| `47003` | 模板参数不合法 | 核对 `tmplData` 的字段名与申请的模板是否一致 |
| `40037` | 模板 ID 无效 | 核对 `tmplIds` |

---

## 五、数据模型汇总

| 模型 | 主键 | 关键字段 | 说明 |
|---|---|---|---|
| **User** | `id` | openid, unionid, nickName, avatarUrl, email, plan | `openid` 唯一索引，不返回给客户端 |
| **AcademicProfile** | `userId` | curriculum, courses, gpa, ielts, countries, majors | 与用户 1:1 |
| **Favorite** | `(userId, schoolId)` | createdAt | 联合唯一索引 |
| **MatchResult** | `id` | userId, generatedAt, total, tiers, list | 保留最近 N 条便于对比 |
| **School** | `id` | nameCn, nameEn, region, qs, require, campuses | 由离线采集编译；**后台可覆盖**（见 4.10 的 `schoolOverrides`） |
| **Feedback** | `_id` | ticketId, type, userId, content, contact, images, schoolId, status | ⚠️ **工单号是 `ticketId`，不是数据库 `_id`**；`ticketId` 形如 `fb_YYYYMMDD_<24hex>` 且返回给用户 |
| **AdminAudit** | `_id` | action, target, admin, revision, createdAt | 后台操作留痕，仅管理端可读 |

---

## 4.10 管理后台接口（新增）

> 实现：独立云函数 `admin`，HTTP 访问路径 `/admin`（**与聚合函数 `api` 完全隔离**）。
> 线上入口：部署后由 `bash tools/deploy-admin-function.sh` 输出（含云开发环境 ID 的 URL 不写入公开文档）
> 前端：`admin/`（纯静态三文件，随函数一起打包到 `cloudfunctions/admin/static/`，页面与接口同源，无跨域配置）
> ⚠️ 改完 `admin/` 必须跑 `node tools/sync-data-copies.js` 把三件套同步进 `static/`（2026-09-22 起由脚本看守，不再手工 `cp`）；
> 不部署也能看效果：`node tools/preview-admin.js` 起本地预览台（页面与接口是真实文件，数据是内存样例），再用 `tools/browser-check-admin.js` 跑真实浏览器端到端验证

### 为什么单独一个函数，而不是加进 `api` 的路由表

`api` 的 `ROUTES` 是「按路径找 handler」，**没有通用鉴权中间件**：`content` / `feedback` 按设计公开或匿名，`auth` 自处理。往那张表里加管理路由，等于开了一个无鉴权写入口。管理端必须**先鉴权再分发**，所以独立成函数，鉴权是入口的第一条语句。

### 鉴权

| 项 | 约定 |
|---|---|
| 请求头 | `X-Admin-Key: <密钥>` |
| 服务端存储 | 环境变量 `ADMIN_KEY_SHA256`（**只存 SHA-256**，不存明文） |
| 比对方式 | `crypto.timingSafeEqual`，避免时序侧信道 |
| 密钥长度 | 32–256 字符，低于 32 字符一律拒绝 |
| 未配置 | 返回 **503**（明确「尚未配置」），**不得放行** |
| 错误/缺失 | 返回 **401**，响应体不区分「没给」与「给错」 |

密钥明文只落在本机 `admin/.admin-key`（已 gitignore），**不入库、不进日志、不出现在任何响应里**。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin-api/overview` | 工单各状态计数、**用户数（总数 / 当前保持登录数）**、可管理院校数、内容版本号 |
| GET | `/admin-api/content` | 当前内容补丁 + `revision`。⚠️ **界面入口已下线**（2026-09-22），路由保留供院校补丁复用同一条发布路径 |
| PUT | `/admin-api/content` | 发布内容补丁（**整份替换**，需带 `revision`）。⚠️ 同上：无界面入口，仅契约保留 |
| GET | `/admin-api/audit` | 最近 50 条操作留痕 |
| GET | `/admin-api/tickets` | 工单列表，支持 `page` / `size` / `status` / `type` / `keyword` |
| GET | `/admin-api/tickets/{ticketId}` | 工单详情（含处理历史） |
| PATCH | `/admin-api/tickets/{ticketId}` | 更新状态 / 优先级 / 负责人 / 处理备注 / 回复记录 |
| GET | `/admin-api/tickets/{ticketId}/images` | 截图临时链接（由服务端换取，有效期 300 秒） |
| GET | `/admin-api/users` | **用户档案列表（只读）**，支持 `page` / `size` / `keyword`（昵称 / 邮箱 / 年级 / 城市） |
| GET | `/admin-api/users/{id}` | **单份用户档案（只读）**，`{id}` 为该档案的 `_id`（= `sha256('openid:' + openid)`） |
| GET | `/admin-api/schools` | 院校列表（静态基线 + 后台补丁合并后） |
| GET | `/admin-api/schools/{id}` | 单校详情 |
| PUT | `/admin-api/schools/{id}` | 发布院校补丁 |

### 用户档案（`/admin-api/users`）的三条纪律

**① 与小程序读的是同一份数据。** 数据源就是小程序端 `api` 云函数
（`handlers/auth.js` 首登建档、`handlers/user.js` 改资料）写入的 `users` 集合 ——
管理台不另建用户表、不复制、不缓存。因此「后台看到的」与「小程序里的」不可能不一致。

**② 绝不下发 `openid`。** 接口返回的是**显式白名单**字段：
`id / nickName / avatarUrl / email / plan / grade / city / signedIn / createdAt / updatedAt`
（详情另加 `academic` / `favorites` / `favoritesUpdatedAt`，见 ③）。
⚠️ 用户文档里 `openid` 与 `_id` 同时在，视图只要写成 `Object.assign({}, doc)` 就会静默泄露 ——
这类缺陷不会报错、也不会有人发现，只能靠断言钉住（`tools/test-admin-server.js` 第 7b 节）。
`_id` **可以**下发：它是 `sha256('openid:' + openid)`，不可逆，且是取详情的稳定主键。
界面上以「档案 ID」呈现。

**③ 显示真的有的数字，不为好看补数字。** 成绩档案与收藏自 2026-09-22 起**已上云**
（见 2.2 的状态表），所以用户详情页**会展示**它们 —— 但展示的必须是库里那份真实数据：

- 字段为空就显示「未填写」，**绝不拿 0 或示例值去填**。
  内容层 `defaultAcademic` 里的 GPA 86 是版式示意图上的数字，不是任何用户的成绩 ——
  这条红线本项目踩过四次。
- 一份「从未保存过」的档案在库里根本没有 `academic` 字段，接口返回 `null`，
  页面显示空态。「没有数据」与「数据是 0」必须分得开。
- 收藏里的院校名由**服务端**查 `data/schools.json` 得出，前端不做映射 ——
  否则改院校名时会出现「小程序显示新名字、后台显示旧名字」，而且不报错。
  查不到的（院校已下线）**照样列出来**并标明「不在当前院校库中」，不静默丢弃：
  那条收藏在用户那里是真实存在的。
- 国家 / 专业 / 课程体系的中文名同样由服务端查内容层 `enums` 得出，
  同一份内容层、同一套名字。

`plan`（申请计划）等字段服务端目前一律留空，界面显示「未填写」而不是编一个档位。

⚠️ 详情接口（`GET /admin-api/users/{id}`）比列表多返回 `academic` / `favorites` /
`favoritesUpdatedAt` 三块；**列表刻意不带**（一页最多 100 条，payload 会白膨胀十几倍，
而列表里根本不展示它们）。
`favorites` 的元素形状是 `{ id, nameCn, nameEn, countryCn, qsLabel, missing }` ——
这是管理台自己的对外形态（`/admin-api/*` 是独立契约），**不是** 2.2/4.4 的 `ids`。

**降级语义**：`users` 集合若尚未在云开发控制台创建，
列表与详情返回 **503** 并给出可操作的原因（不是笼统的 500）；
`/admin-api/overview` 仍然可用，其 `users` 计数返回 **`null`**，
界面显示「—」—— ⚠️ 返回 `0` 会被读成「一个用户都没有」，那是编造结论。

### 并发保护：`revision`

内容与工单都带 `revision`。发布/更新必须回传**读取时拿到的值**；不一致返回 **409**，提示刷新后重试。
理由：两人同时编辑时，静默覆盖比报错严重得多 —— 报错可恢复，覆盖不可恢复。
内容发布与审计写入在**同一事务**内完成，不会出现「改了配置但没留痕」。

### 发布前校验（拒绝清单）

| 被拒改动 | 原因 |
|---|---|
| `ai.enabled = true` | 运行期模型能力是**合规红线**，不允许由后台打开（见 `AI接入边界方案.md`） |
| `defaultAcademic` | 后台不得预置用户成绩（数据真实性红线） |
| `matchConfig` | 算法口径变更需代码审核，不走运营配置 |
| `feedback.descMax / imageMax / replyWithin` 与服务端不一致 | 两处定义会静默漂移 |
| 未知字段 / 原型污染键（`__proto__` 等） | 越权与注入防护 |
| 功能入口 `ready:true` 却指向不存在的页面 | 后台不能发布一个点了会白屏的入口 |
| 院校 `region` 变更、`require` 数值越界、有要求却无数据来源、来源非 HTTPS | 院校数据必须可追溯、不猜不编 |

### 工单语义（避免假成功）

- 工单状态只代表**内部处理进度**，写「处理回复记录」**不等于**已通知用户 ——
  当前小程序端没有「查看回复」的通道，所以面板文案明确标注「系统不会自动发送」。
- 「办结 / 关闭」必须先有处理说明（本次提交的或历史上已记录的），否则 **400**。
- 列表与详情**不返回**微信匿名标识（`openid`）与数据库 `_id`；
  联系方式仅在持密钥的管理端可见。
- 后台**不会为了让界面好看而造演示工单**，空态就是空态。


### 建议建表清单

> ⚠️ 这张表描述的是**自建后端（REST 路线）**的形态，**不是**云开发下现在的库结构。
> 云开发当前只用 3 个集合（见 2.3），且成绩与收藏是同文档字段而非独立表。
> 照着本表去云开发控制台建集合，会建出一套永远为空的表。

```sql
users(id, openid UNIQUE, unionid, nick_name, avatar_url, email, plan, grade, city, created_at, updated_at)
-- 云开发下以下两块是 users 文档里的 JSON 字段，不单独立表（见 2.3 的说明）
academic_profiles(user_id PK, curriculum, courses JSON, gpa, gpa_scale, ielts JSON, toefl, sat, countries JSON, majors JSON, updated_at)
favorites(user_id, school_id, created_at, UNIQUE(user_id, school_id))
match_results(id, user_id, generated_at, total, tiers JSON, payload JSON)
schools(id PK, name_cn, name_en, region, country_cn, city_cn, province_cn, qs, qs_tie, qs_score, founded, type, crest JSON, require JSON, campuses JSON, source JSON, checked_at)
feedbacks(id PK, type, user_id NULL, content, contact, images JSON, school_id NULL, client JSON, status, created_at)
```

⚠️ 自建后端路线下，`academic_profiles` 与 `favorites` 的**未登录语义必须与云开发一致**：
读返回「空」（不是报错），写返回 **401**；`favorites` 还要保证
「不存在这个用户」与「一所都没收藏」可区分 —— 否则客户端同步逻辑的
「该推还是该拉」判断会失效（详见 4.4 的同步规则）。

---

## 六、院校数据来源与更新

院校数据**不通过接口实时抓取**，而是离线编译进包：

```
data-source/qs2027.json       ← QS World University Rankings 2027（2026-06-18 发布，多源交叉验证）· 99 所
data-source/admission-us.json ← 美国 53 校官方招生页采集
data-source/admission-ca.json ← 加拿大 25 校官方招生页采集
data-source/admission-au.json ← 澳大利亚 11 校官方招生页采集
data-source/raw/              ← 采集原始分片（字段形态各异，由 build.js 归一化吸收）
        ↓  node data-source/build.js
miniprogram/data/universities.js  （约 224 KB，远低于主包 2 MB 上限）
```

⚠️ **英国 6 校目前没有 `admission-*.json`**，因此没有 `require`（99 − 89 = 10 所缺，
其中英 6 + 美 4）。新增地区只需在 `build.js` 的 `ADMISSION_REGIONS` 加一项，
但**别忘了同时补齐该地区的录取要求文件** —— 只加 QS 只会多出 6 所「待评估」院校。

后端上线后，`GET /v1/schools` 应返回同一套结构，后台可对 `require` 字段做增量修正。
客户端保留了本地内置数据作为降级源，**后端故障不影响浏览与匹配**。

---

## 附录 A · 枚举取值

**目标国家 `countries`**：`us` 美国 / `uk` 英国 / `ca` 加拿大 / `au` 澳大利亚 / `hk` 中国香港

**专业方向 `majors`**：`cs` 计算机科学 / `eng` 工程 / `biz` 商科 / `sci` 生命科学 / `math` 数学与统计 / `psy` 心理学 / `soc` 社会科学 / `hum` 人文 / `art` 艺术设计

**课程体系 `curriculum`**：`AP` / `AL` A-Level / `IB` / `NONE` 暂无

**档位 `tier`**：`safe` 保底 / `match` 匹配 / `reach` 冲刺 / `unknown` 待评估

**路径类型 `pathways[].type`**：`foundation` 预科 / `language` 语言班 / `dual` 双录有条件录取 / `intl_year1` 国际大一

**校徽图形 `crest.shape`**：`building` / `shield` / `blocks` / `wave` / `arch` / `cap` / `leaf` / `star`

**SAT 要求 `require.sat`**：`required` / `optional` / `not_required` / `unknown`

**AP 认可方式 `require.ap`**：`direct` 可作录取依据 / `credit_only` 仅换学分 / `unknown`

---

## 附录 B · 客户端文件对照

| 文件 | 职责 |
|---|---|
| `utils/request.js` | 请求底座：baseUrl、鉴权头、错误归一、超时重试 |
| `utils/api.js` | 业务接口门面：双适配器 + 登录态 + 内容合并 + 降级策略 |
| `utils/store.js` | 本地持久化（local 模式的数据源） |
| `utils/match.js` | 匹配算法（口径见 4.5，权重与阈值来自内容层） |
| `data/universities.js` | 内置院校数据（构建产物） |
| `data/content.js` | **内容默认值**：所有文案 / 枚举 / 算法参数 / 功能开关 |
| `data/legal.js` | 协议 / 隐私政策 / 免责声明正文 |

**页面不直接引用 `store.js` 与 `data/`，一律通过 `api.js`**，
以保证切到后端、或后端改内容后无需改动页面。

### 「不写死」的实现约定

| 类别 | 存放位置 | 改动是否需要发版 |
|---|---|---|
| 页面文案、提示语 | `content.*` | ❌ 不需要 |
| 下拉枚举（国家 / 专业 / 体系） | `content.enums` | ❌ 不需要 |
| 功能入口与分组 | `content.functions.groups` / `content.home.features` | ❌ 不需要 |
| 匹配权重与分档阈值 | `content.matchConfig` | ❌ 不需要 |
| 功能开关 / 灰度 | `content.featureFlags` | ❌ 不需要 |
| 标签栏**页签增删** | `app.json` + `content.tabBar` | ✅ 需要（小程序限制） |
| 新增页面 | `app.json` | ✅ 需要 |

后续给已有页面加信息时，**先补接口字段 → 再补内容层默认值 → 最后改页面绑定**，
这样即使后端尚未上线，页面也能用内置默认值正常渲染。
