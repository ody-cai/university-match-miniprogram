#!/usr/bin/env node
/**
 * 跨设备云同步（成绩档案 / 收藏）行为测试台
 * ==================================================================
 * 被测对象是 `miniprogram/utils/api.js` 里的**登录同步决策逻辑**。
 * 这部分代码的特点是：**每个分支都只在特定状态下才被执行** ——
 * 静态读代码看不出对错，跑起来才会发现
 * 「换设备登录时本机数据被清空了」或「用户取消的收藏又回来了」。
 *
 * 本台的做法：mock 掉 wx（Storage + 云函数调用），并实现一个**极简的
 * 虚拟服务端**，然后驱动**真实的** api.js / store.js / request.js 跑完整场景。
 *
 * ⚠️ 边界说明（重要）：虚拟服务端**不是**被测对象，它只负责给出契约意义上的
 *    合理响应。服务端自己的行为（字段白名单、越界校验、事务并发、
 *    未登录的 401/null 语义）由 `tools/test-cloud-handlers.js` 覆盖。
 *    本台只回答一个问题：
 *    **客户端在「云端是这样、本机是那样」的时候，做对了没有。**
 *
 * 覆盖的场景（每条都对应一个会丢数据或泄露数据的具体错误）：
 *   1. 换设备登录：云端有、本机干净        → 云端覆盖本机
 *   2. 先试用后登录：云端空、本机有内容    → 本机上传（不丢）
 *   3. 本机数据属于另一个账号              → 云端覆盖，不把 A 的数据带给 B
 *   4. 本机有未推送的改动（dirty）         → 本机为准，且云端同步成同一份
 *   5. 云端读不到（网络失败）              → 本机一个字节都不动
 *   6. 登录后保存成绩                      → 云端与本机同时有
 *   7. 未登录时的收藏                      → 只在本机 + 标 dirty，登录后补传
 *   8. 取消收藏发出的必须是 DELETE         → 旧缺陷：远端只发 POST，取消永不生效
 *   9. 连点多次保存                        → 不产生乱序覆盖（单飞 + 合并）
 *  10. 本地模式（没配后端）                → 零网络调用，行为完全不变
 *
 * 用法：node tools/test-cloud-sync.js
 */
const path = require('path');

const PROJECT = path.join(__dirname, '..', 'miniprogram');

/* ==================================================================
   虚拟服务端
   ================================================================== */
