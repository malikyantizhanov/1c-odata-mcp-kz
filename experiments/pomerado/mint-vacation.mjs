// Минт интеграции Pomerado «начислить отпускные» в веб-клиенте 1С Fresh (БК КЗ 3.0), режим библиотеки.
// Логин и пароль — из окружения (в проде — расшифрованные из onec_connections), в чат и в файлы не попадают.
// Прочие вопросы Pomerado пишутся в questions/<id>.json; ответ ждётся в answers/<id>.json.
//
// Окружение: OPENAI_API_KEY, ONEC_WEB_URL, ONEC_WEB_USERNAME, ONEC_WEB_PASSWORD,
//            VAC_EMPLOYEE, VAC_DATE_FROM, VAC_DATE_TO [, VAC_ORGANIZATION, VAC_PERIOD]
import { Effect } from "effect";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPomerado, makeInputAsker, prepareIntegration } from "pomerado";

const here = import.meta.dirname;
const need = (k) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`не задано ${k}`);
  return v;
};
const url = need("ONEC_WEB_URL");
const login = { username: need("ONEC_WEB_USERNAME"), password: need("ONEC_WEB_PASSWORD") };
need("OPENAI_API_KEY");

const input = {
  employee: need("VAC_EMPLOYEE"),
  dateFrom: need("VAC_DATE_FROM"),
  dateTo: need("VAC_DATE_TO"),
  ...(process.env.VAC_ORGANIZATION ? { organization: process.env.VAC_ORGANIZATION } : {}),
  ...(process.env.VAC_PERIOD ? { registrationPeriod: process.env.VAC_PERIOD } : {}),
};

const intent = `
Веб-клиент 1С:Предприятие 8.3, конфигурация «Бухгалтерия для Казахстана» 3.0, сервис 1С:Fresh.
Задача: начислить отпускные сотруднику. В этой конфигурации отдельного документа «Отпуск» нет —
отпускные начисляются документом «Начисление зарплаты работникам организаций»
(раздел «Зарплата и кадры» → «Начисление зарплаты»).

Шаги:
1. Войти (если нужно — запустить приложение из личного кабинета 1cfresh) и дождаться загрузки рабочего стола 1С.
2. Создать новый документ «Начисление зарплаты работникам организаций».
   Организация — input.organization, если задана; месяц начисления (ПериодРегистрации) — input.registrationPeriod
   (формат ГГГГ-ММ), если задан, иначе месяц input.dateFrom.
3. На вкладке «Начисления» добавить строку: Работник — input.employee (выбрать из справочника по ФИО),
   Вид расчёта — «Отпуск» (вид расчёта, название которого начинается с «Отпуск»),
   период строки: с input.dateFrom по input.dateTo (даты в input — ГГГГ-ММ-ДД).
4. Нажать кнопку «Рассчитать» (если её нет — «Заполнить и рассчитать» / «Рассчитать» в командной панели
   табличной части) и дождаться, пока 1С посчитает сумму в колонке «Результат».
5. Нажать «Записать» (НЕ «Провести», НЕ «Провести и закрыть»: документ остаётся непроведённым).
6. Вернуть: номер и дату документа, ФИО работника, вид расчёта, период, сумму «Результат» (число),
   количество дней, если оно показано.

Если 1С показывает сообщение об ошибке или «Результат» остался 0 — не нажимать «Записать», а вернуть ошибку
с текстом сообщения 1С. Веб-клиент 1С строит интерфейс из div-элементов с атрибутами title и id вида
form<N>_<ИмяЭлемента>: номер N меняется между сеансами, поэтому опирайся на окончание id или title, а не на N.
Модальные окна 1С рисуются внутри страницы. После расчёта 1С может показать индикатор длительной операции — ждать.
`.trim();

const request = { url, intent, input, effect: "write" };

// Вопросы: логин — из окружения; остальное — через файлы.
const qdir = join(here, "questions");
const adir = join(here, "answers");
mkdirSync(qdir, { recursive: true });
mkdirSync(adir, { recursive: true });

const answerByFile = (req) =>
  Effect.promise(async () => {
    writeFileSync(join(qdir, `${req.id}.json`), JSON.stringify(req, null, 2));
    console.error(`[ask] вопрос ${req.id} → questions/${req.id}.json`);
    const file = join(adir, `${req.id}.json`);
    while (!existsSync(file)) await new Promise((r) => setTimeout(r, 2000));
    const a = JSON.parse(readFileSync(file, "utf8"));
    rmSync(file);
    return a;
  });

const ask = makeInputAsker((req) => {
  const qs = req.questions ?? [];
  if (qs.length > 0 && qs.every((q) => q.type === "credential")) {
    console.error(`[ask] логин для ${req.id}: подставлен из окружения`);
    return Effect.succeed(
      Object.fromEntries(qs.map((q) => [q.id, { ...login, identifierKind: "username", saveLogin: false }])),
    );
  }
  return answerByFile(req);
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const save = yield* prepareIntegration({
      root: join(here, "integrations"),
      name: "onec_vacation_accrual",
      request,
      description: "Начислить отпускные сотруднику в 1С Fresh (БК КЗ 3.0): документ «Начисление зарплаты», Рассчитать, Записать без проведения.",
    });
    const pomerado = yield* createPomerado({ ask });
    const outcome = yield* pomerado.mint(request);
    writeFileSync(
      join(here, "mint-outcome.json"),
      JSON.stringify({ ...outcome, artifact: outcome.artifact ? "<saved>" : undefined }, null, 2),
    );
    if (outcome.artifact === undefined) {
      console.error("[mint] интеграция не собрана:", outcome.summary ?? "");
      return;
    }
    const saved = yield* save(outcome.artifact);
    console.error("[mint] сохранено:", saved.directory);
  }),
);

Effect.runPromise(program).catch((e) => {
  // в тексте ошибки Pomerado маскирует похожее на секреты; на всякий случай вырезаем пароль сами
  console.error("[mint] сбой:", String(e?.stack ?? e).split(login.password).join("***"));
  process.exit(1);
});
