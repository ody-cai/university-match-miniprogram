#!/usr/bin/env node
/**
 * 意见反馈云函数 · 真实 handler 单元测试
 * ==================================================================
 * 为什么需要它：feedback.js 的若干修复都发生在服务端 handler 内部——
 *   · 工单号并发撞号（count+1 读后写）
 *   · 图片混合非法时静默丢图（filter 悄悄丢弃）
 *   · 限流维度与落库维度不一致（限流记 unknown、落库写 null）
 *   · client 字段越界落库
 * 现有 tools/test-feedback-api.js（小程序端）、test-cloud-transport.js
 * （传输层）都测不到这里。本文件直接 require 真实的
 * handlers/feedback.js，mock 掉 wx-server-sdk，断言其行为。
 *
 * 做法：用 Module._load 拦截 'wx-server-sdk'，注入内存版 db mock
 * （可设定限流 count 返回、捕获落库载荷与限流 where 条件），然后直接
 * 调 submit() 走与真机相同的校验/限流/落库代码路径。
 *
 * ⚠️ 本机不装 wx-server-sdk，也不连真库；全部走 mock。
 * 用法：node tools/test-cloud-feedback.js
 */
const path = require('path');
const Module = require('module');

/* ================= mock wx-server-sdk ================= */
const state = {
  rateTotal: 0, // 限流 count 查询返回的总次数
  lastRateWhere: null, // 最近一次限流查询的 where 条件（用于断言维度一致）
  adds: [], // 落库记录 { name, data }
};

const db = {
  command: { gte: (v) => ({ $gte: v }) },
  RegExp: (o) => ({ $regex: o.regexp }),
  collection(name) {
    return {
      where(cond) {
        if (name === 'feedbacks') state.lastRateWhere = cond;
        return this;
      },
      // 当前 handler 里唯一的 count 调用就是限流查询
      count() {
        return Promise.resolve({ total: state.rateTotal });
      },
      add(doc) {
        state.adds.push({ name, data: doc.data });
        return Promise.resolve({ _id: 'mock_' + state.adds.length });
      },
    };
  },
};

const fakeCloud = { database: () => db };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud;
  return origLoad.apply(this, arguments);
};

const { submit } = require(path.join(
  __dirname,
  '..',
  'miniprogram',
  'cloudfunctions',
  'api',
  'handlers',
  'feedback.js'
));

