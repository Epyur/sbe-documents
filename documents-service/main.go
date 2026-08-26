package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Document struct {
	ID               int64    `json:"id"`
	Title            string   `json:"title"`
	DocType          string   `json:"doc_type"`
	CuratorEmail     string   `json:"curator_email"`
	Deadline         int64    `json:"deadline"`
	FileKey          string   `json:"file_key"`
	FileName         string   `json:"file_name"`
	FileSize         int64    `json:"file_size"`
	FileURL          string   `json:"file_url"`
	LinkURL          string   `json:"link_url"`
	LinkFileName     string   `json:"link_file_name"`
	ParentID         int64    `json:"parent_id"`
	Completed        bool     `json:"completed"`
	Remarks          []Remark `json:"remarks"`
	CreatedAt        string   `json:"created_at"`
	UpdatedAt        string   `json:"updated_at"`
	Country          string   `json:"country"`
	DocNumber        string   `json:"doc_number"`
	ValidFrom        int64    `json:"valid_from"`
	Comment          string   `json:"comment"`
	Responsible      string   `json:"responsible"`
	ProductGroup     string   `json:"product_group"`
	Trademark        string   `json:"trademark"`
	Manufacturer     string   `json:"manufacturer"`
	TnVedCode        string   `json:"tn_ved_code"`
	TestingLab       string   `json:"testing_lab"`
	ProtocolNumber   string   `json:"protocol_number"`
	CertificationBody string  `json:"certification_body"`
	IkDate           int64    `json:"ik_date"`
	Archived         bool     `json:"archived"`
}

type Remark struct {
	ElementNumber  string       `json:"element_number"`
	CurrentEdition string       `json:"current_edition"`
	ProposedEdition string      `json:"proposed_edition"`
	Justification  string       `json:"justification"`
	Files          []RemarkFile `json:"files"`
	AuthorEmail    string       `json:"author_email"`
}

type RemarkFile struct {
	FileKey  string `json:"file_key"`
	FileName string `json:"file_name"`
	FileSize int64  `json:"file_size"`
	FileURL  string `json:"file_url"`
}

type PushRequest struct {
	Documents []Document `json:"documents"`
}

