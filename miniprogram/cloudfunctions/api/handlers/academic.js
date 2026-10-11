/**
 * 成绩档案：GET / PUT `/v1/academic/profile`、POST `/v1/academic/profile/reset`
 * ==================================================================
 * 为什么会有这个文件：此前这三个端点在契约里写着「⛔ 仅本地」，
 * 于是学生填的均分与语言成绩**只存在于那一台手机的 Storage 里** ——
 * 换手机、清缓存即全部消失；管理台也只能硬编码一句
 * 「成绩档案当前只存在用户本机、未上云」。本次把它上云。
 *
 * ── 未登录的语义（与契约 4.2 的 user.profile 同一口径） ─────────────
 * GET     ：未登录 / 从未填过 → `ok(null)`，**不返回 401**。
 *           页面在未登录时也要能正常渲染表单，而且本机还留着一份缓存
 *           （见 utils/api.js 门面层的 `getAcademic`），不该被错误挡住。
 *           ⚠️ 服务端**不返回任何默认档案**：内容层的 `defaultAcademic`
 *           是产品初始态，不是某个用户的数据。把它当「这个用户的档案」
 *           发出去，就是把一份从未填写的档案说成用户填过的 —— 编造数据。
 * PUT / reset：未登录 → **401**。写操作不接受静默降级成
 *           「写了个没人认领的孤儿档案」（同 handlers/user.js 的 PUT）。
 *
 * ── 存哪儿 ────────────────────────────────────────────────────────
 * 存进 `users` 集合的 `academic` 字段，**不新建集合**。理由：
 *   · 身份判定直接复用 lib/users.js 的 `findActive`
 *     （已登录 = 文档存在且 activeSession===true）。另起一个集合就要
 *     再实现一遍这套判据，两份实现迟早会漂，而漂移不会报错；
 *   · 云开发没有 JOIN，分集合读要多一次往返；
 *   · 数据规模是「一人一份」，合并进用户文档正是文档型数据库的常规用法。
 * ⚠️ 契约 2.3 里那张 `favorites` / `academic_profiles` 集合表，描述的是
 *    「将来改成客户端直连数据库」时的形态 —— 现在不是直连，别照着建集合。
 *
 * ── 与个人资料的边界 ──────────────────────────────────────────────
 * 本文件**只**动 `academic` 与 `updatedAt` 两个字段，走 `.update()` 局部写入。
 * 绝不能改成 `.set()` 整份覆盖：那会连带清掉昵称、头像、`activeSession`、
 * 以及收藏列表（`handlers/favorites.js` 写的是同一份文档）。
 */
const { ok, bizError } = require('../lib/response');
const { COLLECTION, findActive } = require('../lib/users');
const { EMPTY_ACADEMIC, shapeAcademic, buildAcademic } = require('../lib/academic');
const cloud = require('wx-server-sdk');

const db = cloud.database();

/** 未登录的统一拒绝文案。两处（PUT / reset）必须逐字一致，否则用户会看到两种说法 */
const UNAUTH = '登录状态已失效，请重新登录';

/**
 * 取当前用户的档案文档；未登录 / 无档案一律 401。
 * @param {string} openid 服务端从 getWXContext 拿到的身份，**不采信客户端传来的任何 id**
 */
async function requireActive(openid) {
  if (!openid) throw bizError(401, UNAUTH);
  const doc = await findActive(openid);
  if (!doc) throw bizError(401, UNAUTH);
  return doc;
}

/**
 * GET /v1/academic/profile
 * 返回 `data: null` 的两种情形都要如实表达，不要用空档案糊过去：
 *   · 未登录；
 *   · 登录过、但从未保存过成绩（文档里没有 `academic` 字段）。
 */
async function profile({ openid }) {
  if (!openid) return ok(null);
  const doc = await findActive(openid);
  if (!doc) return ok(null);
  if (!doc.academic) return ok(null);
  return ok(shapeAcademic(doc.academic));
}

/**
 * PUT /v1/academic/profile —— **全量覆盖**（契约 4.3）
 * 客户端 match 页每次 `persist()` 传的都是整份档案，与之匹配。
 * 字段白名单与取值校验见 lib/academic.js。
 */
async function save({ openid, data }) {
  const doc = await requireActive(openid);
  const academic = buildAcademic(data, new Date().toISOString());
  await db.collection(COLLECTION).doc(doc._id).update({
    data: { academic, updatedAt: new Date() },
  });
  return ok(shapeAcademic(academic));
}

/**
 * POST /v1/academic/profile/reset
 * 「重置」= 回到**初始态**，不是删掉记录 —— 响应仍是一份完整（空）档案，
 * 客户端拿到后直接渲染，不必再区分「null 表示重置成功」这种含糊约定。
 */
async function reset({ openid }) {
  const doc = await requireActive(openid);
  const academic = buildAcademic(EMPTY_ACADEMIC, new Date().toISOString());
  await db.collection(COLLECTION).doc(doc._id).update({
    data: { academic, updatedAt: new Date() },
  });
  return ok(shapeAcademic(academic));
}

module.exports = { profile, save, reset };
