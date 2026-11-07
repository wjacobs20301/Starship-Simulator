#!/usr/bin/env bash
# Update the live site from GitHub (run on the server, as the user the containers run as).
#   deploy/deploy.sh               pull, build, publish
#   deploy/deploy.sh --if-changed  the same, only for a branch with a new commit (for the timer)
#
# Two sites from two branches:
#   main -> https://starship.wjacobs.space/       the game
#   dev  -> https://starship.wjacobs.space/dev/   the next version, for testing before it goes to
#                                                 main (not listed by search engines)
# The build runs in a Node container: nothing to install on the host.
set -euo pipefail
BASE="${STARSHIP_HOME:-$HOME/starship}"
IF_CHANGED="${1:-}"
cd "$BASE/app"

# Build a checkout in the Node container: build <dir> [vite base].
build() {
  podman run --rm --pull=newer -v "$1:/app:Z" -w /app docker.io/library/node:22-slim \
    sh -c "npm ci --no-audit --no-fund --loglevel=error && npm run build -- --base=${2:-/}"
}

# Publish a build: hashed assets first, then the page (so a visitor never gets a page whose files
# are missing). The previous builds' code files are kept for a week: a page that loaded just
# before this deploy still finds everything it asks for (players already flying are never
# interrupted: the game is loaded once, in their browser, and a new build only reaches them when
# they reload). publish <dist> <site dir> [rsync excludes...]
publish() {
  local dist="$1" site="$2"
  shift 2
  mkdir -p "$site"
  rsync -a --exclude index.html "$@" "$dist/" "$site/"
  rsync -a --delete --exclude /assets/ "$@" "$dist/" "$site/"
  find "$site/assets" -type f -mtime +7 -delete
}

# --- main: the game ---
git fetch --quiet origin main
if [[ "$IF_CHANGED" != "--if-changed" || "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  # (The server's copy is never edited by hand: it always matches GitHub.)
  git reset --hard --quiet origin/main
  build "$BASE/app" /
  # (The dev site lives inside the main one, at /dev/: left alone.)
  publish "$BASE/app/dist" "$BASE/site" --exclude /dev/
  # Pick up any Caddyfile change without dropping connections.
  if podman container exists starship-web; then
    podman exec starship-web caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
      systemctl --user restart starship-web.service
  fi
  echo "Deployed main: $(git log -1 --format='%h %s')"
fi

# --- dev: the next version, at /dev/ (only if there's a dev branch on GitHub) ---
if git fetch --quiet origin dev 2>/dev/null; then
  DEV="$BASE/app-dev"
  # (Its own checkout, sharing the main one's history.)
  [[ -d "$DEV" ]] || git worktree add --quiet --detach "$DEV" origin/dev
  cd "$DEV"
  if [[ "$IF_CHANGED" != "--if-changed" || ! -f "$BASE/site/dev/index.html" || "$(git rev-parse HEAD)" != "$(git rev-parse origin/dev)" ]]; then
    git reset --hard --quiet origin/dev
    build "$DEV" /dev/
    publish "$DEV/dist" "$BASE/site/dev"
    echo "Deployed dev: $(git log -1 --format='%h %s')"
  fi
fi
