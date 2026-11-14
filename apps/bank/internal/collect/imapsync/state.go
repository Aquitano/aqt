package imapsync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/gofrs/flock"
	_ "modernc.org/sqlite"
)

type checkpoint struct {
	Validity uint32
	UID      uint32
}

type state struct {
	db   *sql.DB
	lock *flock.Flock
	dir  string
}

type Status struct {
	Account     string `json:"account"`
	LastAttempt string `json:"last_attempt"`
	LastSuccess string `json:"last_success"`
	LastError   string `json:"last_error"`
	Pending     int    `json:"pending"`
	Rejected    int    `json:"rejected"`
}

func openState(dir string) (*state, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	lock := flock.New(filepath.Join(dir, "daemon.lock"))
	locked, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !locked {
		return nil, fmt.Errorf("another IMAP collector is using %s", dir)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "state.sqlite"))
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	st := &state{db: db, lock: lock, dir: dir}
	_, err = db.Exec(`
		PRAGMA journal_mode=WAL;
		PRAGMA synchronous=FULL;
		PRAGMA busy_timeout=5000;
		CREATE TABLE IF NOT EXISTS accounts (
			id TEXT PRIMARY KEY, identity TEXT NOT NULL,
			last_attempt TEXT NOT NULL DEFAULT '', last_success TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE IF NOT EXISTS folders (
			account TEXT NOT NULL, folder TEXT NOT NULL, validity INTEGER NOT NULL, uid INTEGER NOT NULL,
			PRIMARY KEY (account, folder)
		);
		CREATE TABLE IF NOT EXISTS pending (
			account TEXT NOT NULL, folder TEXT NOT NULL, validity INTEGER NOT NULL,
			uid INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
			PRIMARY KEY (account, folder, uid)
		);
		CREATE TABLE IF NOT EXISTS rejected (
			account TEXT NOT NULL, folder TEXT NOT NULL, validity INTEGER NOT NULL, uid INTEGER NOT NULL,
			rejected_at TEXT NOT NULL,
			PRIMARY KEY (account, folder, validity, uid)
		)`)
	var tracksGmail bool
	if err == nil {
		err = db.QueryRow(`SELECT EXISTS (SELECT 1 FROM pragma_table_info('pending') WHERE name = 'gmail')`).Scan(&tracksGmail)
	}
	if err == nil && !tracksGmail {
		_, err = db.Exec(`ALTER TABLE pending ADD COLUMN gmail TEXT NOT NULL DEFAULT ''`)
	}
	if err != nil {
		st.close()
		return nil, err
	}
	return st, nil
}

func (st *state) close() {
	_ = st.db.Close()
	_ = st.lock.Close()
}

func (st *state) bind(ctx context.Context, account, identity string) error {
	if _, err := st.db.ExecContext(ctx, `INSERT INTO accounts(id, identity) VALUES (?, ?) ON CONFLICT DO NOTHING`, account, identity); err != nil {
		return err
	}
	var saved string
	if err := st.db.QueryRowContext(ctx, `SELECT identity FROM accounts WHERE id = ?`, account).Scan(&saved); err != nil {
		return err
	}
	if saved != identity {
		return fmt.Errorf("account %s changed mailbox identity, source or Bank destination; use a new account id to start a fresh checkpoint", account)
	}
	return nil
}

func (st *state) load(ctx context.Context, account, folder string) (checkpoint, error) {
	var point checkpoint
	err := st.db.QueryRowContext(ctx, `SELECT validity, uid FROM folders WHERE account = ? AND folder = ?`, account, folder).Scan(&point.Validity, &point.UID)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return point, err
}

func (st *state) save(ctx context.Context, account, folder string, point checkpoint) error {
	_, err := st.db.ExecContext(ctx, `INSERT INTO folders(account, folder, validity, uid) VALUES (?, ?, ?, ?)
		ON CONFLICT(account, folder) DO UPDATE SET validity = excluded.validity, uid = excluded.uid`, account, folder, point.Validity, point.UID)
	return err
}

func (st *state) attempt(ctx context.Context, account string) error {
	_, err := st.db.ExecContext(ctx, `UPDATE accounts SET last_attempt = ? WHERE id = ?`, time.Now().UTC().Format(time.RFC3339), account)
	return err
}

func (st *state) finish(ctx context.Context, account string, outcome error) error {
	if outcome != nil {
		_, err := st.db.ExecContext(ctx, `UPDATE accounts SET last_error = ? WHERE id = ?`, outcome.Error(), account)
		return err
	}
	_, err := st.db.ExecContext(ctx, `UPDATE accounts SET last_success = ?, last_error = '' WHERE id = ?`, time.Now().UTC().Format(time.RFC3339), account)
	return err
}

