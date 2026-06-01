# portless-sync

Syncs the [portless](https://portless.sh) local CA certificate from WSL to the Windows host trust store, so Chrome and Edge on the Windows side stop showing SSL errors for `.localhost` URLs proxied by portless.

## The problem

Portless generates a local CA at `~/.portless/ca.pem` inside WSL and trusts it within the Linux environment. But when you open a portless URL (e.g. `https://myapp.localhost`) in Chrome or Edge **on the Windows host**, the Windows trust store doesn't know about this CA, so you get SSL certificate errors.

## Install as a service (recommended)

Run once to register a systemd user service that starts automatically with your WSL session:

```sh
node bin/portless-sync.js install
```

The service runs in watch mode — it syncs immediately on start and automatically re-syncs whenever portless regenerates the CA cert (e.g. after `portless trust`).

```sh
# Check it's running
systemctl --user status portless-sync

# View live logs
journalctl --user -u portless-sync -f

# Remove the service
node bin/portless-sync.js uninstall
```

## Manual usage

```sh
# One-shot sync
node bin/portless-sync.js

# Run in the foreground in watch mode
node bin/portless-sync.js watch
```

## All commands

| Command     | Description                                               |
|-------------|-----------------------------------------------------------|
| `install`   | Install and enable the systemd user service               |
| `uninstall` | Stop and remove the systemd user service                  |
| `watch`     | Run in the foreground, re-syncing on CA cert changes      |
| `sync`      | One-shot sync (default when no command is given)          |

## Options

```
--state-dir DIR  Override the portless state directory (default: ~/.portless)
--help           Show help
```

## Requirements

- WSL (Windows Subsystem for Linux) with C: mounted at `/mnt/c`
- Node.js 18+
- systemd user session (standard in Ubuntu 22.04+ on WSL2)
- `certutil.exe` — ships with Windows, no extra install needed

## How it works

1. Reads `~/.portless/ca.pem`
2. Computes a SHA-1 thumbprint of the cert using Node's built-in `crypto` module (locale-independent)
3. Checks `certutil -store -user Root` — skips if the thumbprint is already present
4. Removes any stale portless CA entries from the Windows store (avoids accumulation on re-generation)
5. Calls `certutil -addstore -user Root <cert>` — no admin privileges needed (`CurrentUser\Root`)

After a fresh install, restart Chrome/Edge if they were already open.
