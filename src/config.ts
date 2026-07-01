/**
 * Kelma Mobile runtime configuration.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The default sync server. Kelma ships pointed at KelmaSync, the self-hosted,
 * Anki-wire-compatible sync server. Anki clients append `/sync/*` and
 * `/msync/*` to this base URL, so it must be the gateway root.
 *
 * This must be reachable from the device running Kelma Mobile — on a physical
 * phone, `127.0.0.1` means the phone itself, so use the host machine's LAN IP
 * (and keep the phone on the same Wi-Fi network as the KelmaSync server).
 * Override per-user once a settings screen exists.
 */
export const DEFAULT_SYNC_ENDPOINT = 'http://192.168.1.225:8080';


/**
 * The client version string reported to the sync server. Tracks the pinned
 * Anki/rslib core so the server can apply protocol compatibility rules.
 */
export const SYNC_CLIENT_VERSION = 'kelma-mobile,0.1.0,anki25.09.2';

/** Identifier of the active profile (single-profile for now). */
export const DEFAULT_PROFILE_ID = 'default';
