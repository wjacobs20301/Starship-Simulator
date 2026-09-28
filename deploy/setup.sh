#!/usr/bin/env bash
# One-time setup on the server (Bazzite / any Linux with Podman and systemd), as your normal user:
#   ~/starship/app     this repo (cloned before running this)
#   ~/starship/site    the built site (deploy.sh fills it)
#   ~/starship/tiles   the map tiles: tiles/terrain and tiles/globe/tiles (copied separately)
#   ~/starship/tunnel.env   TUNNEL_TOKEN=... (from the Cloudflare dashboard; not in git)
set -euo pipefail
BASE="${STARSHIP_HOME:-$HOME/starship}"
APP="$BASE/app"
mkdir -p "$BASE/site" "$BASE/tiles/globe" "$HOME/.config/containers/systemd" "$HOME/.config/systemd/user"

# The containers (Quadlets: systemd starts them at boot) and the optional auto-deploy timer.
cp "$APP"/deploy/quadlet/*.container "$APP"/deploy/quadlet/*.network "$HOME/.config/containers/systemd/"
cp "$APP"/deploy/quadlet/starship-deploy.service "$APP"/deploy/quadlet/starship-deploy.timer "$HOME/.config/systemd/user/"

if [[ ! -f "$BASE/tunnel.env" ]]; then
  echo "TUNNEL_TOKEN=" >"$BASE/tunnel.env"
  echo "Created $BASE/tunnel.env: put the Cloudflare tunnel token in it."
fi
chmod 600 "$BASE/tunnel.env"

# Keep the user's services running without anyone logged in, and start them at boot.
loginctl enable-linger "$USER"
systemctl --user daemon-reload

# First build, then the web server.
"$APP/deploy/deploy.sh"
systemctl --user restart starship-web.service
echo "Web server: $(systemctl --user is-active starship-web.service) (check http://localhost:8080)"

if grep -q '^TUNNEL_TOKEN=.\+' "$BASE/tunnel.env"; then
  systemctl --user restart starship-tunnel.service
  echo "Tunnel: $(systemctl --user is-active starship-tunnel.service)"
else
  echo "Tunnel not started yet: add the token to $BASE/tunnel.env, then: systemctl --user start starship-tunnel.service"
fi
