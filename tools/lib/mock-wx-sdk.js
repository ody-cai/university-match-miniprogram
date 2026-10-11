/**
 * 微信云开发 SDK 的**内存实现**（共享模块：验证台与本地预览台各 require 同一份）
 * ==================================================================
 * 为什么单独成文件：`cloudfunctions/admin/*.js` 在加载时就
 * `require('wx-server-sdk')` 并 `cloud.database()`，而本机没有该 SDK
 * （只存在于云端）。于是「管理端鉴权、发布校验、并发冲突、工单流转」
 * 这些最不该出事的逻辑在本机根本跑不到。
 *
 * 此前这份实现内联在 `tools/test-admin-server.js` 里。再要做一台
 * 「本地可点的预览台」时，唯一的选择就是复制一份 —— 两份 mock 迟早会漂，
 * 而漂移的表现是「预览里好好的、验证台里挂了」，属于最难判断的一类不一致。
 * ⇒ 抽成本模块，两边 require 同一份。
 *
 * 刻意保真到足以测出真问题：
 *   · 文档不存在抛 `document with _id x does not exist`（**云端实测原文**）
 *   · 集合缺失抛 `database collection not exists`（云开发要求集合先在控制台创建）
 *   · `runTransaction` 失败时整体回滚（否则测不出「写了一半」）
 *   · `where` 支持 and / or / gte / RegExp，分页真的 skip + limit
 *
 * ⚠️ 它不代表真机通过：不覆盖云网关、真实数据库权限与索引。
 *    线上链路由 `tools/test-admin-live.js` 打真实环境验证。
 */
'use strict';

function createStore() {
  return {
    /** collection -> Map<_id, doc> */
    collections: {},
    seq: 0,
    tempUrlCalls: 0,
    /**
     * 「这个集合在库里不存在」的集合名。
     * 云开发要求集合先在控制台手动创建，缺集合时读写会抛
     * `database collection not exists`（**不是**返回空结果）。
     * 真实环境里这是最常见的部署事故，所以内存实现要能复现它 ——
     * 否则「缺集合时后台会不会整片挂掉」这条永远测不到。
     */
    missing: new Set(),
  };
}

/** 数据库查询操作符（对应 db.command.xxx） */
const OP = {
  or: (list) => ({ __op: 'or', list }),
  and: (list) => ({ __op: 'and', list }),
  gte: (value) => ({ __op: 'gte', value }),
};
function makeRegExp({ regexp, options }) {
  return new RegExp(regexp, options || '');
}

function valueMatch(actual, expected) {
  if (expected && typeof expected === 'object' && expected.__op) {
    if (expected.__op === 'or') return expected.list.some((c) => valueMatch(actual, c));
    if (expected.__op === 'and') return expected.list.every((c) => valueMatch(actual, c));
    if (expected.__op === 'gte') {
      const a = actual instanceof Date ? actual.getTime() : new Date(actual).getTime();
      const b = expected.value instanceof Date ? expected.value.getTime() : new Date(expected.value).getTime();
      return a >= b;
    }
  }
  if (expected instanceof RegExp) return expected.test(String(actual == null ? '' : actual));
  return actual === expected;
}

/** 条件对象 → 布尔；支持顶层 and/or 与按字段的比较 */
function docMatch(doc, cond) {
  if (!cond || typeof cond !== 'object') return true;
  if (cond.__op === 'and') return cond.list.every((c) => docMatch(doc, c));
  if (cond.__op === 'or') return cond.list.some((c) => docMatch(doc, c));
  return Object.keys(cond).every((k) => valueMatch(doc[k], cond[k]));
}

function cloneDeep(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(cloneDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = cloneDeep(v[k]);
    return out;
  }
  return v;
}
function cloneCollections(c) {
  const out = {};
  for (const name of Object.keys(c)) {
    out[name] = new Map();
    for (const [k, v] of c[name].entries()) out[name].set(k, cloneDeep(v));
  }
  return out;
}

