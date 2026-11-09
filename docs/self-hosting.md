# Self-hosting

Stdio is the default. HTTP mode is for a machine you administer. It speaks Streamable HTTP at `/mcp` and answers `GET /healthz` with `{"ok":true}`.

A typical layout is a Debian 12 unprivileged Proxmox LXC. Node binds to `127.0.0.1:8080`. nginx or Caddy in the same container terminates TLS and proxies the whole site. The example domain below is `tumonline-mcp.kersys.lt`. Replace it if you use another name.

Each person adds `https://tumonline-mcp.kersys.lt/mcp` in their MCP client. The client discovers OAuth, registers itself, and opens a browser on this server. The person enters a TUM ID or pastes an activated Campus token. This server stores that token encrypted for their MCP user. You do not create TUMonline accounts and you never see the token in the page or the journal.

This process is its own OAuth 2.1 authorization server: protected-resource metadata, authorization-server metadata, dynamic client registration, an authorization-code flow with PKCE `S256`, rotating refresh tokens, and revocation. A static bearer remains available for an admin client that cannot do OAuth. That bearer still needs its own Campus token before personal tools work.

Automated tests mock TUMonline and NavigaTUM. They do not log in with a TUM account, and they do not exercise a real reverse proxy.

## Size

For one or a few students:

| Resource | Starting point |
| --- | --- |
| CPU | 1 vCPU |
| Memory | 512 MB |
| Disk | 4 GB |
| OS | Debian 12 |
| Container | Unprivileged LXC |

Node stays small. The extra disk is for the OS, Node 22, and the state directory. Do not enable Docker. The process is a normal systemd service.

## Unprivileged LXC

The shipped unit is meant to start in an unprivileged Proxmox LXC **without** nesting. It sets `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`, and `RestrictAddressFamilies`. It does **not** set `RestrictNamespaces`, `ProtectClock`, `ProtectHostname`, `PrivateDevices`, `ProtectKernelTunables`, `ProtectKernelModules`, or `ProtectControlGroups`. Those need user namespaces and fail in a default unprivileged container.

Two ways to go further:

1. Leave the unit as shipped. That is the relaxed sandbox.
2. Set `nesting=1` on the container (Proxmox: container Options, Features, nesting), restart the container, and install `deploy/tumonline-student-mcp.hardening.conf` as a drop-in. That file turns the namespace settings back on.

```bash
install -D -m 644 deploy/tumonline-student-mcp.hardening.conf \
  /etc/systemd/system/tumonline-student-mcp.service.d/hardening.conf
systemctl daemon-reload
systemctl restart tumonline-student-mcp
```

If the service then fails with a namespace or permission error, remove that drop-in. The tokens are still on disk as mode `0600` under `/var/lib/tumonline-student-mcp`.

## Install

From a checkout, as root, on Debian 12:

```bash
sudo ./deploy/install-debian12.sh
```

The script installs Node.js 22 from the official tarball when `node` is missing or older than 22, creates the system user `tumonline-mcp`, copies the app to `/opt/tumonline-student-mcp`, installs the systemd unit, and starts the service. It does not overwrite an existing `/etc/tumonline-student-mcp.env` and it does not delete the state directory.

Edit `/etc/tumonline-student-mcp.env`:

- `TUMONLINE_MCP_PUBLIC_URL` is the public origin, with no path. For this host that is `https://tumonline-mcp.kersys.lt`. That value is the OAuth issuer. Forwarded headers do not change it.
- `TUMONLINE_MCP_BASE_URL` stays `https://campus.tum.de/tumonline` unless you are pointing tests at another prefix.
- `TUMONLINE_MCP_TOKEN_KEY` is optional. If you leave it empty, the first run creates `token.key` in the state directory. Back up that file with the state directory. Losing it makes every stored Campus token unreadable.

Then:

```bash
systemctl restart tumonline-student-mcp
```

Give each person `https://tumonline-mcp.kersys.lt/mcp`.

The same steps by hand:

