#!/bin/sh
set -eu
# 只初始化新目录；现有目录权限由部署者明确维护，不递归改写整个挂载。
if [ "$(id -u)" = 0 ]; then
  case "${PUID}" in ''|*[!0-9]*) echo "PUID must be numeric" >&2; exit 1;; esac
  case "${PGID}" in ''|*[!0-9]*) echo "PGID must be numeric" >&2; exit 1;; esac
  if [ "$PUID" -eq 0 ]; then echo "PUID must identify a non-root user" >&2; exit 1; fi
  mkdir -p /data
  chown "${PUID}:${PGID}" /data
  exec gosu "${PUID}:${PGID}" /entrypoint.sh "$@"
fi
if [ ! -w /data ]; then echo "/data must be writable by the configured UID/GID" >&2; exit 1; fi
if [ ! -f /data/gameshelf.db ]; then touch /data/gameshelf.db; fi
if [ -f /data/setup-token ] || [ -z "${SETUP_TOKEN:-}" ]; then
  if [ ! -f /data/setup-token ]; then
    umask 077
    node -e "require('node:fs').writeFileSync('/data/setup-token',require('node:crypto').randomBytes(24).toString('hex'),{flag:'wx',mode:0o600})"
  fi
  SETUP_TOKEN="$(cat /data/setup-token)"
  export SETUP_TOKEN
fi
if [ "${#SETUP_TOKEN}" -lt 24 ]; then echo "SETUP_TOKEN must be at least 24 characters" >&2; exit 1; fi
# 自动应用版本化迁移；失败直接退出，不继续对数据库写入。
node node_modules/prisma/build/index.js migrate deploy
echo "GameShelf starting; initialization credential: /data/setup-token or configured SETUP_TOKEN (not logged)."
exec "$@"
