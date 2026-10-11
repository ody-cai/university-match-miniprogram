#!/usr/bin/env bash
#
# 部署 admin 云函数（微信云开发 · HTTP 访问服务）+ 自动验证
# ==================================================================
# 为什么不能手敲 `tcb fn deploy admin`：
#
#   2026-09-22 实测，直接在本项目根目录跑 `tcb fn deploy` 会**报「✔ 云函数部署成功！」**
#   并把控制台里的修改时间刷新到当前，**但线上跑的是旧代码**（新增的 handler 不在包里，
#   新登记的路由照样 501），**全程没有任何报错**。根因是项目根没有 `cloudbaserc.json` 时
#   CLI 走「智能推测」，打包范围与函数的代码根都会落错位置。
#   ⇒ 判据从来不是那句「成功」，而是**下回来的文件清单 + 真打一次线上**。
#
#   ⚠️ 一个被证伪的判据，别再拿它当证据（2026-09-22 实测）：
#      「CodeSize 11 MB ⇒ 一定是把整个项目打进去了」—— **假的**。
#      把线上代码 down 下来数过：顶层是 `index.js / handlers.js / http.js / static / data /
#      node_modules`，**没有任何 `.git` / `README.md` / `.workbuddy`**；
#      11 MB 主要就是云端装好的 `wx-server-sdk` 及其依赖（解压后 6404 个文件 / 54 MB）。
#      ⇒ 判「打包范围对不对」要看**文件清单的顶层结构**，不能看体积。
#
# 本脚本固化三件事：
#   ① 在**只含这一个函数的暂存目录**里部署，`functionRoot: "."` + 同名子目录，路径无歧义；
#   ② 显式带上 `--httpFn`（admin 是 HTTP 访问型函数；CLI 默认是 Event 型，
#      漏了会把函数类型改掉 —— 那等于把后台整站打死，且不会有明显报错）；
#      ⚠️ 但**不要**带 `--path`：访问路径 `/admin` 首次部署时就创建了，重复创建会报 `Path is used`；
#   ③ 部署完自己回读 + 真打线上：文件清单、路由字符串、页面页签、带密钥的接口、无密钥的 401。
#
# 密钥处理（三条都不能破）：
#   · 明文只在 `admin/.admin-key`（已 gitignore），**不进仓库、不进日志、不进 argv**；
#   · 服务端只存 `ADMIN_KEY_SHA256`。⚠️ 部署时若 rc 里不写它，可能被清空 →
#     表现为「密钥正确也进不去后台（503 未配置）」。所以本脚本**从本机密钥现算摘要**带上去；
#   · 带密钥的 HTTP 探测用 `curl -K -`（配置走 stdin），**避免密钥出现在进程 argv 里**。
#
# 用法：bash tools/deploy-admin-function.sh
# 退出码：0 = 部署且验证全部通过；非 0 = 任一步失败（此时线上可能仍跑旧代码）
#
# ⚠️ 密钥文件位置：默认取本仓库根的 `admin/.admin-key`。但本项目常以 **git worktree**
#    形式开工，而 `.admin-key` 已 gitignore —— 它只存在于当年第一次部署的那个工作区里，
#    新建的 worktree 里没有。此时用 `ADMIN_KEY_FILE=<绝对路径>` 指过去即可，
#    **不要**为了省事把密钥复制进新工作区（多一份副本就多一处泄露面）。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FN_NAME="admin"
FN_SRC="$ROOT/miniprogram/cloudfunctions/$FN_NAME"
STAGE="${TMPDIR:-/tmp}/tcb-deploy-$FN_NAME"
DL_DIR="${TMPDIR:-/tmp}/tcb-download-$FN_NAME"
KEY_FILE="${ADMIN_KEY_FILE:-$ROOT/admin/.admin-key}"

