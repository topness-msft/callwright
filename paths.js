// Centralized paths for the MUTABLE state files, so they can live on a
// persistent volume when hosted. Static assets (prompts, schema) stay in the
// app dir and are loaded relative to cwd as before.
//
// Set CALLWRIGHT_DATA_DIR (e.g. /data on a Fly volume) to relocate state.
// VIRTUPHIL_DATA_DIR is accepted as a legacy fallback. Defaults to "." so
// local/dev behavior is unchanged.

const path = require("path");
const fs = require("fs");

const DATA_DIR =
  process.env.CALLWRIGHT_DATA_DIR || process.env.VIRTUPHIL_DATA_DIR || ".";

// Path to a file on the persistent volume (where runtime-added assets live).
function volumePath(file) { return path.join(DATA_DIR, file); }

// Volume-first asset resolution: prefer a volume copy (e.g. a runtime-added
// language's prompt) and fall back to the image-baked file. Used for assets
// that may be added at runtime but ship with seeds (prompts, lang-phrases).
function resolveAsset(file) {
  if (DATA_DIR !== ".") {
    try { const v = volumePath(file); if (fs.existsSync(v)) return v; } catch { /* ignore */ }
  }
  return file;
}

module.exports = {
  DATA_DIR,
  CONFIG_PATH: path.join(DATA_DIR, "config.json"),
  AGENTS_PATH: path.join(DATA_DIR, "agents.json"),
  PROFILES_PATH: path.join(DATA_DIR, "scenario-profiles.json"),
  CANDIDATES_PATH: path.join(DATA_DIR, "scenario-candidates.json"),
  RETRIES_PATH: path.join(DATA_DIR, "retries.json"),
  ROUTINE_TRIGGERS_PATH: path.join(DATA_DIR, "routine-triggers.json"),
  volumePath,
  resolveAsset,
};
