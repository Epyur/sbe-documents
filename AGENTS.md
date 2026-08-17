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
