import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Единственная задача setup-файла — увести тесты с боевой базы на :memory:
    // до загрузки модулей приложения. Подробности — в src/test-setup.ts.
    setupFiles: ['./src/test-setup.ts'],
  },
});
