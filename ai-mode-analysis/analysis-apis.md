# analysis-apis — 原子能力 · 接口与消费点事实

> ⚠️ **状态（2026-09-24）：本文件描述的「微信 AI 原子接口」产物已被整体摘除，不属于当前产品。**
> 依据的代码 `miniprogram/skills/university-match`（5 个原子接口 + 独立分包）已删除，
> 原因见 `版本备注.md` §三.6：提审被驳回，「Skill 能力尚处于灰度测试阶段，暂未开放提审」。
> 本文件**从 `miniprogram/` 移到仓库根目录是为了不带进上传包**（小程序包根是 `miniprogram/`）。
> 保留它是为了：将来官方开放 Skill 提审、要重新接入时**不必重新扫一遍源码**。
> 读它之前请先确认那件事已经发生 —— 否则这里的接口清单与现状**故意不一致**。

源项目：`/Users/odycai/WorkBuddy/微信小程序大赛2026/miniprogram`
阶段：3 产出 · 逐接口追加，阶段 4 / 5 引用

**用户已确认的目标能力（阶段 0 产出，跳过阶段 2）**
| # | 能力 | 建议原子接口名 |
|---|------|--------------|
| 1 | 成绩匹配 | `matchSchools` |
| 2 | 院校检索 | `searchSchools` |
| 3 | 院校详情 | `getSchoolDetail` |
| 4 | 收藏管理 | `listFavorites` / `toggleFavorite` |

**probe 判定（3.7）**：**不跑**。触发条件均未命中 ——
① 请求值不是运行时动态下发（`CONFIG.baseUrl` 是**空串字面量**，`utils/request.js:15`，
静态可读）；② 响应结构全部能从源码消费点确定（下逐条标注）。
故所有接口 `sampleSource: static-source`，生成代码标 `[ai-mode:static]`，
交棒时须声明**未经真机验证**。

---

## 通用约定（所有接口共用）

| 项 | 内容 | 来源 |
|----|------|------|
| 调用方式 | 业务层**只调 `utils/api.js` 门面**，页面不直接碰 `data/` 与 `store` | `utils/api.js:1-9` 文件头 |
| 门面路由 | `call(name)`：`request.isReady()` 为 false → local；为 true → remote，**失败可回落 local 的白名单** = `['schools.list','schools.detail','meta.config']` | `utils/api.js:395-408` |
| 鉴权引用 | 见 `analysis-auth.md`。本批 5 个接口中**只有** `match.run`（remote）走默认 `auth: true`；`schools.list` / `schools.detail` 也走默认 `auth: true`（源码未传 `auth:false`） | `utils/api.js:253,261,262` |
| 通用参数 | 全部由封装层注入，业务层**零手抄** | `utils/request.js:93-97` |
| 签名 | 无 | `analysis-auth.md` 2.6 |

---

## 1. 成绩匹配 → `matchSchools`

### 1.1 真实入口

源码里「成绩匹配」是**跨两个页面**的一条用户操作序列，原子接口必须把这段序列**整段复刻**
（不是新增逻辑 —— 每一环都在源码里存在）：

| 序 | 源码位置 | 动作 |
|----|---------|------|
| ① | `pages/match/match.js:264-272 persist()` | 用户在 03 页编辑成绩 → `api.saveAcademic(profile)` |
| ② | `pages/match/match.js:277-284 onStart()` | 校验「至少选一个目标国家」→ `wx.navigateTo('/pages/matching/matching')` |
| ③ | `pages/matching/matching.js:59` | `const profile = await api.getAcademic()` |
| ④ | `pages/matching/matching.js:62-72` | `api.checkProfile(profile)`；`!ok` → **停止，不出分** |
| ⑤ | `pages/matching/matching.js:78` | `const result = await api.runMatch(profile)` |
| ⑥ | `pages/matching/matching.js:86-97` | `api.getInsight(profile, result)` → 写回 `result.insight/insightBy/suggestions` → `api.saveResult(result)` |

