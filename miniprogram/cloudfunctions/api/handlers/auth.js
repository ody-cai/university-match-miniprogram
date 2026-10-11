/**
 * 认证：POST /v1/auth/login、GET /v1/auth/session
 * ==================================================================
 * ⚠️ 云开发路线下，「登录」的含义与自建后端**不一样**，别照抄 REST 的时序：
 *
 *   REST ：wx.login() 得 code → 后端调 code2session → 换 openid → 签发自定义 token
 *   cloud：云函数用 cloud.getWXContext() **直接拿到 openid**，
 *          既不需要 code，也不需要签发 token
 *
 * 因此这里的 login 实际动作是「按 openid 建档 / 取档」，而不是「换取凭据」。
 * openid 由微信静默下发，**不需要用户授权、不弹窗**，所以它不构成
 * 《小程序内用户帐号登录规范》意义上的「要求用户登录」。
 * 这和契约 3 节的合规要求不冲突：本函数的调用仍由用户**主动点击**触发。
 *
 * 响应里保留 `token` 字段（固定为空串）是为了**让客户端代码零改动** ——
 * 客户端 login() 会 request.setToken(data.token)，空串即「不带 Authorization 头」，
 * 云函数本来就只认 openid，不需要这个头。
 * ⚠️ 但客户端有一处**必须**配合：utils/api.js 的 restoreSession()
 *    不能再靠「有没有 token」判断是否已登录（否则云开发路线下每次启动
 *    都会判定为未登录）。该改动已同步落地。
 */
const cloud = require('wx-server-sdk');
const { ok, bizError } = require('../lib/response');
/**
 * users 集合的读写与整形统一放在 lib/users.js：handlers/user.js（个人资料）
 * 要用同一份 shapeUser / findByOpenid。两份实现迟早会漂，而漂移不会报错 ——
 * 只会让「登录返回的用户」与「资料页返回的用户」字段不一样。
 */
const {
  COLLECTION,
  shapeUser,
  stableId,
  isDuplicateKeyError,
  findByOpenid,
  findActive,
} = require('../lib/users');

const db = cloud.database();

/**
 * POST /v1/auth/login —— 按 openid 建档（首次）或取档（再次）
 *
 * ⚠️ 新用户建档时**不预置任何身份信息**（昵称、头像、邮箱、套餐全部留空）。
 *    本地适配器曾为了「演示好看」写死过一个昵称，导致真机上显示出
 *    与用户无关的账号名 —— 那是编造数据。服务端同样不许重蹈覆辙。
 *
 * 登录态用 `activeSession` 字段表达（云开发路线没有 token）：
 *   · 登录 ⇒ 置 true
 *   · 登出 ⇒ 置 false（见 logout）
 *   · session 仅当 activeSession===true 才返回用户，否则视为未登录。
 */
async function login({ openid }) {
  if (!openid) throw bizError(401, '无法获取微信身份，请稍后重试');

  const now = new Date();
  const existing = await findByOpenid(openid);

  if (existing) {
    // 已建档：只刷新登录态与时间戳，**不覆盖**用户自己填的昵称/套餐等。
    await db.collection(COLLECTION).doc(existing._id).update({
      data: { updatedAt: now, activeSession: true },
    });
    const doc = Object.assign({}, existing, { updatedAt: now, activeSession: true });
    return ok({
      /** 云开发路线无自定义登录态，见本文件头部说明 */
      token: '',
      expiresIn: 0,
      user: shapeUser(doc),
    });
  }

  // 首次建档。用确定性 `_id` 写入，使并发抢建撞唯一键而非各写各的。
  const id = stableId(openid);
  try {
    await db.collection(COLLECTION).add({
      data: {
        _id: id,
        openid,
        nickName: '',
        avatarUrl: '',
        email: '',
        // 刻意留空而不是给个默认套餐名：凭空给用户安一个档位，
        // 页面就会显示出一个他从未选择过的身份。
        plan: '',
        grade: '',
        city: '',
        activeSession: true,
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (e) {
    // 唯一冲突 = 另一个并发请求已经建好档。重新取一次即可，
    // 不重复写、不覆盖对方写下的任何字段。
    if (isDuplicateKeyError(e)) {
      const winner = await findByOpenid(openid);
      if (winner) {
        return ok({ token: '', expiresIn: 0, user: shapeUser(winner) });
      }
    }
    // 其它写入错误（权限、超时……）照常抛出，不要静默吞掉。
    throw e;
  }

  const doc = {
    _id: id,
    openid,
    nickName: '',
    avatarUrl: '',
    email: '',
    plan: '',
    grade: '',
    city: '',
    activeSession: true,
    createdAt: now,
    updatedAt: now,
  };
  return ok({
    token: '',
    expiresIn: 0,
    user: shapeUser(doc),
  });
}

/**
 * GET /v1/auth/session —— 校验登录态
 *
 * 契约 4.1：**未登录时返回 data:null，不返回 401**，
 * 这样小程序启动时可以静默探测而不会触发「登录已过期」的提示。
 * 云开发路线下「已登录」= users 集合里存在该 openid 且 activeSession===true。
 * 已登出（activeSession!==true）与从未建档一样视为未登录。
 */
async function session({ openid }) {
  if (!openid) return ok(null);
  // findActive 就是「存在文档且 activeSession===true」这一句判据，
  // 与 handlers/user.js 的鉴权共用同一实现（不然两处迟早会有一处忘记判 activeSession）
  const doc = await findActive(openid);
  if (!doc) return ok(null);
  return ok({ user: shapeUser(doc) });
}

/**
 * POST /v1/auth/logout —— 使当前登录态失效（契约 4.1）
 *
 * 云开发路线没有 token 可失效，语义上「使登录态失效」= 把 activeSession 置 false。
 * 拿不到身份时无法定位记录，按幂等处理直接返回成功（不影响客户端登出体验）。
 * 响应 data 无内容（契约规定）。
 */
async function logout({ openid }) {
  if (openid) {
    const doc = await findByOpenid(openid);
    if (doc) {
      await db.collection(COLLECTION).doc(doc._id).update({
        data: { activeSession: false, updatedAt: new Date() },
      });
    }
  }
  return ok(null);
}

module.exports = { login, logout, session };
