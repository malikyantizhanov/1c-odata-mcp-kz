# Установка для команды (Cursor Team Marketplace) и файл баз

Сервер ставится одной командой прямо из GitHub — без `git clone`, без локальной сборки, без публикации в npm.
У каждого бухгалтера свой список баз 1С в файле `~/.1c-odata/databases.json` (или `.yaml`).

## 1. Запуск одной командой

```bash
npx -y github:malikyantizhanov/1c-odata-mcp-kz
```

При первом запуске npm скачивает репозиторий, ставит зависимости и собирает сервер (скрипт `prepare` → `tsc`).
У git-зависимостей npm сам ставит devDependencies (TypeScript) на время сборки. Последующие запуски берут готовую
сборку из кеша npx (см. п. 1а — как этого избежать).

| | Время (проверено: Linux, Node 20, npm 10.9, пустой кеш) |
|---|---|
| первый запуск до ответа `initialize` | ≈ 17–19 с |
| повторный запуск (кеш npx) | ≈ 1,5 с |

Требования:

- **Node.js ≥ 20 и npm ≥ 10.** С npm 9 (например, `nodejs`/`npm` из пакетов Debian/Ubuntu) установка из git со скриптом
  `prepare` через `npx` не работает (ошибка «could not determine executable to run» или зависание) — обновите npm:
  `npm i -g npm@10` или поставьте Node с nodejs.org.
- Доступ к github.com и registry.npmjs.org (и git в PATH на случай, если npm будет клонировать репозиторий).
- Ветка без указания версии (`github:…/1c-odata-mcp-kz`) — при каждом старте npm проверяет последний коммит `main` и при
  изменениях пересобирает. Чтобы зафиксировать версию для всей команды: `github:malikyantizhanov/1c-odata-mcp-kz#<тег или коммит>`.

Windows и macOS:

- **Windows:** если клиент пишет `spawn npx ENOENT`, запускайте через `cmd`: команда `cmd`, аргументы
  `/c npx -y github:malikyantizhanov/1c-odata-mcp-kz`. Права файла (`chmod 600`) на Windows не проверяются —
  храните файл в своём профиле (`%USERPROFILE%\.1c-odata\databases.json`).
- **macOS:** Cursor, запущенный из Dock, не видит переменные из `~/.zshrc`. Пароли через `password_env` задавайте в
  поле «Env» сервера или держите пароль в самом файле с правами 600.

## 1а. Запуск через обёртку (всегда свежая сборка)

`npx -y github:…` без указания коммита может взять старую сборку из кеша npx. Чтобы каждый запуск брал актуальный `main`,
определите SHA последнего коммита и запустите именно его. Пример скрипта-обёртки (`~/.1c-odata/run-mcp.sh`, `chmod 700`; секретов в нём нет —
пароли берутся из переменных окружения `ODATA_PW_<…>`, которые задаёт клиент или ваш профиль):

```bash
#!/usr/bin/env bash
set -euo pipefail
SHA=$(git ls-remote https://github.com/malikyantizhanov/1c-odata-mcp-kz refs/heads/main | cut -c1-40)
exec npx -y "github:malikyantizhanov/1c-odata-mcp-kz#$SHA"
```

Новый SHA — новый ключ в кеше npx, поэтому устаревшая сборка не используется; если коммит не менялся, берётся готовая из кеша (быстро).
В форме клиента: Command `bash`, Args `~/.1c-odata/run-mcp.sh` (абсолютный путь). Нужен git в PATH.

## 2. Файл баз (`ODATA_CONFIG`)

Путь — переменная `ODATA_CONFIG` (`~` раскрывается). Если она не задана — берётся первый существующий из
`~/.1c-odata/databases.json`, `~/.1c-odata/databases.yaml`, `~/.1c-odata/databases.yml`.

```json
{
  "default": "buh",
  "databases": [
    {
      "name": "buh",
      "label": "ТОО «Ромашка» — Бухгалтерия",
      "base_url": "https://1cfresh.kz/a/ea20/000000/odata/standard.odata/",
      "username": "odata",
      "password_env": "ODATA_PW_BUH",
      "writable": true
    },
    {
      "name": "ip",
      "label": "ИП Иванов",
      "base_url": "https://1cfresh.kz/a/ea20/111111/odata/standard.odata/",
      "username": "odata",
      "password": "…",
      "writable": true
    }
  ]
}
```

