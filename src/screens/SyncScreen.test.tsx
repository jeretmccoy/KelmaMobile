/**
 * Sync progress UI contract.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

jest.mock('../core/KelmaCore', () => ({
  fullSync: jest.fn(),
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
  syncMedia: jest.fn().mockResolvedValue({ files: 123, bytes: 1024 }),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SyncScreen } from './SyncScreen';

test('shows collection and media progress with final on-disk totals', async () => {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<SyncScreen onSynced={jest.fn()} />);
  });

  await ReactTestRenderer.act(async () => {
    renderer.root
      .findByProps({ placeholder: 'Username or email' })
      .props.onChangeText('user');
    renderer.root
      .findByProps({ placeholder: 'Password' })
      .props.onChangeText('pass');
  });

  await ReactTestRenderer.act(async () => {
    renderer.root
      .findByProps({ accessibilityLabel: 'Sync collection and media' })
      .props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });

  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain('No collection changes');
  expect(output).toContain('123 files · 1.0 KB');
  expect(output).toContain('Sync complete.');
});
