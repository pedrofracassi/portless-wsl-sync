# portless-wsl-sync

Syncs the [portless](https://portless.sh) local CA certificate from WSL to the Windows host trust store, so Chrome and Edge on the Windows side stop showing SSL errors for `.localhost` URLs proxied by portless.

> [!WARNING]
> This project was one-shot vibecoded to solve the issue I had. I've published it so maybe it can help others, but do not plan to provide support nor maintain it. Users are welcome to fork it if they need any changes.

## The problem

Portless generates a local CA at `~/.portless/ca.pem` inside WSL and trusts it within the Linux environment. But when you open a portless URL (e.g. `https://myapp.localhost`) in Chrome or Edge **on the Windows host**, the Windows trust store doesn't know about this CA, so you get SSL certificate errors.

## The solution

`portless-sync` reads `~/.portless/ca.pem` and installs it into the Windows `CurrentUser\Root` certificate store using `certutil.exe`. No administrator privileges are required.

## Usage

### One-shot sync

Run once after `portless` has been started for the first time (so it has generated the CA):

```sh
node bin/portless-sync.js
```

### Watch mode

Keep running in the background. It syncs immediately and then re-syncs automatically whenever portless regenerates the CA cert:

```sh
node bin/portless-sync.js --watch
```

A good place to put this is in a terminal multiplexer session, or in a `.bashrc`/`.zshrc` startup hook.

### Options

```
--watch          Watch for CA cert changes and re-sync automatically
--state-dir DIR  Override the portless state directory (default: ~/.portless)
--help           Show help
```

## Requirements

- WSL (Windows Subsystem for Linux) with the C: drive mounted at `/mnt/c`
- Node.js 18+
- `certutil.exe` — ships with Windows, no extra install needed

## How it works

1. Reads `~/.portless/ca.pem` (or the path given by `--state-dir`)
2. Computes a SHA-1 thumbprint of the cert
3. Checks `certutil -store -user Root` — if the thumbprint is already there, skips
4. Removes any stale portless CA entries from the Windows store (avoids accumulation on re-generation)
5. Calls `certutil -addstore -user Root <cert>` to install the new CA

After running, restart Chrome or Edge if they were already open.