> ⚠️ **AI 传入的成绩 = 03 页表单编辑的结果**。所以 `inputSchema` 的字段
> 等价于用户在 03 页填的 `gpa` / `ielts` / `curriculum` / `courses` / `countries` / `majors`。
> 拼装 `profile` 的方式复刻 `pages/match/match.js:264-271 persist()` +
> `utils/store.js:89-94 getProfile()` 的**浅合并**语义（在默认档案上覆盖字段）。

### 1.2 请求构造

| 项 | local 分支（当前生效）| remote 分支（后端就绪后）|
|----|---------------------|------------------------|
| 入口 | `local['match.run']` | `remote['match.run']` |
| URL | —（无网络）| `POST /v1/match/run` @ `api` |
| body | — | `{ profile }` |
| `idempotent` | — | **`false`（不重试）** |
| 来源 | `utils/api.js:155-159` | `utils/api.js:253` |

同批还涉及（**都属于同一能力的实现链路，不是独立原子能力**）：
`academic.get` → `GET /v1/academic/profile`（`utils/api.js:246`）；
`academic.save` → `PUT /v1/academic/profile` body `p`（`utils/api.js:247`）；
`match.save` → `POST /v1/match/save` body `{ result }`，`idempotent:false`（`utils/api.js:255`）——
但 `api.saveResult` **不走 `call()`**，直接 `store.setResult(r)`（`utils/api.js:505`），
即**远端模式下结果仍写本机**，此行为必须原样保留。
`ai.insight` → `POST /v1/ai/insight` body `payload`，`idempotent:false`（`utils/api.js:259`）。

### 1.3 入参赋值来源

| 参数 | kind | 表达式 / 说明 | 来源 |
|------|------|-------------|------|
| `gpa` | `userInput` | 用户口述 → 覆盖 `profile.gpa`（源码约束 0–100，`pages/match/match.js:182`）| `pages/match/match.js:186` |
| `ielts.overall/l/r/w/s` | `userInput` | 覆盖 `profile.ielts`（源码约束总分 0–9，单项 `Number(x)\|\|0`）| `pages/match/match.js:194-200` |
| `curriculum` | `userInput` | 枚举，来自 `content.enums.curricula`（`utils/match.js:27`）| `pages/match/match.js:268` |
| `courses` | `userInput` | 当前体系科目数组；`matchEngine` 只消费 `.length` 与门数要求 | `utils/match.js:114,118,121` |
| `coursesMap` | `computed` | 以 `coursesMap` 为存储真源，`courses` 是「当前体系」镜像 | `utils/store.js:23-27` |
| `countries` | `userInput` | 目标国家/地区，决定匹配范围；空则回落 `uni.MATCH_REGIONS` | `pages/match/match.js:269`、`utils/match.js:243-246` |
| `majors` | `userInput` | 目标专业，本批算法不参与算分（仅档案字段）| `pages/match/match.js:270` |
| `gpaScale` | `literal` | 默认 100（来自 `content.defaultAcademic`）| `utils/store.js:28-33` |

### 1.4 响应字段与来源标记

`sampleSource: static-source`（消费点 = `pages/result/result.js:76-98 applyFilter()`）

