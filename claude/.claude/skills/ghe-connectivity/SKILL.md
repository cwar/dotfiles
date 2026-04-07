---
name: ghe-connectivity
description: |
  Diagnose and resolve GitHub Enterprise (GHE) connectivity issues.
  Triggers on: IP allow list, repository owner has an IP allow list enabled, 
  unable to access, push failed, fetch failed, clone failed, 403 from spotify.ghe.com,
  VPN not connected, can't push to GHE
  Use when git operations (push, pull, fetch, clone) fail against spotify.ghe.com
  or ghe.spotify.net with IP allow-list or authentication errors.
---

# GHE Connectivity

Spotify has two GitHub Enterprise instances with different access requirements:

## Instances

| Instance | URL | Access |
|----------|-----|--------|
| **spotify.ghe.com** | `https://spotify.ghe.com/` | Requires Spotify VPN (GlobalProtect) — has IP allow-list |
| **ghe.spotify.net** | `https://ghe.spotify.net/` | Accessible without VPN (but requires GHE auth token) |

## Diagnosing the Error

If you see any of these errors, the user is **not connected to the Spotify VPN**:

```
remote: The repository owner has an IP allow list enabled, and X.X.X.X is not permitted to access this repository.
fatal: unable to access 'https://spotify.ghe.com/...': The requested URL returned error: 403
```

## Resolution

**Tell the user they need to connect to the VPN first.** Do not retry the command — it will fail again.

Suggested message:
> Looks like you're not connected to the Spotify VPN — `spotify.ghe.com` has an IP allow-list that blocks access without it.
> 
> Connect with: `vpn` (then choose "GP: Quick connect (US East)")
> 
> Once connected, I'll retry the push.

## VPN Details

- The user has a `vpn` CLI tool at `~/.local/bin/vpn`
- It uses GlobalProtect (`gpclient`) connecting to `spotify.gpcloudservice.com`
- Default gateway: "US East"
- Quick connect: run `vpn`, then select "GP: Quick connect (US East)"
- The tool requires `sudo` and opens a browser for SAML/Okta authentication
- **Do NOT attempt to run `vpn` or `gpclient` directly** — it requires interactive browser auth

## Checking VPN Status

```bash
# Check if VPN tunnel is up
ip link show gpd0 2>/dev/null || ip link show tun0 2>/dev/null
```

Note: Even if a tunnel interface exists, the IP may not be on the allow-list (e.g., Tailscale `tun0` vs GlobalProtect `gpd0`). The definitive test is whether the git operation succeeds.

## Quick Connectivity Test

```bash
# Test spotify.ghe.com access
curl -sf -o /dev/null -w "%{http_code}" https://spotify.ghe.com/ 2>/dev/null || echo "unreachable"

# Test ghe.spotify.net access (should work without VPN)
curl -sf -o /dev/null -w "%{http_code}" https://ghe.spotify.net/ 2>/dev/null || echo "unreachable"
```
