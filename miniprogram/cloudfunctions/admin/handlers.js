'use strict';
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const d = require('./domain');
const db = cloud.database();

/* ==================================================================
   订阅消息（反馈受理通知）—— 发送侧
   ==================================================================
   ⚠️ 云调用**必须先在微信开发者工具里上传过一次本云函数**才会登记权限
      （`config.json` 的 `permissions.openapi`）。tcb CLI 部署**不会**同步
      这个权限 —— 微信官方文档原文：「在每次使用微信开发者工具上传云函数时
      均会根据配置更新权限，该配置有 10 分钟左右的缓存」。
      未登记时调用返回 -604101（权限未配置）/ -604100（提示需用开发者工具同步）。
      ⇒ 所以发送失败时把错误码**原样透到管理台**，让运营一眼能分辨
        「权限还没登记」和「这个用户没有订阅额度」—— 这两件事的处置完全不同。

   ⚠️ 内容层（`content` 集合的 `notify` 段）是模板配置的唯一真源：
      客户端用它做授权、服务端用它做发送。把模板 ID 写死进代码，会让
      「换了模板但忘了重新部署」变成一次静默失效 —— 用户授权的是新模板、
      服务端发的是旧模板、微信回 47003，用户那头什么都收不到。
   ================================================================== */

/** 订阅记录集合名。⚠️ 与 `cloudfunctions/api/handlers/notify.js` 的常量必须一致 */
const NOTIFY_COLLECTION = 'notify_subs';

/**
 * openid → 稳定 `_id`（SHA-256）。
 * ------------------------------------------------------------------
 * ⚠️ 必须与 `cloudfunctions/api/lib/users.js` 的 `stableId` **逐字一致**。
 *    两个云函数是不同的包、不能相互 require，所以这里只能有一份副本；
 *    代价是「改一处忘另一处」会让两边**永远查不到同一条文档**，
 *    而且**不会报错**（表现为「用户明明授权了，后台说他没有额度」）。
 *    tools/check-docs-consistency.js 会核对两边的实现字符串。
 */
function stableIdOf(openid) {
  return crypto.createHash('sha256').update('openid:' + openid).digest('hex');
}

/** 按 Unicode 码点计数 / 截断（微信的字段长度限制按字符算，不按 UTF-16 码元） */
function cpLength(v) { return Array.from(String(v == null ? '' : v)).length; }
function cpSlice(v, n) {
  const a = Array.from(String(v == null ? '' : v));
  return a.length <= n ? a.join('') : a.slice(0, n).join('');
}

/**
 * 格式化成**北京时间** `YYYY-MM-DD HH:mm`。
 * ------------------------------------------------------------------
 * ⚠️ 必须显式 +8：云函数运行时区是 UTC，直接 `getHours()` 拿到的是 UTC 时间，
 *    写进通知里会比北京时间少 8 小时，而且**不会有任何报错** ——
 *    用户看到「03:12 受理的」只会觉得莫名其妙。
 * ⚠️ 也不用 `toLocaleString`：它的输出依赖运行环境的 ICU 数据，不同 Node
 *    版本格式不一致，而订阅消息的 `time` 字段格式是**硬校验**的。
 */
function fmtTimeCST(v) {
  const base = v instanceof Date ? v : new Date(v);
  if (isNaN(base.getTime())) return '';
  const t = new Date(base.getTime() + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return (
    t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) +
    ' ' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes())
  );
}

/** 微信订阅消息允许的字段名前缀（后面必须跟数字，如 `thing1` / `time2`） */
const TMPL_KEY_RE = /^(thing|time|number|phrase|letter|character_string|amount|date|phone_number|car_number|name|const)\d+$/;


