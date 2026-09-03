import { defineConfig } from '@rstest/core';

/**
 * The pool issue #386 reported: the same unit tests without the preset, so
 * `agent-bundle/meta` resolves to the published throwing module. The
 * repository test drives this configuration only to prove that failure is
 * the `AB4760` diagnostic — it is not a configuration a consumer should copy.
 */
export default defineConfig({
  include: ['tests/unit/**/*.test.ts'],
});
