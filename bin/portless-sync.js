#!/usr/bin/env node
// portless-sync: syncs the portless local CA from WSL to the Windows host trust store.
// Usage: node bin/portless-sync.js [--watch] [--state-dir <path>]

import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const { values: flags } = parseArgs({
  options: {
    watch: { type: "boolean", default: false },
    "state-dir": { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (flags.help) {
  console.log(`portless-sync — sync the portless local CA cert from WSL to Windows

Usage:
  portless-sync [options]

Options:
  --watch          Watch for CA cert changes and re-sync automatically
  --state-dir DIR  Override the portless state directory (default: ~/.portless)
  --help           Show this help message

Installs the portless local CA certificate (~/.portless/ca.pem) into the Windows
CurrentUser Root certificate store via certutil.exe so that Chrome and Edge trust
portless HTTPS URLs without SSL errors.

No administrator privileges required — certutil installs into the current user's
store (CurrentUser\\Root).

Requires WSL with /mnt/c accessible.
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const CERTUTIL = "/mnt/c/Windows/System32/certutil.exe";
const STORE_NAME = "Root"; // Windows "Trusted Root Certification Authorities"

const stateDir = flags["state-dir"] ?? path.join(os.homedir(), ".portless");
const caCertPath = path.join(stateDir, "ca.pem");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a WSL Linux path to a Windows UNC path using wslpath. */
function toWindowsPath(linuxPath) {
  try {
    return execFileSync("wslpath", ["-w", linuxPath], { encoding: "utf8" }).trim();
  } catch {
    // wslpath unavailable — approximate by rewriting /mnt/X/... → X:\...
    return linuxPath.replace(/^\/mnt\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\");
  }
}

/**
 * Compute the SHA-1 thumbprint of a PEM cert.
 * Uses Node crypto — fully locale-independent.
 */
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

/**
 * Check whether a cert with the given SHA-1 thumbprint exists in the
 * Windows CurrentUser Root store.
 * Parses certutil output — works regardless of Windows locale.
 */
function isCaInWindowsStore(thumbprint) {
  if (!thumbprint) return false;
  try {
    const out = execFileSync(CERTUTIL, ["-store", "-user", STORE_NAME], {
      encoding: "utf8",
      stdio: "pipe",
    });
    // certutil prints hash values as plain hex strings, locale-independent.
    return out.toLowerCase().includes(thumbprint.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Remove stale portless CA entries from the Windows Root store.
 * Deletes by the cert's serial number which is unique per generation.
 */
function removeStalePortlessCas() {
  try {
    const out = execFileSync(CERTUTIL, ["-store", "-user", STORE_NAME], {
      encoding: "utf8",
      stdio: "pipe",
    });
    // Find all certs whose issuer/subject contains "portless" and collect their serials.
    // certutil output looks like (locale varies, but "portless Local CA" is our CN):
    //   === Certificate N ===
    //   Serial Number: <hex>
    //   Issuer: CN=portless Local CA
    //   ...
    // Split by certificate blocks (separated by ===...=== lines).
    const blocks = out.split(/={4,}[^=]*={4,}/);
    for (const block of blocks) {
      if (!block.toLowerCase().includes("portless")) continue;
      // Extract serial — it's the hex string on the serial number line.
      const m = block.match(/^\s*([0-9a-f]{16,})\s*$/im);
      if (!m) continue;
      const serial = m[1].trim();
      try {
        execFileSync(CERTUTIL, ["-delstore", "-user", STORE_NAME, serial], { stdio: "pipe" });
      } catch {
        // Might not exist under that serial format — ignore.
      }
    }
  } catch {
    // Ignore errors — store may be empty or certutil failed.
  }
}

/**
 * Install the portless CA cert into the Windows CurrentUser Root store.
 */
function installCaToWindows(certPath) {
  const winPath = toWindowsPath(certPath);
  // -addstore -user → CurrentUser store, no admin required.
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
    console.error("[portless-sync] Make sure you are running inside WSL and the C: drive is mounted at /mnt/c.");
    process.exit(1);
  }

  if (!fs.existsSync(caCertPath)) {
    console.log(`[portless-sync] CA cert not found at ${caCertPath}`);
    console.log("[portless-sync] Run 'portless' at least once so it generates the CA, then re-run portless-sync.");
    return false;
  }

  const thumbprint = certThumbprint(caCertPath);

  if (!force && isCaInWindowsStore(thumbprint)) {
    console.log(`[portless-sync] portless CA is already trusted by Windows${thumbprint ? ` (SHA-1: ${thumbprint})` : ""}.`);
    return false;
  }

  console.log("[portless-sync] Removing any stale portless CA entries from Windows Root store...");
  removeStalePortlessCas();

  console.log("[portless-sync] Installing portless CA into Windows Root store...");
  installCaToWindows(caCertPath);

  console.log("[portless-sync] Done. The portless Local CA is now trusted by Windows.");
  if (thumbprint) console.log(`[portless-sync] SHA-1: ${thumbprint}`);
  console.log("[portless-sync] Restart Chrome/Edge if it was already open for the change to take effect.");
  return true;
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

function watchMode() {
  console.log(`[portless-sync] Watch mode active — monitoring ${caCertPath}`);

  // Initial sync.
  if (fs.existsSync(caCertPath)) {
    sync();
  } else {
    console.log("[portless-sync] Waiting for portless to generate the CA cert...");
  }

  // Ensure the state dir exists so we can watch it.
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  let lastMtime = fs.existsSync(caCertPath) ? fs.statSync(caCertPath).mtimeMs : 0;

  fs.watch(stateDir, (eventType, filename) => {
    if (filename !== "ca.pem") return;
    if (!fs.existsSync(caCertPath)) return;
    try {
      const mtime = fs.statSync(caCertPath).mtimeMs;
      if (mtime === lastMtime) return; // spurious event
      lastMtime = mtime;
      console.log("[portless-sync] CA cert changed — re-syncing...");
      sync(/* force */ true);
    } catch {
      // File disappeared briefly — ignore.
    }
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (flags.watch) {
  watchMode();
} else {
  sync();
}
