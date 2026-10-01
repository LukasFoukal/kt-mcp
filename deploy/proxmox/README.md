# Deploying kt-mcp on a Proxmox LXC (systemd + Caddy, multi-user)

This guide runs several kt-mcp instances, one per person, as plain Node processes in a single Proxmox LXC. They sit behind an existing Caddy reverse proxy on one public IP. No Docker, nginx or Cloudflare Tunnel is involved.

```
Claude ──HTTPS──► Caddy (80/443) ──► LXC 192.168.x.y
                    kt.<domain>        :8092  kt-mcp@lukas
                    kt-mama.<domain>   :8093  kt-mcp@mama
                    kt-tata.<domain>   :8094  kt-mcp@tata
```

Each server logs in to exactly one kaloricketabulky.cz account, so every person gets their own instance. Each instance has its own port, its own subdomain (`PUBLIC_URL` is the OAuth issuer and cannot contain a path), its own access passphrase and its own token state. All instances share one build of the code.

## Prerequisites

- A Proxmox host at the site where Caddy already owns ports 80/443, with those ports forwarded from the router.
- A domain whose DNS you control.
- A kaloricketabulky.cz login for each person.

## 1. Create the container

On the Proxmox host shell, use the Debian LXC script from [community-scripts.org](https://community-scripts.org/):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"
```

Choose **Advanced** and use these settings:

- Hostname `kt-mcp`
- Unprivileged
- 1 vCPU, 1 GB RAM, 8 GB disk (the TypeScript build needs some headroom)
- A static IP

## 2. Install Node.js

The project requires Node 22 or newer. Inside the container:

```bash
apt install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
```

## 3. Build the code

```bash
git clone https://github.com/<you>/kt-mcp /opt/kt-mcp
cd /opt/kt-mcp
npm ci && npm run build && npm prune --omit=dev
```

## 4. Install the systemd template unit

Create `/etc/systemd/system/kt-mcp@.service`:

```ini
[Unit]
Description=kt-mcp (%i)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/kt-mcp
EnvironmentFile=/etc/kt-mcp/%i.env
Environment=NODE_ENV=production
Environment=STATE_DIR=/var/lib/kt-mcp/%i
ExecStart=/usr/bin/node dist/index.js
DynamicUser=yes
StateDirectory=kt-mcp/%i
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Then:

```bash
mkdir -p /etc/kt-mcp
systemctl daemon-reload
```

How the unit works:

- `%i` is the instance name (the part after `@`). It selects that person's env file and state directory.
- `DynamicUser` runs each instance as its own unprivileged throwaway user.
- `StateDirectory` creates `/var/lib/kt-mcp/<name>`, writable only by that instance. Issued OAuth tokens and registered clients live there, so restarts and updates don't force anyone to reconnect.
- systemd reads the env file as root before dropping privileges, so the file can stay `chmod 600`.

## 5. Caddy snippet (one-time)

Add a reusable snippet to the Caddyfile:

```caddy
(kt) {
	reverse_proxy {args[0]} {
		flush_interval -1
	}
}
```

`flush_interval -1` disables response buffering. Without it, the server-sent event streams used by MCP tool calls can stall.

Do **not** set `trusted_proxies` in Caddy's global options. The app trusts exactly one proxy hop (`trust proxy: 1`) for its rate limiter on `/authorize`. By default Caddy discards client-supplied `X-Forwarded-For` and sets the real client IP itself, which is exactly what the app needs.

## 6. Firewall (one-time)

Every instance listens on all interfaces inside the container. Because the app trusts one proxy hop, anyone who could reach these ports directly could spoof `X-Forwarded-For` and get around the rate limiter.

In the Proxmox firewall for this LXC, enable the firewall and add these rules:

- Allow TCP to the instance ports (e.g. `8092:8099`) **from the Caddy host's IP only**.
- Allow SSH from your LAN.
- Drop everything else inbound.

---

## Adding a person

Pick a short instance name using lowercase letters, digits and hyphens only (e.g. `mama`), and the next free port (e.g. `8093`).

### 1. Generate their access passphrase

```bash
openssl rand -base64 24
```

This is what they type once on the consent page when connecting Claude. Give it to them over a private channel.

### 2. Create the env file

Create `/etc/kt-mcp/mama.env`:

```
KT_EMAIL='mama@example.com'
KT_PASSWORD='their-kaloricketabulky-password'
MCP_AUTH_PASSWORD='output-of-openssl-rand'
PUBLIC_URL='https://kt-mama.<domain>'
PORT=8093
```

```bash
chmod 600 /etc/kt-mcp/mama.env
```

Rules for this file:

- `PORT` must be unique across all instances.
- `PUBLIC_URL` must be the exact public origin: scheme and host, no path, no trailing slash.
- Use single quotes around values. systemd strips the quotes and never expands `$`, so special characters in passwords are safe.

### 3. Start the instance

```bash
systemctl enable --now kt-mcp@mama
curl localhost:8093/healthz          # should report https://kt-mama.<domain>/mcp
journalctl -u kt-mcp@mama -n 50
```

### 4. DNS

At your DNS provider, add a record for the subdomain:

| Type | Name      | Value          |
| ---- | --------- | -------------- |
| A    | `kt-mama` | your public IP |

If your public IP is dynamic, use a CNAME to your DDNS hostname instead.

### 5. Caddy

Add a site block and reload Caddy:

```caddy
kt-mama.<domain> { import kt 192.168.x.y:8093 }
```

Caddy obtains the TLS certificate automatically on the first request.

### 6. Firewall

If the new port is outside the range already allowed from Caddy, extend the rule.

### 7. Verify

From the repo directory:

```bash
./scripts/verify-deployment.sh https://kt-mama.<domain>
```

### 8. Connect Claude

In **the person's own** Claude account:

1. Go to **Settings → Connectors → Add custom connector**.
2. Enter `https://kt-mama.<domain>/mcp`.
3. On the consent page, check that the client name shown is Claude, then enter their `MCP_AUTH_PASSWORD`.

Tokens last 30 days and refresh automatically.

### Checklist

- [ ] Unique instance name and port
- [ ] `/etc/kt-mcp/<name>.env` created with `chmod 600`
- [ ] `systemctl enable --now kt-mcp@<name>` and `/healthz` responds
- [ ] DNS record
- [ ] Caddy site block, Caddy reloaded
- [ ] Port allowed from Caddy in the Proxmox firewall
- [ ] `verify-deployment.sh` passes
- [ ] Connector added in their Claude account

---

## Removing a person

```bash
systemctl disable --now kt-mcp@mama
rm /etc/kt-mcp/mama.env
rm -rf /var/lib/kt-mcp/mama          # deletes their OAuth tokens
```

Then remove their Caddy site block and DNS record.

## Revoking access without removing the instance

There is no per-token revocation. To kick out every connected client for one person:

1. Stop the instance.
2. Delete `/var/lib/kt-mcp/<name>/oauth-state.json`.
3. Change `MCP_AUTH_PASSWORD` in their env file.
4. Start the instance again.

They then reconnect with the new passphrase.

## Updating

```bash
cd /opt/kt-mcp
git pull && npm ci && npm run build && npm prune --omit=dev
systemctl restart 'kt-mcp@*'
```

Token state is kept, so nobody needs to reconnect. Node.js itself updates with `apt upgrade`.

## Changing an instance's domain

1. Update `PUBLIC_URL` in the env file and the Caddy site block.
2. Restart the instance.
3. In Claude, remove the connector and add it again.

`PUBLIC_URL` is the OAuth issuer and resource identifier, so tokens issued under the old hostname are rejected.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Instance fails with `status=226/NAMESPACE` | The container blocks systemd sandboxing. Enable **nesting** in the LXC's Options → Features, or remove the `Protect*` and `PrivateTmp` lines from the unit. |
| `EADDRINUSE` in the journal | `PORT` collides with another instance. |
| Tool calls hang or time out | `flush_interval -1` is missing from the Caddy proxy config. |
| Connector says the token is invalid after a change | `PUBLIC_URL` changed. Remove and re-add the connector. |
| Everyone appears to come from one IP | Check Caddy's access log: `remote_ip` should be the visitor's public IP. If it is a private or Docker address, the rate limiter treats all clients as one. |
| Login errors from kaloricketabulky.cz | Check `KT_EMAIL` / `KT_PASSWORD`. Upstream may also have changed its undocumented endpoints; see the main README's limitations. |

## Security notes

- Each env file holds a kaloricketabulky.cz password. The site hashes passwords client-side with MD5, so the hash is as sensitive as the password. Keep the files `600`, and make sure every person knows their credentials live on this server.
- Anyone with an instance's `MCP_AUTH_PASSWORD` has full access to that person's diary. Use long random passphrases and share each one only with its owner.
- Dine4Fit's terms allow personal, non-commercial automation of your own account. One instance per account holder stays within that. Keep request rates at human level.