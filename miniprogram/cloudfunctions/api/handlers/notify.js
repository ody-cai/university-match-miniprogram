/**
 * 订阅消息：GET /v1/notify、PUT /v1/notify
 * ==================================================================
 * 用途：用户在「我的 > 偏好与其他 > 消息通知」里开启订阅后，后台受理其反馈
 * 工单时可以用微信「服务通知」主动告知结果（发送在 admin 云函数里做）。
 *
 * ── 为什么单独一个集合（`notify_subs`），而不是写进 `users` ─────────
 * 「已授权接收通知」这件事的归属是**微信身份（openid）**，不是业务账号：
 * 反馈接口是全项目**唯一允许匿名**的写接口（契约 4.8）—— 刚提交完反馈、
 * 还没登录的用户，恰恰是最需要收到受理结果的。若把它写进 `users`，
 * 就只有登录用户能用；而若允许给未登录者也建 `users` 文档，
 * 管理台的「注册用户」计数立刻被污染（那是编造运营数据）。
 * ⇒ 两份数据分开，各按自己的维度存。
 *
 * ✅ 两侧主键都是 `stableId(openid)`（sha256('openid:' + openid)），
 *    因此「某个用户有没有订阅」可以直接用 `users` 列表里的 `_id` 去查，
 *    不需要任何额外的关联字段。
 *
 * ── 完全不下发 openid ────────────────────────────────────────────
 * 与 `handlers/user.js` 同一条纪律（契约 5 节）：对外对象是**显式白名单**，
 * 绝不写成 `Object.assign({}, doc)`。这里连 `_id` 都不下发 ——
 * 客户端只需要知道自己的状态，不需要知道自己是哪一行。
 *
 * ── 状态四字段的语义（读之前先分清，混了就会显示成另一个状态）──────
 *   accepted    —— **当前是否有一条待用的授权**（true = 开着）
 *   acceptedAt  —— 最近一次授权时间
 *   usedAt      —— 最近一次**因发送而消耗**的时间（不是「用户关闭」的时间）
 *   usedTicketId—— 那次消耗落在哪张工单上
 * ⚠️ 用户**主动关闭**时这三样一起清空（回到初始态）；只有**发送成功**
 *    才写 `usedAt`。否则「我主动关了」会被页面的状态推导判成
 *    `used`（「额度已用掉」），那是把用户的动作说反了。
 *
 * ── 服务端**无法**验证客户端真的授权过 ────────────────────────────
 * 授权发生在微信客户端（`wx.requestSubscribeMessage`），我们只能收到
 * 客户端的上报。所以这里做的是**格式与白名单校验**（闹钟防脏数据），
 * 不是防伪。真正的把关在发送侧：微信云调用会自己校验「这个用户到底有没有
 * 可用的订阅额度」，没有就返回错误码，那时才如实记失败。
 * 不要因为「不可防伪」就在这里假装要强校验 —— 如实记录能力边界。
 */
const cloud = require('wx-server-sdk');
const { ok, bizError } = require('../lib/response');
const { stableId, toIso } = require('../lib/users');

const db = cloud.database();

/** 集合名。⚠️ `cloudfunctions/admin/handlers.js` 里有一份同名常量 —— 两处必须一致 */
const COLLECTION = 'notify_subs';

const CONTENT_COLLECTION = 'content';
const CONTENT_DOC = 'default';

/** users 集合缺失时的报错文案（同 lib/users 的处理口径） */
const COLLECTION_MISSING = /collection.*(not exist|does not exist)|DATABASE_COLLECTION_NOT_EXIST/i;
/**
 * 「文档不存在」—— 对订阅记录来说这是一个**有效答案**（这个用户没订阅过），
 * 不是错误。
 * ⚠️ 判定必须要求错误信息里出现 `document` 字样。裸的 `/does not exist/`
 *    会把「**集合**不存在」也吃掉，于是运维问题被静默降级成「这个用户没订阅」——
 *    表现为「明明授权了却查不到」，而**没有任何地方报错**。
 *    （与 admin/handlers.js 的 DOC_MISSING、tools/verify-notify-page.js 的断言同一口径。）
 */
const DOC_MISSING = /document.*(not exist|does not exist|not found)/i;
function asCollectionError(e) {
  if (COLLECTION_MISSING.test((e && (e.errMsg || e.message)) || '')) {
    throw bizError(503, COLLECTION + ' 集合尚未创建，请先在云开发控制台建集合');
  }
  throw e;
}

/**
 * 读内容层的 `notify.tmplIds`（允许的订阅模板白名单）。
 * ------------------------------------------------------------------
 * ⚠️ 与客户端读的是**同一份**（`content` 集合的补丁 → 客户端 `/v1/content`
 *    拿到同一份）。写死一份模板 ID 到服务端代码里，会让「换了模板但没重新
 *    部署云函数」变成一个静默失效：用户授权的是新模板，服务端发的是旧模板，
 *    微信回 47003，而用户那头什么都收不到。
 * ⚠️ 读不到（集合不存在 / 文档不存在）时返回**空数组**，不是「全部放行」——
 *    宁可拒绝记录，也不要放行一个我们无法核对的模板 ID。
 */