function iso(v) { if (!v) return ''; const x = v instanceof Date ? v : new Date(v); return isNaN(x.getTime()) ? '' : x.toISOString(); }
async function getDoc(database, collection, id) {
  try { const r = await database.collection(collection).doc(id).get(); return r && r.data || null; }
  catch (e) { if (/document not exists|document.*not found|does not exist/i.test(e.errMsg || e.message || '')) return null; throw e; }
}
function contentView(doc) { return { patch: d.patchOf(doc), defaults: d.defaults, revision: d.revision(doc), updatedAt: iso(doc && doc._admin && doc._admin.updatedAt) }; }
function ticketView(t) {
  // 管理界面不需要原始微信标识，也不返回其余未列出的数据库字段。
  // `notify` = 受理通知的发送结果（null 表示**从未尝试发送**）——
  // 与 `favorites === null` 同一条纪律：「没有结论」与「结论是空的」必须分得开。
  return { ticketId: t.ticketId, type: t.type, content: t.content, contact: t.contact || '', images: t.images || [], schoolId: t.schoolId || '', client: t.client || null, status: t.status || 'open', priority: t.priority || 'normal', assignee: t.assignee || '', note: t.note || '', reply: t.reply || '', notify: t.notify || null, revision: d.revision(t), createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt), resolvedAt: iso(t.resolvedAt), history: t.history || [] };
}
/**
 * 用户档案 —— 白名单视图，字段严格按契约 4.2 的对外用户对象。
 *
 * ⚠️ 三条不能破的纪律：
 *  ① **绝不下发 `openid`**（契约 5 节：openid 不返回给客户端）。
 *     它对服务端是主键，对管理台没有用途，下发只会扩大泄露面 ——
 *     管理台页面一旦被分享、截图、或者浏览器插件读取，泄露的就是可直接
 *     关联到具体微信用户的标识。用户文档里还有 `openid` 字段，
 *     所以这里必须是**显式白名单**，不能写成 `Object.assign({}, doc)`。
 *  ② **`_id` 可以下发**：它是 `sha256('openid:' + openid)`，不可逆，
 *     且正是「按 id 取详情」需要的稳定主键。下发的还是它，不是 openid。
 *  ③ **只展示数据库里真的有的字段**。成绩与收藏自 2026-09-22 起已上云
 *     （契约 2.2），所以详情页会展示它们 —— 但展示的是**库里那份真实数据**，
 *     不是凭空的数字。字段为空就显示「未填写」，绝不拿 0 或内容层的
 *     示例值（`defaultAcademic`）去填。`plan` 目前服务端一律留空，
 *     空就是空，显示「未设置」而不是编一个档位。
 */
function userView(u) {
  return {
    id: u._id,
    nickName: u.nickName || '',
    avatarUrl: u.avatarUrl || '',
    email: u.email || '',
    plan: u.plan || '',
    grade: u.grade || '',
    city: u.city || '',
    // 「已登录」= 存在文档且 activeSession===true（与 lib/users.js 的 findActive 同一判据）
    signedIn: u.activeSession === true,
    createdAt: iso(u.createdAt),
    updatedAt: iso(u.updatedAt),
  };
}

/**
 * 把枚举 key 映射成中文名。
 * ------------------------------------------------------------------
 * 在**服务端**映射而不是前端硬编码一份对照表，理由与「文案不写死」同源：
 * 国家 / 专业 / 课程体系的中文名在内容层（`data/content.js` 的 enums）里，
 * 可以远程下发。前端再抄一份，改名字时就会出现「小程序显示新名字、
 * 后台显示旧名字」，而且不会报错。
 * 取不到就**原样显示 key**，不要显示空白 —— 那会让人以为数据丢了。
 */
function labelOf(list, key) {
  const hit = (list || []).filter(function (x) { return x && x.key === key; })[0];
  return hit && hit.label ? hit.label : key;
}
function labelsOf(list, keys) {
  return (Array.isArray(keys) ? keys : []).map(function (k) { return labelOf(list, k); });
}

/**
 * 成绩档案的对外形态（契约 4.3）。
 * ------------------------------------------------------------------
 * ⚠️ 仍然**一个数字都不许补**。字段为空就是空，界面显示「未填写」；
 *    绝不能拿 0 或内容层 `defaultAcademic` 里的示例值去填 ——
 *    那是编造用户数据，与「空档案曾自带 GPA 86」是同一条红线。
 *    （`domain.js` 的 validatePatch 已明确禁止后台预置：
 *      `禁止通过运营后台预置用户成绩`。）
 *
 * 一份**从未填写过**的档案在库里根本没有 `academic` 字段，
 * 这里返回 null，界面显示空态 —— 「没有数据」与「数据是 0」必须分得开。
 */