Запись в базу разрешает **один** флаг — `"writable": true` у этой базы (по умолчанию `false`). Глобальный `READ_ONLY`
по умолчанию `false` и не мешает; `READ_ONLY=true` — необязательный режим «только чтение», включается только вручную.
Любую запись всё равно должен сначала подтвердить бухгалтер (dry-run → «да» → `confirm=true`).
В JSON-файле комментарии и неизвестные поля не допускаются (формат строгий), поэтому пояснение — здесь;
в [`databases.example.yaml`](../databases.example.yaml) оно есть комментарием.

Примеры в корне репозитория: [`databases.example.json`](../databases.example.json),
[`databases.example.yaml`](../databases.example.yaml). Можно и просто массив баз без `default`.

| Поле | Обязательно | Смысл |
|---|---|---|
| `name` | да | имя базы для параметра `database` (латиница, цифры, `_`, `-`; регистр не важен) |
| `label` | нет | человекочитаемое название |
| `base_url` | да | адрес OData `…/odata/standard.odata/` |
| `username` | да | пользователь 1С с правом OData |
| `password` или `password_env` | одно из двух | пароль прямо в файле **или** имя переменной окружения, где он лежит |
| `writable` | нет | разрешить запись в эту базу (по умолчанию `false`; запись включается только этим флагом; общий `READ_ONLY=true` — необязательный явный запрет записи) |
| `default` (верхний уровень) | нет | база по умолчанию |

Безопасность:

- Файл с паролями — `chmod 600 ~/.1c-odata/databases.json`. Если файл доступен группе или всем, сервер при старте
  пишет предупреждение в stderr.
- `password_env` — секретов в файле нет; пароль лежит в переменной окружения (например, в поле Env сервера у
  конкретного пользователя).
- Пароли и логины не попадают ни в лог старта, ни в тексты ошибок: ошибки называют файл, номер и имя базы и поле, но
  не значения (битый JSON/YAML — только позиция).

### Слияние с переменными окружения (обратная совместимость)

- Старые переменные работают как раньше: `ODATA_BASE_URL`/`ODATA_USERNAME`/`ODATA_PASSWORD` (база `default`) и
  `ODATA_DB_<ИМЯ>_BASE_URL`/`_USERNAME`/`_PASSWORD`/`_LABEL`/`_WRITABLE`.
- Файл и переменные **складываются**. Одинаковое имя базы — **побеждают переменные окружения** (база из файла
  заменяется целиком, в stderr — предупреждение). Внутри одного источника повтор имени — ошибка.
- Одиночная `ODATA_BASE_URL` учитывается, только если нет `ODATA_DB_<ИМЯ>_BASE_URL` (как раньше).
- База по умолчанию: `ODATA_DEFAULT_DB` → `default` из файла → первая по алфавиту.
- Явно заданный `ODATA_CONFIG`, которого нет на диске, — ошибка; файл по умолчанию просто необязателен.

## 3. Значения для формы Cursor Team Marketplace (транспорт «Command»)

| Поле | Значение |
|---|---|
| Name | `1c-odata` |
| Transport | Command |
| Command | `npx` (Windows: `cmd`) |
| Args | `-y` `github:malikyantizhanov/1c-odata-mcp-kz` (Windows: `/c` `npx` `-y` `github:malikyantizhanov/1c-odata-mcp-kz`) |
| Env | `ODATA_CONFIG=~/.1c-odata/databases.json` — необязательно (это и так путь по умолчанию) |

Необязательные переменные Env: `ODATA_DEFAULT_DB` (база по умолчанию), `READ_ONLY` (по умолчанию `false`; `true` — вручную запретить запись во всех базах, даже с `writable: true`), `ODATA_PRINT_DIR` (куда класть PDF), `ODATA_PW_<…>` — пароли для
`password_env` (**секрет**; задавать у каждого пользователя, не в общей записи команды).

Каждый бухгалтер один раз создаёт `~/.1c-odata/databases.json` со своими базами (`chmod 600`) и перезапускает Cursor;
проверка — «проверь соединение с 1С» (инструмент `read.system.health_check`).