| 字段 | 类型 | 消费点 | 来源 |
|------|------|-------|------|
| `list[].id` | string | `result.js:85` 卡片 key / 跳详情 | `utils/match.js:250-261` |
| `list[].nameCn` / `nameEn` | string | `result.js:86-87` | 同上 |
| `list[].countryCn` / `cityCn` | string | `result.js:88-89` | 同上 |
| `list[].qsLabel` | string | `result.js:90` | 同上 |
| `list[].crest` | object | `result.js:91` 校徽 | 同上 |
| `list[].match` | number \| **null** | `result.js:92,94`（null ⇒ 显示 unknown）| `utils/match.js:210-217` |
| `list[].tier` | `safe`\|`match`\|`reach`\|`unknown` | `result.js:93-94` | `utils/match.js:174-177` |
| `list[].matched` | boolean | `result.js:95`（置顶标记）| `utils/match.js:216` |
| `list[].dims[]` | array | **详情页**读 `dims[].key/value/met` 判路径可行性 | `pages/detail/detail.js:81-86`、`utils/match.js:180-208` |
| `list[].needData` / `reason` | boolean / string | 空态与提示 | `utils/match.js:145-147,155-163` |
| `tiers` | `{reach,match,safe,unknown}` | 汇总卡 | `utils/match.js:268-269` |
| `total` / `evaluated` | number | 汇总 | `utils/match.js:273-274` |
| `insight` | string | 行动建议 | `utils/match.js:279,285-311` |
| `disclaimer` | string | **必须展示的口径声明** | `utils/match.js:280` |
| `needsProfile` / `missing` | boolean / array | 档案不全时的空态 | `utils/match.js:235-236` |
| `generatedAt` | ISO string | 结果时间 | `utils/match.js:272` |
| `insightBy` / `suggestions` | string / array | 由 ⑥ 写回，**来源必须如实标注**（`rule` 不得冒充 `ai`）| `pages/matching/matching.js:87-96` |

**生成侧补充说明（5.8 自检用）** —— 下列 3 个字段不在上述消费点表格里，但**同样有源码来源**，
是页面对内容层模板的取值，加进 `structuredContent` 是为了让模型不必再取一次内容层：

| 字段 | 来源 |
|------|------|
| `list[].tierLabel` | `pages/result/result.js:94` 用 `c.result.tierShort[s.tier]` 生成短标签 |
| `insightByLabel` | `pages/result/result.js:65-66` 用 `c.result.insightBy[insightBy]` 生成来源标注 |
| `summarySuffix` | 内容层模板 `c.result.summarySuffix`（`pages/result/result.wxml` 消费）|

### 1.5 可行性校验（3.6）

✅ **高置信** —— 真实入口唯一（`pages/matching/matching.js runPipeline()`），
参数与返回路径全部可从源码静态确定。

---

## 2. 院校检索 → `searchSchools`

### 2.1 真实入口

`pages/schools/schools.js:59-83 refresh()` ——
`Promise.all([api.listSchools({region,keyword,sort}), api.getFavorites()])`。
**收藏状态与列表数据分两次取**是源码刻意的设计（收藏是用户数据、院校是公共数据，
来源可能不同，合并放前端做，避免接口耦合）—— 原子接口须保留这个二分。

### 2.2 请求构造

| 项 | local（当前）| remote |
|----|-------------|--------|
| 入口 | `local['schools.list']` | `remote['schools.list']` |
| URL | — | `GET /v1/schools` @ `api`，`data = q` |
| 来源 | `utils/api.js:186-207` | `utils/api.js:261` |

local 实现细节（必须复刻）：`uni.listByRegion(query.region)` → 关键词过滤
（匹配 `nameCn` / `nameEn.toLowerCase()` / `cityCn` / `countryCn`，`kw` 先 `trim().toLowerCase()`）
→ `sort === 'qs'` 或 `'default'` 都按 `a.qs - b.qs` 升序（`utils/api.js:191-204`）。
⚠️ 源码这两个分支**结果相同**（都按 qs 升序），照抄，不要"优化"。

### 2.3 入参赋值来源

| 参数 | kind | 表达式 / 说明 | 来源 |
|------|------|-------------|------|
| `region` | `userInput` | 地区 key；默认 `'all'`；来源 = 地区 chip 事件 `dataset.key` | `pages/schools/schools.js:30,95` |
| `keyword` | `userInput` | 搜索词；**源码有 300ms 防抖**（`clearTimeout` + `setTimeout(300)`）| `pages/schools/schools.js:85-92` |
| `sort` | `userInput` | 排序 key；默认 `'default'`；来源 = 排序 chip | `pages/schools/schools.js:31,100` |

