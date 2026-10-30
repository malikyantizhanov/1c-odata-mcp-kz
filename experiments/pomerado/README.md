# Проба Pomerado: отпускные в 1С Fresh

Не входит в сборку коннектора (`tsconfig` и `files` в `package.json` коннектора `experiments/` не включают).

```sh
cd experiments/pomerado && npm i --no-audit --no-fund
export PATH=$PWD/node_modules/.bin:$PATH   # Node 24 из пакета node
npm run mint
```

Окружение (секреты — только переменными окружения, не в чат и не в файлы):

| Переменная | Что |
|---|---|
| `OPENAI_API_KEY` | ключ OpenAI (минт; выполнение готовой интеграции модель не вызывает) |
| `ONEC_WEB_URL` | адрес входа в копию базы на 1cfresh.kz |
| `ONEC_WEB_USERNAME`, `ONEC_WEB_PASSWORD` | учётка (та же, что OData) |
| `VAC_EMPLOYEE`, `VAC_DATE_FROM`, `VAC_DATE_TO` | пример: ФИО сотрудника, даты отпуска `ГГГГ-ММ-ДД` |
| `VAC_ORGANIZATION`, `VAC_PERIOD` | необязательно: организация, месяц начисления `ГГГГ-ММ` |

Минт с `effect: "write"` один раз создаёт настоящий документ — только на копии базы. Вопросы Pomerado, кроме
логина, появляются в `questions/<id>.json`; ответ кладётся в `answers/<id>.json`. Результат — MCP-сервер в
`integrations/onec_vacation_accrual/`.