function academicView(a) {
  if (!a || typeof a !== 'object') return null;
  const e = (d.defaults && d.defaults.enums) || {};
  const countries = Array.isArray(a.countries) ? a.countries : [];
  const majors = Array.isArray(a.majors) ? a.majors : [];
  return {
    curriculum: a.curriculum || '',
    // 中文名由服务端查内容层的 enums 得出，前端不做映射（见 labelOf 的注释）
    curriculumLabel: labelOf(e.curricula, a.curriculum || ''),
    // 各课程体系的中文名（前端展开 coursesMap 时按体系分组显示）
    curriculumLabels: (e.curricula || []).map(function (x) { return { key: x.key, label: x.label }; }),
    gpa: a.gpa === undefined ? null : a.gpa,
    gpaScale: a.gpaScale === undefined ? 100 : a.gpaScale,
    ielts: a.ielts || null,
    toefl: a.toefl === undefined ? null : a.toefl,
    sat: a.sat === undefined ? null : a.sat,
    countries: countries,
    countryLabels: labelsOf(e.countries, countries),
    majors: majors,
    majorLabels: labelsOf(e.majors, majors),
    coursesMap: a.coursesMap && typeof a.coursesMap === 'object' ? a.coursesMap : {},
    courses: Array.isArray(a.courses) ? a.courses : [],
    updatedAt: iso(a.updatedAt),
  };
}

/**
 * 收藏院校的对外形态 —— 把 id 映射成院校名。
 * ------------------------------------------------------------------
 * 管理台看的是人，不是一个 `ubc` 这样的内部标识。
 *
 * ⚠️ 查不到时**如实标记 `missing`**，不要静默丢弃：院校可能已从库中下线，
 *    而那条收藏在用户那里是真实存在的。丢掉它会让「收藏 5 所」在详情里
 *    只列出 4 所，看起来像数据丢了 —— 这在数据真实性上的严重程度
 *    不比「多显示一个」低。
 *
 * 用的是后台自己那份 `data/schools.json`（由 sync-data-copies.js 与
 * 小程序端保持同步），不额外引入第二份院校清单。
 */
const SCHOOL_BY_ID = (function () {
  const m = {};
  for (const s of d.schools) m[s.id] = s;
  return m;
})();

function favoritesView(ids) {
  const list = Array.isArray(ids) ? ids : [];
  return list.map(function (id) {
    const s = SCHOOL_BY_ID[id];
    if (!s) {
      // 院校已下线 / id 不在当前库里：保留 id 并标出来，界面显示原始 id + 提示
      return { id: id, nameCn: '', nameEn: '', countryCn: '', qsLabel: '', missing: true };
    }
    return {
      id: id,
      nameCn: s.nameCn || '',
      nameEn: s.nameEn || '',
      countryCn: s.countryCn || '',
      qsLabel: s.qsLabel || '',
      missing: false,
    };
  });
}

/**
 * 用户**详情**视图 = 基本信息 + 成绩档案 + 收藏院校。
 * 只有详情带这两块：列表一页最多 100 条，把完整成绩档案塞进去会让
 * payload 无谓地膨胀，而列表上根本不展示它们。
 */
function userDetailView(u) {
  return Object.assign(userView(u), {
    academic: academicView(u.academic),
    /**
     * ⚠️ 必须区分「**从未同步过**收藏」与「同步过但一所都没收藏」：
     *    · `undefined`（文档里根本没这个字段）= 升级前的老账号，返回 **null**；
     *    · `[]`（同步过、确实是空的）= 返回 **空数组**。
     *    两者在界面上是**不同的空态文案** ——「没有结论」与「结论是空的」
     *    必须能分开，这是本项目反复强调的一条纪律（同 tier 的
     *    `undefined` vs `'unknown'`）。混成一个，排查「用户说收藏丢了」
     *    时就分不清「他真没收藏过」还是「同步没跑成功」。
     */
    favorites: Array.isArray(u.favorites) ? favoritesView(u.favorites) : null,
    favoritesUpdatedAt: iso(u.favoritesUpdatedAt),
  });
}
/** users 集合缺失（云开发要求集合先手动创建）时的报错文案 */
const COLLECTION_MISSING = /collection.*(not exist|does not exist)|DATABASE_COLLECTION_NOT_EXIST/i;
function asCollectionError(e, name) {
  if (COLLECTION_MISSING.test((e && (e.errMsg || e.message)) || '')) {
    d.error(503, name + ' 集合尚未创建，请先在云开发控制台建集合');
  }
  return e;
}
async function findTicket(id) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) d.error(400, '工单号格式无效');
  const r = await db.collection('feedbacks').where({ ticketId: id }).limit(1).get();
  if (!r.data || !r.data.length) d.error(404, '工单不存在'); return r.data[0];
}
/**
 * 用户计数。
 * ⚠️ 失败时返回 **null，而不是 0**。
 *    0 会被读成「一个用户都没有」—— 那是编造结论；`users` 集合缺失、
 *    权限不足时返回 null，界面显示「—」。
 * ⚠️ 也**不能让它把 overview 整条拖垮**：管理台第一屏就是 /admin-api/overview，
 *    概览挂掉 = 密钥正确也进不去后台，爆炸半径远大于「少一张卡片」。
 */
