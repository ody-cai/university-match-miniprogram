/**
 * 用户资料：GET /v1/user/profile、PUT /v1/user/profile
 * ==================================================================
 * 为什么会有这个文件：此前 `user.profile` / `user.updateProfile` **没有**
 * 登记在云函数的 ROUTES 表里，于是云开发路线上它们一律落到 501 →
 * 客户端静默回落到本地实现。后果不是报错，而是**界面上写着
 * 「资料会同步到你的账号」，实际一个字节都没上云** —— 一句没人察觉的假话。
 * 个人资料页（10）上线时把这两个端点补齐。
 *
 * ── 两条不能破的纪律 ──────────────────────────────────────────────
 *
 * ① **身份只认服务端的 openid**，不认客户端传来的任何 id。
 *    云函数用 `cloud.getWXContext().OPENID` 拿身份，这个标识由微信静默下发、
 *    不需要用户授权。若改成「客户端传 userId 我改谁」，就是一个越权改他人资料的洞。
 *
 * ② **写入白名单**：只允许契约 4.2 列出的五个字段。
 *    `plan` / `openid` / `activeSession` / `createdAt` / `_id` 客户端无权改，
 *    传了就**忽略**（而不是报错）—— 报错会把「客户端多发了个字段」
 *    变成用户可见的失败；忽略既不泄露也不放权。
 *
 * ── 未登录的语义 ──────────────────────────────────────────────────
 * GET：没有档案 / 未登录 → `ok(null)`（与 auth/session 一致，
 *      客户端 `getProfile()` 拿到 null 自行回落，不抛错）。
 * PUT：没有档案 / 未登录 → **401**。改写他人档案这种事不允许静默降级成
 *      「写了个没人认领的孤儿文档」。客户端在个人资料页对此做了前置拦截。
 *
 * ── 校验口径必须与客户端一致 ──────────────────────────────────────
 * 长度按 **Unicode 码点**计（`cpLength`），与 `data/content.js` 的
 * nicknameMax 20 / emailMax 60 / cityMax 20 逐一对齐。
 * 一边按码元、一边按码点，用户就会遇到「前端说没超、后端说超了」。
 */
const { ok, bizError, cpLength } = require('../lib/response');
const { COLLECTION, shapeUser, findActive } = require('../lib/users');
const cloud = require('wx-server-sdk');

const db = cloud.database();

/**
 * 可写字段 → 上限（码点）
 * ⚠️ 与 data/content.js 的 profile.*Max 必须一致，改一处要同步另一处。
 */
const WRITABLE = { nickName: 20, email: 60, grade: 10, city: 20, avatarUrl: 300 };

/** 与客户端同一套宽松规则：只要不是明显不是邮箱就行 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * 头像地址白名单。
 * ------------------------------------------------------------------
 * 只接受 `https://`（自建后端的 /v1/upload 返回值）与 `cloud://`
 * （云开发的 fileID，可被 `<image src>` 直接消费）。
 * ⚠️ 必须挡住 `wxfile://` / `http://tmp/...` 这类**本机临时路径** ——
 *    客户端已经拦了一道（上传失败就不提交头像），服务端再拦一道：
 *    真存进去只会得到一张换设备就裂的图，而且没有任何报错提示。
 */
function validAvatar(url) {
  return /^(https:\/\/|cloud:\/\/)/.test(url);
}

/** 取一个「干净的字符串字段」，非字符串一律当没传（不静默 toString 一个对象进去） */
function field(raw, key) {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
  const v = raw[key];
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return undefined;
  return v.trim();
}

/** 字段的中文名，仅用于拼校验提示（提示是给人看的，不能出现 nickName 这种内部名） */
const LABEL = { nickName: '昵称', email: '邮箱', grade: '年级', city: '城市', avatarUrl: '头像地址' };

/**
 * 校验并挑出可写字段。
 * 返回 `{ patch }`；只包含**请求里真的带了**的字段（部分更新语义）。
 */
function buildPatch(data) {
  const raw = data || {};
  const patch = {};

  for (const key of Object.keys(WRITABLE)) {
    const v = field(raw, key);
    if (v === undefined) continue; // 没传 → 不在这次修改范围内

    const max = WRITABLE[key];
    if (cpLength(v) > max) {
      throw bizError(400, LABEL[key] + '最多 ' + max + ' 个字');
    }

    if (key === 'email' && v && !EMAIL_RE.test(v)) {
      throw bizError(400, '邮箱格式不正确');
    }
    if (key === 'avatarUrl' && v && !validAvatar(v)) {
      throw bizError(400, '头像地址不合法');
    }

    patch[key] = v;
  }

  // 昵称是唯一必填项：允许清空会让「个人资料」退回一个没有称呼的状态，
  // 而界面上的资料卡会显示「未设置昵称」，用户会以为保存失败了。
  if (patch.nickName !== undefined && !patch.nickName) {
    throw bizError(400, '请先填写昵称');
  }

  return patch;
}

/**
 * GET /v1/user/profile
 * 未登录返回 `data: null`（不返回 401）—— 账号页与个人资料页在未登录时
 * 也要能正常渲染「登录后同步数据」的提示，不该被一个错误挡住。
 */
async function profile({ openid }) {
  if (!openid) return ok(null);
  const doc = await findActive(openid);
  if (!doc) return ok(null);
  return ok(shapeUser(doc));
}

/**
 * PUT /v1/user/profile
 * 请求体为**部分字段**（契约 4.2）：只更新请求里出现的键，
 * 其余字段原样保留 —— 这也是为什么不能整份覆盖写。
 */
async function updateProfile({ openid, data }) {
  if (!openid) throw bizError(401, '登录状态已失效，请重新登录');

  const doc = await findActive(openid);
  if (!doc) throw bizError(401, '登录状态已失效，请重新登录');

  const patch = buildPatch(data);
  if (!Object.keys(patch).length) {
    // 没有可写字段：不写库、也不报错，直接回当前资料。
    // 报错会让「点保存时什么都没改」变成一个红色失败提示。
    return ok(shapeUser(doc));
  }

  const now = new Date();
  const next = Object.assign({}, patch, { updatedAt: now });
  await db.collection(COLLECTION).doc(doc._id).update({ data: next });

  return ok(shapeUser(Object.assign({}, doc, next)));
}

module.exports = { profile, updateProfile };
