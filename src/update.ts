/** Kelma-controlled update manifest client. */
import {
  ALTSTORE_UPDATE_URL,
  MOBILE_APP_VERSION,
  UPDATE_MANIFEST_URL,
} from './config';

export type MobileUpdate = {
  version: string;
  build: number;
  url: string;
  sha256: string;
  size: number;
  notesUrl: string;
};

type UpdateManifest = {
  schema?: number;
  ios?: Partial<MobileUpdate> & { notes_url?: string };
};

export function versionTuple(value: string): number[] {
  const match = value.trim().match(/^(\d+(?:\.\d+)*)/);
  return match ? match[1].split('.').map(Number) : [0];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const left = versionTuple(candidate);
  const right = versionTuple(current);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export async function fetchMobileUpdate(): Promise<MobileUpdate> {
  const response = await fetch(UPDATE_MANIFEST_URL, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Update server returned ${response.status}.`);
  }
  const manifest = (await response.json()) as UpdateManifest;
  const ios = manifest.ios;
  if (manifest.schema !== 1 || !ios || typeof ios.version !== 'string') {
    throw new Error('The Kelma update manifest is invalid.');
  }
  if (
    typeof ios.build !== 'number' ||
    typeof ios.url !== 'string' ||
    !ios.url.startsWith('https://') ||
    typeof ios.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(ios.sha256)
  ) {
    throw new Error('The iOS update metadata is invalid.');
  }
  return {
    version: ios.version,
    build: ios.build,
    url: ios.url,
    sha256: ios.sha256.toLowerCase(),
    size: Number(ios.size ?? 0),
    notesUrl: String(ios.notes_url ?? ALTSTORE_UPDATE_URL),
  };
}

export async function availableMobileUpdate(): Promise<MobileUpdate | null> {
  const update = await fetchMobileUpdate();
  return isNewerVersion(update.version, MOBILE_APP_VERSION) ? update : null;
}
