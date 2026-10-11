'use strict';
const cloud = require('wx-server-sdk');
// 初始化必须早于加载 handlers，后者会立即获取数据库实例。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const h = require('./handlers');
const d = require('./domain');
function response(code, message, data) { return { code, message: message || '', data: data === undefined ? null : data }; }
function parseBody(event) { if (event && event.body && typeof event.body === 'string') { try { return JSON.parse(event.body); } catch (e) { d.error(400, '请求体不是有效 JSON'); } } return (event && event.body) || (event && event.data) || {}; }
function key(event) { const headers = (event && (event.headers || event.header)) || {}; return headers['x-admin-key'] || headers['X-Admin-Key'] || ''; }
function pathOf(event) { return String((event && (event.path || event.requestContext && event.requestContext.path)) || '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'; }
exports.main = async (event) => {
  try {
    const path = pathOf(event), method = String((event && (event.httpMethod || event.method)) || 'GET').toUpperCase();
    const config = process.env.ADMIN_KEY_SHA256 || '';
    d.authorize(key(event), config);
    if (method === 'GET' && path === '/admin-api/audit') return response(0, '', await h.auditList());
    if (method === 'GET' && path === '/admin-api/overview') return response(0, '', await h.overview());
    if (method === 'GET' && path === '/admin-api/content') return response(0, '', await h.getContent());
    if (method === 'PUT' && path === '/admin-api/content') { const body = parseBody(event); return response(0, '', await h.putContent(body, 'admin')); }
    if (method === 'GET' && path === '/admin-api/tickets') return response(0, '', await h.listTickets(Object.assign({}, event.queryString || {}, event.query || {})));
    // 用户档案：只读。集合与小程序端 api 云函数写入的是同一份（users）。
    if (method === 'GET' && path === '/admin-api/users') return response(0, '', await h.listUsers(Object.assign({}, event.queryString || {}, event.query || {})));
    const user = path.match(/^\/admin-api\/users\/([^/]+)$/);
    if (user && method === 'GET') return response(0, '', await h.getUser(decodeURIComponent(user[1])));
    const ticket = path.match(/^\/admin-api\/tickets\/([^/]+)$/);
    if (ticket && method === 'GET') return response(0, '', await h.getTicket(decodeURIComponent(ticket[1])));
    if (ticket && method === 'PATCH') return response(0, '', await h.updateTicket(decodeURIComponent(ticket[1]), parseBody(event), 'admin'));
    const images = path.match(/^\/admin-api\/tickets\/([^/]+)\/images$/);
    if (images && method === 'GET') return response(0, '', await h.listImages(decodeURIComponent(images[1])));
    /**
     * 发送受理通知（订阅消息）。
     * ⚠️ 刻意是**独立的一个动作**，而不是挂在 PATCH 工单上：订阅消息会消耗
     *    用户那一条一次性额度且收不回，不该被「顺手改个状态」带出去。
     */
    const notify = path.match(/^\/admin-api\/tickets\/([^/]+)\/notify$/);
    if (notify && method === 'POST') return response(0, '', await h.notifyTicket(decodeURIComponent(notify[1]), parseBody(event), 'admin'));
    if (method === 'GET' && path === '/admin-api/schools') return response(0, '', await h.listSchools(Object.assign({}, event.queryString || {}, event.query || {})));
    const school = path.match(/^\/admin-api\/schools\/([^/]+)$/);
    if (school && method === 'GET') return response(0, '', await h.getSchool(decodeURIComponent(school[1])));
    if (school && method === 'PUT') return response(0, '', await h.putSchool(decodeURIComponent(school[1]), parseBody(event), 'admin'));
    return response(404, '后台接口不存在', null);
  } catch (e) { console.error('[admin]', e); return response(e.code || 500, e.message || '服务器开小差了，请稍后再试', null); }
};
