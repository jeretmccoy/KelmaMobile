import { availableMobileUpdate, fetchMobileUpdate, isNewerVersion } from './update';

beforeEach(() => {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      schema: 1,
      ios: {
        version: '1.1.8',
        build: 9,
        url: 'https://kelma.tech/altstore/KelmaMobile.ipa',
        sha256: 'a'.repeat(64),
        size: 123,
        notes_url: 'https://kelma.tech/altstore/',
      },
    }),
  });
});

test('compares dotted versions numerically', () => {
  expect(isNewerVersion('1.1.10', '1.1.9')).toBe(true);
  expect(isNewerVersion('1.1.4', '1.1.4')).toBe(false);
  expect(isNewerVersion('1.2', '1.1.99')).toBe(true);
});

test('validates and returns the iOS update', async () => {
  await expect(fetchMobileUpdate()).resolves.toMatchObject({
    version: '1.1.8',
    build: 9,
  });
  await expect(availableMobileUpdate()).resolves.toMatchObject({ version: '1.1.8' });
});
