# AGENTS.md — sbe-documents (Документы)

SBE-плагин «Документы»: локальная БД-кэш документов + синхронизация с documents-service
(сервер — канон), файлы документов в S3 (`sbe-doc`).

**Бэк — в этой же папке** (`documents-service/`, 2026-08-24, переехал из
`server_back/documents-service/`) — на отдельной ветке `backend` (main — чистый
релизный срез кода плагина, без бэка; см. правило «Бэки в папках плагинов» в
корневом `plugins/AGENTS.md`).

## Назначение (текущее)

- **Синхронизация** с сервером `https://epyur.fvds.ru` через JWT из ЦУП СБЕ
  (`getService('sbe-apstore').auth.getToken('documents')`): push `/api/documents/sync/push`,
  pull `/api/documents/sync/pull`. Сервер — канон, локальный JSON — кэш. Конфликты — LWW
  по `updated_at`.
- **Локальная БД**: `yourbase/sbe_documents/documents_data.json`
  (`{"documents": [...], "doc_types": [...]}`). Модель `DocItem` совместима с серверной.
- **Миграция**: одноразовый импорт документов (`type: "document"`) из `yourbase/yougile_cache.json`
  монолита. doc_type = название колонки YouGile; ссылки kb.tn.ru/yougile остаются как `link_url`.
- **UI — фасад «LogicTEAM.Документы»** (как sbe-requests/sbe-lims): топбар (создание, crumb) +
  сайдбар (сворачивание, «Документы», «Фильтры» — чекбоксы типов, Синхронизация, Экспорт HTML) +
  контент-карточка. Документы — карточками; связанные (`parent_id>0`) — вложенными списками
  внутри карточки родителя (собственной карточки не имеют). Привязка существующих — «🔗 Привязать
  документы»; «➕ Связанный документ» — только создание нового; отвязка — «⤴ Отвязать» в деталях.
- **Файлы**: 1 файл на документ + файлы замечаний — загружаются в S3 через сервис
  (`POST /api/documents/file`, `POST /api/documents/remark-file`). Скачивание — через
  `GET /api/documents/file?key=...` (JWT) в кэш `yourbase/sbe_documents/files/` с открытием
  в Obsidian или системным приложением (прямой `file_url` недоступен — бакет приватный).
  Загрузка через **rclone CLI** внутри сервиса (aws-sdk-go-v2 зависал на этом Ceph).
- **Точка входа** — магазин: «Установленные → Открыть» (`publishService('sbe-documents', {open})`).

## Структура

| Файл | Что это |
|---|---|
| `src/main.ts` | `SbeDocumentsPlugin`: настройки, БД, syncService, миграция, импорт реестра, view, publishService, новость в «Новости» ЦУП |
| `src/database/documents-db.ts` | `DocumentsDatabase`: кэш JSON, mergeFromServer (LWW), dedupe, importLegacy, doc_types |
| `src/services/sync.service.ts` | `DocumentsSyncService`: push/pull/uploadFile/uploadRemarkFile, JWT, multipart, таймауты |
| `src/services/sert-import.service.ts` | `SertImportService`: импорт реестра сертификатов (sert/Реестр сертификатов TN1.json), загрузка файлов в S3, дедуп |
| `src/utils/xlsx-writer.ts` | `buildXlsx`: генерация `.xlsx` без зависимостей (ZIP stored + CRC32 + inline strings) |
| `src/ui/documents-view.ts` | `DocumentsView`: фасад «LogicTEAM.Документы» (топбар+сайдбар+контент), карточки со вложенными связанными, детали, привязка/отвязка, create/edit, замечания, фильтры по типам/странам в сайдбаре, скачивание/открытие файлов, экспорт HTML/Excel, импорт реестра |
| `src/ui/settings-tab.ts` | Настройки: apiUrl, куратор по умолчанию |
| `src/types/documents.ts` | `DocItem`, `DocumentRemark`, `DocumentsDbData`, `UploadFileResponse`, legacy-типы |
| `src/styles.css` | Классы `tn-doc-*` на семантических токенах |

## Настройки (data.json)

`apiUrl` (default `https://epyur.fvds.ru`), `defaultAuthor` (default `И.И. Иванов`),
`legacyMigrated`, `sertImported` (одноразовый импорт реестра сертификатов),
`lastAnnouncedVersion` (версия, для которой опубликована новость в ЦУП).

## Правила

- `catch(e: unknown)` + `errorMessage()`; `requestUrl()`; `window.setTimeout()`; без `any`;
  UI на русском; автор — Полищук Евгений (polishchuk@tn.ru). Классы `tn-doc-*` / `tn-btn*`
  / `tn-table` на семантических токенах sbe-core.