type Server struct {
	pool         *pgxpool.Pool
	s3           *S3Store
	fileBaseURL  string
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if err := loadJWTSecret(); err != nil {
		log.Fatalf("JWT: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping: %v", err)
	}

	s3Store, err := NewS3Store()
	if err != nil {
		log.Fatalf("S3: %v", err)
	}

	s := &Server{pool: pool, s3: s3Store}
	s.fileBaseURL = s3Store.publicBaseURL()

	if err := s.migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if err := s.migrateNotifyTables(ctx); err != nil {
		log.Fatalf("migrateNotifyTables: %v", err)
	}
	if err := s.seedOwner(ctx); err != nil {
		log.Fatalf("seedOwner: %v", err)
	}
	regCtx, regCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer regCancel()
	if err := s.registerApp(regCtx); err != nil {
		log.Printf("registerApp (non-fatal): %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/documents/health", s.handleHealth)
	mux.HandleFunc("POST /api/documents/sync/push", s.requirePerm("editor")(s.handlePush))
	mux.HandleFunc("GET /api/documents/sync/pull", s.requirePerm("viewer")(s.handlePull))
	mux.HandleFunc("POST /api/documents/file", s.requirePerm("editor")(s.handleUploadFile))
	mux.HandleFunc("POST /api/documents/remark-file", s.requirePerm("commenter")(s.handleUploadRemarkFile))
	mux.HandleFunc("GET /api/documents/file", s.requirePerm("viewer")(s.handleDownloadFile))
	mux.HandleFunc("GET /api/documents/file-link", s.requirePerm("viewer")(s.handleFileLink))
	mux.HandleFunc("GET /api/documents/permissions", s.requirePerm("admin")(s.handleListPermissions))
	mux.HandleFunc("POST /api/documents/permissions", s.requirePerm("admin")(s.handleSetPermission))
	mux.HandleFunc("GET /api/documents/permissions/me", s.requirePerm("viewer")(s.handleMyPermission))
	mux.HandleFunc("GET /api/documents/common-access", s.requirePerm("admin")(s.handleGetCommonAccess))
	mux.HandleFunc("POST /api/documents/common-access", s.requirePerm("admin")(s.handleSetCommonAccess))
	mux.HandleFunc("GET /api/documents/notify-settings", s.requirePerm("admin")(s.handleGetNotifySettings))
	mux.HandleFunc("POST /api/documents/notify-settings", s.requirePerm("admin")(s.handleSetNotifySettings))
	mux.HandleFunc("POST /api/documents/archive", s.requirePerm("editor")(s.handleArchiveDocument))
	mux.HandleFunc("DELETE /api/documents/{id}", s.requirePerm("editor")(s.handleDeleteDocument))
	mux.HandleFunc("POST /api/documents/types/merge", s.requirePerm("admin")(s.handleMergeDocTypes))

	s.startNotifyJob()

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("documents-service listening on :%s", port)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
}

func (s *Server) migrate(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS documents (
	id            BIGSERIAL PRIMARY KEY,
	title         TEXT NOT NULL DEFAULT '',
	doc_type      TEXT NOT NULL DEFAULT '',
	curator_email TEXT NOT NULL DEFAULT '',
	deadline      BIGINT NOT NULL DEFAULT 0,
	file_key      TEXT NOT NULL DEFAULT '',
	file_name     TEXT NOT NULL DEFAULT '',
	file_size     BIGINT NOT NULL DEFAULT 0,
	file_url      TEXT NOT NULL DEFAULT '',
	link_url      TEXT NOT NULL DEFAULT '',
	link_file_name TEXT NOT NULL DEFAULT '',
	parent_id     BIGINT NOT NULL DEFAULT 0,
	completed     BOOLEAN NOT NULL DEFAULT false,
	remarks       JSONB NOT NULL DEFAULT '[]',
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS documents_permissions (
	app   TEXT NOT NULL,
	email TEXT NOT NULL,
	role  TEXT NOT NULL,
	PRIMARY KEY (app, email)
)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS documents_common_access (
	app    TEXT PRIMARY KEY,
	level  TEXT NOT NULL DEFAULT ''
)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
ALTER TABLE documents
	ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS doc_number TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS valid_from BIGINT NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS responsible TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS product_group TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS trademark TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS manufacturer TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS tn_ved_code TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS testing_lab TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS protocol_number TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS certification_body TEXT NOT NULL DEFAULT '',
	ADD COLUMN IF NOT EXISTS ik_date BIGINT NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
UPDATE documents_permissions SET role = 'editor' WHERE role = 'user'`); err != nil {
		return err
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	var req PushRequest
	// Лимит 20 МБ — push шлёт пачку документов.
	if err := decodeJSON(w, r, &req, 20<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if len(req.Documents) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"inserted": 0, "updated": 0})
		return
	}

	now := time.Now().UTC()
	inserted := 0
	updated := 0
	for _, d := range req.Documents {
		remarksJSON, err := json.Marshal(d.Remarks)
		if err != nil || d.Remarks == nil {
			remarksJSON = []byte("[]")
		}
		updatedAt := parseTime(d.UpdatedAt, now)

		if d.ID > 0 {
			tag, err := s.pool.Exec(r.Context(), `
UPDATE documents SET
	title = $2, doc_type = $3, curator_email = $4, deadline = $5,
	file_key = $6, file_name = $7, file_size = $8, file_url = $9,
	link_url = $10, link_file_name = $11, parent_id = $12, completed = $13,
		remarks = $14, updated_at = $15,
	country = $16, doc_number = $17, valid_from = $18, comment = $19,
	responsible = $20, product_group = $21, trademark = $22, manufacturer = $23,
	tn_ved_code = $24, testing_lab = $25, protocol_number = $26,
	certification_body = $27, ik_date = $28, archived = $29
WHERE id = $1 AND updated_at < $15`, d.ID, d.Title, d.DocType, d.CuratorEmail,
				d.Deadline, d.FileKey, d.FileName, d.FileSize, d.FileURL,
				d.LinkURL, d.LinkFileName, d.ParentID, d.Completed, remarksJSON, updatedAt,
				d.Country, d.DocNumber, d.ValidFrom, d.Comment, d.Responsible, d.ProductGroup,
				d.Trademark, d.Manufacturer, d.TnVedCode, d.TestingLab, d.ProtocolNumber,
				d.CertificationBody, d.IkDate, d.Archived)
			if err != nil {
				log.Printf("push update: %v", err)
				continue
			}
			if tag.RowsAffected() > 0 {
				updated++
				continue
			}
			insTag, err := s.pool.Exec(r.Context(), `
INSERT INTO documents (id, title, doc_type, curator_email, deadline, file_key, file_name,
	file_size, file_url, link_url, link_file_name, parent_id, completed, remarks, created_at, updated_at,
	country, doc_number, valid_from, comment, responsible, product_group, trademark, manufacturer,
	tn_ved_code, testing_lab, protocol_number, certification_body, ik_date, archived)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15,
	$16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
ON CONFLICT (id) DO NOTHING`, d.ID, d.Title, d.DocType, d.CuratorEmail,
				d.Deadline, d.FileKey, d.FileName, d.FileSize, d.FileURL,
				d.LinkURL, d.LinkFileName, d.ParentID, d.Completed, remarksJSON, updatedAt,
				d.Country, d.DocNumber, d.ValidFrom, d.Comment, d.Responsible, d.ProductGroup,
				d.Trademark, d.Manufacturer, d.TnVedCode, d.TestingLab, d.ProtocolNumber,
				d.CertificationBody, d.IkDate, d.Archived)
			if err != nil {
				log.Printf("push insert by id: %v", err)
				continue
			}
			if insTag.RowsAffected() > 0 {
				inserted++
				s.bumpSequence(r.Context())
			}
			continue
		}

		_, err = s.pool.Exec(r.Context(), `
INSERT INTO documents (title, doc_type, curator_email, deadline, file_key, file_name,
	file_size, file_url, link_url, link_file_name, parent_id, completed, remarks, created_at, updated_at,
	country, doc_number, valid_from, comment, responsible, product_group, trademark, manufacturer,
	tn_ved_code, testing_lab, protocol_number, certification_body, ik_date, archived)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14,
	$15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)`, d.Title, d.DocType,
			d.CuratorEmail, d.Deadline, d.FileKey, d.FileName, d.FileSize, d.FileURL,
			d.LinkURL, d.LinkFileName, d.ParentID, d.Completed, remarksJSON, updatedAt,
			d.Country, d.DocNumber, d.ValidFrom, d.Comment, d.Responsible, d.ProductGroup,
			d.Trademark, d.Manufacturer, d.TnVedCode, d.TestingLab, d.ProtocolNumber,
			d.CertificationBody, d.IkDate, d.Archived)
		if err != nil {
			log.Printf("push insert: %v", err)
			continue
		}
		inserted++
	}

	writeJSON(w, http.StatusOK, map[string]any{"inserted": inserted, "updated": updated})
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
SELECT id, title, doc_type, curator_email, deadline, file_key, file_name, file_size,
	file_url, link_url, link_file_name, parent_id, completed, remarks, created_at, updated_at,
	country, doc_number, valid_from, comment, responsible, product_group, trademark, manufacturer,
	tn_ved_code, testing_lab, protocol_number, certification_body, ik_date, archived
FROM documents ORDER BY id`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	documents := make([]Document, 0, 64)
	for rows.Next() {
		var d Document
		var remarksRaw []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&d.ID, &d.Title, &d.DocType, &d.CuratorEmail, &d.Deadline,
			&d.FileKey, &d.FileName, &d.FileSize, &d.FileURL, &d.LinkURL, &d.LinkFileName,
			&d.ParentID, &d.Completed, &remarksRaw, &createdAt, &updatedAt,
			&d.Country, &d.DocNumber, &d.ValidFrom, &d.Comment, &d.Responsible, &d.ProductGroup,
			&d.Trademark, &d.Manufacturer, &d.TnVedCode, &d.TestingLab, &d.ProtocolNumber,
			&d.CertificationBody, &d.IkDate, &d.Archived); err != nil {
			log.Printf("pull scan: %v", err)
			continue
		}
		d.CreatedAt = createdAt.Format(time.RFC3339)
		d.UpdatedAt = updatedAt.Format(time.RFC3339)
		if len(remarksRaw) > 0 && string(remarksRaw) != "[]" {
			_ = json.Unmarshal(remarksRaw, &d.Remarks)
		}
		if d.Remarks == nil {
			d.Remarks = []Remark{}
		}
		documents = append(documents, d)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"documents": documents})
}

