#!/usr/bin/env node
// portless-sync: syncs the portless local CA from WSL to the Windows host trust store.

import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const { values: flags, positionals } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0]; // install | uninstall | watch | sync (default)

const HELP = `portless-sync — sync the portless local CA cert from WSL to Windows

Usage:
  portless-sync [command] [options]

Commands:
  install      Install and enable a systemd user service that runs in watch mode
  uninstall    Stop and remove the systemd user service
  watch        Run in the foreground, re-syncing whenever the CA cert changes
  sync         One-shot sync (default when no command is given)

Options:
  --state-dir DIR  Override the portless state directory (default: ~/.portless)
  --help           Show this help message

Installs the portless local CA certificate (~/.portless/ca.pem) into the Windows
CurrentUser Root certificate store via certutil.exe so that Chrome and Edge trust
portless HTTPS URLs without SSL errors.

No administrator privileges required — certutil installs into the current user's
store (CurrentUser\\Root).

Requires WSL with /mnt/c accessible.
`;

if (flags.help || command === "help") {
  console.log(HELP);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const CERTUTIL = "/mnt/c/Windows/System32/certutil.exe";
const STORE_NAME = "Root"; // Windows "Trusted Root Certification Authorities"
const SERVICE_NAME = "portless-sync";
const SCRIPT_PATH = path.resolve(process.argv[1]);
const HOME = os.homedir();

const stateDir = flags["state-dir"] ?? path.join(HOME, ".portless");
const caCertPath = path.join(stateDir, "ca.pem");

// ---------------------------------------------------------------------------
// Certificate helpers
// ---------------------------------------------------------------------------

/** Convert a WSL Linux path to a Windows UNC path using wslpath. */
function toWindowsPath(linuxPath) {
  try {
    return execFileSync("wslpath", ["-w", linuxPath], { encoding: "utf8" }).trim();
  } catch {
    return linuxPath
      .replace(/^\/mnt\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:\\`)
      .replace(/\//g, "\\");
  }
}

/** Compute the SHA-1 thumbprint of a PEM cert (locale-independent, uses Node crypto). */
function certThumbprint(certPath) {
  try {
    const pem = fs.readFileSync(certPath, "utf8");
    const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const der = Buffer.from(b64, "base64");
    return createHash("sha1").update(der).digest("hex").toLowerCase();
  } catch {
    return null;
  }
}

/** Check whether a cert with the given thumbprint is in the Windows CurrentUser Root store. */
function isCaInWindowsStore(thumbprint) {
  if (!thumbprint) return false;
  try {
    const out = execFileSync(CERTUTIL, ["-store", "-user", STORE_NAME], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return out.toLowerCase().includes(thumbprint.toLowerCase());
  } catch {
    return false;
  }
}

/** Remove all portless CA entries from the Windows Root store (prevents stale cert accumulation). */
function removeStalePortlessCas() {
  try {
    const out = execFileSync(CERTUTIL, ["-store", "-user", STORE_NAME], {
      encoding: "utf8",
      stdio: "pipe",
    });
    // Split into per-cert blocks and find ones belonging to portless.
    const blocks = out.split(/={4,}[^=\n]*={4,}/);
    for (const block of blocks) {
      if (!block.toLowerCase().includes("portless")) continue;
      const m = block.match(/^\s*([0-9a-f]{16,})\s*$/im);
      if (!m) continue;
      try {
        execFileSync(CERTUTIL, ["-delstore", "-user", STORE_NAME, m[1].trim()], { stdio: "pipe" });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Install the portless CA cert into the Windows CurrentUser Root store. */
function installCaToWindows(certPath) {
  const winPath = toWindowsPath(certPath);
  execFileSync(CERTUTIL, ["-addstore", "-user", STORE_NAME, winPath], {
    stdio: "pipe",
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

/** Perform one sync cycle. Returns true if the cert was (re-)installed. */
function sync(force = false) {
  if (!fs.existsSync(CERTUTIL)) {
    console.error("[portless-sync] certutil.exe not found at /mnt/c/Windows/System32/certutil.exe");
    console.error("[portless-sync] Make sure you are running inside WSL with /mnt/c accessible.");
    process.exit(1);
  }

  if (!fs.existsSync(caCertPath)) {
    console.log(`[portless-sync] CA cert not found at ${caCertPath}`);
    console.log("[portless-sync] Run 'portless' at least once so it can generate the CA, then re-run portless-sync.");
    return false;
  }

  const thumbprint = certThumbprint(caCertPath);

  if (!force && isCaInWindowsStore(thumbprint)) {
    console.log(`[portless-sync] portless CA already trusted by Windows${thumbprint ? ` (SHA-1: ${thumbprint})` : ""}.`);
    return false;
  }

  console.log("[portless-sync] Removing stale portless CA entries from Windows Root store...");
  removeStalePortlessCas();

  console.log("[portless-sync] Installing portless CA into Windows Root store...");
  installCaToWindows(caCertPath);

  console.log("[portless-sync] Done. The portless Local CA is now trusted by Windows.");
  if (thumbprint) console.log(`[portless-sync] SHA-1: ${thumbprint}`);
  console.log("[portless-sync] Restart Chrome/Edge if it was already open.");
  return true;
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

function watchMode() {
  console.log(`[portless-sync] Watch mode active — monitoring ${caCertPath}`);

  if (fs.existsSync(caCertPath)) {
    sync();
  } else {
    console.log("[portless-sync] Waiting for portless to generate the CA cert...");
  }

  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  let lastMtime = fs.existsSync(caCertPath) ? fs.statSync(caCertPath).mtimeMs : 0;

  fs.watch(stateDir, (eventType, filename) => {
    if (filename !== "ca.pem") return;
    if (!fs.existsSync(caCertPath)) return;
    try {
      const mtime = fs.statSync(caCertPath).mtimeMs;
      if (mtime === lastMtime) return;
      lastMtime = mtime;
      console.log("[portless-sync] CA cert changed — re-syncing...");
      sync(/* force */ true);
    } catch { /* file disappeared briefly */ }
  });
}

// ---------------------------------------------------------------------------
// Systemd service install / uninstall
// ---------------------------------------------------------------------------

const SYSTEMD_USER_DIR = path.join(HOME, ".config", "systemd", "user");
const SERVICE_FILE = path.join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);

function getNodePath() {
  // Resolve the real node binary path so the service works regardless of nvm shims.
  try {
    return execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
}

function getCurrentPath() {
  // Capture the current PATH so the service inherits the same environment,
  // including nvm, bun, and Windows tools under /mnt/c.
  return process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
}

function buildServiceUnit() {
  const nodePath = getNodePath();
  const currentPath = getCurrentPath();
  const stateDirFlag = flags["state-dir"] ? ` --state-dir ${flags["state-dir"]}` : "";

  return `[Unit]
Description=portless-sync — sync portless local CA cert to Windows trust store
After=default.target

[Service]
Type=simple
ExecStart=${nodePath} ${SCRIPT_PATH} watch${stateDirFlag}
WorkingDirectory=${HOME}
Environment="PATH=${currentPath}"
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

function serviceInstall() {
  fs.mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  fs.writeFileSync(SERVICE_FILE, buildServiceUnit(), "utf8");
  console.log(`[portless-sync] Wrote service file: ${SERVICE_FILE}`);

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", SERVICE_NAME], { stdio: "inherit" });
    console.log(`[portless-sync] Service enabled and started.`);
    console.log(`[portless-sync] Check status:  systemctl --user status ${SERVICE_NAME}`);
    console.log(`[portless-sync] View logs:     journalctl --user -u ${SERVICE_NAME} -f`);
  } catch (err) {
    console.error("[portless-sync] Failed to enable/start the service:", err.message);
    console.error(`[portless-sync] You can try manually: systemctl --user enable --now ${SERVICE_NAME}`);
    process.exit(1);
  }
}

function serviceUninstall() {
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", SERVICE_NAME], { stdio: "inherit" });
  } catch { /* already stopped/disabled — fine */ }

  if (fs.existsSync(SERVICE_FILE)) {
    fs.rmSync(SERVICE_FILE);
    console.log(`[portless-sync] Removed service file: ${SERVICE_FILE}`);
  } else {
    console.log(`[portless-sync] Service file not found (already uninstalled?): ${SERVICE_FILE}`);
  }

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  } catch { /* ignore */ }

  console.log("[portless-sync] Service uninstalled.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

switch (command) {
  case "install":
    serviceInstall();
    break;
  case "uninstall":
    serviceUninstall();
    break;
  case "watch":
    watchMode();
    break;
  case "sync":
  case undefined:
    sync();
    break;
  default:
    console.error(`[portless-sync] Unknown command: ${command}`);
    console.error("Run with --help for usage.");
    process.exit(1);
}
