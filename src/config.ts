/**
 * Kelma Mobile runtime configuration.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The default KelmaSync v2 REST server. Native clients append `/v2/*` routes
 * to this base URL.
 *
 * Points at the public KelmaSync v2 deployment, reachable from any network
 * (served through Cloudflare → cloudflared tunnel → Go server on bev). Override
 * per-user once a settings screen exists.
 */
export const DEFAULT_SYNC_ENDPOINT = 'https://sync2.kelma.tech';

/** Previous production aliases that reach the same token/database service. */
export const LEGACY_SYNC_ENDPOINTS = ['https://sync2.ankiai.tech'] as const;


/**
 * Where users create a Kelma account. Account creation is owned by Kelma
 * Immersion (the web app at kelma.tech) — the app links out here for sign-up
 * and only signs in with the resulting email + password.
 */
export const KELMA_SIGNUP_URL = 'https://kelma.tech';

/**
 * The client version string reported to the sync server. Tracks the pinned
 * Anki/rslib core so the server can apply protocol compatibility rules.
 */
export const SYNC_CLIENT_VERSION = 'kelma-mobile,1.1.3,anki25.09.2';

/** Identifier of the active profile (single-profile for now). */
export const DEFAULT_PROFILE_ID = 'default';
