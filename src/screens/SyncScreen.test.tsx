/**
 * Sync progress UI contract.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

jest.mock('../core/KelmaCore', () => ({
  fullSyncMonitored: jest.fn(),
  resetMedia: jest.fn().mockResolvedValue(undefined),
  syncCollection: jest.fn().mockResolvedValue({
    required: 'noChanges',
    uploadOk: false,
    downloadOk: false,
    serverMessage: '',
    newEndpoint: null,
  }),
  syncLogin: jest.fn().mockResolvedValue({
    hkey: 'key',
    endpoint: 'http://127.0.0.1:8080',
  }),
  syncMediaMonitored: jest.fn().mockResolvedValue({ files: 123, bytes: 1024 }),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SyncScreen } from './SyncScreen';

// Flush the awaited sign-in -> collection -> media promise chain.
async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

test('shows collection and media progress with final on-disk totals', async () => {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <SyncScreen onSynced={jest.fn()} onSignedIn={jest.fn()} />,
    );
  });

  await ReactTestRenderer.act(async () => {
    renderer.root.findByProps({ placeholder: 'Email' }).props.onChangeText('user@example.com');
    renderer.root.findByProps({ placeholder: 'Password' }).props.onChangeText('pass');
  });

  await ReactTestRenderer.act(async () => {
    renderer.root
      .findByProps({ accessibilityLabel: 'Sync collection and media' })
      .props.onPress();
    await flush();
  });

  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain('No collection changes');
  expect(output).toContain('123 files · 1.0 KB');
  expect(output).toContain('Sync complete in');
});

test('starts signed-in when credentials are already persisted (no re-login)', async () => {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <SyncScreen
        onSynced={jest.fn()}
        onSignedIn={jest.fn()}
        initialAuth={{ hkey: 'key', endpoint: 'http://127.0.0.1:8080' }}
      />,
    );
  });

  // No login form (email field) is shown, and the "Sync now" affordance is used.
  expect(renderer.root.findAllByProps({ placeholder: 'Email' })).toHaveLength(0);
  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain('Signed in');
  expect(output).toContain('Sync now');
});
