package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// NotifySettings — настройки уведомлений куратора об истечении срока документа.
type NotifySettings struct {
	Enabled bool  `json:"enabled"`
	Days    []int `json:"days"`
}

// parseDays разбирает строку "30,14,7" в отсортированный список уникальных дней.
func parseDays(s string) []int {
	parts := strings.Split(s, ",")
	seen := map[int]bool{}
	var out []int
	for _, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || n <= 0 || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

func joinDays(days []int) string {
	parts := make([]string, len(days))
	for i, d := range days {
		parts[i] = strconv.Itoa(d)
	}
	return strings.Join(parts, ",")
}

// migrateNotifyTables создаёт таблицы настроек и журнала уведомлений.
func (s *Server) migrateNotifyTables(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS documents_notify_settings (
	id      INT PRIMARY KEY DEFAULT 1,
	enabled BOOLEAN NOT NULL DEFAULT false,
	days    TEXT NOT NULL DEFAULT '30,14,7'
)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
INSERT INTO documents_notify_settings (id, enabled, days)
VALUES (1, false, '30,14,7')
ON CONFLICT (id) DO NOTHING`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS documents_notifications (
	document_id BIGINT NOT NULL,
	day         INT NOT NULL,
	email       TEXT NOT NULL DEFAULT '',
	sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (document_id, day)
)`); err != nil {
		return err
	}
	return nil
}

func (s *Server) handleGetNotifySettings(w http.ResponseWriter, r *http.Request) {
	var enabled bool
	var days string
	err := s.pool.QueryRow(r.Context(),
		`SELECT enabled, days FROM documents_notify_settings WHERE id = 1`).Scan(&enabled, &days)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": enabled, "days": parseDays(days)})
}

func (s *Server) handleSetNotifySettings(w http.ResponseWriter, r *http.Request) {
	var req NotifySettings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	days := req.Days
	if days == nil {
		days = []int{}
	}
	_, err := s.pool.Exec(r.Context(),
		`UPDATE documents_notify_settings SET enabled = $1, days = $2 WHERE id = 1`,
		req.Enabled, joinDays(parseDays(joinDays(days))))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": req.Enabled, "days": parseDays(joinDays(days))})
}

// startNotifyJob запускает фоновую проверку истекающих документов (на старте и далее раз в 6 ч).
func (s *Server) startNotifyJob() {
	go func() {
		s.checkArchived()
		s.checkNotifications()
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			s.checkArchived()
			s.checkNotifications()
		}
	}()
}

// checkArchived переводит документы с истёкшим сроком действия в статус «Архивный».
func (s *Server) checkArchived() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tag, err := s.pool.Exec(ctx, `
		UPDATE documents SET archived = true
		WHERE deadline > 0 AND deadline < $1 AND archived = false`,
		time.Now().UTC().UnixMilli())
	if err != nil {
		log.Printf("checkArchived: %v", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("checkArchived: в архив переведено документов: %d", n)
	}
}

// checkNotifications отправляет кураторам письма об истекающих документах
// по настроенным срокам (N дней до истечения), не чаще одного письма на (документ, срок).
func (s *Server) checkNotifications() {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	var enabled bool
	var daysStr string
	err := s.pool.QueryRow(ctx,
		`SELECT enabled, days FROM documents_notify_settings WHERE id = 1`).Scan(&enabled, &daysStr)
	if err != nil {
		log.Printf("notify: settings read: %v", err)
		return
	}
	if !enabled {
		return
	}
	days := parseDays(daysStr)
	if len(days) == 0 {
		return
	}

	now := time.Now().UTC()
	notified := 0
	for _, day := range days {
		windowEnd := now.AddDate(0, 0, day)
		rows, err := s.pool.Query(ctx, `
SELECT id, title, doc_number, deadline, curator_email
FROM documents
WHERE completed = false AND deadline > $1 AND deadline <= $2 AND curator_email <> ''
ORDER BY id`, now.UnixMilli(), windowEnd.UnixMilli())
		if err != nil {
			log.Printf("notify: query day=%d: %v", day, err)
			continue
		}
		for rows.Next() {
			var id int64
			var title, docNumber, email string
			var deadline int64
			if err := rows.Scan(&id, &title, &docNumber, &deadline, &email); err != nil {
				log.Printf("notify: scan: %v", err)
				continue
			}
			var exists bool
			if err := s.pool.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM documents_notifications WHERE document_id = $1 AND day = $2)`,
				id, day).Scan(&exists); err != nil {
				log.Printf("notify: check: %v", err)
				continue
			}
			if exists {
				continue
			}
			daysLeft := int(time.Until(time.UnixMilli(deadline)).Hours() / 24)
			if daysLeft < 0 {
				daysLeft = 0
			}
			subject := "Срок действия документа истекает"
			body := fmt.Sprintf(
				"Здравствуйте!\n\n"+
					"Срок действия документа скоро истекает:\n\n"+
					"Документ: %s\n"+
					"№ документа: %s\n"+
					"Окончание действия: %s\n"+
					"Осталось дней: %d\n\n"+
					"Пожалуйста, проверьте документ и при необходимости продлите срок действия.\n\n"+
					"— Служебные уведомления, отвечать не нужно.",
				title, docNumber, time.UnixMilli(deadline).Format("02.01.2006"), daysLeft)
			if err := sendEmail(email, subject, body); err != nil {
				log.Printf("notify: email to %s (doc %d, day %d): %v", email, id, day, err)
				continue
			}
			if _, err := s.pool.Exec(ctx, `
INSERT INTO documents_notifications (document_id, day, email)
VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, id, day, email); err != nil {
				log.Printf("notify: record: %v", err)
			}
			notified++
		}
		rows.Close()
	}
	if notified > 0 {
		log.Printf("notify: отправлено уведомлений: %d", notified)
	}
}