async function userCounts() {
  try {
    const [all, active] = await Promise.all([
      db.collection('users').count(),
      db.collection('users').where({ activeSession: true }).count(),
    ]);
    return { total: all.total || 0, signedIn: active.total || 0 };
  } catch (e) {
    console.error('[admin] 用户计数失败', e);
    return null;
  }
}
async function overview() {
  const counts = await Promise.all(d.STATUSES.map(status => db.collection('feedbacks').where({ status }).count()));
  const all = await db.collection('feedbacks').count();
  const tickets = { total: all.total || 0 }; d.STATUSES.forEach((s,i) => { tickets[s] = counts[i].total || 0; });
  const doc = await getDoc(db, 'content', 'default');
  return { tickets, users: await userCounts(), schoolCount: d.schools.length, contentRevision: d.revision(doc), updatedAt: iso(doc && doc._admin && doc._admin.updatedAt) };
}
async function getContent() { return contentView(await getDoc(db, 'content', 'default')); }
async function publish(expected, buildPatch, note, admin, action) {
  note = d.text(note || '', 300, '发布备注');
  const auditId = 'release_' + crypto.randomBytes(12).toString('hex');
  let saved;
  // 配置发布与审计写入在同一事务；并发冲突不能出现后写覆盖。
  await db.runTransaction(async tx => {
    const old = await getDoc(tx, 'content', 'default');
    d.assertRevision(d.revision(old), expected);
    const patch = buildPatch(d.patchOf(old)); d.validatePatch(patch);
    saved = Object.assign({}, patch, { _admin: { revision: expected + 1, updatedAt: new Date(), updatedBy: admin, note } });
    await tx.collection('content').doc('default').set({ data: saved });
    await tx.collection('admin_audit').doc(auditId).set({ data: { action, target: 'content/default', admin, note, revision: expected + 1, previousPatch: d.patchOf(old), createdAt: new Date() } });
  });
  return contentView(saved);
}
async function putContent(body, admin) {
  d.validatePatch(body.patch);
  return publish(body.revision, () => body.patch, body.note, admin, 'content.publish');
}
function pagination(q) {
  const page = Number(q.page || 1), size = Number(q.size || 20);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(size) || size < 1 || size > 100) d.error(400, '分页参数无效');
  return { page, size };
}
async function listTickets(q = {}) {
  const { page, size } = pagination(q);
  const filter = {};
  if (q.status) { if (!d.STATUSES.includes(q.status)) d.error(400, '工单状态无效'); filter.status = q.status; }
  if (q.type) { if (!d.TYPES.includes(q.type)) d.error(400, '工单类型无效'); filter.type = q.type; }
  const kw = d.text(String(q.keyword || ''), 100, '关键词');
  let condition = filter;
  if (kw) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const clauses = ['ticketId', 'content', 'contact', 'schoolId'].map(k => ({ [k]: db.RegExp({ regexp: escaped, options: 'i' }) }));
    condition = db.command.and([filter, db.command.or(clauses)]);
  }
  const query = db.collection('feedbacks').where(condition);
  const [count, result] = await Promise.all([query.count(), db.collection('feedbacks').where(condition).orderBy('createdAt', 'desc').skip((page - 1) * size).limit(size).get()]);
  return { list: (result.data || []).map(ticketView), total: count.total || 0, page, size };
}
async function getTicket(id) { return ticketView(await findTicket(id)); }
async function updateTicket(id, body, admin) {
  const ref = await findTicket(id); const changes = {};
  for (const field of Object.keys(body)) if (!['revision','status','priority','assignee','note','reply'].includes(field)) d.error(400, '不支持的工单字段');
  if (body.status !== undefined) { if (!d.STATUSES.includes(body.status)) d.error(400, '工单状态不合法'); changes.status = body.status; }
  if (body.priority !== undefined) { if (!d.PRIORITIES.includes(body.priority)) d.error(400, '优先级不合法'); changes.priority = body.priority; }
  for (const f of ['assignee','note','reply']) if (body[f] !== undefined) changes[f] = d.text(body[f], f === 'assignee' ? 64 : 1000, f);
  if (!Object.keys(changes).length) d.error(400, '没有可更新字段');
  let saved;
  await db.runTransaction(async tx => {
    const old = await getDoc(tx, 'feedbacks', ref._id);
    if (!old) d.error(404, '工单不存在');
    d.assertRevision(d.revision(old), body.revision);
    if (['resolved','closed'].includes(changes.status) && !(changes.note || changes.reply || old.note || old.reply)) d.error(400, '办结或关闭前请填写处理说明');
    const at = new Date();
    const entry = { action: 'ticket.update', admin, createdAt: at.toISOString(), from: old.status || 'open', status: changes.status || old.status, detail: changes.note || changes.reply || '更新工单状态或分派', changes };
    const history = (old.history || []).concat(entry).slice(-100);
    saved = Object.assign({}, old, changes, { history, updatedAt: at, _admin: { revision: body.revision + 1, updatedAt: at, updatedBy: admin } });
    if (changes.status) saved.resolvedAt = ['resolved','closed'].includes(changes.status) ? at : null;
    const write = Object.assign({}, saved); delete write._id; delete write._openid;
    await tx.collection('feedbacks').doc(ref._id).set({ data: write });
    await tx.collection('admin_audit').doc('ticket_' + crypto.randomBytes(12).toString('hex')).set({ data: { action: 'ticket.update', target: id, admin, revision: body.revision + 1, createdAt: at, status: saved.status } });
  });
  return ticketView(saved);
}

