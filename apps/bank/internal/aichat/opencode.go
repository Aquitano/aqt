package aichat

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

// OpenCode sessions: the SQLite database at
// ~/.local/share/opencode/opencode.db. Messages carry their role in a JSON
// `data` column; the text lives in the `part` table's JSON, one row per
// content block. Sessions with a parent_id are machine-spawned subagents and
// are skipped the same way Claude Code sidechains are.

// ImportOpenCode ingests an opencode.db (or the data directory holding one).
// The database is never read or shipped as-is: a consistent snapshot is taken
// first (OpenCode may be mid-write) and its credential tables are stripped
// before anything is parsed, archived or uploaded.
func ImportOpenCode(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	return importOpenCode(ctx, st, archiveDir, path, false)
}

// SyncOpenCode is ImportOpenCode for a recurring sweep: when the sanitized
// snapshot is byte-identical to what is archived, an earlier run already
// ingested it all (archiving happens after ingest) and nothing is parsed.
func SyncOpenCode(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	return importOpenCode(ctx, st, archiveDir, path, true)
}

func importOpenCode(ctx context.Context, st *store.Store, archiveDir, path string, onlyChanged bool) (Result, error) {
	var res Result
	info, err := os.Stat(path)
	if err != nil {
		return res, err
	}
	if info.IsDir() {
		path = filepath.Join(path, "opencode.db")
		if _, err := os.Stat(path); err != nil {
			if onlyChanged {
				return res, nil // a data dir with no database yet is nothing to sync
			}
			return res, err
		}
	}
	name := openCodeArchiveName(filepath.Base(path))
	if err := archive.ValidName(name); err != nil {
		return res, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return res, err
	}
	rawRef := filepath.Join("opencode", name)
	// An input that is byte-identical to its own archived copy is a replay of
	// the archive (bank reimport, or an upload of it): it is already the
	// sanitized snapshot, so it is parsed directly, and re-archiving is
	// skipped — snapshotting a snapshot is not byte-stable, and Replace would
	// churn the archived raw on every replay without changing its content.
	if archive.Identical(archiveDir, "opencode", name, raw) {
		if onlyChanged {
			res.UnchangedSessions++
			return res, nil
		}
		msgsByThread, err := readOpenCodeDB(ctx, path, &res)
		if err != nil {
			return res, err
		}
		return res, ingestOpenCode(ctx, st, rawRef, msgsByThread, &res)
	}
	dbPath, cleanup, err := snapshotOpenCodeDB(path)
	if err != nil {
		return res, err
	}
	defer cleanup()
	snap, err := os.ReadFile(dbPath)
	if err != nil {
		return res, err
	}
	if onlyChanged && archive.Identical(archiveDir, "opencode", name, snap) {
		res.UnchangedSessions++
		return res, nil
	}

	msgsByThread, err := readOpenCodeDB(ctx, dbPath, &res)
	if err != nil {
		return res, err
	}
	if len(msgsByThread) == 0 {
		return res, nil
	}
	// Ingest before archiving: the snapshot becomes "already archived" only
	// once every message landed, so a run that died mid-ingest re-reads it.
	// Replace, not Copy — the database is one growing input, and one
	// superseding snapshot per source is its complete raw form.
	if err := ingestOpenCode(ctx, st, rawRef, msgsByThread, &res); err != nil {
		return res, err
	}
	if _, err := archive.Replace(archiveDir, "opencode", name, snap); err != nil {
		return res, fail.Opf("archive %s: %w", dbPath, err)
	}
	return res, nil
}

func ingestOpenCode(ctx context.Context, st *store.Store, rawRef string, msgsByThread map[string][]message, res *Result) error {
	for _, msgs := range msgsByThread {
		res.Conversations++
		if err := res.ingest(ctx, st, "opencode", rawRef, msgs, nil); err != nil {
			return err
		}
	}
	return nil
}

// openCodeArchiveName picks the archive filename for a database. The name
// must differ per source — two machines syncing into one server would
// otherwise supersede each other's raw under a single "opencode.db" — so a
// bare basename gains this host's name, while a basename that already carries
// a discriminator (a staged upload, a replayed archive copy) is kept.
func openCodeArchiveName(base string) string {
	if strings.HasPrefix(base, "opencode-") && strings.HasSuffix(base, ".db") {
		return base
	}
	host, err := os.Hostname()
	host = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		}
		return '-'
	}, host)
	if err != nil || host == "" {
		host = "local"
	}
	return "opencode-" + host + ".db"
}

