#!/usr/bin/env bash
# Update the live site from GitHub (run on the server, as the user the containers run as).
#   deploy/deploy.sh               pull, build, publish
#   deploy/deploy.sh --if-changed  the same, only if there's a new commit (for the timer)
# The build runs in a Node container: nothing to install on the host.
set -euo pipefail
BASE="${STARSHIP_HOME:-$HOME/starship}"
cd "$BASE/app"

git fetch --quiet origin main
if [[ "${1:-}" == "--if-changed" && "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]]; then
  exit 0
fi
# (The server's copy is never edited by hand: it always matches GitHub.)
git reset --hard --quiet origin/main

podman run --rm --pull=newer -v "$BASE/app:/app:Z" -w /app docker.io/library/node:22-slim \
  sh -c 'npm ci --no-audit --no-fund --loglevel=error && npm run build'

# Publish: hashed assets first, then the page (so a visitor never gets a page whose files are missing).
# The previous builds' code files are kept for a week: a page that loaded just before this deploy
# still finds everything it asks for (players already flying are never interrupted: the game is
# loaded once, in their browser, and a new build only reaches them when they reload).
rsync -a --exclude index.html "$BASE/app/dist/" "$BASE/site/"
rsync -a --delete --exclude /assets/ "$BASE/app/dist/" "$BASE/site/"
find "$BASE/site/assets" -type f -mtime +7 -delete

# Pick up any Caddyfile change without dropping connections.
if podman container exists starship-web; then
  podman exec starship-web caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
    systemctl --user restart starship-web.service
fi
echo "Deployed $(git log -1 --format='%h %s')"