- Коммиты/пуши — только по явной команде пользователя.
- **«Фиксируй» = поднять версию (+0.0.1 в `manifest.json` и `package.json`), обновить
  документацию, подготовить сообщение для коммита и СПРОСИТЬ подтверждение commit/push.**
  Не поднимать версию плагина при коммите чисто бэковых изменений в
  `documents-service/` (ветка `backend`), если сам плагин не менялся.

## История работ

### 2026-08-25 — v0.1.10 (архив, глобальные фильтры, сортировка, настройки реестра)
- **Архив документов**: поле `archived` в модели; куратор или админ могут отправить документ
  в архив / вернуть из архива (кнопки в деталях, «🗑 Удалить» — необратимо). После истечения
  срока действия документ автоматически переводится в архив (`documents-service.checkArchived`,
  при старте и раз в 6 ч) и продолжает отображаться. Статус «Архивный» показывается в
  карточке и деталях (`effectiveArchived` учитывает и истёкший срок).
- **Глобальные фильтры** в сайдбаре: «Все документы» / «Действующие документы» /
  «Архивные документы» (состояние `archivedFilter`, применяется к списку и экспорту).
- **Сортировка** (`compareDocs`): неархивные со сроком (ближе срок — выше) → неархивные
  без срока → архивные (недавно истёкшие выше, истёкшие давно ниже).
- **Куратор при создании** документа подставляется email пользователя, добавляющего документ
  (раньше — `defaultAuthor`).
- **Настройки реестра** (кнопка «⚙️» в сайдбаре, admin): страница внутри плагина с
  управлением группами типов — переименование, объединение (общее имя), удаление только
  пустых групп. Изменения применяются и на сервере (`POST /api/documents/types/merge`), и в
  локальной БД (`DocumentsDatabase.mergeDocType/removeDocType/countByDocType`). Раздел из
  настроек плагина убран (там отображался некорректно); карточки-строки на flex вместо таблицы.
- **Алфавитная сортировка** названий типов в фильтрах сайдбара, datalist формы и в
  «Настройках реестра» (`localeCompare('ru')`).
- Кнопка «Импорт реестра» из сайдбара убрана (импорт выполняется автоматически один раз).
- **Бэкенд** (ветка backend): колонка `archived`, эндпоинты `POST /api/documents/archive`
  (куратор/admin) и `DELETE /api/documents/{id}` (куратор/admin), `POST /api/documents/types/merge`
  (admin), авто-архив по истечении срока, фикс INSERT без id (лишний плейсхолдер $29).
  Задеплоено на VDS, E2E зелёный.
- Версия 0.1.9 → **0.1.10** (manifest + package.json). `npx tsc --noEmit` EXIT=0,
  `npm run build` OK.

### 2026-08-25 — v0.1.9 (реестр сертификатов: модель, импорт, экспорт Excel)
- **Расширена модель `DocItem`** 13 полями под колонки Excel: `country`, `doc_number`,
  `valid_from`, `comment`, `responsible`, `product_group`, `trademark`, `manufacturer`,
  `tn_ved_code`, `testing_lab`, `protocol_number`, `certification_body`, `ik_date`.
- **Бэкенд documents-service** (ветка `backend`): 13 новых колонок таблицы `documents`
  (`ADD COLUMN IF NOT EXISTS`), структура `Document`, push (UPDATE/INSERT) и pull
  (SELECT/Scan) с новыми полями. Задеплоено на VDS (`docker compose up -d --build documents`),
  health OK, E2E round-trip всех полей (в т.ч. кириллица) зелёный.
