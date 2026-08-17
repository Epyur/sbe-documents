# AGENTS.md — sbe-documents (Документы)

SBE-плагин «Документы»: локальная БД-кэш документов + синхронизация с documents-service
(сервер — канон), файлы документов в S3 (`sbe-doc`).

## Назначение (текущее)

- **Синхронизация** с сервером `https://epyur.fvds.ru` через JWT из ЦУП СБЕ
  (`getService('sbe-apstore').auth.getToken('documents')`): push `/api/documents/sync/push`,
  pull `/api/documents/sync/pull`. Сервер — канон, локальный JSON — кэш. Конфликты — LWW
  по `updated_at`.
- **Локальная БД**: `yourbase/sbe_documents/documents_data.json`
  (`{"documents": [...], "doc_types": [...]}`). Модель `DocItem` совместима с серверной.
- **Миграция**: одноразовый импорт документов (`type: "document"`) из `yourbase/yougile_cache.json`
  монолита. doc_type = название колонки YouGile; ссылки kb.tn.ru/yougile остаются как `link_url`.
- **Файлы**: 1 файл на документ + файлы замечаний — загружаются в S3 через сервис
  (`POST /api/documents/file`, `POST /api/documents/remark-file`), ключ и URL хранятся в документе.
  Загрузка через **rclone CLI** внутри сервиса (aws-sdk-go-v2 зависал на этом Ceph).
- **Точка входа** — магазин: «Установленные → Открыть» (`publishService('sbe-documents', {open})`).

## Структура

| Файл | Что это |
|---|---|
| `src/main.ts` | `SbeDocumentsPlugin`: настройки, БД, syncService, миграция, view, publishService |
| `src/database/documents-db.ts` | `DocumentsDatabase`: кэш JSON, mergeFromServer (LWW), dedupe, importLegacy, doc_types |
| `src/services/sync.service.ts` | `DocumentsSyncService`: push/pull/uploadFile/uploadRemarkFile, JWT, multipart, таймауты |
| `src/ui/documents-view.ts` | `DocumentsView`: таблица, детали, create/edit, связанные (parentId), замечания, экспорт HTML |
| `src/ui/settings-tab.ts` | Настройки: apiUrl, куратор по умолчанию |
| `src/types/documents.ts` | `DocItem`, `DocumentRemark`, `DocumentsDbData`, `UploadFileResponse`, legacy-типы |
| `src/styles.css` | Классы `tn-doc-*` на семантических токенах |

## Настройки (data.json)

`apiUrl` (default `https://epyur.fvds.ru`), `defaultAuthor` (default `И.И. Иванов`).

## Правила

- `catch(e: unknown)` + `errorMessage()`; `requestUrl()`; `window.setTimeout()`; без `any`;
  UI на русском; автор — Полищук Евгений (polishchuk@tn.ru). Классы `tn-doc-*` / `tn-btn*`
  / `tn-table` на семантических токенах sbe-core.
- Коммиты/пуши — только по явной команде пользователя.
- **«Фиксируй» = поднять версию (+0.0.1 в `manifest.json` и `package.json`), обновить
  документацию, подготовить сообщение для коммита и СПРОСИТЬ подтверждение commit/push.**

## История работ

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