function createCloud() {
  const state = {
    account: 'acc-A',
    users: {}, // account -> { academic, favorites }
    calls: [],
    stats: {},
    /** 故障注入：null | { mode:'network'|'501'|'code', code?:number, match?:RegExp } */
    fail: null,
  };

  const user = () => {
    if (!state.users[state.account]) state.users[state.account] = { academic: null, favorites: null };
    return state.users[state.account];
  };
  const bump = (k) => {
    state.stats[k] = (state.stats[k] || 0) + 1;
  };
  const profileOf = (id) => ({
    id,
    nickName: '',
    avatarUrl: '',
    email: '',
    plan: '',
    grade: '',
    city: '',
    createdAt: '',
    updatedAt: '',
  });

  function respond(req) {
    const p = req.path;
    const m = req.method;
    const u = user();

    if (m === 'POST' && p === '/v1/auth/login') {
      return { code: 0, message: '', data: { token: '', expiresIn: 0, user: profileOf(state.account) } };
    }
    if (m === 'GET' && p === '/v1/auth/session') {
      return { code: 0, message: '', data: { user: profileOf(state.account) } };
    }

    if (p === '/v1/academic/profile') {
      if (m === 'GET') return { code: 0, message: '', data: u.academic };
      if (m === 'PUT') {
        const next = Object.assign({}, req.data || {});
        delete next.updatedAt; // 与真实服务端一致：时间戳由服务端盖章
        u.academic = Object.assign(next, { updatedAt: new Date().toISOString() });
        bump('academicPut');
        return { code: 0, message: '', data: u.academic };
      }
    }
    if (m === 'POST' && p === '/v1/academic/profile/reset') {
      u.academic = null;
      return { code: 0, message: '', data: null };
    }

    if (m === 'GET' && p === '/v1/favorites') {
      return {
        code: 0,
        message: '',
        data: u.favorites === null ? null : { ids: u.favorites.slice(), updatedAt: new Date().toISOString() },
      };
    }
    const fav = /^\/v1\/favorites\/(.+)$/.exec(p);
    if (fav) {
      const id = decodeURIComponent(fav[1]);
      if (u.favorites === null) u.favorites = [];
      if (m === 'POST') {
        bump('favPost');
        u.favorites = [id].concat(u.favorites.filter((x) => x !== id));
      } else if (m === 'DELETE') {
        bump('favDelete');
        u.favorites = u.favorites.filter((x) => x !== id);
      }
      return { code: 0, message: '', data: { id, favorite: m === 'POST', ids: u.favorites.slice() } };
    }

    return { code: 501, message: '该接口尚未在云端实现', data: null };
  }

  return {
    state,
    /** 清空请求统计（用于「这一段里到底发了几次」的断言） */
    resetCounters() {
      state.calls.length = 0;
      state.stats = {};
    },
    call(o) {
      const req = o.data || {};
      state.calls.push({ path: req.path, method: req.method, data: req.data });
      const fail = state.fail;
      const hit = fail && (!fail.match || fail.match.test(req.path));
      // 刻意用 setTimeout 模拟真实往返：同步 resolve 会让「单飞 + 合并」
      // 永远来不及生效，等于没测到（场景 9 就是靠这个才成立的）
      setTimeout(() => {
        if (hit && fail.mode === 'network') return o.fail({ errMsg: 'request:fail timeout' });
        if (hit && fail.mode === '501') {
          return o.success({ result: { code: 501, message: '该接口尚未在云端实现', data: null } });
        }
        /**
         * 业务码注入（如 401 登录态失效）。
         * ⚠️ 必须走 `o.success` 而不是 `o.fail`：真实的登录态失效是一次
         *    **HTTP 200 + body.code = 401**，request.js 据此 clearToken 并抛
         *    ApiError(401)。用 o.fail 模拟出来的是网络层错误，码不一样，
         *    而「401 不触发 501 回落」正是这条用例要验的点。
         */
        if (hit && fail.mode === 'code') {
          return o.success({ result: { code: fail.code, message: 'fail-injected', data: null } });
        }
        try {
          o.success({ result: respond(req) });
        } catch (e) {
          o.fail({ errMsg: 'request:fail ' + e.message });
        }
      }, 1);
    },
  };
}

/* ==================================================================
   wx mock 与模块装载
   ================================================================== */
function setupWx(cloud) {
  const mem = {};
  global.wx = {
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''),
    setStorageSync: (k, v) => {
      mem[k] = v;
    },
    showToast: () => {},
    showModal: (o) => {
      if (o.success) o.success({ confirm: true });
    },
    navigateTo: () => {},
    switchTab: () => {},
    login: (o) => o.success && o.success({ code: 'test-code' }),
    getFileSystemManager: () => ({ saveFile: (o) => o.fail && o.fail({ errMsg: 'no-fs-in-test' }) }),
    cloud: { callFunction: (o) => cloud.call(o) },
  };
  global.getCurrentPages = () => [{}];
  global.getApp = () => ({ globalData: {} });
  return mem;
}

/** 重新装载 api.js —— 它和 request.js 都有模块级状态（队列、token 缓存） */
function loadApi() {
  ['utils/api.js', 'utils/request.js', 'utils/store.js'].forEach((m) => {
    const p = path.join(PROJECT, m);
    try {
      delete require.cache[require.resolve(p)];
    } catch (e) {
      /* 尚未加载过：无需清理 */
    }
  });
  return require(path.join(PROJECT, 'utils/api.js'));
}

function reset() {
  const cloud = createCloud();
  const mem = setupWx(cloud);
  const api = loadApi();
  api.request.CONFIG.baseUrl = '';
  api.request.CONFIG.env = 'cloud1-sync-test';
  const store = require(path.join(PROJECT, 'utils/store.js'));
  return { api, store, mem, cloud };
}

/* ==================================================================
   断言工具
   ================================================================== */
