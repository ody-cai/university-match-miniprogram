#!/usr/bin/env node
/**
 * 服务端 handlers 内存 mock 测试台
 * ==================================================================
 * 改动全部落在云函数侧的 `handlers/auth.js` / `handlers/content.js`，
 * 这些模块在加载时就 `require('wx-server-sdk')` 并 `cloud.database()`，
 * 本机没装该 SDK（真实运行只在云端）。本台用 `Module._load` 钩子把
 * `wx-server-sdk` 替换成一份**内存实现**，再 require 真实 handler 源码，
 * 走与线上完全相同的业务逻辑，覆盖以下契约语义：
 *
 *   1. login 建档/取档，并置 activeSession=true
 *   2. session 仅当 activeSession===true 才返回用户，否则返回 null
 *   3. logout 置 activeSession=false（且走独立路由）
 *   4. 并发首次建档：同一 openid 仅产生**一条**用户记录（唯一冲突处理）
 *   5. content：文档/集合不存在（-502005）才返回 {}，其它错误一律抛出
 *   6. content 读取超时（-501002）**不得**成功，必须抛出
 *   7. 响应绝不向客户端泄露 openid
 *   8. 成绩档案（契约 4.3）：未登录可读(null) / 不可写(401)；未填的数值必须是
 *      null 而不是 0；courses 由 coursesMap 派生；越界值与越权字段都进不去
 *   9. 收藏（契约 4.4）：收藏/取消双双幂等且「最近在前」；院校标识只校验格式；
 *      **并发收藏不丢更新**（靠事务）
 *  10. 服务端空档案 EMPTY_ACADEMIC 与内容层 defaultAcademic **字段逐一对齐**
 *      —— 两者对不上不会报错，只会让「重置」之后某块 UI 空掉
 *
 * ⚠️ 不依赖真机、也不 require utils/api.js / feedback.js（它们归别的代理处理）。
 * 用法：node tools/test-cloud-handlers.js
 */
const path = require('path');
const Module = require('module');

const FN_DIR = path.join(__dirname, '..', 'miniprogram', 'cloudfunctions', 'api');

/* ================= 内存 mock 的共享状态 ================= */
function createStore() {
  return {
    collections: {}, // name -> Map<_id, doc>
    seq: 0,
    /** 内容读取故障注入：undefined=正常 | 'timeout' | 'permission' | 'missing' */
    faults: { contentGet: undefined },
  };
}

/* ================= mock wx-server-sdk ================= */
function makeError(code, msg) {
  const e = new Error(msg);
  e.errCode = code;
  e.errMsg = msg;
  return e;
}

function createMockSdk(store) {
  function collection(name) {
    if (!store.collections[name]) store.collections[name] = new Map();
    const map = store.collections[name];

    const col = {
      _where: null,
      _limit: null,
      where(cond) {
        col._where = cond;
        return col;
      },
      limit(n) {
        col._limit = n;
        return col;
      },
      orderBy() {
        return col;
      },
      async count() {
        return { total: map.size };
      },
      async get() {
        // auth 路径：where({openid}).limit(1).get()
        if (col._where && col._where.openid !== undefined) {
          const out = [];
          for (const d of map.values()) {
            if (d.openid === col._where.openid) out.push(d);
          }
          return { data: col._limit ? out.slice(0, col._limit) : out };
        }
        // 兜底：返回全部（本台不依赖此分支）
        return { data: Array.from(map.values()) };
      },
      async add({ data }) {
        // 模拟「普通 -502001 数据库请求失败」（**无** E11000 证据）：
        // 权限/超时等。这种错误必须被 login 如实抛出，绝不能被误判为
        // “唯一冲突”而吞掉、伪装成登录成功。
        if (name === 'users' && store.faults.usersAdd === 'plainFail') {
          throw makeError(-502001, 'database request fail: no permission to operate database');
        }
        const doc = Object.assign({}, data);
        // 复刻 wx 云「唯一键冲突」：errCode -502001 + E11000 duplicate key error。
        if (doc._id && map.has(doc._id)) {
          throw makeError(
            -502001,
            `[FailedOperation.Insert] multiple write errors: [{write errors: ` +
              `[{E11000 duplicate key error collection: x.y index: _id dup key: { : "${doc._id}" }}]}, {}]`
          );
        }
        if (!doc._id) doc._id = 'auto_' + ++store.seq;
        map.set(doc._id, doc);
        return { _id: doc._id };
      },
      doc(id) {
        return {
          async get() {
            if (name === 'content') {
              const fault = store.faults.contentGet;
              if (fault === 'timeout') {
                throw makeError(-501002, 'cloud.callFunction:fail -501002 云端响应超时');
              }
              if (fault === 'permission') {
                throw makeError(-502003, 'database request fail: no permission to operate database');
              }
              // 宽泛码但**无** ResourceNotFound 证据：模拟“套了 -502005 的其它故障”。
              // 必须被 content 如实抛出，不能当成“文档不存在”返回空补丁。
              if (fault === 'broad') {
                throw makeError(-502005, 'database request fail: generic failure without resource info');
              }
            }
            if (map.has(id)) return { data: map.get(id) };
            // 文档/集合不存在：wx 云封装为 -502005 [ResourceNotFound]
            // ⚠️ 措辞按 2026-09-19 云端**实测**原文：
            //    document.get:fail document with _id default does not exist
            //    早期 mock 只写了 'document not exists'，比真实报错窄，
            //    于是漏掉了「空集合导致接口 500」这个真实缺陷。
            if (store.faults.contentMissing === 'legacy') {
              throw makeError(-502005, 'doc.get:fail -502005 [ResourceNotFound] document not exists');
            }
            throw makeError(
              -502005,
              'doc.get:fail document with _id ' + id + ' does not exist'
            );
          },
          async update({ data }) {
            const cur = map.get(id);
            if (!cur) return { stats: { updated: 0 } };
            Object.assign(cur, data);
            map.set(id, cur);
            return { stats: { updated: 1 } };
          },
          async set({ data }) {
            map.set(id, Object.assign({ _id: id }, data));
            return { stats: { updated: 1 } };
          },
          async remove() {
            const existed = map.delete(id);
            return { stats: { removed: existed ? 1 : 0 } };
          },
        };
      },
    };
    return col;
  }

  /**
   * 事务：真实云开发会串行化并自动重试冲突。内存 mock 用一个 promise 锁
   * 模拟「串行执行」。
   * ⚠️ 这个锁是**必要**的近似，不是装饰：不加锁时 5 个并发收藏会各自读到
   *    同一份旧列表、最后只有一个写成功，测试反而会「证明」并发是安全的。
   *    它只保证串行，不模拟真实的重试语义，但对本项目要验的不变量
   *    （并发写入不丢更新）已经足够。
   */
  let txChain = Promise.resolve();
  const db = {
    collection,
    runTransaction(fn) {
      const prev = txChain;
      let release;
      txChain = new Promise((r) => { release = r; });
      return prev.then(
        () => fn({ collection }),
        () => fn({ collection })
      ).then(
        (v) => { release(); return v; },
        (e) => { release(); throw e; }
      );
    },
  };
  return {
    database() {
      return db;
    },
    init() {},
    getWXContext() {
      return { OPENID: store.currentOpenid || '' };
    },
    DYNAMIC_CURRENT_ENV: 'dynamic',
  };
}

