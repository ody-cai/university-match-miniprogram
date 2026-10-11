#!/usr/bin/env node
'use strict';
/**
 * 线上工单全生命周期联调（**真实云数据库**，跑完必清理）
 * ==================================================================
 * 为什么需要它：test-admin-server.js 用的是内存 mock，只能证明「代码逻辑对」，
 * 不能证明「真的能读写线上 feedbacks 集合」。工单受理是本次后台的核心功能，
 * 必须在真实数据库上走一遍：查到 → 详情 → 并发冲突 → 办结校验 → 状态流转 → 留痕。
 *
 * ── 关于「用户提交」那一段 ───────────────────────────────────────
 * 用户侧提交路径（POST /v1/feedback）**要求微信静默下发的 openid**，
 * 命令行调用拿不到，因此本脚本**不能**伪造用户提交 —— 那一段只能在
 * 微信开发者工具/真机里由真人提交验证。本脚本验证的是「受理与处理」这一半：
 * 直接按真实落库结构插入一条带 LT 前缀的测试工单，走管理接口全流程。
 *
 * ── 清理保证 ────────────────────────────────────────────────────
 * 测试工单号固定前缀 `fb_lt_`，与真实工单（fb_YYYYMMDD_<24hex>）绝不重叠。
 * 开始前先清一次历史残留，结束在 finally 里按前缀删除；删除后复查计数回落。
 * 绝不按其它条件删除任何数据。
 *
 * 用法：node tools/test-admin-ticket-live.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENV = process.env.CLOUD_ENV_ID;
const BASE = process.env.ADMIN_BASE;
if (!ENV || !BASE) {
  console.error('✖ 请设置 CLOUD_ENV_ID 与 ADMIN_BASE 环境变量');
  process.exit(1);
}
const KEY_PATH = path.join(ROOT, 'admin', '.admin-key');
const MARKER = '【自动化联调占位工单·可安全删除】';
const TICKET_ID = 'fb_lt_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 10);

let pass = 0;
let fail = 0;
function check(title, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + title); }
  else { fail++; console.log('  ✗ ' + title + (detail !== undefined ? '\n      ' + detail : '')); }
}
function head(t) { console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64)); }

/** 直接执行文档型数据库命令（仅用于插桩与按前缀清理） */
function mongo(commandType, command) {
  const out = execFileSync('tcb', [
    'db', 'nosql', 'execute', '-e', ENV, '--json',
    '--command', JSON.stringify([{ TableName: 'feedbacks', CommandType: commandType, Command: JSON.stringify(command) }]),
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return out;
}

/** 从 mongo 输出里取「受影响/匹配条数」（网关返回的是 Extended JSON 的 $numberInt 形态） */
function countOf(commandType, command) {
  const out = mongo(commandType, command);
  const m = out.match(/"n"\s*:\s*\{\s*"\$numberInt"\s*:\s*"(\d+)"/);
  if (!m) {
    const err = out.match(/"(?:errmsg|message)"\s*:\s*"([^"]+)"/);
    throw new Error('数据库命令未返回条数' + (err ? '：' + err[1] : ''));
  }
  return Number(m[1]);
}

async function call(pathname, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const res = await fetch(BASE + pathname, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch (e) { body = { code: -1, message: '响应不是 JSON' }; }
  return { status: res.status, body };
}

function cleanup() {
  try {
    const n = countOf('DELETE', { delete: 'feedbacks', deletes: [{ q: { ticketId: { $regex: '^fb_lt_' } }, limit: 0 }] });
    return n;
  } catch (e) { return null; }
}

(async function main() {
  if (!fs.existsSync(KEY_PATH)) { console.error('未找到管理密钥文件 ' + KEY_PATH); process.exit(2); }
  const KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();
  const auth = { 'X-Admin-Key': KEY };

  console.log('本次测试工单号：' + TICKET_ID + '（前缀 fb_lt_，结束后按前缀删除）');

  /* 开始前清一次残留，避免上次异常退出留下脏数据 */
  cleanup();

  let inserted = false;
  try {
    /* ---------- 1. 插入真实结构的测试工单 ---------- */
    head('1 · 按真实落库结构插入测试工单（不走用户提交接口，原因见文件头）');
    mongo('INSERT', {
      insert: 'feedbacks',
      documents: [{
        ticketId: TICKET_ID,
        type: 'complaint',
        userId: 'lt_placeholder_openid',
        content: MARKER + ' 院校录取要求页面显示的合作项目信息与官方招生页不一致，希望核实。',
        contact: 'lt-test-contact',
        images: [],
        schoolId: 'toronto',
        client: { platform: 'devtools', version: '1.0.0', brand: 'lt', model: 'lt', system: 'lt' },
        status: 'open',
        // 网关只接受 Extended JSON 的 numberLong 形态；裸数字或 ISO 字符串都会报 InvalidParameter
        createdAt: { $date: { $numberLong: String(Date.now()) } },
      }],
    });
    inserted = true;
    const baselineAfterInsert = countOf('COMMAND', { count: 'feedbacks', query: { ticketId: TICKET_ID } });
    check('测试工单已写入云数据库', baselineAfterInsert === 1, '匹配条数=' + baselineAfterInsert);

    /* ---------- 2. 列表检索 ---------- */
    head('2 · 后台列表能查到该工单');
    const kw = await call('/admin-api/tickets?size=100&keyword=' + encodeURIComponent(TICKET_ID), { headers: auth });
    check('关键词搜索返回 code 0', kw.body.code === 0, JSON.stringify(kw.body).slice(0, 200));
    const hit = ((kw.body.data && kw.body.data.list) || []).find((t) => t.ticketId === TICKET_ID);
    check('搜索结果包含该工单', !!hit, JSON.stringify(kw.body.data && kw.body.data.total));
    check('类型为「投诉与举报」', hit && hit.type === 'complaint', hit && hit.type);
    check('初始状态为待处理 open', hit && hit.status === 'open', hit && hit.status);
    check('初始版本号为 0', hit && hit.revision === 0, hit && String(hit.revision));

    /* ---------- 3. 详情 ---------- */
    head('3 · 工单详情字段完整');
    const detail = await call('/admin-api/tickets/' + TICKET_ID, { headers: auth });
    check('详情返回 code 0', detail.body.code === 0, JSON.stringify(detail.body).slice(0, 200));
    const t = detail.body.data || {};
    check('正文与提交内容一致', t.content === MARKER + ' 院校录取要求页面显示的合作项目信息与官方招生页不一致，希望核实。', t.content);
    check('联系方式已留存', t.contact === 'lt-test-contact', t.contact);
    check('关联院校已留存', t.schoolId === 'toronto', t.schoolId);
    check('不返回微信匿名标识（管理界面不需要）', t.userId === undefined, JSON.stringify(Object.keys(t)));
    check('初始无处理记录', Array.isArray(t.history) && t.history.length === 0, JSON.stringify(t.history));

    /* ---------- 4. 并发保护 ---------- */
    head('4 · 并发保护：过期版本号必须被拒绝');
    const stale = await call('/admin-api/tickets/' + TICKET_ID, { method: 'PATCH', headers: auth, body: JSON.stringify({ revision: 999, status: 'processing', note: '不该写进去' }) });
    check('过期 revision → 409', stale.body.code === 409, JSON.stringify(stale.body).slice(0, 200));
    const afterStale = await call('/admin-api/tickets/' + TICKET_ID, { headers: auth });
    check('被拒的更新没有污染数据', afterStale.body.data.status === 'open' && afterStale.body.data.revision === 0,
      JSON.stringify({ s: afterStale.body.data.status, r: afterStale.body.data.revision }));

    /* ---------- 5. 办结必须写说明 ---------- */
    head('5 · 办结/关闭前必须填写处理说明');
    const noNote = await call('/admin-api/tickets/' + TICKET_ID, { method: 'PATCH', headers: auth, body: JSON.stringify({ revision: 0, status: 'resolved' }) });
    check('无说明直接办结 → 400', noNote.body.code === 400, JSON.stringify(noNote.body).slice(0, 200));

    /* ---------- 6. 状态流转 + 留痕 ---------- */
    head('6 · 受理 → 处理 → 办结，全程留痕');
    const toProcessing = await call('/admin-api/tickets/' + TICKET_ID, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify({ revision: 0, status: 'processing', priority: 'high', assignee: '联调测试', note: '已受理，正在核对官方招生页。' }),
    });
    check('受理（pending → processing）成功', toProcessing.body.code === 0, JSON.stringify(toProcessing.body).slice(0, 200));
    check('状态已变为处理中', toProcessing.body.data && toProcessing.body.data.status === 'processing');
    check('优先级已更新为高', toProcessing.body.data && toProcessing.body.data.priority === 'high');
    check('版本号递增为 1', toProcessing.body.data && toProcessing.body.data.revision === 1);
    check('产生 1 条处理记录', toProcessing.body.data && toProcessing.body.data.history.length === 1);

    const toResolved = await call('/admin-api/tickets/' + TICKET_ID, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify({ revision: 1, status: 'resolved', reply: '已核对并更正，感谢反馈。' }),
    });
    check('办结（带回复）成功', toResolved.body.code === 0, JSON.stringify(toResolved.body).slice(0, 200));
    check('状态已变为已解决', toResolved.body.data && toResolved.body.data.status === 'resolved');
    check('办结时间已记录', !!(toResolved.body.data && toResolved.body.data.resolvedAt), JSON.stringify(toResolved.body.data && toResolved.body.data.resolvedAt));
    check('版本号递增为 2', toResolved.body.data && toResolved.body.data.revision === 2);
    check('处理记录累计 2 条', toResolved.body.data && toResolved.body.data.history.length === 2);

    const reread = await call('/admin-api/tickets/' + TICKET_ID, { headers: auth });
    check('重新读取：状态与回复均已持久化',
      reread.body.data.status === 'resolved' && reread.body.data.reply === '已核对并更正，感谢反馈。' && reread.body.data.note === '已受理，正在核对官方招生页。',
      JSON.stringify({ s: reread.body.data.status, reply: reread.body.data.reply, note: reread.body.data.note }));

    /* ---------- 7. 字段白名单 ---------- */
    head('7 · 不接受白名单外的字段');
    const badField = await call('/admin-api/tickets/' + TICKET_ID, { method: 'PATCH', headers: auth, body: JSON.stringify({ revision: 2, userId: '伪造' }) });
    check('写入 userId 等字段 → 400', badField.body.code === 400, JSON.stringify(badField.body).slice(0, 200));
    const badStatus = await call('/admin-api/tickets/' + TICKET_ID, { method: 'PATCH', headers: auth, body: JSON.stringify({ revision: 2, status: '乱写' }) });
    check('非法状态 → 400', badStatus.body.code === 400, JSON.stringify(badStatus.body).slice(0, 200));

    /* ---------- 8. 截图接口 ---------- */
    head('8 · 截图接口（本工单无图）');
    const imgs = await call('/admin-api/tickets/' + TICKET_ID + '/images', { headers: auth });
    check('无截图时返回空列表而不是报错', imgs.body.code === 0 && Array.isArray(imgs.body.data.list) && imgs.body.data.list.length === 0,
      JSON.stringify(imgs.body).slice(0, 200));

    /* ---------- 9. 概览统计包含该工单 ---------- */
    head('9 · 概览统计口径');
    const ov = await call('/admin-api/overview', { headers: auth });
    check('概览可读', ov.body.code === 0, JSON.stringify(ov.body).slice(0, 200));
    check('已解决计数 ≥ 1（含本条测试工单）', ov.body.data.tickets.resolved >= 1, JSON.stringify(ov.body.data.tickets));

    /* ---------- 10. 清理 ---------- */
    head('10 · 清理测试数据（按 fb_lt_ 前缀删除）');
    const deleted = cleanup();
    inserted = false;
    check('按前缀删除成功且删掉了本工单', deleted === 1, '删除条数=' + deleted);
    const left = countOf('COMMAND', { count: 'feedbacks', query: { ticketId: { $regex: '^fb_lt_' } } });
    check('库中已无任何 fb_lt_ 残留', left === 0, '剩余=' + left);
    const gone = await call('/admin-api/tickets/' + TICKET_ID, { headers: auth });
    check('通过后台再查已返回 404', gone.body.code === 404, JSON.stringify(gone.body).slice(0, 160));
  } catch (e) {
    console.error('\n联调过程出错：' + e.message);
    fail++;
  } finally {
    if (inserted) {
      console.log('\n⚠️ 进入兜底清理（前序步骤异常中断）');
      console.log('   清理条数：' + cleanup());
    }
  }

  console.log('\n' + '─'.repeat(64));
  console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + '）');
  console.log('─'.repeat(64));
  process.exit(fail > 0 ? 1 : 0);
})();