- **Подготовка данных**: Python-утилита `sert/Реестр сертификатов TN1.xlsx` (листы
  «РД со сроком действия» 153 + «Заключения, испытания» 75) → `sert/Реестр сертификатов
  TN1.json` с матчингом файлов из `sert/1. Сертификаты` по номеру документа
  (нормализация/транслитерация, алиасы для `-С`/`-Р`, `CRP/CPR`; папки `\повтор\`/`\старое\`
  исключены). Сопоставлено 138 файлов; отчёт по не-сматченным — в
  `C:\Users\adm\AppData\Local\Temp\opencode\sert_match_report.txt`.
- **Импорт реестра**: `SertImportService` — чтение JSON из вольта, загрузка файлов в S3
  (`uploadFile`), создание `DocItem` (`sync_status local`, куратор `apotapov@tn.ru`),
  дедуп по `doc_number`+`title` (если документ уже есть без файла, а файл появился —
  дозагружается). Одноразовый автоимпорт при первом запуске (флаг `sertImported`) +
  кнопка «📥 Импорт реестра» в сайдбаре (editor/admin). После импорта — автосинхронизация.
- **UI**: карточка показывает `№ документа`, страну, ответственного; в деталях — таблица
  «Реквизиты реестра» (все заполненные поля); форма создания/редактирования расширена
  полями Excel (включая «Начало действия», «Дата ИК»); фильтр «Страна» в сайдбаре.
- **Экспорт Excel**: кнопка «📊 Экспорт Excel» — выгрузка текущего отфильтрованного набора
  (поиск + типы + страны) в настоящий `.xlsx` (самописный writer `src/utils/xlsx-writer.ts`,
  ZIP stored + CRC32 + inline strings, без npm-зависимостей). Файл
  `yourbase/sbe_documents/exports/Реестр_<дата>.xlsx` открывается системным приложением.
- **Новость в «Новости» ЦУП** (`announceUpdate`) — подключён механизм публикации один раз
  на версию (флаг `lastAnnouncedVersion`).
- **Уведомления об истечении срока** (`/api/documents/notify-settings`, admin): в настройках
  плагина включается отправка писем кураторам за N дней до окончания действия документа
  (сроки настраиваются, по умолчанию «30,14,7»). Письмо уходит с `noreply` (та же
  `SMTP_FROM`, что у auth-service) через локальный exim; одно письмо на (документ, срок) —
  таблица `documents_notifications`. Фоновая проверка — на старте сервиса и раз в 6 ч
  (нотификация с `startNotifyJob`); письма шлёт `documents-service`, не плагин.
- Версия 0.1.8 → **0.1.9** (manifest + package.json). `npx tsc --noEmit` EXIT=0,
  `npm run build` OK.
- Дизайн-спека: `docs/superpowers/specs/2026-08-25-sbe-documents-sert-registry-design.md`.

### 2026-08-20 — v0.1.8 (пересборка за sbe-core: SbeContactsApi)
- `sbe-core`: добавлены `SbeContactsApi` и `'sbe-contacts'` в `SbeServiceMap` — пересборка `main.js`, исходники плагина не менялись. Версия 0.1.7 → **0.1.8** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK.

### 2026-08-19 — v0.1.7 (фасад + карточки со связями, скачивание файлов, фиксы)
- **Скачивание файлов из S3**: `file_url` — прямой S3-URL (бакет `sbe-doc` приватный) → в
  браузере ошибка доступа. Используется JWT-эндпоинт `GET /api/documents/file?key=...`
  (`sync.service.downloadFile`): файл сохраняется в `yourbase/sbe_documents/files/`, затем
  открывается в Obsidian (md/pdf/img/txt/csv/html — `workspace.openLinkText`) или системным
  приложением (`require('electron').shell.openPath`). esbuild: `external: ['obsidian', 'electron']`.
  `request()` теперь возвращает `{status, text, arrayBuffer}`.
- **Фасад «LogicTEAM.Документы»** (как sbe-requests/sbe-lims): топбар + сайдбар (сворачивание,
  дерево навигации, «Фильтры» с чекбоксами типов, Синхронизация, Экспорт HTML) + контент-карточка.
- **Карточки вместо таблицы**: документы — карточками (заголовок, чип срока, мета, файл), связанные
  (`parent_id>0`) показываются вложенными списками внутри карточки родителя (рекурсивно, как
  подзадачи в sbe-tasks) и **не имеют собственной карточки**; порядок — по id (порядок добавления).
- **Привязка/отвязка**: «🔗 Привязать документы» — пикер существующих «свободных» документов
  (чекбоксы, без перезаполнения реквизитов); «➕ Связанный документ» — только создание нового
  (форма без блока выбора из существующих); «⤴ Отвязать» в деталях (`parent_id=0`). При привязке
  поднимается `updated_at` → push LWW проходит, связь переживает синк.
- **Фикс кнопки «← Назад»**: `renderDocumentsView()` теперь очищает `bodyEl` (`container.empty()`).
  В старой сборке контент очищал только `renderPage()`, а «Назад» вызывал рендер списка напрямую —
  детали оставались, список дописывался каждый раз.
- **Пояснение по потерянным связям**: legacy-связи (`parent_id`) жили только в локальном кэше,
  на сервере были `parent_id=0`; `mergeFromServer` (LWW, сервер — канон) затирал их при
  `server.updated_at >= local.updated_at`. Связи, созданные через привязку, сохраняются.
- Версия 0.1.6 → **0.1.7** (manifest + package.json). `npx tsc --noEmit` EXIT=0; `npm run build` OK.
  Коммит и пуш сделаны.

### 2026-08-18 — v0.1.6 (пересборка за sbe-core: sbe-lims в service-map)
- `sbe-core`: добавлены `SbeLimsApi` и `'sbe-lims'` в `SbeServiceMap` — пересборка `main.js`,
  исходники плагина не менялись. Версия 0.1.5 → **0.1.6** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK. Коммит и пуш сделаны.

### 2026-08-18 — v0.1.5 (пересборка за sbe-core: SbeEknApi)
- `sbe-core`: добавлены `SbeEknApi` и `'sbe-ekn'` в `SbeServiceMap` — пересборка `main.js`,
  исходники не менялись. Версия 0.1.4 → **0.1.5** (manifest + package.json).

### 2026-08-17 — v0.1.4 (Этап 5: роли + общий доступ; фикс дублей миграции)
- **Расширенная модель ролей**: `viewer` < `commenter` < `editor` < `admin`. Сервер
  (documents-service): `effectiveRole`, таблица `documents_common_access`, миграция
  `user`→`editor`. Endpoints: push/file→editor, pull/download→viewer, remark-file→commenter,
  + `GET/POST /api/documents/common-access`.
- **Общий доступ**: в настройках «Права доступа» — селектор уровня + таблица ролей (4 роли,
  «✖ Убрать»). UI учитывает роль: добавление/редактирование — editor+, замечания — commenter+.
- **Фикс дублей миграции**: `migrateLegacyOnce` теперь одноразовая через флаг `legacyMigrated`
  в настройках; `importLegacy` пропускает записи с тем же содержимым (title + link/file),
  а не только по id. Причина дублей: миграция генерировала новые случайные id при каждом
  запуске плагина и повторно добавляла все 5 legacy-документов. Очищены дубликаты на сервере
  и в кэше (оставлены 5 оригинальных). `data.json` → `legacyMigrated: true`.
- Версия 0.1.3 → **0.1.4** (manifest + package.json). tsc EXIT=0, build OK.

### 2026-08-17 — v0.1.3 (Этап 5: Права доступа)
- Настройки: раздел «Права доступа» — для admin таблица ролей (смена user↔admin, добавление
  по email), для user — «Ваша роль: …», без доступа — подсказка.
- `sync.service.ts`: `getMyPermission`, `listPermissions`, `setPermission`.
- Сервер (documents-service): `/api/documents/permissions/me|list|set` (см. server_back/documents-service).
- Версия 0.1.2 → **0.1.3** (manifest + package.json). tsc EXIT=0, build OK.

### 2026-08-17 — v0.1.2 (типы документов: создание из UI)
- Кнопка «➕ Создать тип документа» в формах создания и редактирования —
  добавляет тип в локальный `doc_types[]` (метод `createDocTypeFromField`, DB `addDocType`),
  обновляет datalist.
- `doc_type` хранится в самом документе на сервере → на другом компьютере тип приходит
  с pull и пополняет список выбора автоматически. Сервер не менялся.
- Класс `tn-doc-flex` добавлен в styles.css.
- Версия 0.1.1 → **0.1.2** (manifest + package.json). tsc EXIT=0, build OK.

### 2026-08-17 — v0.1.1 (источник реестра)
- `sbe-core`: `DEFAULT_REGISTRY_URL` → `https://epyur.fvds.ru/registry.json`
  (raw.githubusercontent.com отдавал 429). Пересборка `main.js`, исходники не менялись.
- Версия 0.1.0 → **0.1.1** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK.

### 2026-08-17 — v0.1.0 (создание)
- Плагин вынесен из монолита `yougile-tntn` (модуль «Документы», `ui/documents-view.ts`),
  переведён с YouGile на локальную БД + documents-service + S3. Скаффолд как sbe-mailer.
- БД-кэш + LWW-синхронизация + миграция из `yougile_cache.json` (5 документов), view,
  settings, файлы через сервис в S3. `publishService('sbe-documents')`.
- `sbe-core`: добавлены `SbeDocumentsApi`, `'sbe-documents'` в `SbeServiceMap` и
  `getServiceName` («Документы»); пересобраны все 7 SBE-плагинов.
- Реестр: запись `sbe-documents` (hasView, tools, ownerEmail); registry.json синхронизирован
  на сервер (`https://epyur.fvds.ru/registry.json`).
- Инициирующий коммит `ea80574` в `Epyur/sbe-documents`.

## Статистика ошибок и отступлений

- Нарушений правил нет: 0 `any`, 0 `fetch`, 0 инлайн-стилей, `window.setTimeout` корректен,
  все `catch(e: unknown)` + `errorMessage()`.
- `npx tsc --noEmit` EXIT=0, `npm run build` OK (без предупреждений).
