/**
 * 用户档案的共用读写（users 集合）
 * ==================================================================
 * 为什么单独成文件：`handlers/auth.js` 与 `handlers/user.js` 都要
 * 「按 openid 找档」和「把数据库文档整形为契约 4.2 的对外对象」。
 * 各写一份的下场是两份 shapeUser 慢慢漂移 —— 登录返回的字段和
 * 资料页返回的字段不一样，而这**不会报错**，只会让页面在某个入口缺一个字段。
 * 这与契约 5 节「openid 不返回给客户端」是同一条纪律。
 *
 * ⚠️ 本文件不 require index.js（会形成环），只依赖 lib/response 之外的东西为零。
 */
const cloud = require('wx-server-sdk');

const db = cloud.database();
const COLLECTION = 'users';

/** 时间字段归一化为 ISO 字符串（数据库里存的是 Date 对象） */
function toIso(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * 对外用户对象 —— 严格按契约 4.2 的字段清单
 * ⚠️ `openid` 绝不下发给客户端（契约 5 节：openid 不返回给客户端）。
 *    它对服务端是主键，对客户端没有用途，下发只会扩大泄露面。
 *    为此我们也不用 openid 当 `_id`：这里 `_id` 是 openid 的 SHA-256，
 *    既稳定又不泄露原值。
 */
function shapeUser(doc) {
  return {
    id: doc._id,
    nickName: doc.nickName || '',
    avatarUrl: doc.avatarUrl || '',
    email: doc.email || '',
    plan: doc.plan || '',
    grade: doc.grade || '',
    city: doc.city || '',
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

/**
 * openid → 稳定 `_id`（SHA-256）。
 * 用哈希而不是 openid 本身做主键：
 *   · 不向任何下游泄露真实 openid（契约 5 节）；
 *   · 哈希是确定性的 —— 同一个 openid 永远得到同一个 `_id`，
 *     于是「并发首次建档」时第二份 `add` 会撞唯一键，被唯一冲突
 *     处理兜住，不会写出两条用户记录（见 auth.login 的 add 分支）。
 */
function stableId(openid) {
  return require('crypto').createHash('sha256').update('openid:' + openid).digest('hex');
}

/**
 * 是否数据库唯一键冲突。
 * ⚠️ 只认 `E11000` / `duplicate key` 的**证据**，绝对不能凭 `errCode === -502001`
 * 判定：-502001 是「数据库请求失败」的**宽泛**码，权限不足、超时等多种失败
 * 都套这个码。若仅凭它认唯一冲突，普通写入失败会被误当成「并发抢建撞键」而
 * 被静默吞掉、伪装成登录成功。
 * 真正能区分唯一冲突的只有 errMsg 里的 `E11000 duplicate key error`。
 */
function isDuplicateKeyError(e) {
  if (!e) return false;
  return /E11000|duplicate key/i.test(e.errMsg || '');
}

async function findByOpenid(openid) {
  const res = await db.collection(COLLECTION).where({ openid }).limit(1).get();
  return (res && res.data && res.data[0]) || null;
}

/**
 * 已登录档案 —— 「已登录」= 存在文档且 activeSession===true。
 * 云开发路线没有 token，登录态就落在这个字段上（见 auth.js 头部说明）。
 */
async function findActive(openid) {
  const doc = await findByOpenid(openid);
  if (!doc || doc.activeSession !== true) return null;
  return doc;
}

/**
 * 院校标识的**格式**校验（收藏用）。
 * ------------------------------------------------------------------
 * ⚠️ 只校验格式，**不校验存在性**。存在性校验需要一份院校 id 清单，
 *    为了它把 `data/universities.js` 再拷进云函数包，就是又一份影子副本
 *    （见 tools/sync-data-copies.js 的清单），而且院校一旦下线，
 *    用户已有的收藏会立刻全部变成「非法」。
 *    格式已经挡住了注入、路径穿越与非字符串；「这所院校在不在库里」
 *    由读取侧负责如实标记（管理台就是这么做的）。
 */
function isValidSchoolId(v) {
  return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
}

module.exports = {
  COLLECTION,
  toIso,
  shapeUser,
  stableId,
  isDuplicateKeyError,
  findByOpenid,
  findActive,
  isValidSchoolId,
};