/* ================= 注入 mock 后加载真实 handler ================= */
const store = createStore();
const mockSdk = createMockSdk(store);

const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return mockSdk;
  return _origLoad.call(this, request, parent, isMain);
};

const auth = require(path.join(FN_DIR, 'handlers', 'auth.js'));
const content = require(path.join(FN_DIR, 'handlers', 'content.js'));
const user = require(path.join(FN_DIR, 'handlers', 'user.js'));
const academic = require(path.join(FN_DIR, 'handlers', 'academic.js'));
const favorites = require(path.join(FN_DIR, 'handlers', 'favorites.js'));
// ⚠️ notify 必须在这里 require：`Module._load` 上面刚被替换成 mock，
//    出了这段就还原了 —— 在 main 里再 require 会去真实磁盘找 wx-server-sdk 而失败。
const notify = require(path.join(FN_DIR, 'handlers', 'notify.js'));

// 还原，避免影响其它 require（虽然本台之后不再 require）
Module._load = _origLoad;

/* ================= 断言工具 ================= */
let pass = 0;
let fail = 0;
function check(title, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${title}`);
  } else {
    fail++;
    console.log(`  ✗ ${title}${detail !== undefined ? '\n      ' + detail : ''}`);
  }
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}

(async function main() {
  /* ============================================================
     1 · login / session / logout 登录态流转
     ============================================================ */
  head('1 · login → session → logout → session 登录态流转');

  store.collections = {};
  const O1 = 'openid_user_1';

  const rLogin = await auth.login({ openid: O1 });
  check('login 返回 code:0', rLogin.code === 0, JSON.stringify(rLogin));
  check('login 返回 user 对象', !!(rLogin.data && rLogin.data.user), JSON.stringify(rLogin.data));
  check(
    'login 写入 activeSession=true',
    store.collections.users && store.collections.users.values().next().value.activeSession === true
  );

  const rSession1 = await auth.session({ openid: O1 });
  check('登录后 session 返回用户', !!(rSession1.data && rSession1.data.user), JSON.stringify(rSession1.data));
  check('登录后 session 不返回 null', rSession1.data !== null);

  const rLogout = await auth.logout({ openid: O1 });
  check('logout 返回 code:0', rLogout.code === 0, JSON.stringify(rLogout));
  check('logout 响应 data 无内容（契约 4.1）', rLogout.data === null, JSON.stringify(rLogout.data));
  const afterLogout = Array.from(store.collections.users.values()).find((d) => d.openid === O1);
  check('logout 置 activeSession=false', afterLogout && afterLogout.activeSession === false);

  const rSession2 = await auth.session({ openid: O1 });
  check('登出后 session 返回 null（视为未登录）', rSession2.data === null, JSON.stringify(rSession2.data));

  const rLogin2 = await auth.login({ openid: O1 });
  check('再次登录后 session 又返回用户', !!(await auth.session({ openid: O1 })).data);
  check('再次登录不新建用户（仍为 1 条）', store.collections.users.size === 1, '实际 ' + store.collections.users.size);

  /* ============================================================
     2 · 不向客户端泄露 openid
     ============================================================ */
  head('2 · 响应绝不含 openid');

  const wire = JSON.stringify(rLogin2);
  check('login 响应体不含裸 openid 字符串', wire.indexOf(O1) === -1, '命中: ' + wire.indexOf(O1));
  check('user 对象没有 openid 字段', rLogin2.data.user.openid === undefined, JSON.stringify(rLogin2.data.user));
  check(
    'user.id 是哈希而非 openid（不包含原始 openid）',
    rLogin2.data.user.id && rLogin2.data.user.id.indexOf(O1) === -1
  );

  /* ============================================================
     3 · 并发首次建档：同一 openid 仅 1 条记录
     ============================================================ */
  head('3 · 并发首次建档不重复');

  store.collections = {};
  const OX = 'openid_concurrent_x';
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, () => auth.login({ openid: OX }))
  );
  const usersX = Array.from(store.collections.users.values()).filter((d) => d.openid === OX);
  check(`并发 ${N} 次 login 仅建档 1 条`, usersX.length === 1, '实际 ' + usersX.length);
  const ids = new Set(results.map((r) => r.data && r.data.user && r.data.user.id));
  check('所有并发返回的用户 id 一致', ids.size === 1, '不同 id 数: ' + ids.size);
  check('建档记录 activeSession=true', usersX[0] && usersX[0].activeSession === true);

  /* ============================================================
     3b · 普通 -502001（无 E11000）不得被误判为唯一冲突吞掉
     ============================================================ */
  head('3b · 普通 -502001 写入失败不得被吞');

  store.collections = {};
  store.faults.usersAdd = 'plainFail'; // add 抛 -502001 但消息无 E11000
  let loginThrew = false;
  try {
    await auth.login({ openid: 'openid_perm_fail' });
  } catch (e) {
    loginThrew = e && e.errCode === -502001 && !/E11000|duplicate key/i.test(e.errMsg || '');
  }
  store.faults.usersAdd = undefined;
  const permUsers = Array.from(store.collections.users.values()).filter(
    (d) => d.openid === 'openid_perm_fail'
  );
  check('普通 -502001 被如实抛出（未当成唯一冲突吞掉）', loginThrew);
  check('普通 -502001 失败时**未**建档（不伪装成功）', permUsers.length === 0, '实际 ' + permUsers.length);

  /* ============================================================
     4 · content：仅文档不存在返回 {}，其它抛出
     ============================================================ */
  head('4 · content 错误处理');

  store.collections = {};
  store.faults.contentGet = undefined; // 文档不存在
  const cEmpty = await content.get();
  check('文档不存在（-502005）返回 {} ', cEmpty.code === 0 && JSON.stringify(cEmpty.data) === '{}', JSON.stringify(cEmpty));

  // 4b · 两种「不存在」措辞都必须被当成空状态
  //   回归背景：正则曾只匹配 `not exists`，而云端空集合实际抛的是
  //   `document with _id default does not exist` → 接口固定 500，
  //   客户端静默回落默认值，表现为「后台改了但线上没变」，无法排查。
  store.faults.contentMissing = 'legacy';
  const cLegacy = await content.get();
  check(
    '措辞 document not exists 可识别为空状态',
    cLegacy.code === 0 && JSON.stringify(cLegacy.data) === '{}',
    JSON.stringify(cLegacy)
  );
  store.faults.contentMissing = undefined;
  const cModern = await content.get();
  check(
    '措辞 does not exist（线上实测原文）可识别为空状态，不得 500',
    cModern.code === 0 && JSON.stringify(cModern.data) === '{}',
    JSON.stringify(cModern)
  );

  // 放一份真实内容
  store.collections.content = new Map();
  store.collections.content.set('default', {
    _id: 'default',
    _openid: 'creator',
    home: { season: '2026 Fall' },
    featureFlags: { beta: true },
    version: '1.2.3',
  });
  const cReal = await content.get();
  check('存在内容时返回补丁', cReal.code === 0 && cReal.data.home && cReal.data.home.season === '2026 Fall');
  check('返回剥离了 _id / _openid 元字段', cReal.data._id === undefined && cReal.data._openid === undefined, JSON.stringify(cReal.data));

  // 权限错误必须抛出（不得吞掉）
  store.faults.contentGet = 'permission';
  let threwPerm = false;
  try {
    await content.get();
  } catch (e) {
    threwPerm = e && e.errCode === -502003;
  }
  check('权限错误（-502003）被抛出而非返回 {}', threwPerm);

  // 宽泛码 -502005 但**无** ResourceNotFound 证据：必须抛出，不能当文档不存在
  store.faults.contentGet = 'broad';
  let threwBroad = false;
  try {
    await content.get();
  } catch (e) {
    threwBroad = e && e.errCode === -502005 && !/ResourceNotFound|document not exists|not exists/i.test(e.errMsg || '');
  }
  check('宽泛 -502005（无 ResourceNotFound 证据）被抛出而非返回 {}', threwBroad);

  /* ============================================================
     5 · content 超时不得成功（核心不变量）
     ============================================================ */
  head('5 · content 读取超时不得成功');

  store.faults.contentGet = 'timeout';
  let threwTimeout = false;
  let timeoutResult = null;
  try {
    timeoutResult = await content.get();
  } catch (e) {
    threwTimeout = e && e.errCode === -501002;
  }
  check('超时（-501002）被抛出', threwTimeout, 'errCode 见捕获');
  check(
    '超时**绝不**被伪装成成功（不得返回 ok({})）',
    !(timeoutResult && timeoutResult.code === 0),
    timeoutResult ? JSON.stringify(timeoutResult) : '（已抛出，符合预期）'
  );

  /* ============================================================
     6 · 个人资料（user.profile / user.updateProfile）
     ============================================================
     这两个端点此前根本没登记进 ROUTES，云开发路线上一直 501 → 客户端
     静默回落本地。页面却写着「资料会同步到你的账号」—— 补上后必须验的不是
     「能存」，而是几件**存错了也不会报错**的事：越权、白名单、码点计数、
     本机临时头像路径。
     注：本节的 openid 用独立的 O6，避免与前面 1–3b 的登录态互相干扰。 */
  head('6 · 个人资料读写（契约 4.2）');

  const O6 = 'openid_profile_1';

  // 6.1 未登录：GET 返回 null（不 401，账号页据此渲染「登录后同步数据」）
  const beforeLogin = await user.profile({ openid: O6 });
  check('未登录 GET profile 返回 data:null 而不是报错', beforeLogin.code === 0 && beforeLogin.data === null, JSON.stringify(beforeLogin));

  // 6.2 未登录：PUT 必须 401，且**不得**写出任何档案
  let putUnauth = null;
  try {
    await user.updateProfile({ openid: O6, data: { nickName: '陌生人' } });
    putUnauth = 'NO-THROW';
  } catch (e) {
    putUnauth = e.bizCode;
  }
  check('未登录 PUT profile 抛 401（不静默建了一个没人认领的档案）', putUnauth === 401, String(putUnauth));
  const afterUnauth = await user.profile({ openid: O6 });
  check('被拒的写入没有落库', afterUnauth.data === null);

  // 6.3 登录后：GET 返回契约字段，且不含 openid
  await auth.login({ openid: O6 });
  const p1 = await user.profile({ openid: O6 });
  const u1 = p1.data || {};
  check('登录后可读档案', p1.code === 0 && !!u1.id);
  check(
    '字段与契约 4.2 一致（昵称/头像/邮箱/年级/城市/创建时间）',
    ['id', 'nickName', 'avatarUrl', 'email', 'plan', 'grade', 'city', 'createdAt', 'updatedAt'].every((k) => k in u1),
    Object.keys(u1).join(', ')
  );
  check('响应不含 openid（契约 5 节）', JSON.stringify(p1).indexOf(O6) === -1);
  check('新档不预置任何身份信息', !u1.nickName && !u1.email && !u1.plan && !u1.grade && !u1.city);

  // 6.4 部分更新：只传 city，其它字段一个都不许动
  await user.updateProfile({ openid: O6, data: { nickName: '张三', grade: '高三' } });
  const rPartial = await user.updateProfile({ openid: O6, data: { city: '深圳' } });
  check(
    '部分更新只改传了的字段',
    rPartial.data.city === '深圳' && rPartial.data.nickName === '张三' && rPartial.data.grade === '高三',
    JSON.stringify({ city: rPartial.data.city, nickName: rPartial.data.nickName, grade: rPartial.data.grade })
  );
  check('updatedAt 被刷新成 ISO 字符串', /^\d{4}-\d{2}-\d{2}T/.test(rPartial.data.updatedAt), rPartial.data.updatedAt);

  // 6.5 白名单：客户端传了无权改的字段要**被忽略**（不是报错、更不是写进去）
  const rPriv = await user.updateProfile({
    openid: O6,
    data: { plan: '旗舰版', openid: 'openid_hacker', activeSession: false, _id: 'x', createdAt: '2000-01-01', city: '广州' },
  });
  check('越权字段被忽略（plan 不被客户端改写）', rPriv.data.plan === '', JSON.stringify(rPriv.data.plan));
  check('越权字段被忽略（_id / createdAt 不变）', rPriv.data.id === u1.id && rPriv.data.createdAt === u1.createdAt);
  check('同一请求里合法字段照常生效', rPriv.data.city === '广州');

  // 6.6 校验：昵称必填、按**码点**计长度
  let eEmpty = null;
  try {
    await user.updateProfile({ openid: O6, data: { nickName: '   ' } });
  } catch (e) {
    eEmpty = e.bizCode;
  }
  check('昵称被清空时拒绝（400）', eEmpty === 400, String(eEmpty));

  // 20 个 emoji = 20 个码点、40 个 UTF-16 码元。用 str.length 判会误报超限。
  const rEmoji = await user.updateProfile({ openid: O6, data: { nickName: '🙂'.repeat(20) } });
  check('20 个 emoji 的昵称按码点计是合法的', rEmoji.code === 0, JSON.stringify(rEmoji.message || '').slice(0, 60));
  let eLong = null;
  try {
    await user.updateProfile({ openid: O6, data: { nickName: '🙂'.repeat(21) } });
  } catch (e) {
    eLong = e.bizCode;
  }
  check('21 个码点 → 400（长度口径与客户端 maxlength 一致）', eLong === 400, String(eLong));

  // 6.7 校验：邮箱格式
  let eMail = null;
  try {
    await user.updateProfile({ openid: O6, data: { email: 'abc@' } });
  } catch (e) {
    eMail = e.bizCode;
  }
  check('邮箱格式非法 → 400', eMail === 400, String(eMail));
  const rMail = await user.updateProfile({ openid: O6, data: { email: '  a@b.co  ' } });
  check('合法邮箱通过并去掉首尾空格', rMail.data.email === 'a@b.co', rMail.data.email);

  // 6.8 头像地址：必须挡住本机临时路径
  let eTmp = null;
  try {
    await user.updateProfile({ openid: O6, data: { avatarUrl: 'wxfile://usr/avatar_a.png' } });
  } catch (e) {
    eTmp = e.bizCode;
  }
  check('wxfile:// 临时路径被拒绝（存进去就是换设备即裂图）', eTmp === 400, String(eTmp));
  let eHttpTmp = null;
  try {
    await user.updateProfile({ openid: O6, data: { avatarUrl: 'http://tmp/x.png' } });
  } catch (e) {
    eHttpTmp = e.bizCode;
  }
  check('http://tmp/... 同样被拒绝', eHttpTmp === 400, String(eHttpTmp));
  const rCloud = await user.updateProfile({
    openid: O6,
    data: { avatarUrl: 'cloud://<cloud-env-id>.636c/avatar/1-a.png' },
  });
  check('cloud:// fileID 通过（云开发路线返回的就是它）', /^cloud:\/\//.test(rCloud.data.avatarUrl), rCloud.data.avatarUrl);

  // 6.9 空 patch：不写库、不报错，原样返回当前资料
  const rNoop = await user.updateProfile({ openid: O6, data: { 无关字段: 1 } });
  check(
    '只传无权字段时按「没有改动」处理：不报错、返回当前资料',
    rNoop.code === 0 && rNoop.data.email === 'a@b.co' && /^cloud:\/\//.test(rNoop.data.avatarUrl),
    JSON.stringify({ email: rNoop.data.email, avatarUrl: rNoop.data.avatarUrl })
  );

  // 6.10 越权确认：另一个 openid 读不到别人的资料
  const O6b = 'openid_profile_2';
  await auth.login({ openid: O6b });
  const other = await user.profile({ openid: O6b });
  check('另一个身份读到的是自己的空档，拿不到他人资料', other.data && other.data.id !== u1.id && !other.data.city, JSON.stringify(other.data && other.data.city));

  /* ============================================================
     7 · 成绩档案（契约 4.3）
     ============================================================
     这组端点此前根本没登记进 ROUTES，云开发路线上一直 501 → 客户端静默
     回落本地。于是「换台手机成绩就没了」在真机上没有任何提示。
     补上后要验的不是「能存」，而是几件**存错了也不会报错**的事：
     未填被折成 0、courses 与 coursesMap 漂移、越权字段混进档案、越界值入库。
     注：openid 用独立的 O7 / O7b，避免与前几节的登录态互相干扰。 */
  head('7 · 成绩档案读写（契约 4.3）');

  const O7 = 'openid_academic_1';

  async function bizCodeOf(fn) {
    try {
      await fn();
      return 'NO-THROW';
    } catch (e) {
      return e.bizCode || e.message;
    }
  }

  // 7.1 未登录 GET → null（不 401，页面据此回落本机缓存）
  const aBefore = await academic.profile({ openid: O7 });
  check('未登录 GET 返回 data:null 而不是报错', aBefore.code === 0 && aBefore.data === null, JSON.stringify(aBefore));

  // 7.2 未登录 PUT → 401，且**不得**写出任何档案
  const aPutUnauth = await bizCodeOf(() => academic.save({ openid: O7, data: { gpa: 90 } }));
  check('未登录 PUT 抛 401（不写没人认领的孤儿档案）', aPutUnauth === 401, String(aPutUnauth));
  check('被拒的写入没有落库', (await academic.profile({ openid: O7 })).data === null);

  // 7.3 登录后、从未填写 → 仍然是 null（「没填过」≠「填了一份空的」）
  await auth.login({ openid: O7 });
  const aAfterLogin = await academic.profile({ openid: O7 });
  check('登录后从未填写仍是 null，不凭空返回一份空档案', aAfterLogin.code === 0 && aAfterLogin.data === null, JSON.stringify(aAfterLogin));

  // 7.4 保存后读回；courses 必须是 coursesMap 的派生值
  const aSaved = await academic.save({
    openid: O7,
    data: {
      curriculum: 'AP',
      coursesMap: { AP: [{ name: 'AP Calculus BC', date: '2026 年 5 月统考', score: 5, max: 5 }] },
      gpa: 86,
      ielts: { overall: 5.0, l: 4.5, r: 4.5, w: 5.5, s: 5.0 },
      countries: ['ca', 'au'],
      majors: ['cs'],
    },
  });
  check('保存返回完整档案且均分正确', aSaved.code === 0 && aSaved.data.gpa === 86, JSON.stringify(aSaved).slice(0, 160));
  check('courses 由 coursesMap 派生（镜像不与真源漂移）', aSaved.data.courses.length === 1 && aSaved.data.courses[0].name === 'AP Calculus BC');
  check('雅思单项原样保留', aSaved.data.ielts.l === 4.5 && aSaved.data.ielts.s === 5.0);
  check('updatedAt 由服务端盖章为 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(aSaved.data.updatedAt), aSaved.data.updatedAt);

  const aReread = await academic.profile({ openid: O7 });
  check('重新读取拿到同一份', aReread.data.gpa === 86 && aReread.data.countries.join(',') === 'ca,au');
  check('响应不含 openid（契约 5 节）', JSON.stringify(aReread).indexOf(O7) === -1);

  // 7.5 未填的数值必须是 null，绝不能折成 0
  const aEmptyVals = await academic.save({ openid: O7, data: { gpa: null, ielts: null, toefl: null, sat: null } });
  check('未填的均分是 null 而不是 0', aEmptyVals.data.gpa === null, String(aEmptyVals.data.gpa));
  check('未填的语言成绩是 null 而不是一条 0 分记录', aEmptyVals.data.ielts === null && aEmptyVals.data.toefl === null);
  check('coursesMap 四个体系键恒存在（前端不必判 undefined）', ['AP', 'AL', 'IB', 'NONE'].every((k) => Array.isArray(aEmptyVals.data.coursesMap[k])));

  // 7.6 越界与类型：写进库里会污染匹配引擎，且不会报错，必须在入口挡住
  const badCases = [
    ['均分越界 120', { gpa: 120 }],
    ['均分 0（0 分不是合法均分）', { gpa: 0 }],
    ['雅思总分越界 9.5', { ielts: { overall: 9.5 } }],
    ['托福越界 130', { toefl: 130 }],
    ['目标国家不是数组', { countries: 'ca' }],
    ['科目缺名字', { coursesMap: { AP: [{ score: 5, max: 5 }] } }],
    ['科目得分不是数字', { coursesMap: { AP: [{ name: 'X', score: '满分' }] } }],
  ];
  for (const [label, data] of badCases) {
    const code = await bizCodeOf(() => academic.save({ openid: O7, data }));
    check(label + ' → 400', code === 400, String(code));
  }

  // 7.7 SAT 上限取 2400：旧分制（1600 制之前）仍有学生在用
  const aSat = await academic.save({ openid: O7, data: { sat: 2200 } });
  check('SAT 2200（旧分制）被接受，不被判非法', aSat.code === 0 && aSat.data.sat === 2200, JSON.stringify(aSat.data && aSat.data.sat));

  // 7.8 越权字段不得混进档案
  const aPriv = await academic.save({ openid: O7, data: { gpa: 90, openid: 'openid_hacker', _id: 'x', activeSession: false } });
  check(
    '未列出的字段不进入档案（openid / _id / activeSession）',
    aPriv.data.openid === undefined && aPriv.data._id === undefined && aPriv.data.activeSession === undefined,
    Object.keys(aPriv.data).join(',')
  );

  // 7.9 重置回到初始态
  const aReset = await academic.reset({ openid: O7 });
  check(
    '重置后回到初始态（均分空、收藏国家空、科目清空）',
    aReset.data.gpa === null && aReset.data.countries.length === 0 && aReset.data.coursesMap.AP.length === 0,
    JSON.stringify({ gpa: aReset.data.gpa, c: aReset.data.countries })
  );
  const aResetUnauth = await bizCodeOf(() => academic.reset({ openid: 'openid_never_logged_in_at_all' }));
  check('未登录 reset → 401', aResetUnauth === 401, String(aResetUnauth));

  // 7.10 成绩写入不得影响同文档里的个人资料
  const profAfterAcademic = await user.profile({ openid: O7 });
  check('写成绩不影响同文档的个人资料', !!(profAfterAcademic.data && profAfterAcademic.data.id), JSON.stringify(profAfterAcademic.data && profAfterAcademic.data.id));

  // 7.11 越权：另一个身份读不到
  const O7b = 'openid_academic_2';
  await auth.login({ openid: O7b });
  const aOther = await academic.profile({ openid: O7b });
  check('另一个身份读到自己空档，拿不到他人成绩', aOther.data === null, JSON.stringify(aOther.data));

  /* ============================================================
     8 · 收藏（契约 4.4）
     ============================================================
     同样是从「⛔ 仅本地」变成「已上云」。这里要验的重点：
       · null 与 {ids:[]} 必须分开（客户端同步逻辑靠它决定推还是拉）；
       · 收藏 / 取消**双双幂等**（远端适配器曾经只发 POST，取消永远不生效）；
       · **并发写入不丢更新** —— 「读列表→改→写回」在并发下会静默丢收藏，
         靠服务端事务兜住。
     */
  head('8 · 收藏读写（契约 4.4）');

  const O8 = 'openid_fav_1';

  // 8.1 未登录 GET → null，**不是** {ids: []}
  const fBefore = await favorites.list({ openid: O8 });
  check('未登录 GET 返回 data:null（不是空数组）', fBefore.code === 0 && fBefore.data === null, JSON.stringify(fBefore));

  // 8.2 未登录写 → 401
  const fUnauth = await bizCodeOf(() => favorites.add({ openid: O8, params: { schoolId: 'ubc' } }));
  check('未登录收藏 → 401', fUnauth === 401, String(fUnauth));

  // 8.3 登录后、从未同步过 → 仍是 null，与「收藏为空」严格区分
  await auth.login({ openid: O8 });
  const fAfterLogin = await favorites.list({ openid: O8 });
  check('登录后从未同步过仍是 null（与「一所都没收藏」区分开）', fAfterLogin.data === null, JSON.stringify(fAfterLogin.data));

  // 8.4 收藏与顺序
  const f1 = await favorites.add({ openid: O8, params: { schoolId: 'ubc' } });
  check('收藏返回 favorite:true 与完整列表', f1.data.favorite === true && f1.data.ids.join(',') === 'ubc', JSON.stringify(f1.data));
  const f2 = await favorites.add({ openid: O8, params: { schoolId: 'toronto' } });
  check('最近收藏在前（与本地 unshift 同序）', f2.data.ids.join(',') === 'toronto,ubc', f2.data.ids.join(','));

  // 8.5 幂等：重复收藏仍返回 favorite:true（客户端直接拿它渲染星标）
  const f2again = await favorites.add({ openid: O8, params: { schoolId: 'toronto' } });
  check('重复收藏幂等：仍返回 favorite:true 且列表不重复', f2again.data.favorite === true && f2again.data.ids.length === 2, JSON.stringify(f2again.data.ids));

  // 8.6 取消与幂等
  const f3 = await favorites.remove({ openid: O8, params: { schoolId: 'ubc' } });
  check('取消收藏返回 favorite:false 且列表已移除', f3.data.favorite === false && f3.data.ids.join(',') === 'toronto', JSON.stringify(f3.data));
  const f3again = await favorites.remove({ openid: O8, params: { schoolId: 'ubc' } });
  check('重复取消幂等', f3again.data.favorite === false && f3again.data.ids.join(',') === 'toronto', JSON.stringify(f3again.data.ids));

  // 8.7 GET 与写入结果一致，且不下发内部字段
  const fList = await favorites.list({ openid: O8 });
  check('GET 与写入结果一致', fList.data.ids.join(',') === 'toronto', fList.data.ids.join(','));
  check('updatedAt 是 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(fList.data.updatedAt), fList.data.updatedAt);
  check('响应不含 openid', JSON.stringify(fList).indexOf(O8) === -1);
  check(
    '响应只含契约字段（不含 _id / favoritesUpdatedAt）',
    fList.data._id === undefined && fList.data.favoritesUpdatedAt === undefined,
    Object.keys(fList.data).join(',')
  );

  // 8.8 院校标识只校验**格式**（不校验存在性，避免再引入一份院校清单）
  for (const bad of ['', 'a b', '../../etc/passwd', 'x'.repeat(65)]) {
    const code = await bizCodeOf(() => favorites.add({ openid: O8, params: { schoolId: bad } }));
    check('非法院校标识 ' + JSON.stringify(String(bad).slice(0, 18)) + ' → 400', code === 400, String(code));
  }
  const fOk = await favorites.add({ openid: O8, params: { schoolId: 'a-legal_ID-9' } });
  check('合法字符集（字母/数字/下划线/连字符）被接受', fOk.code === 0, JSON.stringify(fOk.message || ''));

  // 8.9 并发写入不丢更新 —— 全局「读-改-写」的经典缺陷，必须靠事务兜住
  await favorites.remove({ openid: O8, params: { schoolId: 'toronto' } });
  await favorites.remove({ openid: O8, params: { schoolId: 'a-legal_ID-9' } });
  const burst = ['b1', 'b2', 'b3', 'b4', 'b5'];
  await Promise.all(burst.map((id) => favorites.add({ openid: O8, params: { schoolId: id } })));
  const fBurst = await favorites.list({ openid: O8 });
  check(
    '并发收藏 5 所全部保留（事务防丢更新）',
    fBurst.data.ids.length === 5 && burst.every((i) => fBurst.data.ids.indexOf(i) > -1),
    fBurst.data.ids.join(',')
  );

  // 8.10 收藏写入不得影响同文档的资料与成绩
  const profAfterFav = await user.profile({ openid: O8 });
  check('写收藏不影响同文档的个人资料', !!(profAfterFav.data && profAfterFav.data.id));
  check('写收藏不影响同文档的成绩档案', (await academic.profile({ openid: O8 })).data === null);

  // 8.11 越权：另一个身份读不到
  const O8b = 'openid_fav_2';
  await auth.login({ openid: O8b });
  const fOther = await favorites.list({ openid: O8b });
  check('另一个身份看到 null，拿不到他人收藏', fOther.data === null, JSON.stringify(fOther.data));

  /* ============================================================
     9 · 服务端空档案与内容层默认档案逐字段对齐
     ============================================================
     两处对不上**不会报错**，只会让「重置成绩」之后某一块 UI 空掉
     （例如少了 coursesMap 的某个体系键，页面就不渲染那一组科目）。
     这类漂移靠人眼看不出来，所以用它来守。
     ⚠️ lib/academic.js 不依赖 SDK，可直接 require。 */
  head('9 · 服务端空档案 ⇄ 内容层默认档案');

  const EMPTY = require(path.join(FN_DIR, 'lib', 'academic.js')).EMPTY_ACADEMIC;
  const DEFAULT_ACADEMIC = require(path.join(FN_DIR, '..', '..', 'data', 'content.js')).defaultAcademic;

  const emptyKeys = Object.keys(EMPTY).sort().join(',');
  const defaultKeys = Object.keys(DEFAULT_ACADEMIC).sort().join(',');
  check(
    '字段集合逐一对齐',
    emptyKeys === defaultKeys,
    '服务端: ' + emptyKeys + '\n      内容层: ' + defaultKeys
  );
  check(
    'coursesMap 的体系键一致',
    Object.keys(EMPTY.coursesMap).sort().join(',') === Object.keys(DEFAULT_ACADEMIC.coursesMap).sort().join(','),
    Object.keys(EMPTY.coursesMap).join(',') + ' vs ' + Object.keys(DEFAULT_ACADEMIC.coursesMap).join(',')
  );
  check('服务端空档案的均分是 null（不是 0 或示例值）', EMPTY.gpa === null, String(EMPTY.gpa));
  check('服务端空档案的目标国家 / 专业是空数组', EMPTY.countries.length === 0 && EMPTY.majors.length === 0);

  /* ============================================================
     11 · 订阅消息（契约 4.9）
     ------------------------------------------------------------
     这一节的判据全在「**不要把不知道说成没有**」这条线上：
     未订阅（null）、订阅过但已用掉、拿不到微信身份，是三种不同的事，
     页面上也是三句不同的话。服务端要是把它们合并，客户端就没法区分。
     ============================================================ */
  head('11 · 订阅消息 —— GET / PUT /v1/notify');

  // ⚠️ 必须复位上一节注入的 content 读取故障：否则本节凡是要读模板白名单的
  //    用例都会撞上「云端响应超时」，表现为一个莫名其妙的非 400 返回值。
  store.faults.contentGet = undefined;
  store.faults.contentMissing = undefined;

  const crypto = require('crypto');

  /** handler 用 `throw bizError(...)` 表达业务错误，折成 code 便于断言 */
  async function codeOf(p) {
    try {
      const r = await p;
      return r && r.code;
    } catch (e) {
      return e && e.bizCode;
    }
  }

  // 内容层白名单（模拟运营已在管理台配好一个模板）
  const contentBackup = store.collections.content;
  store.collections.content = new Map([
    ['default', { _id: 'default', notify: { enabled: true, tmplIds: ['tmpl-ok'] } }],
  ]);

  const NO = 'openid_notify_1';

  const rGet0 = await notify.get({ openid: NO });
  check('从未订阅时 GET 返回 code:0 + data:null', rGet0.code === 0 && rGet0.data === null, JSON.stringify(rGet0));

  const rNoId = await notify.get({ openid: '' });
  check(
    '拿不到微信身份时 GET 仍是 data:null（不是 401 —— 别把唯一有用的入口挡掉）',
    rNoId.code === 0 && rNoId.data === null,
    JSON.stringify(rNoId)
  );

  check(
    "accepted 传字符串 'true' 被拒绝（**不静默转换**）",
    (await codeOf(notify.save({ openid: NO, data: { accepted: 'true', templateId: 'tmpl-ok' } }))) === 400
  );
  check('accepted 缺失被拒绝', (await codeOf(notify.save({ openid: NO, data: {} }))) === 400);
  check('accepted 传 1 被拒绝', (await codeOf(notify.save({ openid: NO, data: { accepted: 1 } }))) === 400);
  check('没有微信身份时 PUT 被拒绝（400，不是静默写入孤儿文档）', (await codeOf(notify.save({ openid: '', data: { accepted: true, templateId: 'tmpl-ok' } }))) === 400);
  check('缺 templateId 被拒绝', (await codeOf(notify.save({ openid: NO, data: { accepted: true } }))) === 400);
  check(
    'templateId 不在内容层白名单时被拒绝（无法核对的模板不放行）',
    (await codeOf(notify.save({ openid: NO, data: { accepted: true, templateId: 'tmpl-not-listed' } }))) === 400
  );

  const rOk = await notify.save({ openid: NO, data: { accepted: true, templateId: 'tmpl-ok' } });
  check('授权写入成功', rOk.code === 0 && rOk.data.accepted === true, JSON.stringify(rOk));
  check(
    '授权后 GET 返回 accepted:true（页面据此显示「已开启」）',
    (await notify.get({ openid: NO })).data.accepted === true
  );
  check('对外对象不含 openid', rOk.data.openid === undefined);
  check('对外对象不含 _id', rOk.data._id === undefined);

  // 模拟后台发送成功、额度被消耗
  const sid = crypto.createHash('sha256').update('openid:' + NO).digest('hex');
  const sdoc = store.collections.notify_subs.get(sid);
  check('订阅记录按 sha256(openid:) 作 _id 存（与 users 同构）', !!sdoc, sid.slice(0, 12) + '…');
  sdoc.accepted = false;
  sdoc.usedAt = new Date();
  sdoc.usedTicketId = 'fb_probe_ticket';
  const rUsed = await notify.get({ openid: NO });
  check(
    '额度被消耗后 GET 返回 accepted:false + usedAt（页面显示「已使用」而不是「未开启」）',
    rUsed.data.accepted === false && !!rUsed.data.usedAt,
    JSON.stringify(rUsed.data)
  );
  check('usedTicketId 原样下发（用户能对上号）', rUsed.data.usedTicketId === 'fb_probe_ticket');

  const rOff = await notify.save({ openid: NO, data: { accepted: false } });
  check('用户主动关闭返回 accepted:false', rOff.code === 0 && rOff.data.accepted === false);
  check(
    '**主动关闭清空 usedAt**（否则状态推导会判成「已用掉」，把用户的动作说反）',
    rOff.data.usedAt === '',
    JSON.stringify(rOff.data)
  );
  check('主动关闭清空 usedTicketId', rOff.data.usedTicketId === '');
  check('主动关闭后 acceptedAt 也清空（回到初始态）', rOff.data.acceptedAt === '');

  // 重新授权：accepted 重新为 true
  const rAgain = await notify.save({ openid: NO, data: { accepted: true, templateId: 'tmpl-ok' } });
  check('关闭后可以重新授权', rAgain.code === 0 && rAgain.data.accepted === true);

  // 白名单为空 → 拒绝记录（不能放行一个我们核对不了的模板）
  store.collections.content = new Map([['default', { _id: 'default', notify: { enabled: true, tmplIds: [] } }]]);
  check(
    '内容层白名单为空时拒绝授权（能力没配好就不该记成「已开启」）',
    (await codeOf(notify.save({ openid: 'openid_notify_2', data: { accepted: true, templateId: 'tmpl-ok' } }))) === 400
  );

  // 内容文档不存在 → 同样没有白名单（不是崩溃）
  store.collections.content = new Map();
  check(
    '内容文档不存在时是「没有白名单」而不是 500',
    (await codeOf(notify.save({ openid: 'openid_notify_3', data: { accepted: true, templateId: 'tmpl-ok' } }))) === 400
  );

  store.collections.content = contentBackup;

  /* ============================================================ */
  console.log('\n' + '─'.repeat(64));
  console.log(`断言：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
  console.log('─'.repeat(64));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n测试台自身异常：', e);
  process.exit(2);
});