/**
 * 「文档不存在」—— 对订阅记录来说这是一个**有效答案**（这个用户没订阅过），
 * 不是错误。
 * ⚠️ 判定必须要求错误信息里出现 `document` 字样。裸的 `/does not exist/`
 *    会把「**集合**不存在」也吃掉，于是运维问题被静默降级成「这个用户没订阅」——
 *    表现为「明明授权了却查不到」，而没有任何地方报错。
 */
const DOC_MISSING = /document.*(not exist|does not exist|not found)/i;

/** 读订阅记录；文档不存在返回 null，集合不存在抛 503 */
async function getSub(openid) {
  try {
    const r = await db.collection(NOTIFY_COLLECTION).doc(stableIdOf(openid)).get();
    return (r && r.data) || null;
  } catch (e) {
    const msg = (e && (e.errMsg || e.message)) || '';
    if (COLLECTION_MISSING.test(msg)) throw asCollectionError(e, NOTIFY_COLLECTION);
    if (DOC_MISSING.test(msg)) return null;
    throw e;
  }
}

/**
 * 读内容层的通知配置（模板 ID / 字段映射 / 跳转页 / 环境版本）。
 * ⚠️ 返回 `{ok:false, reason}` 而不是抛错：调用方要能把「为什么发不出去」
 *    原样展示给运营（是没配模板？还是没配字段映射？还是能力被关了？），
 *    而不是笼统的一句 503。
 */
async function notifyConfig() {
  let n = {};
  try {
    const doc = await getDoc(db, 'content', 'default');
    n = (doc && doc.notify) || {};
  } catch (e) {
    // 内容集合不存在是正常的（没发布过内容补丁）→ 落到下面的「未配置」分支
    n = {};
  }

  if (n.enabled === false) {
    return { ok: false, reason: '通知能力已在内容配置里关闭（notify.enabled = false）' };
  }

  const tmplIds = (Array.isArray(n.tmplIds) ? n.tmplIds : []).filter((x) => typeof x === 'string' && x);
  if (!tmplIds.length) {
    return { ok: false, reason: '尚未配置订阅消息模板 ID（内容配置 notify.tmplIds 为空）' };
  }

  const tmplData = (Array.isArray(n.tmplData) ? n.tmplData : []).filter(
    (x) => x && typeof x.key === 'string' && typeof x.source === 'string'
  );
  if (!tmplData.length) {
    return { ok: false, reason: '尚未配置通知模板字段映射（内容配置 notify.tmplData 为空）' };
  }

  return {
    ok: true,
    reason: '',
    tmplIds,
    tmplData,
    page: typeof n.page === 'string' ? n.page : '',
    envVersion: ['developer', 'trial', 'formal'].indexOf(n.envVersion) > -1 ? n.envVersion : 'formal',
    push: n.push && typeof n.push === 'object' ? n.push : {},
  };
}

