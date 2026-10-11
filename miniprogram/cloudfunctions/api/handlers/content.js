/**
 * GET /v1/content —— 内容与配置下发（无需鉴权）
 * ==================================================================
 * 用途（契约 4.7）：把页面文案、枚举、功能入口、匹配权重、灰度开关
 * 收到服务端，使「改文案 / 调口径 / 开关功能」**不需要重新发版**。
 *
 * 客户端按「对象递归合并、数组整体替换」把本响应合并到内置默认值
 * （`data/content.js`）上，因此这里**只下发需要覆盖的字段**；
 * 不需要改的字段一律不要出现在返回里 —— 下发全量等于把默认值抄了一份，
 * 两边从此各改各的，静默漂移（这正是 2026-09-16 移除 countdownTarget 的原因）。
 *
 * ⚠️ 云数据库 `content` 集合的权限必须设为
 *    「所有用户可读，仅管理端可写」（自定义安全规则 { "read": true, "write": false }）。
 *    若误设成「仅创建者可读写」，小程序的普通用户将读不到任何内容补丁，
 *    而**不会报错** —— loadContent() 会静默回落到内置默认值，
 *    表现为「后台改了文案但线上没变」，极难排查。
 */
const cloud = require('wx-server-sdk');
const { ok } = require('../lib/response');

const db = cloud.database();

const COLLECTION = 'content';
/** 单文档存储：内容补丁整体是一份配置，拆多文档只会带来合并顺序问题 */
const DOC_ID = 'default';

/** 数据库元字段，不下发给客户端 */
const META_FIELDS = ['_id', '_openid', '_admin'];

/**
 * 是否「文档/集合不存在」—— 这是**唯一**允许被当成「空状态」的异常。
 * ⚠️ 只认 `ResourceNotFound` / `document not exists` 的**证据**，不能凭
 * `errCode === -502005` 单独判定：-502005 是「资源不存在」类码，但仅凭它
 * 容易把其它数据库故障（如权限/超时套了同类码）误当成“文档不存在”，从而
 * 静默返回空补丁、把真实故障伪装成“没配内容”。真正的证据在 errMsg 里。
 *
 * ⚠️ 正则必须同时覆盖 `not exists` 与 `does not exist` 两种措辞
 * （2026-09-19 实测补）：`doc(id).get()` 命中空集合时，云端实际抛出的是
 *   document.get:fail document with _id default does not exist
 * 早期只写 `not exists`，漏掉 `does not exist`，导致**内容集合为空时**
 * 该接口固定返回 500；客户端又会静默回落内置默认值（loadContent 的 catch），
 * 表面上页面照常，实则每次启动都在吃一次错误 ——
 * 且与「后台改了文案但线上没变」的表现完全一致，极难排查。
 */
function isDocNotFound(e) {
  if (!e) return false;
  return /ResourceNotFound|not exists|does not exist|not found/i.test(e.errMsg || '');
}

async function get() {
  let doc = null;
  try {
    const res = await db.collection(COLLECTION).doc(DOC_ID).get();
    doc = res && res.data;
  } catch (e) {
    // **仅**「文档/集合不存在」是正常空状态（还没配过任何内容）：
    //   返回空补丁 → 客户端合并后等于内置默认值 → 页面照常渲染。
    // 其它任何错误（权限 -502003、响应超时 -501002、系统错误 -501001……）
    // 一律**抛出**，交给入口转成 500，绝不能被静默吞掉伪装成「没配内容」——
    // 那样会让一次真实的后端故障表现为「后台改了文案但线上没变」，极难排查。
    if (!isDocNotFound(e)) throw e;
    doc = null;
  }

  if (!doc) return ok({});

  const patch = Object.assign({}, doc);
  for (const f of META_FIELDS) delete patch[f];
  return ok(patch);
}

module.exports = { get };