async function allowedTemplates() {
  try {
    const r = await db.collection(CONTENT_COLLECTION).doc(CONTENT_DOC).get();
    const n = (r && r.data && r.data.notify) || {};
    return Array.isArray(n.tmplIds) ? n.tmplIds.filter((x) => typeof x === 'string' && x) : [];
  } catch (e) {
    const msg = (e && (e.errMsg || e.message)) || '';
    // 内容文档不存在是正常的（没发布过内容补丁才会有这个文档）→ 没有白名单
    if (DOC_MISSING.test(msg)) return [];
    // 集合不存在也是「没有白名单」，但那是运维问题：留一条日志，别让它悄无声息
    if (COLLECTION_MISSING.test(msg)) {
      console.error('[notify] content 集合不存在，订阅模板白名单读取失败');
      return [];
    }
    throw e;
  }
}

/** 对外对象 —— 显式白名单，不下发 `_id` / `openid` */
function shape(doc) {
  return {
    accepted: doc.accepted === true,
    acceptedAt: toIso(doc.acceptedAt),
    usedAt: toIso(doc.usedAt),
    usedTicketId: doc.usedTicketId || '',
  };
}

async function findSub(openid) {
  try {
    const r = await db.collection(COLLECTION).doc(stableId(openid)).get();
    return (r && r.data) || null;
  } catch (e) {
    // 顺序不能反：先判「集合是否存在」，再判「文档是否存在」——
    // 集合缺失时必须抛 503，不能被当成「这个用户没订阅过」。
    const msg = (e && (e.errMsg || e.message)) || '';
    if (DOC_MISSING.test(msg)) return null;
    asCollectionError(e);
  }
}

/**
 * GET /v1/notify
 * ------------------------------------------------------------------
 * 未登录 / 从未订阅过 → `ok(null)`。
 * ⚠️ 这里刻意**不要求业务登录**（`auth: false`）—— 与反馈接口同理。
 *    拿不到 openid（极端环境）时也返回 `ok(null)`：
 *    此时客户端会显示「未开启」，而它能做的事（去授权）依然有效，
 *    没必要用一个 401 把唯一有用的入口挡掉。
 */
async function get({ openid }) {
  if (!openid) return ok(null);
  const doc = await findSub(openid);
  return ok(doc ? shape(doc) : null);
}

/**
 * PUT /v1/notify
 * ------------------------------------------------------------------
 * 请求体：`{ accepted: boolean, templateId?: string }`
 *   accepted=true  —— 用户刚在微信授权框里点了「允许」
 *   accepted=false —— 用户在设置页主动关闭
 *
 * ⚠️ `accepted` 只接受**真正的布尔值**。传 `'true'` / `1` / `{}` 一律 400，
 *    **不静默转换** —— 静默转换会把「客户端写错了」变成「用户以为开好了」，
 *    而我们这边没有任何日志能发现。
 */
async function save({ openid, data }) {
  if (!openid) throw bizError(400, '无法获取微信身份，请稍后重试');

  const d = data || {};
  if (typeof d.accepted !== 'boolean') throw bizError(400, '订阅状态必须是布尔值');

  const id = stableId(openid);
  const now = new Date();
  const next = { updatedAt: now };

  if (d.accepted) {
    /**
     * 模板 ID 必须命中内容层白名单。
     * ⚠️ 白名单为空时**一律拒绝**（不是放行）：那说明内容层还没配好，
     *    此时服务端无法核对，而放行一条记录会让页面显示「已开启」，
     *    后台发送时却必然失败 —— 两边都以为对方会处理。
     * ⚠️ 客户端没传 templateId 也要拒绝：它是我们唯一能核对的凭据。
     */
    const tid = typeof d.templateId === 'string' ? d.templateId : '';
    if (!tid) throw bizError(400, '缺少订阅模板标识');
    const allow = await allowedTemplates();
    if (allow.indexOf(tid) === -1) throw bizError(400, '订阅模板未配置或已变更，请稍后重试');

    next.accepted = true;
    next.acceptedAt = now;
    next.templateId = tid;
    // ⚠️ 刻意**不清** usedAt / usedTicketId：它们是「上一次通知」的历史，
    //    状态推导里 accepted 优先于 usedAt（见 api.js 的 resolveNotifyStatus），
    //    留着能让后台与用户都看得到上次是什么时候发的。
  } else {
    /**
     * 用户主动关闭 = **回到初始态**，三样一起清。
     * ⚠️ 只把 accepted 置 false 而留下 usedAt，会让状态推导把它判成
     *    `used`（「额度已用掉，需重新开启」）—— 那是把用户的主动动作
     *    说成了另一件事。发送历史记在工单上，不会因此丢失。
     */
    next.accepted = false;
    next.acceptedAt = null;
    next.usedAt = null;
    next.usedTicketId = '';
  }

  const existing = await findSub(openid);

  if (existing) {
    await db.collection(COLLECTION).doc(id).update({ data: next });
    return ok(shape(Object.assign({}, existing, next)));
  }

  try {
    await db.collection(COLLECTION).add({ data: Object.assign({ _id: id, createdAt: now }, next) });
  } catch (e) {
    /**
     * 并发首次写入撞唯一键 → 说明另一个请求已经建好了，改走 update。
     * ⚠️ 判定只看 errMsg 里的 `E11000 / duplicate key` 证据，
     *    不能凭 `errCode === -502001`：那是「数据库请求失败」的宽泛码，
     *    权限不足也会套它，误判会把真正的写失败伪装成成功。
     *    （与 lib/users.js 的 isDuplicateKeyError 同一口径。）
     */
    if (!/E11000|duplicate key/i.test((e && e.errMsg) || '')) asCollectionError(e);
    await db.collection(COLLECTION).doc(id).update({ data: next });
  }

  return ok(shape(next));
}

module.exports = { get, save, COLLECTION };