```bash
apt-get update
apt-get install -y ca-certificates curl xz-utils tar
useradd --system --user-group --home-dir /var/lib/tumonline-student-mcp \
  --create-home --shell /usr/sbin/nologin tumonline-mcp
install -d -o tumonline-mcp -g tumonline-mcp -m 700 /var/lib/tumonline-student-mcp
rm -rf /opt/tumonline-student-mcp
mkdir -p /opt/tumonline-student-mcp
# Copy this repository to /opt/tumonline-student-mcp, without .git.
chown -R root:root /opt/tumonline-student-mcp
find /opt/tumonline-student-mcp -type d -exec chmod 755 {} +
find /opt/tumonline-student-mcp -type f -exec chmod 644 {} +
chmod 755 /opt/tumonline-student-mcp/bin/tumonline-student-mcp
install -m 644 deploy/tumonline-student-mcp.service /etc/systemd/system/tumonline-student-mcp.service
install -m 640 -o root -g tumonline-mcp deploy/tumonline-student-mcp.env.example /etc/tumonline-student-mcp.env
systemctl daemon-reload
systemctl enable --now tumonline-student-mcp.service
```

```bash
journalctl -u tumonline-student-mcp -f
curl -fsS http://127.0.0.1:8080/healthz
```

Journal lines are status and path. They do not include OAuth tokens, Campus tokens, or TUM IDs.

## What the browser does

`GET /authorize` is a page on this server. It has no third-party scripts or images. It offers two choices:

1. A TUM ID. The server calls `wbservicesbasic.requestToken?pUsername=<id>&pTokenName=<name>` and stores the returned token encrypted. The page lists the activation steps: TUMonline, Visitenkarte or Services, Token-Management, activate the named token, enable calendar, lectures, grades, exam results, tuition fees, identity, and persons. **Check activation** calls `isTokenConfirmed`.
2. An existing activated token, posted as a password field. The server stores it encrypted, calls `isTokenConfirmed`, and finishes sign-in only when TUMonline says it is active.

The token is not rendered. The form is protected by a cookie that must match a hidden field. The page is sent with `Referrer-Policy: same-origin`, so the browser sends this site's `Origin` on the form POST. A POST whose `Origin` is missing or the string `null` is rejected. Failed attempts are shown on the page and counted per TUM ID and per TCP peer.

Access tokens last 15 minutes. Refresh tokens last 30 days and rotate on every use. Reusing an old refresh token revokes that grant. `POST /revoke` revokes a presented token. Revoking a refresh token also revokes the access tokens in that grant.

`/files/<token>` is the one-time stream used if a tool ever exposes a file. The token is random. The server keeps only its hash in memory, with an allowlisted `https://campus.tum.de` or `https://nav.tum.de` URL, the account, and a 10-minute expiry. `GET` streams the response and does not buffer it to disk. `HEAD` does not consume the link. Nothing in v1 returns a file; enrollment certificates and profile photos are not offered. Profile `image_data` is dropped before a tool result is built.

## What is stored

`TUMONLINE_MCP_STATE_DIR` defaults to `/var/lib/tumonline-student-mcp`. The directory is mode `0700`. Files inside it are mode `0600`.

| Path | Contents |
| --- | --- |
| `oauth.json` | Hashes of authorization codes, access tokens, and refresh tokens, plus registered redirect URIs. Raw OAuth tokens are not stored. |
| `access-tokens.json` | SHA-256 hashes of optional admin bearer tokens. |
| `token.key` | The 32-byte AES key, if `TUMONLINE_MCP_TOKEN_KEY` is not set. |
| `users/<id>/tum-token.json` | AES-256-GCM ciphertext of that user's Campus token, TUM ID, token name, and confirmed flag. The associated data is the MCP user id, so the file cannot be decrypted for a different user. |

The key and the ciphertext together are the credential. Neither is logged.

## Reverse proxy

TLS ends at the proxy. Leave Node on loopback. Proxy the whole site, not only `/mcp`, so the client can fetch `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token`, and `/revoke`. Do not publish port 8080.

Set `TUMONLINE_MCP_PUBLIC_URL` to the HTTPS origin. Send the public `Host` header. The server allows that host and, when a browser sends `Origin`, that origin. Requests with no `Origin` are allowed so native clients work. Loopback names stay allowed for local checks.

`/mcp` must not be buffered. The server can answer `tools/call` with JSON or one short server-sent event. `GET /mcp` returns 405 because this process does not open a standing event stream. Clients that speak Streamable HTTP continue with `POST`. The older HTTP+SSE transport is not implemented.

