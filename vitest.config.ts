import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Тесты негативных сценариев пишут ошибки через логгер — не в рабочий лог пользователя.
    // Проверка новой версии на GitHub (version.ts) в тестах выключена: без сети и без задержек.
    env: { LOG_LEVEL: "silent", ODATA_UPDATE_CHECK: "false" },
  },
});
