# Cloudflare setup for the OVH preview box

The launcher is exposed through a Cloudflare Tunnel at
`preview-launcher.useatrium.com`. Do **not** put Cloudflare Access in front of this
hostname: the launcher's bearer token is the only authorization gate, and production
Centaur must be able to reach it directly.

## 1. Create the launcher tunnel

In Cloudflare Zero Trust, create a remotely managed tunnel for the OVH box and copy its
tunnel token. On the box, install `cloudflared` from Cloudflare's Ubuntu repository,
then install the tunnel as a system service:

```bash
sudo cloudflared service install '<TUNNEL_TOKEN>'
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

Treat the tunnel token as a secret. Do not commit it or place it in shell history; the
quoted placeholder above is illustrative. Prefer entering the real command in a root
shell with history disabled or using the Cloudflare dashboard's copy/install flow.

Add one public hostname to the tunnel:

- Hostname: `preview-launcher.useatrium.com`
- Service: `http://127.0.0.1:8787` (change the port only if `launcher.py` is configured
  to listen elsewhere)
- Cloudflare Access: disabled; do not create an Access application for this hostname

The tunnel creates the proxied DNS record for the launcher hostname. Verify health from
outside the box:

```bash
curl -fsS https://preview-launcher.useatrium.com/healthz
```

Then verify an authenticated endpoint with the launcher bearer token. Never put the
token in a URL or query string:

```bash
curl -fsS \
  -H "Authorization: Bearer $ATRIUM_PREVIEW_LAUNCHER_TOKEN" \
  https://preview-launcher.useatrium.com/previews/prev-example
```

## 2. Add wildcard preview DNS

In the `useatrium.com` DNS zone, add a wildcard record that points directly to the OVH
box:

- Type: `A`
- Name: `*.preview`
- Content: the box's public IPv4 address
- Proxy status: DNS only
- TTL: Auto

Add a DNS-only `AAAA` record too only when the box has working public IPv6 and its
firewall permits inbound TCP 80/443 over IPv6. Allow inbound TCP 80 and 443 to the box;
Caddy performs TLS termination and obtains the single wildcard certificate through the
Cloudflare DNS-01 API.

The scoped token in `/etc/atrium-preview/caddy.env` needs `Zone:DNS:Edit` for the
`useatrium.com` zone. It does not need account-wide permissions. After setting
`CF_API_TOKEN` and `ACME_EMAIL`, start or restart the shared proxy:

```bash
sudo systemctl restart atrium-preview-caddy
sudo systemctl status atrium-preview-caddy
```

Do not create or delete wildcard certificates or DNS records per preview. `previewctl`
only adds and removes files under Caddy's `conf.d` directory and reloads the shared
proxy.
