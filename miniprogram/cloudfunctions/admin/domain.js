'use strict';
const crypto = require('crypto');
const defaults = require('./data/content');
const schools = require('./data/schools.json');
const STATUSES = ['open', 'processing', 'resolved', 'closed'];
const PRIORITIES = ['normal', 'high', 'urgent'];
const TYPES = ['bug', 'data', 'idea', 'other', 'complaint'];
/**
 * 工单状态的中文名 —— **服务端唯一一份**。
 * ------------------------------------------------------------------
 * 用途是填进订阅消息的字段（`push.xxx`），所以它不能只活在前端：
 * 管理台页面（`static/app.js`）里那份是给浏览器渲染表格用的，
 * 而通知内容由云函数生成 —— 两处若各写一份，用户收到的短信里
 * 会写着「resolved」这种内部状态名。校验脚本会核对两处一致。
 */
const STATUS_LABEL = { open: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function error(code, message) { const e = new Error(message); e.code = code; throw e; }
function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function clean(v, depth = 0) {
  if (depth > 16) error(400, '数据层级过深');
  if (Array.isArray(v)) { if (v.length > 200) error(400, '列表过长'); v.forEach(x => clean(x, depth + 1)); }
  else if (plain(v)) Object.keys(v).forEach(k => { if (forbidden.has(k) || k.startsWith('$') || k.includes('.')) error(400, '包含不允许的字段'); clean(v[k], depth + 1); });
  else if (typeof v === 'string' && v.length > 10000) error(400, '文本过长');
}
function merge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (plain(patch)) { const out = Object.assign({}, base || {}); for (const k of Object.keys(patch)) out[k] = plain(patch[k]) ? merge(out[k], patch[k]) : patch[k]; return out; }
  return patch === undefined ? base : patch;
}
function revision(doc) { return (doc && doc._admin && doc._admin.revision) || 0; }
function patchOf(doc) { const out = Object.assign({}, doc || {}); delete out._id; delete out._openid; delete out._admin; return out; }
function assertRevision(actual, expected) { if (!Number.isInteger(expected) || actual !== expected) error(409, '数据已更新，请刷新后重新编辑，未覆盖他人的修改'); }
function text(v, max, name, required = false) { if (typeof v !== 'string' || v.length > max || (required && !v.trim())) error(400, name + '格式或长度不正确'); return v.trim(); }
function schema(patch, base, path = '') {
  if (!plain(patch)) error(400, '内容补丁必须是对象');
  for (const [key, value] of Object.entries(patch)) {
    const field = path ? path + '.' + key : key;
    if (!(key in base)) error(400, '未知内容字段：' + field);
    const source = base[key];
    if (Array.isArray(source)) { if (!Array.isArray(value)) error(400, field + '必须是数组'); }
    else if (plain(source)) schema(value, source, field);
    else if (source !== null && typeof value !== typeof source) error(400, field + '类型不正确');
  }
}
function validatePatch(patch) {
  if (!plain(patch)) error(400, '内容补丁必须是对象'); clean(patch);
  if (JSON.stringify(patch).length > 160000) error(400, '内容补丁过大');
  const contentOnly = Object.assign({}, patch); delete contentOnly.schoolOverrides;
  schema(contentOnly, defaults);
  const full = merge(defaults, contentOnly);
  if (full.ai.enabled !== false) error(400, '运行期模型功能固定关闭，不允许发布');
  if (patch.defaultAcademic !== undefined) error(400, '禁止通过运营后台预置用户成绩');
  const fb = full.feedback;
  if (fb.descMax !== 200 || fb.imageMax !== 3 || fb.replyWithin !== 3) error(400, '反馈限制与回复时限必须与服务端保持一致');
  if (!Array.isArray(fb.types) || !fb.types.length || fb.types.some(t => !t || !TYPES.includes(t.key) || typeof t.label !== 'string')) error(400, '反馈类型不合法');
  if (patch.matchConfig !== undefined) error(400, '算法口径不开放运营修改，需代码审核');
  if (patch.schoolOverrides !== undefined) {
    if (!plain(patch.schoolOverrides)) error(400, '院校补丁必须是对象');
    for (const [id, value] of Object.entries(patch.schoolOverrides)) validateSchool(id, merge(schools.find(s => s.id === id), value));
  }
  // 功能入口不能凭文案发布一个不存在的页面。
  const validPaths = new Set(['/pages/home/home','/pages/match/match','/pages/schools/schools','/pages/account/account','/pages/result/result','/pages/feedback/feedback','/pages/functions/functions','/pages/detail/detail','/pages/signin/signin','/pages/terms/terms','/pages/notify/notify','/pages/profile/profile','/pages/favorites/favorites']);
  const entries = [...full.home.features, ...full.functions.groups.flatMap(g => g.items || [])];
  if (entries.some(x => !plain(x) || typeof x.label !== 'string' || (x.ready && !validPaths.has(x.url)))) error(400, '已启用的功能必须指向现有小程序页面');
  return patch;
}
function validateSchool(id, school) {
  const base = schools.find(s => s.id === id);
  if (!base || !plain(school) || school.id !== id) error(400, '只能维护已有院校，不可改动院校 ID');
  clean(school);
  for (const key of Object.keys(school)) if (!(key in base) && key !== 'visible') error(400, '未知院校字段：' + key);
  for (const key of ['nameCn','nameEn','region','countryCn','cityCn']) text(school[key], 160, key, true);
  if (school.region !== base.region) error(400, '不允许修改院校所属国家或地区');
  if (school.visible !== undefined && typeof school.visible !== 'boolean') error(400, '展示状态必须是布尔值');
  if (!Number.isInteger(school.qs) || school.qs < 1 || school.qs > 5000) error(400, 'QS 排名应为有效正整数');
  // qsLabel 是派生字段，后台不能手填，必须按 qs + 并列标记 + 区间 现算，
  // 否则会出现「QS 45」与前台「QS =45」不一致，或把区间院校谎报成精确名次。
  if (school.qsRange !== undefined && school.qsRange !== null) {
    if (typeof school.qsRange !== 'string' || !/^\d{3,4}-\d{3,4}$/.test(school.qsRange)) {
      error(400, 'QS 区间格式应为「801-850」这类「下界-上界」');
    }
  }
  school.qsLabel = 'QS ' + (school.qsRange || (school.qsTie ? '=' : '') + school.qs);
  school.qsDisplay = school.qsRange || (school.qsTie ? '=' : '') + school.qs;
  if (!Array.isArray(school.source) || school.source.some(x => typeof x !== 'string' || !/^https:\/\//.test(x))) error(400, '数据来源须为 HTTPS 官网链接');
  if (school.require !== null) {
    if (!plain(school.require) || !school.source.length) error(400, '录取要求必须提供数据来源；未知请设为 null');
    for (const [key, max] of [['gpa',100],['ielts',9],['ieltsSub',9],['toefl',120],['apMin',20]]) {
      const v = school.require[key]; if (v !== null && v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max)) error(400, key + '数值不合法，未知请填 null');
    }
    if (!Array.isArray(school.require.pathways)) error(400, '升学路径必须为数组');
  }
  return school;
}
function authorize(key, hash) {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) error(503, '管理员访问尚未配置');
  if (typeof key !== 'string' || key.length < 32 || key.length > 256) error(401, '管理密钥无效');
  const digest = crypto.createHash('sha256').update(key).digest();
  if (!crypto.timingSafeEqual(digest, Buffer.from(hash, 'hex'))) error(401, '管理密钥无效');
  return '管理员';
}
module.exports = { defaults, schools, STATUSES, PRIORITIES, TYPES, STATUS_LABEL, error, plain, clean, merge, revision, patchOf, assertRevision, text, validatePatch, validateSchool, authorize };
