#!/usr/bin/env bash
# End-to-end: two agent homes, one room, a real argument over a shared scene.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-18755}
export NO_COLOR=1

rm -rf /tmp/arena-host /tmp/arena-guest
export ARENA_HOME=/tmp/arena-host
node bin/arena.mjs create --topic "订单接口 502 到底是谁的锅" --scene ./examples/scene --name 房主 --role 后端 --port "$PORT" < /dev/null > /tmp/create.log 2>&1 || { echo "CREATE FAILED"; cat /tmp/create.log; exit 1; }
ROOM=$(grep -oP '房间号：\K[A-Z0-9]+' /tmp/create.log)
echo "== 房主开房 $ROOM =="

INVITE=$(sed -n '/【Agent 擂台战书】/,$p' /tmp/create.log)
export ARENA_HOME=/tmp/arena-guest
node bin/arena.mjs join "$INVITE" --name "老王-后端Agent" --role "后端" > /tmp/join.log 2>&1
echo "== 老王进房 =="
grep -E "已进房|agent-" /tmp/join.log | head -5

echo; echo "== 房主抛出开场靶子 =="
ARENA_HOME=/tmp/arena-host node bin/arena.mjs speak --seq 0 "订单接口 502 跟后端代码没关系，Nginx 自己超时了" 2>&1

echo; echo "== 老王 listen：应当被唤醒 =="
ARENA_HOME=/tmp/arena-guest timeout 30 node bin/arena.mjs listen --timeout 20 2>&1 | head -14

echo; echo "== 老王先去现场取证 =="
ARENA_HOME=/tmp/arena-guest node bin/arena.mjs status "正在翻 nginx 日志和连接池配置" 2>&1
ARENA_HOME=/tmp/arena-guest node bin/arena.mjs scene logs --pattern "prematurely" 2>&1 | head -6
ARENA_HOME=/tmp/arena-guest node bin/arena.mjs scene grep "maxOpenConns" 2>&1 | head -4

echo; echo "== 老王带证据开火 =="
ARENA_HOME=/tmp/arena-guest node bin/arena.mjs speak --seq 1 --evidence "logs/nginx-error.log:1 upstream prematurely closed → 后端进程断开；src/db_pool.ts:2 maxOpenConns=5" "别甩锅 Nginx。你 OrderController.ts 拿不到 client 就没 release，连接池只有 5 个，满了直接断连。" 2>&1

echo; echo "== 房主试图用旧 seq 发言 → 应被抢话拦截 =="
ARENA_HOME=/tmp/arena-host node bin/arena.mjs speak --seq 1 "我们有连接池监控……" 2>&1 | head -8

echo; echo "== 房主看到插话后改口 =="
ARENA_HOME=/tmp/arena-host node bin/arena.mjs speak --seq 2 --evidence "src/OrderController.ts:5 确实漏了 release" "行，OrderController 漏 release 这点认。但 mybatis 慢查询也占满了，改法是一起加禁言超时。" 2>&1

echo; echo "== 老王 pass 吃瓜（不扣 MP）=="
ARENA_HOME=/tmp/arena-guest node bin/arena.mjs pass --seq 3 2>&1

echo; echo "== 房主挂黑板 =="
echo '{"pool":{"maxOpenConns":20,"connMaxLifetimeMs":30000}}' > /tmp/openapi.json
ARENA_HOME=/tmp/arena-host node bin/arena.mjs board put fix-config --file /tmp/openapi.json 2>&1

echo; echo "== 全场状态 =="
ARENA_HOME=/tmp/arena-host node bin/arena.mjs status 2>&1

echo; echo "== 房主吹哨并出战报 =="
ARENA_HOME=/tmp/arena-host node bin/arena.mjs close --reason "证据链闭环" --conclusion "后端 OrderController 漏 release + 连接池 5 太小。改 maxOpenConns=20 并加 defer release。" 2>&1

echo; echo "== 老王 listen：应当收到收官 =="
ARENA_HOME=/tmp/arena-guest timeout 20 node bin/arena.mjs listen --timeout 5 2>&1 | head -8

echo; echo "== 攻击面自检 =="
ARENA_HOME=/tmp/arena-guest node bin/arena.mjs scene read ../../../etc/passwd 2>&1
ARENA_HOME=/tmp/arena-guest node bin/arena.mjs scene read .env 2>&1

echo; echo "== 清理 =="
pid=$(ss -lptn "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$pid" ] && kill "$pid" 2>/dev/null
echo done
