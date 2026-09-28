# Hosting: starship.wjacobs.space

The game is a static site: the physics, the menus and everything else run in each player's
browser. The server only hands out files:

- **starship-web**: Caddy serving the built site (`~/starship/site`) and the map tiles
  (`~/starship/tiles`, ~10 GB, not in git).
- **starship-tunnel**: `cloudflared`, connecting out to Cloudflare. No router ports are opened and
  the home IP isn't exposed; Cloudflare does HTTPS and caches the files at its edge.

Both are rootless Podman containers run by systemd (Quadlets), started at boot.

```
~/starship/app          this repo (a clone of GitHub)
~/starship/site         the built site (deploy.sh fills it)
~/starship/tiles/terrain       map tiles, copied from the dev machine
~/starship/tiles/globe/tiles   globe tiles, copied from the dev machine
~/starship/tunnel.env   TUNNEL_TOKEN=... (secret, not in git)
```

## One-time setup

### 1. SSH into the server (from the dev machine)

On the server: `sudo systemctl enable --now sshd`, and note its address (`ip -4 addr`).
From the Mac: `ssh-copy-id USER@SERVER`.

### 2. A read-only deploy key for the private repo

On the server:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/starship_deploy -N "" -C "starship-deploy"
printf 'Host github-starship\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/starship_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

Add `~/.ssh/starship_deploy.pub` to the repo as a **read-only** deploy key (GitHub → repo →
Settings → Deploy keys), or from the Mac: `gh repo deploy-key add starship_deploy.pub --title server`.

```bash
git clone git@github-starship:wjacobs20301/Starship-Simulator.git ~/starship/app
```

### 3. Copy the map tiles (from the Mac, ~10 GB, ~770k files)

```bash
cd "Starship Sim/public"
tar --exclude .DS_Store -cf - terrain globe/tiles | ssh USER@SERVER 'mkdir -p ~/starship/tiles && tar -C ~/starship/tiles -xf -'
```

After rebuilding tiles later, send only what changed:

```bash
rsync -a --delete --exclude .DS_Store public/terrain USER@SERVER:~/starship/tiles/
rsync -a --delete --exclude .DS_Store public/globe/tiles USER@SERVER:~/starship/tiles/globe/
```

### 4. The Cloudflare tunnel

Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create a tunnel** → Cloudflared → name it
`starship`. Copy the token (the long string after `--token` in the install command) into
`~/starship/tunnel.env` on the server:

```
TUNNEL_TOKEN=eyJh...
```

Then the tunnel's **Public hostname**: subdomain `starship`, domain `wjacobs.space`, service
**HTTP** → `starship-web:80`.

### 5. Start it

```bash
~/starship/app/deploy/setup.sh
```

It installs the container units, keeps them running without a login (`loginctl enable-linger`),
builds the site and starts both containers. Check `http://localhost:8080` on the server, then
https://starship.wjacobs.space.

### 6. Cloudflare caching (important: saves the home upload)

Caching → Cache Rules → **Create rule**:
- When: hostname equals `starship.wjacobs.space` **and** URI path starts with `/terrain/`, `/globe/`,
  `/models/` or `/assets/`
- Then: **Eligible for cache**; Edge TTL: **use cache-control header if present**.

(Without it, Cloudflare doesn't cache the `.bin` elevation tiles, and every player's terrain comes
from the home connection.)

### 7. Keep the machine awake

Turn off automatic sleep / suspend (System Settings → Power Management, and in Game Mode's power
settings).

## Updating the site

Push to `main` on GitHub: the site updates within 10 minutes. Or straight away, on the server:

```bash
~/starship/app/deploy/deploy.sh
```

The server also checks GitHub every 10 minutes and deploys new commits by itself (the timer is
on; to go back to deploying by hand: `systemctl --user disable --now starship-deploy.timer`):

```bash
systemctl --user enable --now starship-deploy.timer
```

After changing a model or image (their names don't change between builds), purge Cloudflare's
cache for it (Caching → Configuration → Purge Cache).

## Handy commands (on the server)

```bash
systemctl --user status starship-web starship-tunnel    # running?
journalctl --user -u starship-tunnel -f                 # tunnel log
journalctl --user -u starship-web -f                    # web server log
systemctl --user restart starship-web starship-tunnel   # restart
podman auto-update                                      # newer Caddy / cloudflared images
```
