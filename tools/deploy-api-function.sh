#!/usr/bin/env bash
#
# 部署 api 云函数（微信云开发）+ 自动验证
# ==================================================================
# 为什么需要一个脚本，而不是直接 `tcb fn deploy api`：
#
#   2026-09-22 实测，直接在本项目根目录跑 `tcb fn deploy api --dir miniprogram/cloudfunctions/api --force`
#   会**报「✔ 云函数部署成功！」并把修改时间刷新到当前**，但线上跑的是**旧代码** ——
#   `GET /v1/user/profile` 依然返回 501，`handlers/user.js` 根本不在包里。
#
#   根因：项目根目录没有 `cloudbaserc.json`，CLI 走「智能推测」，
#   打包范围变成**整个项目**（含 `.git/`、其它函数的旧副本、`.workbuddy/tmp/` 里的历史 staging），
#   函数的代码根落到了错误的位置。工作区里还并存着另一个 git worktree 的旧副本，更容易踩。
#
#   ⇒ 结论有两条，本脚本把两条都固化了：
#     ① 在**只含这一个函数的暂存目录**里部署，并显式给 `functionRoot`，让路径解析没有歧义；
#     ② 「部署成功」这四个字**不足为凭**，必须自己下回来 + 真 invoke 一次才算部署完成。
#
# 用法：bash tools/deploy-api-function.sh
# 退出码：0 = 部署且验证通过；非 0 = 任一步失败（此时线上可能仍是旧代码）
#
set -euo pipefail

# ---- 0. 定位仓库根（脚本在 tools/ 下，用脚本自身的路径推，不依赖调用者的 cwd）----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FN_SRC="$ROOT/miniprogram/cloudfunctions/api"
FN_NAME="api"
STAGE="${TMPDIR:-/tmp}/tcb-deploy-$FN_NAME"
DL_DIR="${TMPDIR:-/tmp}/tcb-download-$FN_NAME"

# ---- 1. 环境 ID 只从 request.js 取，不在本脚本里再写一份（避免两处漂移）----
ENV_ID="$(sed -n "s/.*env:[[:space:]]*'\([^']*\)'.*/\1/p" "$ROOT/miniprogram/utils/request.js" | head -1)"
if [ -z "$ENV_ID" ]; then
  echo "✖ 没能从 miniprogram/utils/request.js 读到云开发环境 ID（CONFIG.env 是否为空？）" >&2
  echo "  本脚本刻意不硬编码环境 ID：写两份迟早漂移。" >&2
  exit 1
fi

for f in index.js handlers/user.js lib/users.js package.json; do
  [ -f "$FN_SRC/$f" ] || { echo "✖ 缺少源文件：$FN_SRC/$f" >&2; exit 1; }
done

echo "环境：$ENV_ID"
echo "源目录：$FN_SRC"

# ---- 2. 组一个只含该函数的暂存目录 ----
rm -rf "$STAGE"
mkdir -p "$STAGE/$FN_NAME"
cp -R "$FN_SRC/." "$STAGE/$FN_NAME/"
rm -rf "$STAGE/$FN_NAME/node_modules"   # 依赖交给云端安装（函数配置里 自动安装依赖 = TRUE）

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
      "timeout": 3,
      "memorySize": 256
    }
  ]
}
JSON

echo "暂存目录内容（应只有函数本体 + cloudbaserc.json）："
( cd "$STAGE" && find . -type f -not -path "*/node_modules/*" | sort | sed 's/^/  /' )

# ---- 3. 部署 ----
echo
echo "── 部署 ──"
( cd "$STAGE" && tcb fn deploy "$FN_NAME" --force )

# ---- 4. 验证：把线上代码下回来，核对文件与路由 ----
echo
echo "── 验证 1/2：下回线上代码，核对文件清单 ──"
rm -rf "$DL_DIR"
mkdir -p "$DL_DIR"
tcb fn code download "$FN_NAME" "$DL_DIR" -e "$ENV_ID" >/dev/null

fail=0
for f in index.js lib/users.js lib/academic.js handlers/user.js handlers/academic.js handlers/favorites.js handlers/notify.js; do
  if [ -f "$DL_DIR/$f" ]; then
    echo "  ✓ 线上含 $f"
  else
    echo "  ✗ 线上缺 $f —— 发上去的不是当前代码" >&2
    fail=1
  fi
done

