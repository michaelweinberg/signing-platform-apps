import { expect, test } from 'vitest';
import { PLATFORM_NAME } from './index.js';

test('the shared package can be imported', () => {
  expect(PLATFORM_NAME).toBe('signing-platform');
});