# ---- 1. 环境 ID 只从运行期私有配置取，不在本脚本里再写一份（避免两处漂移）----
ENV_ID="$(sed -n "s/.*cloudEnvId:[[:space:]]*['\"]\([^'\"]*\)['\"].*/\1/p" "$ROOT/miniprogram/private/config.js" | head -1)"
if [ -z "$ENV_ID" ]; then
  echo "✖ 没能从 miniprogram/private/config.js 读到云开发环境 ID" >&2
  exit 1
fi

for f in index.js handlers.js domain.js http.js scf_bootstrap package.json config.json static/app.js static/index.html data/schools.json; do
  [ -f "$FN_SRC/$f" ] || { echo "✖ 缺少源文件：$FN_SRC/$f" >&2; exit 1; }
done

# config.json 里的云调用权限是本函数「能发订阅消息」的前提。
# ⚠️ 它**只有用微信开发者工具上传时才会被同步成权限**（官方原文：「在每次使用
#    微信开发者工具上传云函数时均会根据配置更新权限」）。tcb CLI 部署不会登记
#    权限 —— 表现为发送时返回 -604101。所以这里只校验声明文件对不对，
#    真实权限状态要靠部署后的真发一次才知道。
if ! grep -q '"subscribeMessage.send"' "$FN_SRC/config.json" 2>/dev/null; then
  echo "✖ config.json 未声明 subscribeMessage.send —— 后台「发送受理通知」会返回 -604101" >&2
  exit 1
fi

# 静态页是影子副本：漏同步就会「页面改了、线上还是旧的」。部署前强制校验一次。
echo "── 前置：静态页影子副本一致性 ──"
node "$ROOT/tools/sync-data-copies.js" --check | tail -1

# ---- 2. 密钥 → 摘要（明文只在变量里，不打印、不落盘）----
if [ ! -f "$KEY_FILE" ]; then
  echo "✖ 找不到 $KEY_FILE —— 本脚本需要它现算 ADMIN_KEY_SHA256。" >&2
  echo "  缺失时**不要**直接部署：rc 里不带摘要可能把线上配置清空，后台会变成「未配置」。" >&2
  exit 1
fi
ADMIN_KEY="$(cat "$KEY_FILE")"
ADMIN_KEY_HASH="$(printf '%s' "$ADMIN_KEY" | shasum -a 256 | awk '{print $1}')"
if [ "${#ADMIN_KEY}" -lt 32 ]; then
  echo "✖ 本机密钥短于 32 字符，服务端一律拒绝（domain.authorize）" >&2
  exit 1
fi

echo "环境：$ENV_ID"
echo "源目录：$FN_SRC"
echo "密钥：已从 $KEY_FILE 读取（${#ADMIN_KEY} 字符），摘要 ${ADMIN_KEY_HASH:0:8}…（只打印前 8 位）"

# ---- 3. 组一个只含该函数的暂存目录 ----
rm -rf "$STAGE"
mkdir -p "$STAGE/$FN_NAME"
cp -R "$FN_SRC/." "$STAGE/$FN_NAME/"
rm -rf "$STAGE/$FN_NAME/node_modules"   # 依赖交给云端安装

cat > "$STAGE/cloudbaserc.json" <<JSON
{
  "\$schema": "https://static.cloudbase.net/cli/cloudbaserc.schema.json",
  "envId": "$ENV_ID",
  "region": "ap-shanghai",
  "functionRoot": ".",
  "functions": [
    {
      "name": "$FN_NAME",
      "runtime": "Nodejs16.13",
      "handler": "index.main",
      "timeout": 20,
      "memorySize": 256,
      "envVariables": {
        "ADMIN_KEY_SHA256": "$ADMIN_KEY_HASH"
      }
    }
  ]
}
JSON

echo "暂存目录内容（应只有函数本体 + cloudbaserc.json）："
( cd "$STAGE" && find . -type f -not -path "*/node_modules/*" | sort | sed 's/^/  /' )

# ---- 4. 部署 ----
echo
echo "── 部署（HTTP 函数；不带 --path）──"
( cd "$STAGE" && tcb fn deploy "$FN_NAME" --force --httpFn )