func (s *Server) handleUploadFile(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "file is required"})
		return
	}
	defer file.Close()

	key := s3Key("main", header.Filename)
	data, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "read file"})
		return
	}
	size, url, err := s.s3.Put(r.Context(), key, data)
	if err != nil {
		log.Printf("s3 put: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"file_key":  key,
		"file_name": header.Filename,
		"file_size": size,
		"file_url":  url,
	})
}

func (s *Server) handleUploadRemarkFile(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart"})
		return
	}
	documentID := r.FormValue("document_id")
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "file is required"})
		return
	}
	defer file.Close()

	key := s3RemarkKey(documentID, header.Filename)
	data, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "read file"})
		return
	}
	size, url, err := s.s3.Put(r.Context(), key, data)
	if err != nil {
		log.Printf("s3 put: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"file_key":  key,
		"file_name": header.Filename,
		"file_size": size,
		"file_url":  url,
	})
}

func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" || !validObjectKey(key, "documents") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid or missing key"})
		return
	}
	data, err := s.s3.Get(r.Context(), key)
	if err != nil {
		log.Printf("s3 get: %v", err)
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "file not found"})
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		log.Printf("download write: %v", err)
	}
}

// validObjectKey проверяет ключ S3: разрешён только собственный префикс сервиса,
// без выхода за пределы («..») и служебных символов (path traversal — ревью B3).
func validObjectKey(key, prefix string) bool {
	if key == "" || len(key) > 512 {
		return false
	}
	if strings.Contains(key, "..") || strings.ContainsAny(key, "\\\x00\r\n") {
		return false
	}
	return strings.HasPrefix(key, prefix+"/")
}