/**
 * 模板字段的取值来源。
 * ------------------------------------------------------------------
 * ⚠️ **白名单枚举，不是反射**（不是 `ticket[source]` 那种写法）——
 *    反射会把工单文档里的任意字段发到用户手机上，包括 `userId`（那正是
 *    openid）与内部处理备注 `note`，而且**不会有任何报错**。
 */
function sourceValue(source, cfg, t, at) {
  switch (source) {
    case 'title': return cfg.push.title || '';
    case 'ticketId': return t.ticketId || '';
    case 'status': return d.STATUS_LABEL[t.status] || '';
    case 'time': return fmtTimeCST(at);
    case 'reply': return t.reply || cfg.push.noReply || '';
    default: return '';
  }
}

/**
 * 按微信的字段类型约束整理取值。
 * ------------------------------------------------------------------
 * 微信对每类字段都有硬限制（`thing` ≤ 20 字符、`time` 有固定格式……），
 * **不整理就会直接失败**：返回 47003「模板参数不合法」，而用户那头
 * 什么都收不到、也没有任何提示。
 * 这里只做「安全地截断」，**不做任何填充** —— 取不到值由调用方报错，
 * 不在这里编一个「暂无」顶上（那是替数据说话）。
 */
function shapeField(key, value) {
  const v = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  if (/^time\d+$/.test(key)) return v; // 已由 fmtTimeCST 归一化
  if (/^character_string\d+$/.test(key)) return cpSlice(v, 32);
  if (/^phrase\d+$/.test(key)) return cpSlice(v, 5); // ⚠️ phrase 只允许模板预设的枚举值
  if (/^number\d+$/.test(key)) return v.replace(/[^0-9.]/g, '').slice(0, 32);
  if (/^letter\d+$/.test(key)) return v.replace(/[^A-Za-z]/g, '').slice(0, 32);
  // thing / name 等：20 字上限，超出用省略号收尾（不要硬截成半句话）
  return cpLength(v) > 20 ? cpSlice(v, 19) + '…' : v;
}

function buildTemplateData(cfg, t, at) {
  const data = {};
  for (const item of cfg.tmplData) {
    if (!TMPL_KEY_RE.test(item.key)) {
      d.error(400, '通知模板字段名不合法：' + item.key + '（应形如 thing1 / time2）');
    }
    const v = shapeField(item.key, sourceValue(item.source, cfg, t, at));
    if (!v) {
      /**
       * ⚠️ 空值会被微信判成 47003。这里**如实报错**，而不是塞一个编造的占位：
       *    「字段 X 取不到值」是可修的、看得见的；而发一条内容空洞的通知出去
       *    是收不回的，用户还会以为受理结果就长这样。
       */
      d.error(400, '通知字段 ' + item.key + '（来源 ' + item.source + '）取不到值，请先填写工单的处理回复');
    }
    data[item.key] = { value: v };
  }
  return data;
}

/**
 * POST /admin-api/tickets/{id}/notify —— 给工单提交者发一条受理通知
 * ==================================================================
 * 为什么是**独立的显式动作**，而不是「状态改成 resolved 就自动发」：
 *   订阅消息是**不可逆的外部动作** —— 它会消耗用户那一条额度，发出去收不回。
 *   而运营改状态是高频小动作，「补个备注顺手把状态往前挪一格」不应该让
 *   用户手机响一下。所以发送必须由人明确点。
 *
 * ⚠️ 同一张工单**只发一次**（`notify.sentAt` 非空即拒绝）。
 *    重复发送会白白烧掉用户的额度，而他可能只有这一条。
 *    失败不算发出（不写 sentAt），可以重试。
 */
