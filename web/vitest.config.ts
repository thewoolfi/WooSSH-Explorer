import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Unit-test config for the web workspace.
 *
 * Kept separate from `vite.config.ts` on purpose: the dev server config carries a
 * proxy that would happily forward a stray `fetch` to a real backend, whereas the
 * test config only needs the React transform and a DOM.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['test/**/*.test.ts'],
    // A failing assertion must never leave a mock's recorded calls behind for the
    // next test: every spec re-arms the api mocks it needs in its own `beforeEach`.
    restoreMocks: true,
  },
});
