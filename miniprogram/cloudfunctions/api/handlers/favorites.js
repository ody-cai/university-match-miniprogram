/**
 * 收藏院校：GET `/v1/favorites`、POST / DELETE `/v1/favorites/{schoolId}`
 * ==================================================================
 * 为什么会有这个文件：收藏此前在契约里写着「**设计上就是本机数据**」，
 * 服务端确实一个字节都没有。本次把它上云，于是：
 *   · 换设备登录后收藏还在；
 *   · 管理台能看到某个用户收藏了哪些学校（以前只能显示一句「服务端没有」）。
 *
 * ── 未登录的语义 ──────────────────────────────────────────────────
 * GET    ：未登录 / 从未同步过 → `ok(null)`，不返回 401。
 *          客户端据此回落本机缓存（未登录时本机就是唯一数据源），
 *          而不是被一个错误挡住。
 * POST / DELETE：未登录 → **401**。给未登录用户写一份没人认领的收藏列表，
 *          等于把数据挂在一个不存在的账号上，谁也拿不回来。
 *
 * ── 响应为什么带完整的 `ids` ──────────────────────────────────────
 * 契约 4.4 规定 `{ id, favorite, ids }`。带上完整列表不是冗余：
 *   · 客户端收藏页的顺序（最近收藏在前）与院校库的置顶都以**整份列表**为准；
 *   · 只回 `{id, favorite}` 的话，客户端要么自己重算一遍（两份口径，
 *     迟早漂），要么再多发一次 GET（多一次往返）。
 * 顺序约定：**最近收藏在前**（新增时前插），与本地 store.toggleFavorite
 * 的 `unshift` 一致 —— 两侧顺序不同会让收藏页在「本机→云端」切换时跳序。
 *
 * ── 并发安全（这个文件唯一真正难的地方）────────────────────────────
 * 「读列表 → 改 → 写回」这个写法在并发下会**静默丢收藏**：
 * 两个请求同时读到 `[a]`，各自算出 `[a,b]` 与 `[a,c]`，后写的覆盖先写的。
 * 云数据库的更新操作符里没有「去重前插」，所以这里用**事务**把
 * 读-改-写包成一次原子提交。收藏是人手点击触发的低频操作，事务开销无所谓。
 * ⚠️ 不要把它「优化」成两次 `_.pull` + `_.unshift` 的原子更新：
 *    两次更新之间存在窗口，期间任何一次 GET 都会返回一份缺项的列表，
 *    而客户端拿到列表就整份覆盖本机 —— 项也就跟着丢了。
 *
 * ── 为什么校验院校 id 的**格式**却不校验它存在 ────────────────────
 * 存在性校验需要一个院校 id 清单。为了校验而把 universities.js 再拷进
 * 云函数包，就是又一份影子副本（见 tools/sync-data-copies.js 的清单），
 * 而且院校下线时会立刻让老收藏变成「非法」。格式校验已经挡住了
 * 注入与非字符串，剩下的由管理台侧「找不到就如实标记」兜住。
 */
const { ok, bizError } = require('../lib/response');
const { COLLECTION, findActive, toIso, isValidSchoolId } = require('../lib/users');
const cloud = require('wx-server-sdk');

const db = cloud.database();

/**
 * 收藏数量上限。
 * 院校库共 99 所，200 是一个非常宽松的天花板 —— 它的用途不是限制用户，
 * 而是防止单文档被无限灌入（云数据库单文档有 16 MB 上限，写爆了
 * 整个用户档案都读不出来）。
 */
const MAX_FAVORITES = 200;

const UNAUTH = '登录状态已失效，请重新登录';

/** 取当前用户的文档；未登录 / 无档案一律 401 */
async function requireActive(openid) {
  if (!openid) throw bizError(401, UNAUTH);
  const doc = await findActive(openid);
  if (!doc) throw bizError(401, UNAUTH);
  return doc;
}

/** 入库前过滤：只有合法格式的 id 才留下（历史脏数据 / 手工改库的兜底） */
function cleanIds(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (isValidSchoolId(x) && out.indexOf(x) < 0) out.push(x);
  }
  return out.slice(0, MAX_FAVORITES);
}

/** 路径参数校验：格式不对 → 400（不是 404：这是一个格式非法，不是「没找到」） */
function schoolIdOf(raw) {
  const id = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!isValidSchoolId(id)) throw bizError(400, '院校标识格式无效');
  return id;
}

/**
 * GET /v1/favorites
 * 未登录 / 未同步过 → `data: null`（**不是** `{ids: []}`）。
 * 这两者必须分开：`{ids:[]}` 是「登录了、一所都没收藏」，
 * null 是「拿不到云端数据」。客户端同步逻辑对二者的处理完全不同 ——
 * 把后者当成前者，换设备登录时就会把本机收藏清空。
 */
async function list({ openid }) {
  if (!openid) return ok(null);
  const doc = await findActive(openid);
  if (!doc) return ok(null);
  // 文档里没有 favorites 字段 = 从未同步过收藏（老账号），同样返回 null
  if (!Array.isArray(doc.favorites)) return ok(null);
  return ok({ ids: cleanIds(doc.favorites), updatedAt: toIso(doc.favoritesUpdatedAt) });
}

/**
 * 收藏 / 取消收藏的共用实现。
 * @param {'add'|'remove'} action
 */
async function mutate(openid, rawSchoolId, action) {
  const id = schoolIdOf(rawSchoolId);
  const doc = await requireActive(openid);

  let ids = [];
  await db.runTransaction(async (tx) => {
    // 事务内重读当前列表 —— 事务外的那份可能在等待期间已经过期
    const fresh = await tx.collection(COLLECTION).doc(doc._id).get();
    const cur = cleanIds(fresh && fresh.data && fresh.data.favorites);

    ids =
      action === 'add'
        ? [id].concat(cur.filter((x) => x !== id)).slice(0, MAX_FAVORITES)
        : cur.filter((x) => x !== id);

    await tx.collection(COLLECTION).doc(doc._id).update({
      data: { favorites: ids, favoritesUpdatedAt: new Date() },
    });
  });

  /**
   * `favorite` 表示**操作完成后**的状态，而不是「这次是否产生了变化」。
   * 契约 4.4 规定这两个端点都幂等，所以重复收藏同一所时，
   * 响应必须仍是 `favorite: true`（而不是「本来就收藏着，所以 false」）——
   * 客户端拿它直接渲染星标状态，语义含糊会让星标闪错。
   */
  return ok({ id, favorite: action === 'add', ids });
}

/** POST /v1/favorites/{schoolId} —— 收藏，幂等 */
async function add({ openid, params }) {
  return mutate(openid, params && params.schoolId, 'add');
}

/** DELETE /v1/favorites/{schoolId} —— 取消收藏，幂等 */
async function remove({ openid, params }) {
  return mutate(openid, params && params.schoolId, 'remove');
}

module.exports = { list, add, remove, MAX_FAVORITES };