# ---- 5. 验证 1/3：下回线上代码，核对文件与本轮新增的路由 ----
echo
echo "── 验证 1/3：下回线上代码，核对文件清单与路由 ──"
rm -rf "$DL_DIR"
mkdir -p "$DL_DIR"
# 进度条走 stderr，收进文件；失败时才回显，免得刷满屏
if ! tcb fn code download "$FN_NAME" "$DL_DIR" -e "$ENV_ID" > "$DL_DIR/.dl.log" 2>&1; then
  echo "  ✗ 下载线上代码失败：" >&2
  tail -3 "$DL_DIR/.dl.log" >&2
  exit 1
fi

fail=0
for f in index.js handlers.js domain.js http.js package.json config.json static/app.js static/index.html data/schools.json; do
  if [ -f "$DL_DIR/$f" ]; then
    echo "  ✓ 线上含 $f"
  else
    echo "  ✗ 线上缺 $f —— 发上去的不是当前代码" >&2
    fail=1
  fi
done

grep -q '"subscribeMessage.send"' "$DL_DIR/config.json" 2>/dev/null \
  && echo "  ✓ 线上 config.json 已声明 subscribeMessage.send（云调用权限声明就位）" \
  || { echo "  ✗ 线上 config.json 没有云调用权限声明" >&2; fail=1; }

grep -q '/admin-api/users' "$DL_DIR/index.js" 2>/dev/null \
  && echo "  ✓ 线上 index.js 已登记 /admin-api/users" \
  || { echo "  ✗ 线上 index.js 没有用户档案路由 —— 仍是旧代码" >&2; fail=1; }
grep -q 'function userView' "$DL_DIR/handlers.js" 2>/dev/null \
  && echo "  ✓ 线上 handlers.js 含 userView（用户视图白名单）" \
  || { echo "  ✗ 线上 handlers.js 缺 userView" >&2; fail=1; }
grep -q 'data-tab="users"' "$DL_DIR/static/index.html" 2>/dev/null \
  && echo "  ✓ 线上静态页含「用户档案」页签" \
  || { echo "  ✗ 线上静态页还是旧的（缺用户档案页签）" >&2; fail=1; }
if grep -q 'data-tab="content"' "$DL_DIR/static/index.html" 2>/dev/null; then
  echo "  ✗ 线上静态页仍有「内容管理」页签（该入口应已下线）" >&2
  fail=1
else
  echo "  ✓ 线上静态页已无「内容管理」页签"
fi

# ---- 6. 验证 2/3：真打线上页面与接口（密钥走 stdin，不进 argv）----
echo
echo "── 验证 2/3：真打线上（HTTP 访问服务）──"
HOST="https://$ENV_ID-1490301661.ap-shanghai.app.tcloudbase.com"

page="$(curl -s "$HOST/admin" || true)"
if printf '%s' "$page" | grep -q 'data-tab="users"'; then
  echo "  ✓ GET /admin 返回的新页面里已有用户档案页签"
else
  echo "  ✗ GET /admin 还是旧页面" >&2
  fail=1
fi

# 无密钥必须 401（鉴权是入口第一条语句，不能被绕过）
no_key="$(curl -s "$HOST/admin/admin-api/overview" || true)"
if printf '%s' "$no_key" | grep -q '"code":401'; then
  echo "  ✓ 不带密钥访问概览 → 401（鉴权仍生效）"
else
  echo "  ✗ 不带密钥竟然不是 401：$(printf '%s' "$no_key" | head -c 120)" >&2
  fail=1
fi

# 带密钥：概览里应出现 users 计数；用户列表不该再是 404
ov="$(printf 'header = "X-Admin-Key: %s"\nurl = "%s/admin/admin-api/overview"\n' "$ADMIN_KEY" "$HOST" | curl -s -K - || true)"
if printf '%s' "$ov" | grep -q '"users"'; then
  echo "  ✓ 概览已含 users 计数：$(printf '%s' "$ov" | sed -n 's/.*"users":\([^,}]*\).*/\1/p' | head -1)"