func (st *state) stage(ctx context.Context, account, folder string, validity uint32, files []downloaded) error {
	if len(files) == 0 {
		return fmt.Errorf("cannot stage an empty batch")
	}
	dir := filepath.Dir(files[0].Path)
	for _, file := range files {
		if filepath.Dir(file.Path) != dir {
			return fmt.Errorf("batch files must share a staging directory")
		}
	}
	if err := publishBatch(dir); err != nil {
		return fmt.Errorf("persist IMAP staging directory: %w", err)
	}
	for index := range files {
		files[index].Path = filepath.Join(dir+"-ready", filepath.Base(files[index].Path))
	}
	transaction, err := st.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback() }()
	for _, file := range files {
		path, err := filepath.Rel(st.dir, file.Path)
		if err != nil {
			return err
		}
		var gmail []byte
		if file.Gmail != nil {
			if gmail, err = json.Marshal(file.Gmail); err != nil {
				return err
			}
		}
		if _, err := transaction.ExecContext(ctx, `INSERT INTO pending(account, folder, validity, uid, path, size, gmail) VALUES (?, ?, ?, ?, ?, ?, ?)`, account, folder, validity, file.UID, path, file.Size, string(gmail)); err != nil {
			return err
		}
	}
	return transaction.Commit()
}

func (st *state) queued(ctx context.Context, account, folder string) ([]downloaded, checkpoint, error) {
	rows, err := st.db.QueryContext(ctx, `SELECT validity, uid, path, size, gmail FROM pending WHERE account = ? AND folder = ? ORDER BY uid`, account, folder)
	if err != nil {
		return nil, checkpoint{}, err
	}
	defer rows.Close()
	files := []downloaded{}
	var point checkpoint
	for rows.Next() {
		var file downloaded
		var gmail string
		if err := rows.Scan(&point.Validity, &file.UID, &file.Path, &file.Size, &gmail); err != nil {
			return nil, point, err
		}
		if gmail != "" {
			file.Gmail = new(gmailMetadata)
			if err := json.Unmarshal([]byte(gmail), file.Gmail); err != nil {
				return nil, point, fmt.Errorf("queued UID %d Gmail metadata: %w", file.UID, err)
			}
		}
		if !filepath.IsLocal(file.Path) {
			return nil, point, fmt.Errorf("invalid queued message path")
		}
		file.Path = filepath.Join(st.dir, file.Path)
		point.UID = uint32(file.UID)
		files = append(files, file)
	}
	return files, point, rows.Err()
}

func (st *state) acknowledge(ctx context.Context, account, folder string, point checkpoint, rejected []imap.UID) error {
	transaction, err := st.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback() }()
	if _, err := transaction.ExecContext(ctx, `INSERT INTO folders(account, folder, validity, uid) VALUES (?, ?, ?, ?)
		ON CONFLICT(account, folder) DO UPDATE SET validity = excluded.validity, uid = excluded.uid`, account, folder, point.Validity, point.UID); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `DELETE FROM pending WHERE account = ? AND folder = ?`, account, folder); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, uid := range rejected {
		if _, err := transaction.ExecContext(ctx, `INSERT INTO rejected(account, folder, validity, uid, rejected_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, account, folder, point.Validity, uid, now); err != nil {
			return err
		}
	}
	return transaction.Commit()
}

func (st *state) prune() error {
	rows, err := st.db.Query(`SELECT DISTINCT path FROM pending`)
	if err != nil {
		return err
	}
	retained := make(map[string]bool)
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			rows.Close()
			return err
		}
		retained[filepath.Dir(path)] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(st.dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "fetch-") && !retained[entry.Name()] {
			if err := os.RemoveAll(filepath.Join(st.dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func ReadStatus(dir string) ([]Status, error) {
	path := filepath.Join(dir, "state.sqlite")
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	uri := url.URL{Scheme: "file", Path: filepath.ToSlash(absolute), RawQuery: "mode=ro"}
	if !strings.HasPrefix(uri.Path, "/") {
		uri.Path = "/" + uri.Path
	}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	var tracksRejections bool
	if err := db.QueryRow(`SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rejected')`).Scan(&tracksRejections); err != nil {
		return nil, err
	}
	rejected := "0"
	if tracksRejections {
		rejected = "(SELECT count(*) FROM rejected WHERE account = accounts.id)"
	}
	rows, err := db.Query(`SELECT id, last_attempt, last_success, last_error,
		(SELECT count(*) FROM pending WHERE account = accounts.id), ` + rejected + ` FROM accounts ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	statuses := []Status{}
	for rows.Next() {
		var status Status
		if err := rows.Scan(&status.Account, &status.LastAttempt, &status.LastSuccess, &status.LastError, &status.Pending, &status.Rejected); err != nil {
			return nil, err
		}
		statuses = append(statuses, status)
	}
	return statuses, rows.Err()
}
