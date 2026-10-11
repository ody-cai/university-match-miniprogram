/**
 * POST /v1/feedback —— 意见反馈收单
 * ==================================================================
 * ⚠️ 本接口是全项目**唯一允许匿名**的写接口，不要给它加登录前置。
 *    理由（契约 4.8）：意见反馈恰恰是用户**遇到问题时**才会用的功能，
 *    而「登录不上 / 授权失败」本身就是最高频的反馈类型之一。
 *    强制登录会把最该收到的那批反馈挡在门外。
 *
 * 云开发路线下 openid 是微信静默下发的（不需要用户点授权），所以
 * 「匿名」与「有身份」在这里并不矛盾：用户什么都没做，我们也知道
 * 这条工单来自哪个匿名的他 —— 这既让限流可行，也不构成索取个人信息。
 * 注意：这里的「身份」是微信匿名标识，**不是业务登录**（auth.login）。
 * 下面的逻辑会拒绝「连微信匿名标识都拿不到」的请求，但**允许未做业务
 * 登录、却持有 openid 的用户**正常提交（userId 即其微信匿名标识）。
 *
 * ── 幂等性：**非幂等** ────────────────────────────────────────────
 * 同一条内容重复提交视为两张独立工单（用户可能确实在补充说明）。
 * 防重靠客户端提交期间禁用按钮 + 这里的服务端限流，**不做内容去重**。
 */
const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const { ok, bizError, cpLength, cpSlice, dayKey } = require('../lib/response');

const db = cloud.database();
const _ = db.command;

const COLLECTION = 'feedbacks';
/** 与契约 4.8 一致；改动必须同时改契约，两处不一致会导致前端提示超限而后端接受 */
const TYPE_ENUM = ['bug', 'data', 'idea', 'complaint', 'other'];
const CONTENT_MAX = 200;
const CONTACT_MAX = 64;
const IMAGE_MAX = 3;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 3;
/**
 * 承诺回复天数 —— **由服务端下发**（契约 4.8 明确要求）。
 * 不要挪进小程序端：改 SLA 不该发版。
 */
const REPLY_WITHIN = 3;

/**
 * 生成工单号 fb_YYYYMMDD_<24 位十六进制>
 *
 * 早期版本用「当日已有工单数 + 1」生成 4 位序号。那是**读后写**：
 * 并发提交时两次 count 可能读到同一值 → 撞号；撞号后果是两条工单同号，
 * 回访对账会乱。
 *
 * 改用 crypto.randomBytes(12)：12 字节 = 96 bit 熵，碰撞概率可忽略，
 * **并且不再需要为生成序号去查库计数**（少一次 DB 读，也少一个并发竞争点）。
 * 日期前缀保留可读性，便于人工对账。
 */
async function nextTicketId(day) {
  return 'fb_' + day + '_' + crypto.randomBytes(12).toString('hex');
}

/**
 * 截图 fileId 合法性（**仅格式校验，不是归属校验**）
 * ------------------------------------------------------------------
 * ⚠️ 如实记录能力边界，不要假装做到了：契约 4.8 要求「fileId 与上传者
 *    openid 绑定，防止他人的 fileId 被拼进自己的反馈」。但云开发的云存储
 *    **不记录上传者**，服务端无法校验归属 —— 那是自建后端才做得到的事。
 *    本函数只校验格式与路径前缀，能挡掉外链与明显伪造值，
 *    **不能**证明这张图「属于」提交者；挡不住「拿到别人 fileId 再提交」。
 *    这是已知残余风险（见本文件末尾说明），不要通过前缀声称归属有效。
 */
function validFileId(x) {
  if (typeof x !== 'string') return false;
  // cloud://<环境>.<存储桶>/feedback/<文件名>
  if (x.indexOf('cloud://') !== 0) return false; // 外链 URL 一律拒绝
  return x.indexOf('/feedback/') > -1;
}

/**
 * 只保留契约 4.8 约定的 client 字段，并对每个字段限长。
 * 多传的字段（如 deviceId、rawData 等）一律丢弃，避免把无关客户端信息落库。
 */
function sanitizeClient(c) {
  if (!c || typeof c !== 'object') return null;
  const take = (v, max) => (typeof v === 'string' ? cpSlice(v.trim(), max) : '');
  return {
    version: take(c.version, 32),
    platform: take(c.platform, 32),
    system: take(c.system, 64),
  };
}