async function notifyTicket(id, body, admin) {
  const t = await findTicket(id);
  const revision = (body && body.revision);
  d.assertRevision(d.revision(t), revision);

  const openid = t.userId || '';
  if (!openid) d.error(400, '这张工单没有可送达的微信身份，无法发送通知');

  if (t.notify && t.notify.sentAt) {
    d.error(409, '该工单已经发送过受理通知，不能重复发送（每发一次都会消耗用户的一条订阅额度）');
  }

  const cfg = await notifyConfig();
  if (!cfg.ok) d.error(503, cfg.reason);

  const sub = await getSub(openid);
  if (!sub || sub.accepted !== true) {
    d.error(400, '该用户当前没有可用的订阅额度（未开启、或额度已用掉），微信不会下发这条通知');
  }

  const at = new Date();
  // 优先用用户**实际授权过的那个**模板（他可能恰好拒了另一个）；
  // 不在白名单里（运营改过配置）就退到第一个 —— 结果里会如实记下用的是哪一个。
  const templateId =
    sub.templateId && cfg.tmplIds.indexOf(sub.templateId) > -1 ? sub.templateId : cfg.tmplIds[0];
  const data = buildTemplateData(cfg, t, at);

  let sent = false;
  let errCode = 0;
  let errMsg = '';

  try {
    const r = await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      page: cfg.page,
      data,
      miniprogramState: cfg.envVersion,
    });
    /**
     * ⚠️ 云调用失败时**不一定抛异常** —— 有的版本把 `errCode` 放在返回值里。
     *    只包一层 try/catch，会把一次失败的发送记成成功：用户收不到，
     *    管理台却显示「已通知」，双方都以为是对方的问题。
     */
    errCode = Number((r && (r.errCode !== undefined ? r.errCode : r.errcode)) || 0);
    errMsg = (r && (r.errMsg || r.errmsg)) || '';
    sent = errCode === 0;
  } catch (e) {
    errCode = Number((e && (e.errCode !== undefined ? e.errCode : e.errcode)) || -1);
    errMsg = (e && (e.errMsg || e.message)) || '发送失败';
    sent = false;
  }

  const result = {
    sentAt: sent ? at.toISOString() : '',
    attemptedAt: at.toISOString(),
    // 失败时保留错误码：它能把「权限没登记（-604101）」与
    // 「用户没有额度（43101）」区分开，处置方式完全不同
    errCode: sent ? 0 : errCode,
    errMsg: sent ? '' : String(errMsg).slice(0, 200),
    templateId,
    by: admin,
  };

  let saved;
  await db.runTransaction(async (tx) => {
    const old = await getDoc(tx, 'feedbacks', t._id);
    if (!old) d.error(404, '工单不存在');
    d.assertRevision(d.revision(old), revision);

    const entry = {
      action: 'ticket.notify',
      admin,
      createdAt: at.toISOString(),
      from: old.status || 'open',
      status: old.status || 'open',
      detail: sent
        ? '已发送受理通知'
        : '受理通知发送失败（' + (errCode || '未知') + '）：' + (result.errMsg || '未知原因'),
    };
    const history = (old.history || []).concat(entry).slice(-100);

    saved = Object.assign({}, old, {
      notify: result,
      history,
      updatedAt: at,
      _admin: { revision: revision + 1, updatedAt: at, updatedBy: admin },
    });
    const write = Object.assign({}, saved);
    delete write._id;
    delete write._openid;
    await tx.collection('feedbacks').doc(t._id).set({ data: write });

    /**
     * 发送成功 = 用户那一条一次性订阅额度已被消耗，同步把订阅记录置为「已用掉」。
     * ⚠️ 记录不存在就**跳过**，不要在这里补建一条 —— 补建会在管理台凭空造出
     *    一份「某用户授权过」的记录，而我们从没收到过他的授权。
     */
    if (sent) {
      const sid = stableIdOf(openid);
      const sdoc = await getDoc(tx, NOTIFY_COLLECTION, sid);
      if (sdoc) {
        const s = Object.assign({}, sdoc, { accepted: false, usedAt: at, usedTicketId: id, updatedAt: at });
        delete s._id;
        delete s._openid;
        await tx.collection(NOTIFY_COLLECTION).doc(sid).set({ data: s });
      }
    }

    await tx.collection('admin_audit').doc('ticket_' + crypto.randomBytes(12).toString('hex')).set({
      data: {
        action: 'ticket.notify',
        target: id,
        admin,
        revision: revision + 1,
        createdAt: at,
        status: sent ? 'sent' : 'failed',
        errCode: sent ? 0 : errCode,
      },
    });
  });

  return Object.assign(ticketView(saved), { notifyResult: result });
}

