#!/usr/bin/env bash
# 递归同步 @deepseek-ai 依赖闭包到内网 registry.ict.cmcc（无 uplink，需手动补全）。
# 用法: bash scripts/sync-deps-internal.sh <ver> <rootPkg...>
#   例: bash scripts/sync-deps-internal.sh 0.1.1-rc.2 @deepseek-ai/dsh-mcp-client
set -u
INTERNAL="http://registry.ict.cmcc"
VER="${1:?用法: sync-deps-internal.sh <版本> <包...>}"; shift
WORK="$(mktemp -d /tmp/sync-dep.XXXXXX)"
declare -A seen

has_internal() {
  local enc="${1//\//%2f}"
  curl -s "$INTERNAL/$enc" | grep -q "\"$VER\"" 2>/dev/null
}

deps_of() {
  tar -xzf "$1" -O package/package.json 2>/dev/null | node -e "
    let s=\"\"; process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{
      const p=JSON.parse(s); const out=new Set();
      for (const k of [\"peerDependencies\",\"dependencies\"]) {
        for (const n of Object.keys(p[k]||{})) if (n.startsWith(\"@deepseek-ai/\")) out.add(n);
      }
      console.log([...out].join(\" \"));
    });
  "
}

queue=( "$@" ); idx=0
while [ $idx -lt ${#queue[@]} ]; do
  pkg="${queue[$idx]}"; idx=$((idx+1))
  [ -n "${seen[$pkg]:-}" ] && continue
  seen[$pkg]=1
  sub="$WORK/$(echo -n "$pkg" | md5sum | cut -c1-8)"; mkdir -p "$sub"
  tgzname=$(cd "$sub" && npm pack "$pkg@$VER" 2>/dev/null | tail -1)
  if [ -z "$tgzname" ] || [ ! -f "$sub/$tgzname" ]; then echo "  拉取失败 $pkg@$VER"; continue; fi
  local_tgz="$sub/$tgzname"
  for dep in $(deps_of "$local_tgz"); do
    [ -z "${seen[$dep]:-}" ] && queue+=("$dep")
  done
  if has_internal "$pkg"; then
    echo "已存在: $pkg@$VER"
  else
    echo "同步:   $pkg@$VER"
    npm publish "$local_tgz" --registry "$INTERNAL" --tag latest >/dev/null 2>&1 && echo "  -> OK" || echo "  -> FAIL"
  fi
done
rm -rf "$WORK"
echo "=== 完成，共处理 ${#seen[@]} 个包 ==="