async function submit({ data, openid }) {
  const d = data || {};

  /* ---------- 微信身份（匿名标识，非业务登录） ---------- */
  // openid 由微信在云函数里静默下发，**不需要用户授权**，是可靠的限流/归属维度。
  // 若连它都拿不到（极端环境 / 调试器异常），说明无法确认提交来源 —— 直接拒绝，
  // 而不是用 'unknown' 兜底计数、落库又写 null，那样会出现限流维度与落库维度
  // 不一致（一条记在 unknown 下、一条记在 null 下，谁都查不到）。
  // 这**不**要求用户做业务登录：未登录但有 openid 的用户照样能提交。
  if (!openid) throw bizError(400, '无法获取微信身份，请稍后重试');

  /* ---------- 校验 ---------- */
  const type = String(d.type || '');
  if (TYPE_ENUM.indexOf(type) === -1) throw bizError(400, '请选择反馈类型');

  const content = String(d.content || '').trim();
  if (!content) throw bizError(400, '请填写问题描述');
  if (cpLength(content) > CONTENT_MAX) {
    throw bizError(400, '问题描述请控制在 ' + CONTENT_MAX + ' 字以内');
  }

  // ⚠️ 联系方式**不校验格式**（契约 4.8）：用户最常填微信号，任何格式校验
  //    都会把这种最常见填法判成非法，反而挡住有效反馈。
  const contact = cpSlice(String(d.contact || '').trim(), CONTACT_MAX);

  /* ---------- 截图：全量严格校验，禁止静默丢图 ---------- */
  const rawImages = Array.isArray(d.images) ? d.images : [];
  if (rawImages.length > IMAGE_MAX) {
    throw bizError(400, '最多上传 ' + IMAGE_MAX + ' 张截图');
  }
  // 只要有一张不合法就整体拒绝，而不是把合法的留下来、非法的悄悄丢掉
  // （旧逻辑用 filter 会静默丢弃混合里的非法图，用户还以为图都传上去了）。
  for (const img of rawImages) {
    if (!validFileId(img)) {
      throw bizError(400, '截图上传失败，请重新选择图片');
    }
  }
  const images = rawImages.slice(0, IMAGE_MAX);

  /* ---------- 限流（契约 4.8：60 秒内最多 3 次） ---------- */
  // 限流维度与落库维度一致，都用 openid（已在上方保证非空）。
  const since = new Date(Date.now() - RATE_WINDOW_MS);
  const recent = await db
    .collection(COLLECTION)
    .where({ userId: openid, createdAt: _.gte(since) })
    .count();
  if (recent && recent.total >= RATE_MAX) {
    // 429 的 message 必须可直接展示；前端收到后**不要**自动重试
    throw bizError(429, '提交过于频繁，请稍后再试');
  }

  /* ---------- 落库 ---------- */
  const now = new Date();
  const ticketId = await nextTicketId(dayKey(now));

  await db.collection(COLLECTION).add({
    data: {
      ticketId,
      type,
      // 未做业务登录的用户仍有 openid（微信静默下发），照常用其匿名标识关联
      userId: openid,
      content,
      contact,
      images,
      schoolId: cpSlice(String(d.schoolId || ''), 64),
      client: sanitizeClient(d.client),
      status: 'open',
      createdAt: now,
    },
  });

  return ok({
    ticketId,
    createdAt: now.toISOString(),
    replyWithin: REPLY_WITHIN,
  });
}

/**
 * 残余风险（如实记录，不掩盖）：
 * 1) 限流仍是「读 count → 写 add」的读后写。在 60s 窗口内、两个请求
 *    几乎同时到达时，可能都读到相同 count 而都放行（TOCTOU）。后果是
 *    瞬时可能超过 RATE_MAX 次落库——但每条都带 openid、可事后追溯，
 *    且窗口仅 60s，属可控的软限流，非资金/安全场景，暂不引入事务或
 *    自增计数器等重方案。要彻底消除需云端原子自增（如数据库自增字段 /
 *    分布式锁），代价高于收益，故保留为残余风险。
 * 2) 截图归属（见 validFileId 注释）：无法校验 fileId 是否属于提交者，
 *    仅做格式/路径前缀校验。不通过前缀声称归属有效，也不扩大上传功能。
 */
module.exports = { submit };