let pass = 0;
let fail = 0;
function check(title, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + title);
  } else {
    fail++;
    console.log('  ✗ ' + title + (detail !== undefined ? '\n      ' + detail : ''));
  }
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}

/** 一份「本机档案」的最小完整形态 */
function academicOf(gpa, extra) {
  return Object.assign(
    {
      curriculum: 'AP',
      coursesMap: { AP: [], AL: [], IB: [], NONE: [] },
      courses: [],
      gpa: gpa,
      gpaScale: 100,
      ielts: null,
      toefl: null,
      sat: null,
      countries: [],
      majors: [],
    },
    extra || {}
  );
}

(async function main() {
  /* ============================================================
     1 · 换设备登录：云端有、本机干净 → 云端覆盖本机
     ============================================================ */
  head('1 · 换设备登录（云端有、本机干净）→ 云端覆盖本机');

  {
    const { api, store, cloud } = reset();
    cloud.state.users['acc-A'] = {
      academic: academicOf(88, {
        ielts: { overall: 6.5, l: 6, r: 6.5, w: 6, s: 6.5 },
        countries: ['ca'],
        majors: ['cs'],
        updatedAt: '2026-09-01T00:00:00.000Z',
      }),
      favorites: ['ubc', 'toronto'],
    };

    await api.login();

    check('本机拿到云端的均分', store.getProfile().gpa === 88, String(store.getProfile().gpa));
    check('本机拿到云端的雅思', !!(store.getProfile().ielts && store.getProfile().ielts.overall === 6.5), JSON.stringify(store.getProfile().ielts));
    check('本机拿到云端的收藏', store.getFavorites().join(',') === 'ubc,toronto', store.getFavorites().join(','));
    check('本机档案归属被标成当前账号', store.getProfileOwner() === 'acc-A', store.getProfileOwner());
    check('同步完成后不处于 dirty', store.isProfileDirty() === false);
    check('没有把本机的空档案反推上云端', cloud.state.users['acc-A'].academic.gpa === 88, String(cloud.state.users['acc-A'].academic.gpa));
    check('本机没有拿到服务端的时间戳字段（不污染用户数据）', store.getProfile().updatedAt === undefined, String(store.getProfile().updatedAt));
  }

  /* ============================================================
     2 · 先试用后登录：云端空、本机有内容 → 本机上传
     ============================================================ */
  head('2 · 先试用后登录（云端空、本机有内容）→ 本机上传，不丢');

  {
    const { api, store, cloud } = reset();
    // 用户还没登录时就在本机填了成绩
    store.setProfile(
      academicOf(75, { coursesMap: { AP: [{ name: 'AP Physics 1', date: '', score: 4, max: 5 }], AL: [], IB: [], NONE: [] }, countries: ['ca'] })
    );

    await api.login();

    const up = cloud.state.users['acc-A'].academic;
    check('本机填过的成绩被推到云端（没有被清掉）', !!(up && up.gpa === 75), JSON.stringify(up && up.gpa));
    check('各体系科目一起上去了', !!(up && up.coursesMap.AP.length === 1), JSON.stringify(up && up.coursesMap && up.coursesMap.AP));
    check('目标国家一起上去了', !!(up && up.countries.join(',') === 'ca'));
    check('本机数据保持原样', store.getProfile().gpa === 75);
  }

  /* ============================================================
     3 · 本机数据属于另一个账号 → 云端覆盖（隐私边界）
     ============================================================ */
  head('3 · 本机数据属于另一个账号 → 云端覆盖，不把 A 的数据带给 B');

  {
    const { api, store, cloud } = reset();
    store.setProfile(academicOf(70, { countries: ['au'] }));
    store.setProfileOwner('acc-OLD');
    store.setFavorites(['secret-school']);
    store.setFavoritesOwner('acc-OLD');
    cloud.state.users['acc-A'] = { academic: academicOf(92, { countries: ['ca'] }), favorites: ['ubc'] };

    await api.login();

    check('本机成绩被云端覆盖，不带上一账号的数据', store.getProfile().gpa === 92, String(store.getProfile().gpa));
    check('本机目标国家也换成新账号的', store.getProfile().countries.join(',') === 'ca', store.getProfile().countries.join(','));
    check('本机收藏被云端覆盖', store.getFavorites().join(',') === 'ubc', store.getFavorites().join(','));
    check('旧账号的收藏没有被推到新账号', cloud.state.users['acc-A'].favorites.join(',') === 'ubc', cloud.state.users['acc-A'].favorites.join(','));
    check('旧账号的成绩没有被推到新账号', cloud.state.users['acc-A'].academic.gpa === 92, String(cloud.state.users['acc-A'].academic.gpa));
    check('本机归属已更新为新账号', store.getProfileOwner() === 'acc-A' && store.getFavoritesOwner() === 'acc-A');
  }

  /* ============================================================
     4 · 本机有未推送的改动（dirty）→ 本机为准，并让云端同步成同一份
     ============================================================ */
  head('4 · 本机有未推送的改动（dirty）→ 本机为准，云端同步成同一份');

  {
    const { api, store, cloud } = reset();
    // 本机刚改过：均分改成 95，但推送没成功（离线 / 超时）
    store.setProfile(academicOf(95));
    store.setProfileOwner('acc-A');
    store.setProfileDirty(true);
    // 本机刚取消了一所收藏，同样没推上去
    store.setFavorites(['ubc']);
    store.setFavoritesOwner('acc-A');
    store.setFavoritesDirty(true);

    cloud.state.users['acc-A'] = {
      academic: academicOf(60, { ielts: { overall: 6, l: 6, r: 6, w: 6, s: 6 }, countries: ['ca'] }),
      favorites: ['ubc', 'toronto'],
    };

    await api.login();

    check('本机刚改的均分不被云端旧值盖回去', store.getProfile().gpa === 95, String(store.getProfile().gpa));
    check('本机没填的字段从云端补回来（雅思）', !!(store.getProfile().ielts && store.getProfile().ielts.overall === 6), JSON.stringify(store.getProfile().ielts));
    check('本机没填的字段从云端补回来（目标国家）', store.getProfile().countries.join(',') === 'ca');
    check('云端最终也是本机改过的值', cloud.state.users['acc-A'].academic.gpa === 95, String(cloud.state.users['acc-A'].academic.gpa));
    check('云端补上了本机缺的雅思字段', !!(cloud.state.users['acc-A'].academic.ielts && cloud.state.users['acc-A'].academic.ielts.overall === 6));
    check('本机取消的收藏没有从云端复活', store.getFavorites().join(',') === 'ubc', store.getFavorites().join(','));
    check('云端多余的收藏被真的删掉了（发了 DELETE）', (cloud.state.stats.favDelete || 0) >= 1, JSON.stringify(cloud.state.stats));
    check('云端最终不含被取消的那一所', cloud.state.users['acc-A'].favorites.join(',') === 'ubc', cloud.state.users['acc-A'].favorites.join(','));
    check('同步后 dirty 被清掉', store.isProfileDirty() === false && store.isFavoritesDirty() === false);
  }

  /* ============================================================
     5 · 云端读不到（网络失败）→ 本机一个字节都不动
     ============================================================ */
  head('5 · 云端读不到（网络失败）→ 本机一个字节都不动');

  {
    const { api, store, cloud } = reset();
    store.setProfile(academicOf(77));
    store.setProfileOwner('acc-A');
    store.setFavorites(['ubc']);
    store.setFavoritesOwner('acc-A');
    // 只让同步相关的请求失败，登录本身要正常
    cloud.state.fail = { mode: 'network', match: /^\/v1\/(academic|favorites)/ };

    await api.login();

    check('登录本身仍然成功（同步失败不冒泡成登录失败）', store.isSignedIn() === true);
    check('网络失败时本机成绩未被改动', store.getProfile().gpa === 77, String(store.getProfile().gpa));
    check('网络失败时本机收藏未被清空', store.getFavorites().join(',') === 'ubc', store.getFavorites().join(','));
    check('网络失败时归属标记未被改写', store.getProfileOwner() === 'acc-A' && store.getFavoritesOwner() === 'acc-A');
    // 注意断言的是「云端那份数据仍是空的」，而不是「users['acc-A'] 不存在」——
    // 后者会被 auth.login 那次调用顺带创建出来，测不到真正想验的东西
    check(
      '「读不到」没有被当成「云端是空的」而反推数据上去',
      cloud.state.users['acc-A'].academic === null && cloud.state.users['acc-A'].favorites === null,
      JSON.stringify(cloud.state.users['acc-A'])
    );
    check('云端不可达时登录态也没有被顺手清掉', store.isSignedIn() === true);
  }

  /* ============================================================
     6 · 登录后保存成绩 → 云端与本机同时有
     ============================================================ */
  head('6 · 登录后保存成绩 → 云端与本机同时有');

  {
    const { api, store, cloud } = reset();
    await api.login();

    const saved = await api.saveAcademic(academicOf(91, { countries: ['ca'], majors: ['cs'] }));

    check('返回值是「已送达云端」语义（isLocal 为假）', saved.isLocal === false, JSON.stringify(saved.isLocal));
    check('云端已经存下这份成绩', cloud.state.users['acc-A'].academic.gpa === 91, String(cloud.state.users['acc-A'].academic.gpa));
    check('本机也留了一份（未登录 / 离线时可读）', store.getProfile().gpa === 91, String(store.getProfile().gpa));
    check('本机归属被标记', store.getProfileOwner() === 'acc-A');
    check('本机不处于 dirty', store.isProfileDirty() === false);

    // 云端不可达时：本机照常保存，并标 dirty 等下次补传
    cloud.state.fail = { mode: 'network', match: /^\/v1\/academic/ };
    const deferred = await api.saveAcademic(academicOf(93));
    check('云端不可达时本机仍然存下改动（不丢）', store.getProfile().gpa === 93, String(store.getProfile().gpa));
    check('云端不可达时如实返回 isLocal:true（不谎报已同步）', deferred.isLocal === true, JSON.stringify(deferred.isLocal));
    check('云端不可达时标了 dirty（等下次登录补传）', store.isProfileDirty() === true);
    check('云端仍是上一次成功推送的值', cloud.state.users['acc-A'].academic.gpa === 91, String(cloud.state.users['acc-A'].academic.gpa));
  }

  /* ============================================================
     7 · 未登录时的收藏 → 只在本机 + 标 dirty，登录后补传
     ============================================================ */
  head('7 · 未登录时的收藏 → 只在本机，登录后补传');

  {
    const { api, store, cloud } = reset();
    cloud.resetCounters();

    await api.toggleFavorite('ubc');
    await api.toggleFavorite('toronto');

    check('未登录时收藏写在本机', store.getFavorites().join(',') === 'toronto,ubc', store.getFavorites().join(','));
    check('未登录时一次网络请求都不发（注定 401 的白跑）', cloud.state.calls.length === 0, String(cloud.state.calls.length));
    check('未登录时标了 dirty（等登录后补传）', store.isFavoritesDirty() === true);
    check('未登录时归属仍是「无主」', store.getFavoritesOwner() === '');

    await api.login();

    check('登录后本机收藏被推到云端', (cloud.state.users['acc-A'].favorites || []).join(',') === 'toronto,ubc', JSON.stringify(cloud.state.users['acc-A'].favorites));
    check('登录后本机收藏保持', store.getFavorites().join(',') === 'toronto,ubc');
    check('登录后 dirty 被清掉', store.isFavoritesDirty() === false);
    check('登录后归属被认领', store.getFavoritesOwner() === 'acc-A');
  }

  /* ============================================================
     8 · 取消收藏发出的必须是 DELETE（旧缺陷：只增不减）
     ============================================================ */
  head('8 · 取消收藏必须发 DELETE（否则取消永远不生效）');

  {
    const { api, store, cloud } = reset();
    await api.login();
    cloud.state.users['acc-A'].favorites = ['ubc', 'toronto'];
    store.setFavorites(['ubc', 'toronto']);
    store.setFavoritesOwner('acc-A');
    cloud.resetCounters();

    await api.toggleFavorite('ubc');

    check('取消收藏发出的是 DELETE', (cloud.state.stats.favDelete || 0) === 1, JSON.stringify(cloud.state.stats));
    check('取消收藏不发 POST（旧缺陷：只增不减，取消永不生效）', (cloud.state.stats.favPost || 0) === 0, JSON.stringify(cloud.state.stats));
    check('取消后云端列表已移除', cloud.state.users['acc-A'].favorites.join(',') === 'toronto', cloud.state.users['acc-A'].favorites.join(','));
    check('取消后本机列表已移除', store.getFavorites().join(',') === 'toronto', store.getFavorites().join(','));
    check('返回的 favorite 是 false', (await api.toggleFavorite('toronto')).favorite === false);

    cloud.state.users['acc-A'].favorites = [];
    store.setFavorites([]);
    await api.toggleFavorite('mcgill');
    check('新增收藏发出的是 POST', (cloud.state.stats.favPost || 0) === 1, JSON.stringify(cloud.state.stats));
    check('新增后云端与本地一致且最近在前', cloud.state.users['acc-A'].favorites.join(',') === 'mcgill' && store.getFavorites().join(',') === 'mcgill');
  }

  /* ============================================================
     9 · 连点多次保存 → 不产生乱序覆盖（单飞 + 合并）
     ============================================================ */
  head('9 · 连点多次保存 → 不产生乱序覆盖');

  {
    const { api, store, cloud } = reset();
    await api.login();
    cloud.resetCounters();

    // match 页每改一个选项就 persist 一次，连点就是多个并发 PUT
    const a = api.saveAcademic(academicOf(80));
    const b = api.saveAcademic(academicOf(85));
    const c = api.saveAcademic(academicOf(90));
    await Promise.all([a, b, c]);

    check('云端最终是本机最后一次的值', cloud.state.users['acc-A'].academic.gpa === 90, String(cloud.state.users['acc-A'].academic.gpa));
    check('中间那次被合并掉（PUT 次数少于 3）', (cloud.state.stats.academicPut || 0) <= 2, String(cloud.state.stats.academicPut));
    check('本机最终值一致', store.getProfile().gpa === 90, String(store.getProfile().gpa));
    check('完成后不处于 dirty', store.isProfileDirty() === false);
  }

  /* ============================================================
     10 · 本地模式（没配后端）→ 零网络调用，行为完全不变
     ============================================================ */
  head('10 · 本地模式（没配后端）→ 零网络调用');

  {
    const { api, store, cloud } = reset();
    api.request.CONFIG.env = ''; // 摘掉云环境 → transport 落到 none
    cloud.resetCounters();

    await api.login();
    check('本地模式登录不发任何网络请求', cloud.state.calls.length === 0, String(cloud.state.calls.length));

    await api.toggleFavorite('ubc');
    await api.saveAcademic(academicOf(80));
    check('本地模式收藏与保存也不发请求', cloud.state.calls.length === 0, String(cloud.state.calls.length));
    check('本地模式收藏写在本机', store.getFavorites().join(',') === 'ubc', store.getFavorites().join(','));
    check('本地模式保存写在本机', store.getProfile().gpa === 80, String(store.getProfile().gpa));
    check('本地模式如实标记 isLocal（不谎报已同步）', (await api.saveAcademic(academicOf(82))).isLocal === true);
    check('本地模式读取走本机（不发请求）', (await api.getAcademic()).gpa === 82, String((await api.getAcademic()).gpa));
  }

  /* ============================================================
     11 · 读取成绩档案：云端失败 → 回落本机，且**永不 reject**
     ============================================================
     2026-09-25 补。此前 `getAcademic` 完全没有失败处理：
     `academic.get` 不在 `FALLBACK_LOCAL` 里（那里面只有 schools/meta 三个只读接口），
     云端只要回一个非 501 的错误 —— 网络超时、500、或登录态失效的 401 ——
     它就直接 reject。而 match 页的 `onLoad` 当时没有第二个回调，
     于是 `applyProfile` 永不执行、`this.profile` 永远是 undefined，
     用户在成绩页**能填不能存**：点确定时 `this.profile.ielts = ...` 抛异常、
     被框架吞掉、无任何提示，雅思/均分都落不了库，也就匹配不出结果。
     一次网络抖动即可复现，全程静默 —— 这就是那个 P0。

     为什么这里「回落本机」是正确语义而不是降级：
       · 本方法**只读不写**，不会像 syncAcademic 那样把「读不到」当成
         「云端是空的」去做覆盖决策（那条纪律由场景 5 守着，仍然有效）；
       · 本机就是写路径的落地（saveAcademic 每次先写本机），
         它必然持有用户最后一次填写的值。
     ============================================================ */
  head('11 · 读取成绩档案：云端失败回落本机（401 除外）');

  {
    const { api, store, cloud } = reset();
    await api.login();
    await api.saveAcademic(academicOf(88, { countries: ['ca'] }));
    check('前置：本机与云端都是 88，且不 dirty', store.getProfile().gpa === 88 && store.isProfileDirty() === false);

    // ① 正常路径：读云端
    check('正常情况读到云端那一份', (await api.getAcademic()).gpa === 88);

    // ② 本机有未推上去的改动 → 以本机为准，且**不该发这次请求**
    store.setProfile(academicOf(90));
    store.setProfileDirty(true);
    cloud.resetCounters();
    const dirtyRead = await api.getAcademic();
    check('本机 dirty 时以本机为准（否则用户刚填的分数会「变回去」）', dirtyRead.gpa === 90, String(dirtyRead.gpa));
    const getCalls = cloud.state.calls.filter((c) => c.path === '/v1/academic/profile' && c.method === 'GET').length;
    check('本机 dirty 时连读都不去读云端（本机就是更新的那一份）', getCalls === 0, `发了 ${getCalls} 次 GET`);

    // ③ 云端网络失败 → 必须 resolve 出本机那一份，绝不能 reject
    store.setProfileDirty(false);
    cloud.state.fail = { mode: 'network', match: /^\/v1\/academic/ };
    let rejected = false;
    const netRead = await api.getAcademic().catch(() => { rejected = true; return null; });
    check('云端读不到时不 reject（否则整页档案装载中断 → 能填不能存）', rejected === false);
    check('云端读不到时回落本机那一份', !!netRead && netRead.gpa === 90, JSON.stringify(netRead && netRead.gpa));

    // ④ 401（登录态失效）**必须抛出去** —— 与 test-cloud-transport 第 4 节同一条纪律：
    //    「登录态问题必须暴露出来，不能被本地数据掩盖」。会话失效时拿本机缓存
    //    装作一切正常，用户会以为自己还登着、还在同步，下一次写却全落到 401。
    cloud.state.fail = { mode: 'code', code: 401, match: /^\/v1\/academic/ };
    let authCode = null;
    await api.getAcademic().then(
      () => { authCode = 'NO-THROW'; },
      (e) => { authCode = e.code; }
    );
    check('401（登录态失效）必须抛出，不被本机缓存掩盖', authCode === 401, String(authCode));

    // ⑤ 收藏是同一处纪律、同一条 bug 家族 —— 一并守住。
    //    刻意**不设 dirty**，让请求真的发出去并失败，才测得到 catch 分支。
    store.setFavorites(['ubc']);
    store.setFavoritesDirty(false);
    cloud.state.fail = { mode: 'network', match: /^\/v1\/favorites/ };
    rejected = false;
    const favs = await api.getFavorites().catch(() => { rejected = true; return null; });
    check('收藏：云端读不到时不 reject', rejected === false);
    check('收藏：云端读不到时回落本机那一份', Array.isArray(favs) && favs.join(',') === 'ubc', JSON.stringify(favs));

    cloud.state.fail = { mode: 'code', code: 401, match: /^\/v1\/favorites/ };
    // ⚠️ 上面那次 401 会让 request 的 unauthorized 回调把 `sp_sign_in` 清掉
    //    （真实行为：会话失效即登出），此后门面层会走「未登录 → 直接读本机」的短路，
    //    根本发不出请求。要测「401 是否抛出」就必须先把这个标记放回去。
    store.setSignedIn(true);
    store.setFavoritesDirty(false);
    let favCode = null;
    await api.getFavorites().then(
      () => { favCode = 'NO-THROW'; },
      (e) => { favCode = e.code; }
    );
    check('收藏：401 同样必须抛出', favCode === 401, String(favCode));
  }

  /* ============================================================ */
  console.log('\n' + '─'.repeat(64));
  console.log(`断言：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
  console.log('─'.repeat(64));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n测试台自身异常：', e);
  process.exit(2);
});
