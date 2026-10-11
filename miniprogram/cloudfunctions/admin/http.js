'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const admin = require('./index');
const root = path.join(__dirname, 'static');
const hostingOrigin = process.env.HOSTING_ORIGIN || '';
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, overflow = false;
    req.on('data', chunk => { size += chunk.length; if (size > 300000) { overflow = true; chunks = []; } else if (!overflow) chunks.push(chunk); });
    req.on('end', () => { if (overflow) return reject(Object.assign(new Error('请求体过大'), { code: 413 })); try { resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('请求体不是有效 JSON'), { code: 400 })); } });
    req.on('error', reject);
  });
}
async function main(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.headers.origin === hostingOrigin) {
    res.setHeader('Access-Control-Allow-Origin', hostingOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, OPTIONS');
  }
  if (req.method === 'OPTIONS') return send(res, req.headers.origin === hostingOrigin ? 204 : 403, '');
  // 云网关会去掉 /admin 前缀，本地直连则保留；两种入口归一化后使用同一路由。
  let route = url.pathname;
  if (route === '/admin' || route.startsWith('/admin/')) route = route.slice(6) || '/';
  const staticFiles = { '/': ['index.html','text/html; charset=utf-8'], '/index.html':['index.html','text/html; charset=utf-8'], '/styles.css':['styles.css','text/css; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'] };
  if (staticFiles[route] && req.method === 'GET') {
    const [file, type] = staticFiles[route];
    return send(res, 200, fs.readFileSync(path.join(root,file),'utf8'), type);
  }
  if (!route.startsWith('/admin-api/')) return send(res,404,{code:404,message:'资源不存在',data:null});
  const data = ['GET','HEAD'].includes(req.method) ? {} : await bodyOf(req);
  const result = await admin.main({ path:route,httpMethod:req.method,headers:req.headers,body:data,queryString:Object.fromEntries(url.searchParams) });
  const code = result.code === 0 ? 200 : (Number.isInteger(result.code) && result.code >= 400 && result.code <= 599 ? result.code : 500);
  return send(res, code, result);
}
const server = http.createServer((req,res) => main(req,res).catch(e => send(res,e.code || 500,{code:e.code || 500,message:e.code ? e.message : '服务器暂不可用，请稍后重试',data:null})));
if (require.main === module) server.listen(Number(process.env.PORT || 9000), process.env.LOCAL_PREVIEW === '1' ? '127.0.0.1' : '0.0.0.0');
module.exports = { server, main };
