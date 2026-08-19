# specification.md — sbe-documents (Документы)

Форматы обмена между плагином «Документы» (sbe-documents) и documents-service на сервере
(`https://epyur.fvds.ru`), а также с S3 (`sbe-doc`).

## Авторизация

Все запросы к documents-service — JWT Bearer. JWT берётся из ЦУП СБЕ:
`getService('sbe-apstore').auth.getToken('documents')`. При 401 — «Ключ доступа
недействителен», при 403 — «Нет прав доступа».

## Модель документа (DocItem / Document)

```jsonc
{
  "id": 1786...,                    // int64; новые локальные = Date.now()+random
  "title": "НГ (Logicroof NG)…",
  "doc_type": "Сертификат",          // свободный текст
  "curator_email": "polishchuk@tn.ru",
  "deadline": 1907355599000,         // мс (0 = нет срока)
  "file_key": "documents/…/main-t.txt",  // S3-ключ ("" = только внешняя ссылка)
  "file_name": "…", "file_size": 123, "file_url": "https://s3.firstvds.ru/sbe-doc/…",
  "link_url": "https://kb.tn.ru/…",   // legacy-внешняя ссылка (опционально)
  "link_file_name": "…",
  "parent_id": 0,                     // 0 = корневой; >0 = связанный документ (свой карточки нет)
  "completed": false,
  "remarks": [{                       // замечания
    "element_number": "…", "current_edition": "…",
    "proposed_edition": "…", "justification": "…",
    "files": [{ "file_key": "…", "file_name": "…", "file_size": 1, "file_url": "…" }],
    "author_email": "polishchuk@tn.ru"
  }],
  "created_at": "…", "updated_at": "…",  // ISO8601; LWW по updated_at
  "sync_status": "local | synced"        // только локально
}
```

Примечания:
- `file_url` — прямой S3-URL, но бакет `sbe-doc` **приватный**: в браузере не открывается.
  Плагин скачивает файл через `GET /api/documents/file?key=...` (JWT) в кэш вольта
  `yourbase/sbe_documents/files/` и открывает встроенным просмотрщиком Obsidian
  (md/pdf/img/txt/csv/html) или системным приложением (electron `shell.openPath`).
- `parent_id > 0`: привязанный документ не получает отдельную карточку в списке и
  отображается вложенным внутри карточки родителя; отвязка — кнопка в деталях
  (`parent_id = 0`). Привязать можно только «свободный» документ (свой корень).

Локальная БД: `yourbase/sbe_documents/documents_data.json` → `{"documents": [...], "doc_types": [string]}`.
`doc_types` — локальный реестр использованных типов (для datalist), сервер не хранит.

## Endpoints

### POST /api/documents/sync/push — приём/обновление документов
- Тело: `{"documents": [Document, ...]}`.
- Семантика: `id>0` → UPDATE по `WHERE id=$1 AND updated_at < $15` (иначе INSERT
  `ON CONFLICT (id) DO NOTHING`); `id=0` → INSERT (сервер назначает id).
- Ответ: `{"inserted": N, "updated": M}`.

### GET /api/documents/sync/pull — выгрузка всех документов
- Ответ: `{"documents": [Document, ...]}`.

### POST /api/documents/file — загрузка файла документа в S3
- `multipart/form-data`, поле `file`. Сервис кладёт в `sbe-doc` через rclone
  (`documents/{uuid}/main-{name}`), возвращает
  `{"file_key", "file_name", "file_size", "file_url"}`.

### POST /api/documents/remark-file — загрузка файла замечания
- `multipart/form-data`, поля `file` + `document_id`. Ключ `documents/{document_id}/remarks/{name}`.

### GET /api/documents/file?key=... — скачивание файла из S3
- Плагин сохраняет файл в кэш вольта `yourbase/sbe_documents/files/` и открывает:
  встроенным просмотрщиком Obsidian (md/pdf/img/txt/csv/html) или системным приложением
  (electron `shell.openPath`).

### GET /api/documents/health — статус.

## S3

- Бакет `sbe-doc` (endpoint s3.firstvds.ru, Ceph). Доступ через rclone CLI внутри
  documents-service (remote `firstvds_doc`, конфиг из env `S3_ENDPOINT`/`S3_ACCESS_KEY`/
  `S3_SECRET_KEY` при старте). НЕ используем mailers-backup (там ротация 7 дней).

## Сервер (documents-service)

- Go-сервис, контейнер `documents`, БД `documents` (postgres `documents-db`).
- Таблицы: `documents`, `documents_permissions(app, email, role)`.
- JWT: app_id `documents`, роли viewer < commenter < editor < admin + общий доступ
  (`documents_common_access`); owner_email = polishchuk@tn.ru (seed при старте).
- При старте: `POST /apps/register` в auth-service (DOCUMENTS_APP_ID/NAME/OWNER_EMAIL/SERVICE_SECRET).
- Caddy: `/api/documents/*` → `documents:3000` (до `/api/*`).

## Миграция (одноразовая)

При первом запуске (пустая локальная БД): читать `yourbase/yougile_cache.json`, найти задачи с
`description.type == 'document'`, отобразить: id = Date.now()+random, doc_type = название колонки
(по columnId), curator_email = description.curatorEmail (или assigned[0]), deadline = task.deadline,
link_url/link_file_name из description.link/fileName, parent_id — по маппингу taskId→id,
remarks из description.remarks. `sync_status=local` → первый push отправит на сервер.