`/mcp` and `/healthz` reject every query string. `/authorize` uses its query string for the OAuth request. The Campus token is only accepted as a form body.

Failed `/mcp` authentications share one rate-limit bucket per TCP peer (30 failures in five minutes, then 429). A still-valid bearer is not counted. Sign-in attempts are limited separately. Restarting the service clears the in-memory counters. The process does not trust `X-Forwarded-For`.

### Caddy

```caddy
tumonline-mcp.kersys.lt {
	encode off
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
		header_up Host {host}
		header_up X-Forwarded-Proto {scheme}
		transport http {
			response_header_timeout 10m
			read_timeout 10m
			write_timeout 10m
		}
	}
}
```

`encode off` and `flush_interval -1` keep the proxy from buffering `/mcp` and `/files/`. This server does not use `X-Forwarded-Proto` to choose the OAuth issuer.

### nginx

Debian 12 ships nginx 1.22. That version has no `http2 on;` directive (added in nginx 1.25.1). Put HTTP/2 on the listen line:

```nginx
server {
    listen 443 ssl http2;
    server_name tumonline-mcp.kersys.lt;

    ssl_certificate     /etc/letsencrypt/live/tumonline-mcp.kersys.lt/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tumonline-mcp.kersys.lt/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 10m;
        proxy_send_timeout 10m;
        client_max_body_size 1m;
    }
}
```

`client_max_body_size 1m` matches the MCP body limit. OAuth form and registration bodies are limited further, to 16 KB. There is no file-upload tool, so the limit is smaller than a server that accepts exercise uploads.

`proxy_buffering off` covers `/files/` as well as `/mcp`. Leave it off.

## Optional admin bearer

Run the commands as `tumonline-mcp` so the files stay owned by the service user.

```bash
su -s /bin/bash tumonline-mcp
set -a
. /etc/tumonline-student-mcp.env
set +a
cd /opt/tumonline-student-mcp
./bin/tumonline-student-mcp token create --label laptop
./bin/tumonline-student-mcp connect request ab12cde --user t_<id>
exit
```

`token create` prints the bearer once. `connect request` stores a Campus token for that bearer user and prints activation steps, not the token. The client sends `Authorization: Bearer <bearer>` to `https://tumonline-mcp.kersys.lt/mcp`. Do not put either secret in a URL.

## Update

The state directory is outside the install tree.

```bash
git -C /opt/tumonline-student-mcp pull
systemctl restart tumonline-student-mcp
```

Or copy a new tree over `/opt/tumonline-student-mcp` and restart. Re-running `deploy/install-debian12.sh` keeps the env file and the state directory.

## Backups

The archive contains the encryption key and the ciphertext of every Campus token, plus hashes of OAuth tokens. Treat it as a credential.

```bash
umask 077
tar -C /var/lib -czf /root/tumonline-student-mcp-state.tgz tumonline-student-mcp
```

Restore with the service stopped, then fix the owner:

```bash
systemctl stop tumonline-student-mcp
tar -C /var/lib -xzf /root/tumonline-student-mcp-state.tgz
chown -R tumonline-mcp:tumonline-mcp /var/lib/tumonline-student-mcp
chmod 700 /var/lib/tumonline-student-mcp
systemctl start tumonline-student-mcp
```

OAuth access and refresh tokens cannot be recovered from the hash file. People sign in again from the client. Campus tokens can be decrypted only with the same `token.key` or `TUMONLINE_MCP_TOKEN_KEY`.

## Security

- Bind to loopback unless the proxy is on another host, and then firewall that port.
- Put TLS on the proxy. Node speaks plain HTTP.
- `TUMONLINE_MCP_PUBLIC_URL` is the issuer.
- The Campus token is not accepted in a URL on `/mcp` or `/authorize`.
- OAuth tokens and admin bearers are random. Only their SHA-256 hashes are stored.
- Campus tokens are AES-256-GCM with a random 12-byte IV. The MCP user id is associated data.
- Redirect URIs are matched exactly and must be HTTPS, a loopback `http` URL, or a private-use scheme.
- TUMonline calls time out, are spaced per user, and stop after a rate-limit response.
- The service user is `tumonline-mcp`. Do not run it as root.
- MCP session ids live in memory and disappear when the process restarts.