async function listImages(id) {
  const t = await findTicket(id); const ids = (t.images || []).filter(x => typeof x === 'string' && x.startsWith('cloud://'));
  if (!ids.length) return { list: [] };
  const res = await cloud.getTempFileURL({ fileList: ids.map(fileID => ({ fileID, maxAge: 300 })) });
  return { list: (res.fileList || []).map(x => ({ fileId: x.fileID, url: x.tempFileURL || '', error: x.status ? '截图不可读取' : '' })) };
}
/**
 * GET /admin-api/users —— 用户档案列表
 *
 * 数据来源是 `users` 集合 —— 也就是小程序端 `api` 云函数
 * （`handlers/auth.js` 的 login / `handlers/user.js` 的 updateProfile）
 * 写入的那一份。管理台**不另起一套用户数据**：不复制、不缓存、不聚合，
 * 每次读都是库里的当前值，避免「后台看到的用户」与「小程序里的用户」是两份。
 *
 * ⚠️ 与工单列表同一条纪律：**不返回 openid、不返回未列出的数据库字段**。
 *    注意用户文档里 `openid` 与 `_id` 同时存在，光删 `openid` 是不够的 ——
 *    所以 userView 走的是显式白名单（见其注释）。
 *
 * ⚠️ 列表**不带**成绩档案与收藏（见 userDetailView 的注释），
 *    不是为了藏起来，纯粹是 payload 考量 —— 详情的「查看」里能看到全部。
 *
 * ⚠️ 不为了「界面好看」造演示用户。库里没有就是空态。
 */
async function listUsers(q = {}) {
  const { page, size } = pagination(q);
  const kw = d.text(String(q.keyword || ''), 100, '关键词');
  let condition = {};
  if (kw) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const clauses = ['nickName', 'email', 'city', 'grade'].map(k => ({ [k]: db.RegExp({ regexp: escaped, options: 'i' }) }));
    // 无关键词时用 `{}` 而不是 `_.and([{}, ...])` —— 少一层不必要且易踩坑的构造
    condition = db.command.or(clauses);
  }
  try {
    const query = db.collection('users').where(condition);
    const [count, result] = await Promise.all([
      query.count(),
      db.collection('users').where(condition).orderBy('createdAt', 'desc').skip((page - 1) * size).limit(size).get(),
    ]);
    return { list: (result.data || []).map(userView), total: count.total || 0, page, size };
  } catch (e) {
    // 集合不存在 → 明确告诉运维「先去建集合」，而不是笼统的 500
    throw asCollectionError(e, 'users');
  }
}
async function findUser(id) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) d.error(400, '用户 ID 格式无效');
  let doc;
  try {
    doc = await getDoc(db, 'users', id);
  } catch (e) {
    throw asCollectionError(e, 'users');
  }
  if (!doc) d.error(404, '用户不存在');
  return doc;
}
/** 用户**详情** —— 比列表多出成绩档案与收藏院校 */
async function getUser(id) { return userDetailView(await findUser(id)); }
async function listSchools(q = {}) {
  const doc = await getDoc(db, 'content', 'default'); const patches = (doc && doc.schoolOverrides) || {};
  let list = d.schools.map(s => d.merge(s, patches[s.id] || {}));
  const kw = String(q.keyword || '').trim().toLowerCase(); if (kw) list = list.filter(s => [s.id,s.nameCn,s.nameEn,s.cityCn].join(' ').toLowerCase().includes(kw));
  return { list, total: list.length, revision: d.revision(doc) };
}
async function getSchool(id) { const result = await listSchools(); const school = result.list.find(s => s.id === id); if (!school) d.error(404, '院校不存在'); return { school, revision: result.revision }; }
async function putSchool(id, body, admin) {
  const school = d.validateSchool(id, body.school);
  const result = await publish(body.revision, old => Object.assign({}, old, { schoolOverrides: Object.assign({}, old.schoolOverrides || {}, { [id]: school }) }), body.note, admin, 'school.publish');
  return { school, revision: result.revision };
}
async function auditList() { const res = await db.collection('admin_audit').orderBy('createdAt','desc').limit(50).get(); return { list: (res.data || []).map(x => ({ id:x._id, action:x.action, target:x.target, note:x.note || '', revision:x.revision, admin:x.admin, createdAt:iso(x.createdAt) })) }; }
module.exports = { overview, getContent, putContent, listTickets, getTicket, updateTicket, notifyTicket, listImages, listUsers, getUser, listSchools, getSchool, putSchool, auditList };