### 2.4 响应字段与来源标记

`sampleSource: static-source`（消费点 = `pages/schools/schools.js:64-80`）

| 字段 | 消费点 |
|------|-------|
| `total` | `schools.js:81` |
| `list[].id / nameCn / nameEn / countryCn / cityCn / type / qsLabel / qtie / crest` | `schools.js:65-73` |
| `favorites`（来自 `api.getFavorites()`，与 list 合并）| `schools.js:74` |

### 2.5 可行性校验

✅ **高置信**。

---

## 3. 院校详情 → `getSchoolDetail`

### 3.1 真实入口

`pages/detail/detail.js:36-54 refresh()` —— `api.getSchool(this.data.id)`；
`id` 来自 `onLoad(query).id`（由列表/结果/首页以 `?id=` 带入，
见 `pages/schools/schools.js:105`、`pages/home/home.js:157`、`pages/result/result.js:101`）。

### 3.2 请求构造

| 项 | local（当前）| remote |
|----|-------------|--------|
| 入口 | `local['schools.detail']` | `remote['schools.detail']` |
| URL | — | `GET /v1/schools/{id}` @ `api` |
| 失败 | `uni.getSchool(id)` 为空 ⇒ `Promise.reject(request.ApiError(404,'院校不存在'))` | 同上由封装层抛 |
| 来源 | `utils/api.js:209-220` | `utils/api.js:262` |

local 返回四段拼接（**必须原样保留这四段**）：
`school` = `uni.getSchool(id)`；`match` = 最近一次匹配结果里同 id 的
`{score, tier, dims}`（无则 `null`）；`favorite` = `store.isFavorite(id)`；
`recommend` = `matchEngine.recommend(s)`（`utils/match.js:318-349`：
先本校 `campuses`（badge `'分校区'`），再同 region 按 `|qs 差|` 升序取到 `limit=4`（badge `'同档'`））。

### 3.3 入参赋值来源

| 参数 | kind | 说明 | 来源 |
|------|------|------|------|
| `id` | `userInput` | 院校 id；源码用**精确 id**（`uni.getSchool`），不做名称模糊匹配 | `pages/detail/detail.js:29` |

### 3.4 响应字段与来源标记

`sampleSource: static-source`（消费点 = `pages/detail/detail.js:41-47,61-114`）

| 字段 | 消费点 |
|------|-------|
| `school.qsChange` | `detail.js:67-72` 位次变化文案（可为 `null`）|
| `school.require` | `detail.js:77-111` 录取方式推导；`require` 为 `null` ⇒ 页面显示「整理中」，**不编造** |
| `school.require.gpa` / `gpaNote` / `ielts` / `ieltsSub` / `apMin` / `pathways[]` | `detail.js:94,97-109`、`utils/match.js:186-207` |
| `match.score` / `match.tier` / `match.dims[]` | `detail.js:81-86` 判定直录/桥梁是否「当前可行」|
| `favorite` | `detail.js:44,117-123` |
| `recommend[].id/nameCn/nameEn/region/countryCn/cityCn/provinceCn/qs/qsLabel/crest/badge` | `detail.js:131-135` |

### 3.5 可行性校验

✅ **高置信**。

---

## 4. 收藏管理 → `listFavorites` / `toggleFavorite`

### 4.1 真实入口

- `listFavorites`：`pages/schools/schools.js:62`、`pages/home/home.js:74`
- `toggleFavorite`：**三处并列入口，但调用完全相同** ——
  `pages/schools/schools.js:110`、`pages/detail/detail.js:117`、`pages/home/home.js:162`，
  三处都是 `api.toggleFavorite(id)`，无线索歧义，取 `favorites.toggle` 为准。

