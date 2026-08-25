# AGENTS.md — documents-service (Документы)

Go-сервис документов для SBE-плагина «Документы» (sbe-documents). Контейнер `documents`,
БД `documents` (postgres `documents-db`), авторизация — JWT HS256 (общий `JWT_SECRET`
с auth-service) + роли из `documents_permissions`. Файлы документов — в S3 (бакет `sbe-doc`)
через rclone CLI. Деплой: `/opt/mailers/documents-service/`.

## Назначение (текущее)

- `POST /api/documents/sync/push` — приём/обновление документов `{documents:[...]}`, upsert
  по `id`, LWW по `updated_at`, ответ `{inserted:N, updated:M}`.
- `GET /api/documents/sync/pull` — выгрузка всех документов.
- `POST /api/documents/file` — загрузка файла документа в S3 (multipart, поле `file`).
- `POST /api/documents/remark-file` — загрузка файла замечания (multipart, `file` + `document_id`).
- `GET /api/documents/file?key=...` — скачивание файла из S3.
- `GET /api/documents/health`.
- Таблицы: `documents`, `documents_permissions(app, email, role)`.
- Авторизация: `requirePerm("user")` (как у mailer): JWT → email → роль; user(1)/admin(2).
- При старте: `POST /apps/register` (documents + секрет) + seed owner=admin в
  `documents_permissions`.

## S3 (rclone)

- **История (2026-08-17)**: сначала использовался aws-sdk-go-v2 (PutObject) — запросы
  зависали (Ceph, `Content-Length`/chunked) и **дестабилизировали сервер** (load до 100+,
  D-state, SSH «banner exchange timeout»; потребовалось несколько перезагрузок ВМ).
  **Решение**: загрузка/скачивание через **rclone CLI** (`rclone copyto`), работает стабильно
  (PUT ~50-170 мс). rclone установлен в Dockerfile (статический бинарь linux-amd64).
- Бакет `sbe-doc` (создан через rclone на сервере). Remote `firstvds_doc` генерируется из env
  (`S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`) в `rclone.conf` при старте сервиса.
- Ключи: `documents/{uuid}/main-{name}`, `documents/{document_id}/remarks/{name}`.
- НЕ использовать `mailers-backup` (ротация 7 дней).

## Конфиг (env)

`DATABASE_URL`, `PORT`, `JWT_SECRET`, `DOCUMENTS_APP_ID` (default `documents`), `DOCUMENTS_APP_NAME`,
`DOCUMENTS_OWNER_EMAIL`, `DOCUMENTS_SERVICE_SECRET`, `AUTH_SERVICE_URL`,
`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `sbe-doc`).

## Сборка / проверка

```
docker compose up -d --build documents        # на сервере
docker compose exec documents rclone version   # rclone внутри
docker compose logs documents --tail 20
```

## История

- **2026-08-25 — Уведомления куратора об истечении срока:**
  Таблицы `documents_notify_settings` (single-row: enabled, days '30,14,7') и
  `documents_notifications` (document_id+day — дедуп писем). Эндпоинты (admin):
  `GET/POST /api/documents/notify-settings`. `email.go` — отправка через локальный exim
  (SMTP localhost:25, `SMTP_FROM` общая с auth-service = noreply@epyur.fvds.ru;
  `extra_hosts host.docker.internal:host-gateway` добавлен в compose). `startNotifyJob` —
  фоновая проверка при старте и раз в 6 ч: письмо куратору за N дней до окончания
  действия (deadline в (now, now+N], completed=false, curator_email != ''), одно письмо
  на (документ, срок). E2E (2026-08-25): настройки GET/POST, письмо на polishchuk@tn.ru
  доставлено (`250 Ok`, exim mainlog), тестовые данные удалены, настройки сброшены
  (enabled=false, days=30,14,7). `documents-service` собран локально (`go build` OK) и
  в Docker.

- **2026-08-25 — Поля реестра сертификатов (13 колонок):**
  Таблица `documents` расширена (`ADD COLUMN IF NOT EXISTS`): `country`, `doc_number`,
  `valid_from` (BIGINT), `comment`, `responsible`, `product_group`, `trademark`,
  `manufacturer`, `tn_ved_code`, `testing_lab`, `protocol_number`, `certification_body`,
  `ik_date` (BIGINT). Структура `Document` + push (UPDATE/INSERT по id и без id) + pull
  (SELECT/Scan) включены. Задеплоено: `docker compose up -d --build documents`.
  E2E (2026-08-25): health 200; push тестового документа с новыми полями → pull вернул
  все поля (включая кириллицу) без изменений; тестовые записи удалены из БД.

- **2026-08-17 — создание (sbe-documents, этап выноса модуля «Документы»):**
  Сервис создан зеркалом mailer-service (jwt.go/register.go скопированы с адаптацией под
  `documents`/`documents_permissions`), таблица `documents` + `documents_permissions`.
  docker-compose: `documents-db` (postgres) + `documents`; Caddy `/api/documents/*` →
  `documents:3000` (до `/api/*`); `.env`: `DOCUMENTS_*` + `S3_*`.
  auth-service: `seedApps` расширен — seed приложения `documents` (DOCUMENTS_APP_ID/NAME/
  OWNER_EMAIL/SERVICE_SECRET).
  Бакет `sbe-doc` создан через rclone.
- **2026-08-17 — S3: aws-sdk-go-v2 → rclone.** (см. «S3 (rclone)» выше). Бэкапы
  `s3.go.bak1..4`, `main.go.bak4`, `go.mod.bak1`, `Dockerfile.bak1`, `seed.go.bak1`,
  `docker-compose.yml.bak9`, `Caddyfile.bak9/10`.
- **2026-08-17 — E2E:** health 200; pull без JWT → 401; JWT (`app_id=documents`) → push
  `inserted:1`, pull 200; file upload → S3 (`rclone copyto OK`), download → содержимое.
  Тестовые данные удалены (БД пуста, S3 пуст).
- **2026-08-17 — Права доступа (Этап 5, sbe-documents):**
  `permissions.go`: `GET /api/documents/permissions/me` (user); `GET /api/documents/permissions`
  (admin); `POST /api/documents/permissions {email, role}` (admin) — role user/admin/"",
  владельца отозвать нельзя. E2E: me → admin, list, set user → ok, revoke → ok.
  Бэкапы `main.go.bak5`, `permissions.go.bak1`.
- **2026-08-17 — Роли + общий доступ (расширение Этапа 5):**
  Роли `viewer`(1) < `commenter`(2) < `editor`(3) < `admin`(4). `effectiveRole` —
  персональная роль или уровень общего доступа. Таблица `documents_common_access(app, level)`,
  миграция `user`→`editor`. Endpoints: push/file→editor, pull/download→viewer,
  remark-file→commenter, permissions→admin, `GET/POST /api/documents/common-access`.
  E2E: me→admin, common set commenter. Бэкапы `main.go.bak6`, `jwt.go.bak2`,
  `permissions.go.bak2`.

## Статистика ошибок и отступлений

- Локальной Go-сборки нет (на машине отсутствует тулчейн) — компиляция проверяется
  сборкой в Docker на сервере (`mailers-documents` собран успешно).
- Импортов без неиспользуемых нет.
