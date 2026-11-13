/**
 * The single source of the plugin's runtime version identity.
 *
 * Both halves need it: the host half reports it to the settings page (so the
 * page badge always matches the code that is actually loaded) and stamps it on
 * the MCP `Client` handshake, and the browser half reads the same snapshot.
 * Reading the manifest here — instead of copying a literal into each module —
 * keeps those identities from drifting apart, and stays outside `./index.js` so
 * `./supervisor.js` can import it without a module cycle.
 *
 * A missing or unreadable manifest must not fail the row: the version is
 * diagnostic, not functional.
 *
 * @module dsh-mcp-manager/version
 */
import { readFileSync } from 'node:fs'

/** Shown when the manifest cannot be read; never a valid published version. */
export const UNKNOWN_VERSION = '0.0.0'

/**
 * Read `version` from the package manifest beside this module.
 * @returns the declared version, or `0.0.0` when it cannot be read.
 */
function readPackageVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : UNKNOWN_VERSION
  } catch {
    return UNKNOWN_VERSION
  }
}

/** The installed package version, read from this package's own manifest. */
export const VERSION = readPackageVersion()
