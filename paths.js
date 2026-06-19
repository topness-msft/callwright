// Centralized paths for the MUTABLE state files, so they can live on a
// persistent volume when hosted. Static assets (prompts, schema) stay in the
// app dir and are loaded relative to cwd as before.
//
// Set CALLWRIGHT_DATA_DIR (e.g. /data on a Fly volume) to relocate state.
// VIRTUPHIL_DATA_DIR is accepted as a legacy fallback. Defaults to "." so
// local/dev behavior is unchanged.

const path = require("path");

const DATA_DIR =
  process.env.CALLWRIGHT_DATA_DIR || process.env.VIRTUPHIL_DATA_DIR || ".";

module.exports = {
  DATA_DIR,
  CONFIG_PATH: path.join(DATA_DIR, "config.json"),
  AGENTS_PATH: path.join(DATA_DIR, "agents.json"),
  PROFILES_PATH: path.join(DATA_DIR, "scenario-profiles.json"),
};