// handleFileLink возвращает временную публичную ссылку на файл (presigned GET).
func (s *Server) handleFileLink(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "key is required"})
		return
	}
	if !validObjectKey(key, "documents") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid key"})
		return
	}
	link, err := s.s3.Link(r.Context(), key)
	if err != nil {
		log.Printf("file-link: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "link error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": link})
}

// handleMergeDocTypes переименовывает/объединяет типы документов на сервере (admin).
// from — старые названия типов, to — общее имя, которое получают все документы группы.
func (s *Server) handleMergeDocTypes(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From []string `json:"from"`
		To   string   `json:"to"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	to := strings.TrimSpace(req.To)
	if to == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "to is required"})
		return
	}
	from := make([]string, 0, len(req.From))
	for _, f := range req.From {
		f = strings.TrimSpace(f)
		if f != "" && f != to {
			from = append(from, f)
		}
	}
	if len(from) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"updated": 0})
		return
	}
	tag, err := s.pool.Exec(r.Context(),
		`UPDATE documents SET doc_type = $1 WHERE doc_type = ANY($2)`, to, from)
	if err != nil {
		log.Printf("types/merge: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": tag.RowsAffected()})
}

// docCurator возвращает куратора документа (для проверки прав).
func (s *Server) docCurator(ctx context.Context, id int64) (string, error) {
	var curator string
	err := s.pool.QueryRow(ctx, `SELECT curator_email FROM documents WHERE id = $1`, id).Scan(&curator)
	return curator, err
}

// docManageAllowed — документом может управлять admin или editor, совпадающий с куратором.
func (s *Server) docManageAllowed(ctx context.Context, id int64, email, role string) (bool, error) {
	curator, err := s.docCurator(ctx, id)
	if err != nil {
		return false, err
	}
	return role == "admin" || (role == "editor" && email == curator), nil
}

// handleArchiveDocument переводит документ в архив / возвращает из архива (куратор или admin).
func (s *Server) handleArchiveDocument(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID       int64 `json:"id"`
		Archived bool  `json:"archived"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.ID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	role, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	allowed, err := s.docManageAllowed(r.Context(), req.ID, email, role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		}
		return
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: only curator or admin"})
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE documents SET archived = $2 WHERE id = $1`, req.ID, req.Archived); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteDocument удаляет документ из реестра (куратор или admin).
func (s *Server) handleDeleteDocument(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	role, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	allowed, err := s.docManageAllowed(r.Context(), id, email, role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		}
		return
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: only curator or admin"})
		return
	}
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM documents WHERE id = $1`, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	_, _ = s.pool.Exec(r.Context(), `DELETE FROM documents_notifications WHERE document_id = $1`, id)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) bumpSequence(ctx context.Context) {
	_, _ = s.pool.Exec(ctx, `
SELECT setval(pg_get_serial_sequence('documents', 'id'),
	GREATEST((SELECT COALESCE(MAX(id), 0) FROM documents), (SELECT last_value FROM documents_id_seq)), true)`)
}

func parseTime(v string, fallback time.Time) time.Time {
	if v == "" {
		return fallback
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return fallback
	}
	return t
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

// decodeJSON читает JSON-тело с жёстким лимитом размера (защита от DoS памятью, ревью 1.4).
func decodeJSON(w http.ResponseWriter, r *http.Request, v any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	return json.NewDecoder(r.Body).Decode(v)
}