else
  echo "  ✗ 概览里没有 users 字段：$(printf '%s' "$ov" | head -c 160)" >&2
  fail=1
fi

users="$(printf 'header = "X-Admin-Key: %s"\nurl = "%s/admin/admin-api/users?size=1"\n' "$ADMIN_KEY" "$HOST" | curl -s -K - || true)"
if printf '%s' "$users" | grep -q '"code":404'; then
  echo "  ✗ /admin-api/users 仍返回 404 —— 路由没上云" >&2
  fail=1
elif printf '%s' "$users" | grep -q '"code":0'; then
  echo "  ✓ /admin-api/users 可用（返回 $(printf '%s' "$users" | grep -o '"total":[0-9]*' | head -1)）"
else
  echo "  ✗ /admin-api/users 返回异常：$(printf '%s' "$users" | head -c 160)" >&2
  fail=1
fi

# ---- 7. 验证 3/3：函数类型与打包范围 ----
echo
echo "── 验证 3/3：函数类型 + 打包范围（判据是文件清单，不是体积）──"
detail="$(tcb fn detail "$FN_NAME" -e "$ENV_ID" --json 2>/dev/null || true)"
# ⚠️ 不能拿 sed 抠 JSON：`"Type"` 会命中 `"FilterType"` / `"SFType"` 之类，
#    第一次就这么取到了空值，然后误报「函数类型不是 HTTP」。用 node 正经解析。
type="$(printf '%s' "$detail" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s).data||{};process.stdout.write(String(j.Type||''));}catch(e){process.stdout.write('');}})" 2>/dev/null || true)"
size="$(printf '%s' "$detail" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s).data||{};process.stdout.write(String(j.CodeSize||''));}catch(e){process.stdout.write('');}})" 2>/dev/null || true)"
echo "  · 函数类型：${type:-读不到}（应为 HTTP）｜包大小：${size:-读不到} 字节（含云端装的依赖，约 10 MB 属正常）"
[ "${type:-}" = "HTTP" ] || { echo "  ✗ 函数类型不是 HTTP —— 后台整站会打不开（CLI 默认是 Event 型，是不是漏了 --httpFn？）" >&2; fail=1; }

# 打包范围看**顶层结构**：顶层必须就是函数本体，且绝不能出现项目级目录。
# ⚠️ 若出现 `miniprogram/` 或 `.git`，说明打错了根 —— 那才是真事故。
for must in index.js handlers.js http.js static data; do
  [ -e "$DL_DIR/$must" ] || { echo "  ✗ 线上包顶层缺 $must" >&2; fail=1; }
done
leaked="$(find "$DL_DIR" -maxdepth 1 \( -name '.git' -o -name 'README.md' -o -name '.workbuddy' -o -name 'miniprogram' -o -name 'tools' \) -print | head -5)"
if [ -z "$leaked" ]; then
  echo "  ✓ 线上包顶层没有混进项目级文件（无 .git / README.md / .workbuddy / miniprogram / tools）"
else
  echo "  ✗ 线上包顶层混进了项目级内容：$leaked —— 打包范围又变成了整个项目" >&2
  fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "✖ 部署未通过验证 —— 线上可能仍是旧代码，别当它成功了。" >&2
  exit 1
fi

echo "✔ admin 云函数已部署并验证通过。"
echo "  后台入口：$HOST/admin"
echo "  ⚠️ 云调用权限（subscribeMessage.send）**不由本次部署登记**：微信只认"
echo "     【微信开发者工具】右键上传云函数时同步的 config.json 权限声明，"
echo "     tcb CLI 只发代码。首次启用「发送受理通知」前必须做这一步，"
echo "     否则发送返回 -604101；权限有约 10 分钟缓存。"
echo "  下一步（可选）：ADMIN_KEY=\"\$(cat admin/.admin-key)\" node tools/browser-check-admin.js  # 打线上跑真实浏览器端到端"