// openCodeSecretTables hold OAuth access and refresh tokens. They have
// nothing to do with messages and must never reach the archive or a wire.
var openCodeSecretTables = []string{"account", "control_account", "credential"}

// snapshotOpenCodeDB writes a consistent, sanitized copy of the database into
// a temp dir: VACUUM INTO (safe against a live writer, and byte-deterministic
// for an unchanged source file, which is what lets Identical dedup snapshots),
// then the credential tables dropped and vacuumed out of the copy. The source
// file is never modified.
func snapshotOpenCodeDB(path string) (string, func(), error) {
	dir, err := os.MkdirTemp("", "bank-opencode-*")
	if err != nil {
		return "", nil, fail.Opf("staging opencode snapshot: %w", err)
	}
	cleanup := func() { os.RemoveAll(dir) }
	target := filepath.Join(dir, "opencode.db")
	src, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		cleanup()
		return "", nil, err
	}
	_, err = src.Exec("VACUUM INTO ?", target)
	if closeErr := src.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("snapshot %s: %w", path, err)
	}
	snap, err := sql.Open("sqlite", "file:"+target)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	for _, table := range openCodeSecretTables {
		if _, e := snap.Exec("DROP TABLE IF EXISTS " + table); err == nil {
			err = e
		}
	}
	if err == nil {
		_, err = snap.Exec("VACUUM") // purge the dropped pages, don't just unlink them
	}
	if closeErr := snap.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("sanitize snapshot of %s: %w", path, err)
	}
	return target, cleanup, nil
}

type ocMessageData struct {
	Role string `json:"role"`
}

type ocPartData struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func readOpenCodeDB(ctx context.Context, path string, res *Result) (map[string][]message, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	type session struct {
		title    string
		subagent bool
	}
	sessions := map[string]session{}
	// COALESCE throughout: OpenCode's own DDL is not under bank's control,
	// and one NULL title must not scan-error the whole database away.
	rows, err := db.QueryContext(ctx, `SELECT id, COALESCE(title, ''), parent_id IS NOT NULL FROM session`)
	if err != nil {
		return nil, fmt.Errorf("%s: not an opencode database? %w", path, err)
	}
	for rows.Next() {
		var id, title string
		var subagent bool
		if err := rows.Scan(&id, &title, &subagent); err != nil {
			rows.Close()
			return nil, err
		}
		sessions[id] = session{title: title, subagent: subagent}
		if subagent {
			res.SubagentSessions++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// All text parts up front, keyed by message: the part table is the only
	// place a message's words live.
	texts := map[string][]string{}
	rows, err = db.QueryContext(ctx, `SELECT message_id, COALESCE(data, '') FROM part ORDER BY message_id, id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var messageID, data string
		if err := rows.Scan(&messageID, &data); err != nil {
			rows.Close()
			return nil, err
		}
		var p ocPartData
		if json.Unmarshal([]byte(data), &p) != nil {
			continue // one unreadable part must not lose the database
		}
		if p.Type == "text" && strings.TrimSpace(p.Text) != "" {
			texts[messageID] = append(texts[messageID], p.Text)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := map[string][]message{}
	empty := map[string]bool{}
	for id := range sessions {
		if !sessions[id].subagent {
			empty[id] = true
		}
	}
	rows, err = db.QueryContext(ctx, `SELECT id, session_id, COALESCE(time_created, 0), COALESCE(data, '') FROM message ORDER BY session_id, time_created, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, sessionID, data string
		var created int64
		if err := rows.Scan(&id, &sessionID, &created, &data); err != nil {
			return nil, err
		}
		sess, known := sessions[sessionID]
		if known && sess.subagent {
			continue
		}
		var m ocMessageData
		if json.Unmarshal([]byte(data), &m) != nil {
			res.Skipped++
			continue
		}
		sender := m.Role
		if sender == "model" {
			sender = "assistant"
		}
		if sender != "user" && sender != "assistant" {
			continue
		}
		body := strings.TrimSpace(strings.Join(texts[id], "\n"))
		if body == "" {
			continue
		}
		delete(empty, sessionID)
		out[sessionID] = append(out[sessionID], message{
			ExternalID: id,
			Thread:     sessionID,
			Subject:    sess.title,
			Sender:     sender,
			Body:       body,
			SentAt:     openCodeTime(created),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	res.EmptyConversations += len(empty)
	return out, nil
}

// openCodeTime reads the integer timestamps OpenCode stores, which have been
// both seconds and milliseconds across versions.
func openCodeTime(v int64) time.Time {
	if v > 1e12 {
		return time.UnixMilli(v)
	}
	return time.Unix(v, 0)
}