/* ================= 断言工具 ================= */
let pass = 0;
let fail = 0;
function check(title, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${title}`);
  } else {
    fail++;
    console.log(`  ✗ ${title}${detail ? '\n      ' + detail : ''}`);
  }
}
function head(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}
function reset() {
  state.rateTotal = 0;
  state.lastRateWhere = null;
  state.adds = [];
}

async function run() {
  /* 1. 正常提交（有 openid，未业务登录） */
  head('1. 正常提交（匿名身份可用，非业务登录前置）');
  reset();
  const r1 = await submit({
    openid: 'oABC123',
    data: { type: 'bug', content: '列表页点不开', contact: 'ody', images: [] },
  });
  check('返回 code:0', r1.code === 0, JSON.stringify(r1));
  check('ticketId 格式 fb_YYYYMMDD_<24hex>', /^fb_\d{8}_[0-9a-f]{24}$/.test(r1.data.ticketId), r1.data.ticketId);
  check('回传 replyWithin=3', r1.data.replyWithin === 3);
  check('落库 1 条', state.adds.length === 1);
  check('userId = openid（非 null）', state.adds[0].data.userId === 'oABC123');
  check('status=open', state.adds[0].data.status === 'open');

  /* 2. 缺少微信身份 → 拒绝 */
  head('2. 缺少微信身份被拒（但不要求业务登录）');
  reset();
  try {
    await submit({ openid: '', data: { type: 'bug', content: 'x' } });
    check('空 openid 应抛错', false);
  } catch (e) {
    check('空 openid → 400', e.bizCode === 400, e.message);
    check('提示可展示中文', /微信身份/.test(e.message), e.message);
  }
  check('拒绝时未落库', state.adds.length === 0);

  /* 3. 限流：维度与落库一致 */
  head('3. 限流（限流维度 = 落库维度 = openid）');
  reset();
  state.rateTotal = 3;
  try {
    await submit({ openid: 'oLimit', data: { type: 'bug', content: 'x' } });
    check('已达上限应抛 429', false);
  } catch (e) {
    check('超限 → 429', e.bizCode === 429, e.message);
  }
  check('限流 where 用 openid（非 unknown）', !!state.lastRateWhere && state.lastRateWhere.userId === 'oLimit', JSON.stringify(state.lastRateWhere));

  reset();
  state.rateTotal = 2; // < RATE_MAX
  const r3 = await submit({ openid: 'oLimit', data: { type: 'idea', content: '建议加搜索' } });
  check('未达上限放行', r3.code === 0);
  check('落库 userId 与限流维度相同', state.adds[0].data.userId === 'oLimit');

  /* 4. 图片全量严格校验（禁止静默丢图） */
  head('4. 图片严格校验（混合非法必须整体拒绝，不静默丢图）');
  reset();
  try {
    await submit({
      openid: 'oImg',
      data: {
        type: 'data',
        content: '图有问题',
        images: ['cloud://env/feedback/a.png', 'https://evil.com/b.png'],
      },
    });
    check('混合合法+非法图片应拒绝', false, '竟然通过了');
  } catch (e) {
    check('混合非法图片 → 400', e.bizCode === 400, e.message);
  }
  check('拒绝时未落库（不丢图但也不存）', state.adds.length === 0);

  reset();
  try {
    await submit({ openid: 'oImg2', data: { type: 'bug', content: 'x', images: ['https://a.com/1.png'] } });
    check('外链图片应拒绝', false);
  } catch (e) {
    check('外链 → 400', e.bizCode === 400, e.message);
  }

  reset();
  try {
    await submit({
      openid: 'oImg3',
      data: {
        type: 'bug',
        content: 'x',
        images: [
          'cloud://e/feedback/1.png',
          'cloud://e/feedback/2.png',
          'cloud://e/feedback/3.png',
          'cloud://e/feedback/4.png',
        ],
      },
    });
    check('超过 3 张应拒绝', false);
  } catch (e) {
    check('超过上限 → 400', e.bizCode === 400 && /最多上传 3 张/.test(e.message), e.message);
  }

  reset();
  const ok3 = await submit({
    openid: 'oImg4',
    data: {
      type: 'bug',
      content: 'x',
      images: ['cloud://e/feedback/1.png', 'cloud://e/feedback/2.png', 'cloud://e/feedback/3.png'],
    },
  });
  check('3 张合法图片通过', ok3.code === 0);
  check('落库 images 长度=3', state.adds[0].data.images.length === 3);

  /* 5. client 字段收敛 */
  head('5. client 仅保留契约字段并限长');
  reset();
  await submit({
    openid: 'oC',
    data: {
      type: 'other',
      content: 'x',
      client: {
        version: '1.0.0',
        platform: 'ios',
        system: 'iOS 18.2',
        deviceId: 'should-be-dropped',
        rawData: 'drop',
      },
    },
  });
  const client = state.adds[0].data.client;
  check('client 只含 version/platform/system', Object.keys(client).sort().join(',') === 'platform,system,version', JSON.stringify(client));
  check('多余字段被丢弃', !('deviceId' in client) && !('rawData' in client));
  check('version 透传', client.version === '1.0.0');

  reset();
  await submit({
    openid: 'oC2',
    data: {
      type: 'other',
      content: 'x',
      client: { version: 'v'.repeat(100), platform: 'p'.repeat(100), system: 's'.repeat(200) },
    },
  });
  const c2 = state.adds[0].data.client;
  check('version 截断到 32', c2.version.length === 32, c2.version.length);
  check('platform 截断到 32', c2.platform.length === 32, c2.platform.length);
  check('system 截断到 64', c2.system.length === 64, c2.system.length);

  reset();
  await submit({ openid: 'oC3', data: { type: 'other', content: 'x', client: 'not-an-object' } });
  check('client 非对象 → null', state.adds[0].data.client === null);

  /* 6. 基础字段校验 */
  head('6. 基础字段校验');
  reset();
  try {
    await submit({ openid: 'oV', data: { content: '没类型' } });
    check('缺 type 应拒', false);
  } catch (e) {
    check('缺 type → 400', e.bizCode === 400, e.message);
  }
  try {
    await submit({ openid: 'oV', data: { type: 'bug', content: '   ' } });
    check('空白 content 应拒', false);
  } catch (e) {
    check('空白 content → 400', e.bizCode === 400, e.message);
  }
  try {
    await submit({ openid: 'oV', data: { type: 'hack', content: '非法类型' } });
    check('非法 type 应拒', false);
  } catch (e) {
    check('非法 type → 400', e.bizCode === 400, e.message);
  }
  try {
    await submit({ openid: 'oV', data: { type: 'bug', content: 'x'.repeat(201) } });
    check('超 200 字应拒', false);
  } catch (e) {
    check('超 200 字 → 400', e.bizCode === 400, e.message);
  }
  reset();
  await submit({
    openid: 'oV2',
    data: { type: 'bug', content: 'x', contact: 'c'.repeat(200), schoolId: 's'.repeat(200) },
  });
  check('contact 截断到 64', state.adds[0].data.contact.length === 64, state.adds[0].data.contact.length);
  check('schoolId 截断到 64', state.adds[0].data.schoolId.length === 64, state.adds[0].data.schoolId.length);

  /* 7. 工单号唯一且无需计数查库 */
  head('7. 工单号唯一（随机，不查库计数）');
  reset();
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const r = await submit({ openid: 'oU' + i, data: { type: 'bug', content: 'x' } });
    ids.add(r.data.ticketId);
  }
  check('50 次提交无撞号', ids.size === 50, `唯一 ${ids.size}/50`);

  /* ========== 结果 ========== */
  console.log('\n' + '═'.repeat(64));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('═'.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('\n测试台自身异常：', e);
  process.exit(2);
});