### 4.2 请求构造

| 接口 | local（当前）| remote |
|------|-------------|--------|
| `favorites.list` | `store.getFavorites()` | `GET /v1/favorites`，**返回值再取 `d.ids \|\| []`** |
| `favorites.toggle` | `store.toggleFavorite(id)` → `{id, favorite, ids}` | `POST /v1/favorites/{id}` |
| 来源 | `utils/api.js:149-153` | `utils/api.js:250-251` |

⚠️ `favorites.list` 的 remote 分支**多了 `.then(d => d.ids || [])` 的归一化**，
local 分支直接返回数组 —— 两个分支返回形态不一致，源码如此，**两边都要照抄**。

### 4.3 入参赋值来源

| 参数 | kind | 说明 | 来源 |
|------|------|------|------|
| `id`（toggle）| `userInput` | 院校 id，来自 `dataset.id` | `pages/schools/schools.js:109` |

### 4.4 响应字段与来源标记

`sampleSource: static-source`

| 字段 | 消费点 |
|------|-------|
| `favorite`（boolean，`true`=本次新增收藏）| `schools.js:114`、`detail.js:118`、`home.js:166` |
| `id` / `ids` | `utils/api.js:152`（`ids` 未被页面消费，但源码返回，保留）|

### 4.5 生成侧补充：`listFavorites` 为什么要自己把 id 还原成院校（5.8 自检用）

事实：源码的本机收藏**只存 id 数组**（`utils/store.js:103-105`），项目里**没有收藏列表页**
——收藏只以星标形态出现在院校列表与首页推荐上。而「我收藏了哪些学校」是用户会对 AI 直接问的一句话。

因此 `listFavorites` 复刻 `pages/home/home.js:69-101 refreshRecommend()` 的**既有做法**：
拉全量院校（`api.listSchools({region:'all'})`）+ 拉收藏 id，**在前端做合并**。
源码自己把这种组合方式写在注释里：「收藏状态与列表数据分两次取…合并放在前端做，避免让接口耦合」
（`pages/schools/schools.js:16-18`）。

⇒ 这不是新造的业务逻辑，是源码既有的接口组合方式；字段集取自 §2.4 的院校列表消费点。

### 4.5 可行性校验

✅ **高置信**。
⚠️ 非敏感接口（toggle 可逆、无不可恢复副作用）→ **正常收集**，不标 `destructive`。

---

## 5. 阶段 4 交接：storage key 与依赖图

### 5.1 接口间数据传递的 storage key

| key | 写入方 | 读取方 | 数据结构 |
|-----|-------|-------|---------|
| `sp_match_result` | `matchSchools`（经 `api.saveResult`）| `getSchoolDetail`（补 `match` 段）| `run()` 的完整返回对象 |
| `sp_favorites` | `toggleFavorite` | `searchSchools`（星标态）、`listFavorites`、`getSchoolDetail` | `string[]`（院校 id，新收藏 `unshift`）|
| `sp_profile` | `matchSchools`（写回拼装后的档案）| `matchSchools`（下次读默认档案）| `DEFAULT_PROFILE` 的浅合并结果 |

> 分包内 key 名沿用主包原名（`sp_*`）—— 用户从 AI 卡片 handoff 进小程序后，
> 看到的必须是**与主包一致的那份数据**，改名会造成两套状态。

### 5.2 API 依赖图

```
matchSchools ──(storage: sp_match_result)──▶ getSchoolDetail   [补 match 段]
             └─(storage: sp_profile)──────▶ matchSchools       [下次匹配的档案基线]
searchSchools ──(返回 favorites 星标态)──▶ toggleFavorite        [卡片上直接切换]
toggleFavorite ──(storage: sp_favorites)──▶ searchSchools / getSchoolDetail / listFavorites
getSchoolDetail ──(recommend[].id)───────▶ getSchoolDetail      [点相关院校再看一所]
```
