#!/bin/sh
set -eu
# 仅修正应用自有文件；不递归改写挂载，不重置凭据或数据库。
if [ "$(id -u)" = 0 ]; then
  case "${PUID}" in ''|*[!0-9]*) echo "PUID must be numeric" >&2; exit 1;; esac
  case "${PGID}" in ''|*[!0-9]*) echo "PGID must be numeric" >&2; exit 1;; esac
  if [ "$PUID" -eq 0 ]; then echo "PUID must identify a non-root user" >&2; exit 1; fi
  mkdir -p /data
  chown "${PUID}:${PGID}" /data
  for file in /data/setup-token /data/gameshelf.db /data/gameshelf.db-wal /data/gameshelf.db-shm /data/gameshelf.db-journal; do
    if [ -L "$file" ]; then echo "Application data file must not be a symbolic link: $file" >&2; exit 1; fi
    if [ -e "$file" ]; then
      if [ ! -f "$file" ]; then echo "Application data path must be a regular file: $file" >&2; exit 1; fi
      chown "${PUID}:${PGID}" "$file"
      chmod 600 "$file"
    fi
  done
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
