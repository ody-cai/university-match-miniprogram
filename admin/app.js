"use strict";
const state = { key: '', tab: 'tickets', overview: null, tickets: [], users: [], schools: [], selectedTicket: null, selectedUser: null, selectedSchool: null };
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 云网关把本函数挂在 /admin 路径下，页面自身也在 /admin/ 目录，
// 所以接口基址必须跟随页面所在目录；若直接请求 /admin-api/...，浏览器会解析到站点根，
// 命中网关的 INVALID_PATH 404（根本不是云函数），表现为「密钥正确却一进就报错」。
const API_BASE = location.pathname.replace(/\/(?:index\.html)?$/, '');
const api = async (path, opts = {}) => { const headers = Object.assign({'Content-Type':'application/json','X-Admin-Key':state.key}, opts.headers || {}); const res = await fetch(API_BASE + path, Object.assign({}, opts, {headers})); const body = await res.json().catch(() => ({code:res.status,message:'服务返回不是有效 JSON'})); if (!res.ok || body.code !== 0) throw new Error(body.message || '请求失败'); return body.data; };
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(window.__toast); window.__toast = setTimeout(() => el.classList.remove('show'), 2600); }
function setConnection(ok) { const el = $('#connectionState'); el.textContent = ok ? '已连接' : '未连接'; el.className = 'status-dot ' + (ok ? 'online' : 'offline'); }
function loading(id) { $(id).innerHTML = '<div class="empty"><div class="skeleton" style="width:160px;margin:0 auto 13px"></div><div class="skeleton" style="width:240px;margin:auto"></div></div>'; }
function formatDate(v) { return v ? new Date(v).toLocaleString('zh-CN',{hour12:false}) : '—'; }
const typeLabel = {bug:'功能异常',data:'院校数据有误',idea:'功能建议',complaint:'投诉与举报',other:'其他'};
const statusLabel = {open:'待处理',processing:'处理中',resolved:'已解决',closed:'已关闭'};
const priorityLabel = {normal:'普通',high:'高',urgent:'紧急'};
async function boot() { try { state.overview = await api('/admin-api/overview'); setConnection(true); $('#loginView').classList.add('hidden'); $('#dashboardView').classList.remove('hidden'); $('#logoutBtn').classList.remove('hidden'); renderOverview(); await loadTickets(); } catch (e) { setConnection(false); $('#loginError').textContent = e.message; throw e; } }
// ⚠️ 用户计数在服务端取不到时是 `null`，不是 0。0 会被读成「一个用户都没有」——
//    那是编造结论。「确实是 0」与「读不到」在界面上必须能分开，所以这里显示「—」。
function renderOverview() { const t = state.overview.tickets || {}; const u = state.overview.users; const userCard = u ? ['注册用户', u.total||0, '', u.signedIn||0] : ['注册用户', '—', '', '—']; $('#overviewCards').innerHTML = [['全部工单',t.total||0,'',null],['待处理',t.open||0,(t.open?'alert':''),null],['处理中',t.processing||0,'',null],['已解决',t.resolved||0,'',null],userCard,['可管理院校',state.overview.schoolCount||0,'',null]].map(x=>`<div class="metric ${x[2]}"><div class="label">${x[0]}</div><div class="value">${x[1]}</div>${x[3]===null?'':`<div class="hint">其中保持登录 ${x[3]}</div>`}</div>`).join(''); }
async function loadTickets() { loading('#ticketsPanel'); try { const status = $('#ticketStatus')?.value || ''; const keyword = $('#ticketKeyword')?.value || ''; const data = await api('/admin-api/tickets?size=100&status='+encodeURIComponent(status)+'&keyword='+encodeURIComponent(keyword)); state.tickets = data.list || []; renderTickets(data); } catch(e) { $('#ticketsPanel').innerHTML = `<div class="empty">加载工单失败：${esc(e.message)}<br><button class="secondary" data-action="retry-tickets" style="margin-top:14px">重试</button></div>`; } }
function renderTickets(data) { const rows = state.tickets.map(t=>`<tr><td><button class="ghost ticket-id" data-action="ticket" data-id="${esc(t.ticketId)}">${esc(t.ticketId)}</button></td><td><span class="pill ${esc(t.status)}">${statusLabel[t.status]||'待处理'}</span><div style="margin-top:6px;color:#6b7885;font-size:11px">${esc(typeLabel[t.type]||t.type)}</div></td><td><div class="truncate" title="${esc(t.content)}">${esc(t.content)}</div><div style="font-size:11px;color:#8995a2;margin-top:4px">${esc(t.contact||'未留联系方式')}</div></td><td><span class="pill ${esc(t.priority)}">${priorityLabel[t.priority]||'普通'}</span></td><td>${formatDate(t.createdAt)}</td><td><button class="secondary" data-action="ticket" data-id="${esc(t.ticketId)}">处理</button></td></tr>`).join(''); $('#ticketsPanel').innerHTML = `<div class="panel-head"><div><div class="panel-title">投诉工单</div><div class="panel-sub">工单状态只代表内部处理进度；要触达用户请在工单详情的「受理通知」里发送微信服务通知（需该用户已在小程序里开启消息通知）。</div></div><div class="toolbar"><input id="ticketKeyword" class="control-input" placeholder="搜索工单内容 / 编号"><select id="ticketStatus" class="control-input"><option value="">全部状态</option>${Object.entries(statusLabel).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select><button class="secondary" data-action="filter-tickets">筛选</button></div></div>${rows?`<div class="table-wrap"><table class="data-table"><thead><tr><th>工单号</th><th>状态 / 类型</th><th>问题描述 / 联系方式</th><th>优先级</th><th>提交时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="empty">暂无工单。小程序新提交的投诉会在这里出现。</div>'}`; }
async function showTicket(id) { try { state.selectedTicket = await api('/admin-api/tickets/'+encodeURIComponent(id)); const t = state.selectedTicket; const shots = t.images && t.images.length ? await api('/admin-api/tickets/'+encodeURIComponent(id)+'/images').catch(function(){ return { list: [] }; }) : { list: [] }; const shotHtml = (t.images && t.images.length) ? `<div class="detail-block"><h3>用户提交的截图</h3><div class="shot-grid">${(shots.list||[]).map(x=>x.url?`<a class="shot" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(x.url)}" alt="工单截图" loading="lazy"></a>`:`<span class="shot shot--fail">暂时无法读取</span>`).join('')}</div></div>` : ''; $('#modalBody').innerHTML = `<div class="detail-head"><div class="eyebrow">TICKET</div><h2>${esc(t.ticketId)}</h2><div class="detail-meta">提交于 ${formatDate(t.createdAt)} · ${esc(typeLabel[t.type]||t.type)} · ${esc(t.contact||'未留联系方式')}</div></div><div class="detail-block"><h3>投诉 / 反馈内容</h3><p>${esc(t.content)}</p></div>${shotHtml}<div class="detail-block"><div class="form-grid"><label><span class="form-label">处理状态</span><select id="editStatus" class="control-input">${Object.entries(statusLabel).map(([k,v])=>`<option value="${k}" ${t.status===k?'selected':''}>${v}</option>`).join('')}</select></label><label><span class="form-label">优先级</span><select id="editPriority" class="control-input">${Object.entries(priorityLabel).map(([k,v])=>`<option value="${k}" ${t.priority===k?'selected':''}>${v}</option>`).join('')}</select></label><label><span class="form-label">负责人</span><input id="editAssignee" class="control-input" value="${esc(t.assignee)}" placeholder="可留空"></label><label><span class="form-label">关联院校</span><input class="control-input" value="${esc(t.schoolId||'未关联')}" disabled></label><label class="full"><span class="form-label">内部处理备注</span><textarea id="editNote" class="control-input" rows="3" placeholder="记录核查结论、后续动作等">${esc(t.note)}</textarea></label><label class="full"><span class="form-label">处理回复记录</span><textarea id="editReply" class="control-input" rows="3" placeholder="填写要反馈给用户的内容；填写后可在下方「受理通知」里发给他">${esc(t.reply)}</textarea></label></div><div class="action-row"><button class="primary" data-action="save-ticket">保存处理结果</button></div></div>${notifyBlock(t)}<div class="detail-block"><h3>历史记录</h3>${(t.history||[]).length ? t.history.map(x=>`<p class="detail-meta">${formatDate(x.createdAt)} · ${esc(x.admin||'管理端')} · ${esc(x.detail||x.action)}</p>`).join(''):'<p class="detail-meta">暂无处理记录。</p>'}</div>`; $('#modal').classList.remove('hidden'); } catch(e) { toast(e.message); } }
async function saveTicket() { const t = state.selectedTicket; try { await api('/admin-api/tickets/'+encodeURIComponent(t.ticketId), {method:'PATCH',body:JSON.stringify({revision:t.revision,status:$('#editStatus').value,priority:$('#editPriority').value,assignee:$('#editAssignee').value,note:$('#editNote').value,reply:$('#editReply').value})}); $('#modal').classList.add('hidden'); toast('工单已更新'); state.overview = await api('/admin-api/overview'); renderOverview(); await loadTickets(); } catch(e) { toast(e.message); } }
/**
 * 工单详情里的「受理通知」区块 —— 发送结果 + 发送按钮。
 * ------------------------------------------------------------------
 * ⚠️ 三种状态必须**分开渲染**，不要合并成「已通知 / 未通知」两态：
 *    · `t.notify === null`  —— **从未尝试**发送
 *    · 有 `attemptedAt` 无 `sentAt` —— 发过但**失败**，可以重试
 *    · 有 `sentAt`           —— 发过且**成功**，不可重复发（会烧掉用户的额度）
 *    合并会让「失败」看起来像「没发过」：运营要么反复点，要么以为已经通知过了。
 *    这是本项目反复强调的一条纪律（同 `favorites === null` 与 `[]` 的区别）。
 *
 * 取不到状态时（老工单没有该字段）走「从未尝试」分支 —— 那是**事实**，
 * 不是猜测：那一版代码里根本没有发送功能。
 */
function notifyBlock(t) {
  const n = t.notify;
  let body;
  if (!n) {
    body = '<p class="muted">尚未发送。若该用户已在小程序「我的 &gt; 偏好与其他 &gt; 消息通知」里开启，这里可以给他发一条微信服务通知。</p>';
  } else if (n.sentAt) {
    body = '<p class="muted">已于 ' + formatDate(n.sentAt) + ' 发送成功。同一张工单不能重复发送（每发一次都会消耗用户一条订阅额度）。</p>';
  } else {
    body = '<p class="error-text">发送失败（错误码 ' + esc(String(n.errCode === undefined ? '' : n.errCode)) + '）：' + esc(n.errMsg || '未知原因') + '</p>'
      + '<p class="muted">最近一次尝试：' + formatDate(n.attemptedAt) + '。修好原因后可以重试。</p>'
      + '<p class="muted">常见错误码：-604101 / -604100 = 云调用权限未登记（需在微信开发者工具里上传一次 admin 云函数）；43101 = 用户未订阅或额度已用掉。</p>';
  }
  const canSend = !n || !n.sentAt;
  return '<div class="detail-block"><h3>受理通知</h3>' + body
    + (canSend ? '<div class="action-row"><button class="secondary" data-action="notify-ticket">发送受理通知</button></div>' : '')
    + '</div>';
}
/**
 * 发送受理通知。
 * ⚠️ 发送前**必须二次确认**：订阅消息是不可逆的外部动作 ——
 *    它会消耗用户那一条一次性额度（微信规定一次授权只能发一条），
 *    发出去也收不回。而「点一下按钮」看起来太轻了。
 */
async function notifyTicket() {
  const t = state.selectedTicket;
  if (!t) return;
  if (!confirm('给这位用户发送微信服务通知？\n\n这会消耗他一次订阅额度（微信规定一次授权只能发一条），发出后无法撤回。')) return;
  try {
    const r = await api('/admin-api/tickets/' + encodeURIComponent(t.ticketId) + '/notify', {
      method: 'POST',
      body: JSON.stringify({ revision: t.revision }),
    });
    state.selectedTicket = r;
    toast(r && r.notifyResult && r.notifyResult.sentAt ? '受理通知已发送' : '发送失败，请看详情里的错误码');
    await showTicket(t.ticketId);
    await loadTickets();
  } catch (e) { toast(e.message); }
}
/* ==================================================================
   用户档案（users 集合）
   ------------------------------------------------------------------
   数据来源与小程序端 `api` 云函数写入的是**同一份** users 集合 —— 管理台
   不另起一套用户数据，也不缓存、不聚合，每次读到的就是库里的当前值。

   ⚠️ 服务端**不下发 openid**（契约 5 节），页面拿不到也展示不出来；
      能看到的「档案 ID」是 sha256('openid:…')，不可逆。这是有意的，
      不是配置问题 —— 别去服务端把它「补回来」。

   ⚠️ 成绩档案与收藏自 2026-09-22 起**已上云**（契约 2.2），详情页会展示。
      但展示的必须是**库里那份真实数据**：字段为空就显示「未填写」，
      绝不拿 0 或内容层的示例值去填 —— `defaultAcademic` 里的 GPA 86
      是版式示意图上的数字，不是任何用户的成绩。这条红线本项目踩过四次。
   ================================================================== */
/** 空值统一显示成「未填写」，不要拿 0 或占位串去冒充一个真实值 */
function blank(v, text) { return v ? esc(v) : `<span class="none">${esc(text)}</span>`; }
/**
 * 头像有两种来源：`https://`（自建后端上传）与 `cloud://`（云开发存储 fileID）。
 * ⚠️ `cloud://` 只有小程序内能解析，管理台的浏览器里**必然加载失败** ——
 *    直接丢进 `<img src>` 就是个裂图，看起来像「用户没设头像」。
 *    所以两种来源分开处理：不可预览的退化成文字占位，并把原因写进 title。
 */
function avatarOf(u) { if (/^https:\/\//.test(u.avatarUrl)) return `<img class="avatar" src="${esc(u.avatarUrl)}" alt="用户头像" loading="lazy">`; const initial = (u.nickName || '').trim().slice(0, 1) || '—'; return `<span class="avatar avatar--text" title="${esc(u.avatarUrl ? '头像存在云存储，管理台无法直接预览' : '用户未设置头像')}">${esc(initial)}</span>`; }
/**
 * 成绩项：值为空 → 「未填写」；有值 → 原样显示。
 * ⚠️ 不做任何补零 / 估算 / 折算 —— 0 分与「没填」是两件事。
 */
function scoreOrNone(v, suffix) { if (v === null || v === undefined || v === '') return '<span class="none">未填写</span>'; return esc(String(v) + (suffix || '')); }
/** 国际课程成绩：按体系分组展开（只列真的有科目的体系） */
function courseRows(a) { const map = a.coursesMap || {}; const labels = {}; (a.curriculumLabels || []).forEach(function (x) { labels[x.key] = x.label; }); const keys = Object.keys(map).filter(function (k) { return (map[k] || []).length; }); if (!keys.length) return ''; return keys.map(function (k) { const items = (map[k] || []).map(function (c) { const score = (c.score === null || c.score === undefined) ? '—' : String(c.score); const max = (c.max === null || c.max === undefined) ? '' : '/' + String(c.max); return esc((c.name || '') + ' ' + score + max + (c.date ? '（' + c.date + '）' : '')); }).join('、'); return '<dt>' + esc(labels[k] || k) + ' 课程</dt><dd>' + items + '</dd>'; }).join(''); }
/**
 * 成绩档案区块。
 * ⚠️ `academic === null` 表示「该用户从未保存过成绩」，不是「成绩都是 0」。
 *    两种情形的文案必须分开：前者是空态，后者根本不可能出现 ——
 *    服务端不收 0 分的均分（见 lib/academic.js 的 num()）。
 */
function academicBlock(a) {
  if (!a) return '<div class="detail-block"><h3>成绩档案</h3><div class="empty">该用户还没有保存过成绩（从未填写，或登录后尚未同步）。</div></div>';
  const ielts = a.ielts ? esc(a.ielts.overall + '（听 ' + a.ielts.l + ' / 读 ' + a.ielts.r + ' / 写 ' + a.ielts.w + ' / 说 ' + a.ielts.s + '）') : '<span class="none">未填写</span>';
  const kv = [['课程体系', blank(a.curriculumLabel, '未选择')], ['高中均分', scoreOrNone(a.gpa, ' / ' + (a.gpaScale || 100))], ['雅思', ielts], ['托福', scoreOrNone(a.toefl)], ['SAT', scoreOrNone(a.sat)], ['目标国家', (a.countryLabels || []).length ? esc(a.countryLabels.join('、')) : '<span class="none">未选择</span>'], ['目标专业', (a.majorLabels || []).length ? esc(a.majorLabels.join('、')) : '<span class="none">未选择</span>']].map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('');
  return '<div class="detail-block"><h3>成绩档案</h3><dl class="kv">' + kv + courseRows(a) + '</dl><div class="detail-meta" style="margin-top:10px">用户最近保存于 ' + formatDate(a.updatedAt) + '</div></div>';
}
/**
 * 收藏院校区块。
 * ⚠️ `missing: true`（院校已从库里下线）必须**照样列出来**并标明原因：
 *    那条收藏在用户那里是真实存在的，静默丢掉会让「收藏 5 所」只列出 4 所。
 */
function favoritesBlock(list, updatedAt) {
  /**
   * ⚠️ `null` 与 `[]` 是**两种不同的空态**，不能合并成一句「还没有收藏」：
   *    · `null` = 该用户从未同步过收藏（升级前的老账号，文档里没有这个字段）；
   *    · `[]`   = 同步过，但确实一所都没收藏。
   *    这与小程序侧 tier 的 `undefined` / `'unknown'` 是同一条纪律：
   *    「没有结论」与「结论是空的」必须能分开，否则排查「用户说收藏丢了」
   *    时分不清是「他真没收藏」还是「同步压根没跑成功」。
   */
  if (list === null || list === undefined) {
    return '<div class="detail-block"><h3>收藏院校</h3><div class="empty">该用户尚未同步过收藏 —— 可能是升级前的老账号，或登录后从未收藏过院校。</div></div>';
  }
  const rows = list;
  const body = rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>院校</th><th>国家 / 地区</th><th>排名</th><th>标识</th></tr></thead><tbody>' + rows.map(function (f) { const name = f.missing ? '<span class="none">不在当前院校库中</span>' : esc(f.nameCn || f.id); const sub = f.missing ? esc(f.id) : esc(f.nameEn || ''); return '<tr><td><div class="user-name">' + name + '</div><div class="user-sub">' + sub + '</div></td><td>' + (f.countryCn ? esc(f.countryCn) : '<span class="none">—</span>') + '</td><td>' + (f.qsLabel ? esc(f.qsLabel) : '<span class="none">—</span>') + '</td><td><code>' + esc(f.id) + '</code></td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">该用户已同步过收藏，但目前一所都没有。</div>';
  return '<div class="detail-block"><h3>收藏院校（' + rows.length + '）</h3>' + body + (updatedAt ? '<div class="detail-meta" style="margin-top:10px">最近同步 ' + formatDate(updatedAt) + '</div>' : '') + '</div>';
}
async function loadUsers() { loading('#usersPanel'); try { const keyword = $('#userKeyword') ? $('#userKeyword').value : ''; const data = await api('/admin-api/users?size=100&keyword='+encodeURIComponent(keyword)); state.users = data.list || []; renderUsers(data); } catch(e) { $('#usersPanel').innerHTML = `<div class="empty">加载用户档案失败：${esc(e.message)}<br><button class="secondary" data-action="retry-users" style="margin-top:14px">重试</button></div>`; } }
function renderUsers(data) { const rows = state.users.map(u=>`<tr><td><div class="user-cell">${avatarOf(u)}<div><div class="user-name">${blank(u.nickName,'未设置昵称')}</div><div class="user-sub">${blank(u.email,'未填邮箱')}</div></div></div></td><td>${blank(u.grade,'未填写')}<div class="user-sub">${blank(u.city,'未填写')}</div></td><td>${blank(u.plan,'未填写')}</td><td><span class="pill ${u.signedIn?'resolved':'closed'}">${u.signedIn?'保持登录':'已登出'}</span></td><td>${formatDate(u.createdAt)}</td><td><button class="secondary" data-action="user" data-id="${esc(u.id)}">查看</button></td></tr>`).join(''); $('#usersPanel').innerHTML = `<div class="panel-head"><div><div class="panel-title">用户档案</div><div class="panel-sub">共 ${data.total} 份档案 · 读的是小程序端写入的 users 集合；不含微信标识（服务端不下发）。成绩与收藏在「查看」里，列表不重复展开。</div></div><div class="toolbar"><input id="userKeyword" class="control-input" placeholder="搜索昵称 / 邮箱 / 年级 / 城市"><button class="secondary" data-action="filter-users">筛选</button></div></div>${rows?`<div class="table-wrap"><table class="data-table"><thead><tr><th>用户</th><th>年级 / 城市</th><th>申请计划</th><th>登录状态</th><th>建档时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="empty">还没有用户档案。用户在小程序内主动登录后才会建档。</div>'}`; }
/**
 * 用户详情 —— 基本信息 + 成绩档案 + 收藏院校。
 * ⚠️ 本页**只读**，不提供任何修改用户资料的入口：管理台能看不能改。
 *    改用户数据必须走用户自己在小程序里的操作，否则后台就成了
 *    「编造用户数据」的入口 —— 而那是本项目的红线。
 */
async function showUser(id) {
  try {
    const u = await api('/admin-api/users/' + encodeURIComponent(id));
    state.selectedUser = u;
    const kv = [['昵称', blank(u.nickName, '未设置昵称')], ['邮箱', blank(u.email, '未填写')], ['年级', blank(u.grade, '未填写')], ['城市', blank(u.city, '未填写')], ['申请计划', blank(u.plan, '未填写')], ['登录状态', u.signedIn ? '当前保持登录' : '已登出'], ['建档时间', formatDate(u.createdAt)], ['最近更新', formatDate(u.updatedAt)], ['档案 ID', '<code>' + esc(u.id) + '</code>']].map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('');
    $('#modalBody').innerHTML = '<div class="detail-head"><div class="eyebrow">USER PROFILE</div><h2>' + esc(u.nickName || '未设置昵称') + '</h2><div class="detail-meta">建档于 ' + formatDate(u.createdAt) + ' · ' + (u.signedIn ? '当前保持登录' : '已登出') + '</div></div>' +
      '<div class="detail-block"><h3>基本信息</h3><dl class="kv">' + kv + '</dl></div>' +
      academicBlock(u.academic) +
      favoritesBlock(u.favorites, u.favoritesUpdatedAt) +
      '<div class="detail-block"><div class="notice"><strong>关于这一页能看到什么</strong><br>· <strong>成绩与收藏</strong>：来自小程序端写入的 users 集合。用户在小程序里保存后即可见；换设备登录时也会同步到他所用的设备。<br>· <strong>微信标识（openid）</strong>：服务端不下发，管理台没有这项数据 —— 这是有意的，不是缺失。<br>· 本页为只读，不提供任何修改用户资料的入口。</div></div>';
    $('#modal').classList.remove('hidden');
  } catch (e) { toast(e.message); }
}
async function loadSchools() { loading('#schoolsPanel'); try { const data = await api('/admin-api/schools?keyword='+encodeURIComponent($('#schoolKeyword')?.value||'')); state.schools=data.list||[]; renderSchools(data); } catch(e) { $('#schoolsPanel').innerHTML=`<div class="empty">加载院校数据失败：${esc(e.message)}</div>`; } }
function renderSchools(data) { const cards=state.schools.map(s=>`<article class="school-card"><h3>${esc(s.nameCn)}</h3><p>${esc(s.nameEn)}</p><p>${esc(s.countryCn)} · ${esc(s.cityCn)} · QS ${esc(s.qs)}</p><div class="school-actions"><span class="pill ${s.visible===false?'closed':'resolved'}">${s.visible===false?'已隐藏':'展示中'}</span><button class="secondary" data-action="school" data-id="${esc(s.id)}">编辑要求</button></div></article>`).join(''); $('#schoolsPanel').innerHTML=`<div class="panel-head"><div><div class="panel-title">院校数据</div><div class="panel-sub">基线 ${data.total} 所；这里编辑的要求会通过内容补丁下发至小程序。</div></div><div class="toolbar"><input id="schoolKeyword" class="control-input" placeholder="搜索院校 / 城市"><button class="secondary" data-action="filter-schools">筛选</button></div></div>${cards?`<div class="school-grid">${cards}</div>`:'<div class="empty">没有找到院校。</div>'}`; }
async function showSchool(id) { try { state.selectedSchool=await api('/admin-api/schools/'+encodeURIComponent(id)); const s=state.selectedSchool.school; $('#modalBody').innerHTML=`<div class="detail-head"><div class="eyebrow">SCHOOL DATA</div><h2>${esc(s.nameCn)}</h2><div class="detail-meta">${esc(s.nameEn)} · ${esc(s.countryCn)} · QS ${esc(s.qs)}</div></div><div class="detail-block"><div class="notice">录取要求缺失时请使用 null，并确保来源链接来自学校官方招生页。数据更新后，匹配结果会按小程序规则重新计算。</div><label class="form-label">院校完整 JSON</label><textarea id="schoolEditor" class="editor" style="min-height:400px">${esc(JSON.stringify(s,null,2))}</textarea><label class="form-label" style="margin-top:14px">更新备注</label><input id="schoolNote" class="control-input" placeholder="例如：复核语言要求来源"><div class="action-row"><button class="primary" data-action="save-school">保存院校数据</button></div></div>`; $('#modal').classList.remove('hidden'); }catch(e){toast(e.message);} }
async function saveSchool() { const old=state.selectedSchool,s=JSON.parse($('#schoolEditor').value); try { const result=await api('/admin-api/schools/'+encodeURIComponent(s.id),{method:'PUT',body:JSON.stringify({school:s,revision:old.revision,note:$('#schoolNote').value})}); state.selectedSchool=result; $('#modal').classList.add('hidden'); toast('院校数据已发布'); await loadSchools(); }catch(e){toast(e.message);} }
function switchTab(name) { state.tab=name; document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===name)); document.querySelectorAll('.tab-panel').forEach(x=>x.classList.add('hidden')); $('#'+name+'Panel').classList.remove('hidden'); if(name==='users'&&!state.users.length)loadUsers(); if(name==='schools'&&!state.schools.length)loadSchools(); }
document.addEventListener('click', e=>{ const b=e.target.closest('[data-action]'); if(b){ const a=b.dataset.action; if(a==='ticket')showTicket(b.dataset.id); else if(a==='save-ticket')saveTicket(); else if(a==='notify-ticket')notifyTicket(); else if(a==='filter-tickets')loadTickets(); else if(a==='retry-tickets')loadTickets(); else if(a==='user')showUser(b.dataset.id); else if(a==='filter-users')loadUsers(); else if(a==='retry-users')loadUsers(); else if(a==='school')showSchool(b.dataset.id); else if(a==='filter-schools')loadSchools(); else if(a==='save-school')saveSchool(); } const tab=e.target.closest('.tab'); if(tab)switchTab(tab.dataset.tab); });
$('#loginBtn').addEventListener('click',()=>{state.key=$('#keyInput').value; if(!state.key)return $('#loginError').textContent='请输入管理密钥'; boot().catch(()=>{});}); $('#keyInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('#loginBtn').click();}); $('#refreshBtn').addEventListener('click',async()=>{try{state.overview=await api('/admin-api/overview');renderOverview();if(state.tab==='tickets')await loadTickets();if(state.tab==='users')await loadUsers();if(state.tab==='schools')await loadSchools();toast('数据已刷新')}catch(e){toast(e.message)}}); $('#logoutBtn').addEventListener('click',()=>{state.key='';location.reload()}); $('#modalClose').addEventListener('click',()=>$('#modal').classList.add('hidden')); $('#modal').addEventListener('click',e=>{if(e.target.id==='modal')$('#modal').classList.add('hidden')});
