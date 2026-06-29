import { decodeCoreInfo } from './KelmaCore';

describe('decodeCoreInfo', () => {
  it('accepts the native core identity contract', () => {
    expect(
      decodeCoreInfo(
        JSON.stringify({
          ankiVersion: '25.09.2',
          ankiCommit: 'abc123',
          bridgeVersion: '0.1.64-anki25.09.2',
          platform: 'android',
        }),
      ),
    ).toEqual({
      ankiVersion: '25.09.2',
      ankiCommit: 'abc123',
      bridgeVersion: '0.1.64-anki25.09.2',
      platform: 'android',
    });
  });

  it('rejects malformed native payloads', () => {
    expect(() => decodeCoreInfo('{"platform":"web"}')).toThrow(
      'invalid identity payload',
    );
  });
});