function createMockSdk(store) {
  function collection(name) {
    if (store.missing.has(name)) {
      const e = new Error('database collection not exists');
      e.errCode = -502005;
      e.errMsg = 'database collection not exists';
      throw e;
    }
    if (!store.collections[name]) store.collections[name] = new Map();
    const map = store.collections[name];

    function docApi(id) {
      return {
        async get() {
          if (map.has(id)) return { data: cloneDeep(map.get(id)) };
          const e = new Error('document.get:fail document with _id ' + id + ' does not exist');
          e.errCode = -502005;
          e.errMsg = e.message;
          throw e;
        },
        async set({ data }) {
          map.set(id, Object.assign({ _id: id }, cloneDeep(data)));
          return { stats: { updated: 1 } };
        },
        async update({ data }) {
          if (!map.has(id)) return { stats: { updated: 0 } };
          Object.assign(map.get(id), cloneDeep(data));
          return { stats: { updated: 1 } };
        },
        async remove() {
          return { stats: { removed: map.delete(id) ? 1 : 0 } };
        },
      };
    }

    function query(cond) {
      const q = {
        _cond: cond,
        _order: null,
        _skip: 0,
        _limit: null,
        where(c) {
          return query(c);
        },
        orderBy(field, dir) {
          q._order = { field, dir };
          return q;
        },
        skip(n) {
          q._skip = n;
          return q;
        },
        limit(n) {
          q._limit = n;
          return q;
        },
        _rows() {
          let rows = Array.from(map.values()).filter((d) => docMatch(d, q._cond));
          if (q._order) {
            const { field, dir } = q._order;
            rows.sort((a, b) => {
              const av = a[field] instanceof Date ? a[field].getTime() : a[field];
              const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
              return dir === 'desc' ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
            });
          }
          return rows;
        },
        async count() {
          return { total: q._rows().length };
        },
        async get() {
          let rows = q._rows();
          if (q._skip) rows = rows.slice(q._skip);
          if (q._limit) rows = rows.slice(0, q._limit);
          return { data: rows.map(cloneDeep) };
        },
      };
      return q;
    }

    return {
      doc: docApi,
      where: (c) => query(c),
      orderBy: (f, d) => query({}).orderBy(f, d),
      limit: (n) => query({}).limit(n),
      skip: (n) => query({}).skip(n),
      count: () => query({}).count(),
      get: () => query({}).get(),
      async add({ data }) {
        const id = data._id || 'auto_' + ++store.seq;
        if (map.has(id)) {
          const e = new Error('E11000 duplicate key error collection');
          e.errCode = -502001;
          e.errMsg = e.message;
          throw e;
        }
        map.set(id, Object.assign({ _id: id }, cloneDeep(data)));
        return { _id: id };
      },
    };
  }

  const db = {
    collection,
    command: OP,
    RegExp: makeRegExp,
    /**
     * 真事务语义：先克隆整库，成功才提交；抛错则丢弃克隆。
     * 不这样做，就测不出「审计写入失败会不会留下半份配置」。
     */
    async runTransaction(fn) {
      const backup = cloneCollections(store.collections);
      const working = cloneCollections(store.collections);
      const real = store.collections;
      store.collections = working;
      try {
        const tx = { collection };
        const result = await fn(tx);
        return result;
      } catch (e) {
        store.collections = real;
        throw e;
      } finally {
        // 成功路径：working 保持在 store 上即等于提交；失败路径已在 catch 还原
        if (store.collections !== real && store.collections !== backup) {
          /* 提交：无需动作 */
        }
        void backup;
      }
    },
  };

  return {
    database: () => db,
    init() {},
    DYNAMIC_CURRENT_ENV: 'dynamic',
    async getTempFileURL({ fileList }) {
      store.tempUrlCalls++;
      return {
        fileList: (fileList || []).map((f) => ({ fileID: f.fileID, tempFileURL: 'https://temp.example/' + encodeURIComponent(f.fileID), status: 0, maxAge: f.maxAge })),
      };
    },
  };
}

module.exports = { createStore, createMockSdk };