# ROUTES 条数：契约 2.2 的「端点实现状态」表里 ✅ 应有 13 条静态 + 2 条通配 = 15 条
n_routes=$(sed -n "/const ROUTES = {/,/^};/p" "$DL_DIR/index.js" 2>/dev/null | grep -cE "^[[:space:]]*'[A-Z]+ /v1/" || true)
echo "  · 线上 ROUTES 条数：$n_routes（期望 13）"
[ "$n_routes" -eq 13 ] || { echo "  ✗ ROUTES 条数不符" >&2; fail=1; }

# PATTERNS 条数：收藏 / 取消走的是**带路径参数**的通配路由。
# ⚠️ 漏掉它的表现是「收藏端点永远 501 → 客户端静默回落本机」，
#    也就是「收藏只在这台手机上」，而且**没有任何报错**。
n_patterns=$(sed -n "/const PATTERNS = \[/,/\]\.map(/p" "$DL_DIR/index.js" 2>/dev/null | grep -cE "method: '[A-Z]+', path: '/v1/" || true)
echo "  · 线上 PATTERNS 条数：$n_patterns（期望 2）"
[ "$n_patterns" -eq 2 ] || { echo "  ✗ PATTERNS 条数不符（收藏端点会永远 501 且不报错）" >&2; fail=1; }

# ---- 5. 验证：真 invoke，确认关键端点按契约响应 ----
echo
echo "── 验证 2/2：真 invoke 关键端点 ──"

# 通用探测。期望值写的是**契约规定的 code**，不是「不是 501 就行」：
# 未登录时读接口应 0（data:null）、写接口应 401。若拿到 501，
# 说明这条路由没上云 —— 那正是「界面在说谎」的起点。
probe() {
  local label="$1" expect="$2" params="$3" out code
  out="$(tcb fn invoke "$FN_NAME" -e "$ENV_ID" --params "$params" 2>&1 || true)"
  code="$(printf '%s' "$out" | grep -o '"code":[0-9]*' | head -1 | grep -o '[0-9]*' || true)"
  if [ "$code" = "$expect" ]; then
    echo "  ✓ $label → code $code"
  else
    echo "  ✗ $label：期望 $expect，实得 ${code:-无响应}（501 = 该端点没上云）" >&2
    fail=1
  fi
}

probe 'GET /v1/user/profile（未登录 → 0 + data:null）' 0 '{"path":"/v1/user/profile","method":"GET"}'
probe 'PUT /v1/user/profile（未登录 → 401）' 401 '{"path":"/v1/user/profile","method":"PUT","data":{"nickName":"probe"}}'
probe 'GET /v1/academic/profile（未登录 → 0 + data:null）' 0 '{"path":"/v1/academic/profile","method":"GET"}'
probe 'PUT /v1/academic/profile（未登录 → 401）' 401 '{"path":"/v1/academic/profile","method":"PUT","data":{"gpa":90}}'
probe 'GET /v1/favorites（未登录 → 0 + data:null）' 0 '{"path":"/v1/favorites","method":"GET"}'
# ⚠️ 下面两条走 PATTERNS 通配路由，必须真探一次：
#    只有它们能证明「带路径参数的匹配」在线上是通的。
probe 'POST /v1/favorites/{id}（通配路由，未登录 → 401）' 401 '{"path":"/v1/favorites/probe-does-not-exist","method":"POST"}'
probe 'DELETE /v1/favorites/{id}（通配路由，未登录 → 401）' 401 '{"path":"/v1/favorites/probe-does-not-exist","method":"DELETE"}'
# 订阅消息（契约 4.9）。⚠️ 注意语义与上面的 profile 不同：
#   它**不要求业务登录**（订阅按微信身份 openid 记录，与 POST /v1/feedback 同理），
#   所以「拿不到微信身份」返回的是 400 而不是 401。
probe 'GET /v1/notify（无记录 → 0 + data:null）' 0 '{"path":"/v1/notify","method":"GET"}'
probe 'PUT /v1/notify（无微信身份 → 400）' 400 '{"path":"/v1/notify","method":"PUT","data":{"accepted":true,"templateId":"probe"}}'

echo
if [ "$fail" -ne 0 ]; then
  echo "✖ 部署未通过验证 —— 线上可能仍是旧代码，别当它成功了。" >&2
  exit 1
fi

echo "✔ api 云函数已部署并验证通过。"
echo "  契约 2.2「端点实现状态」表里标 ✅ 的 15 条，现在才真的都通了。"
