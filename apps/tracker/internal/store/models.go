package store

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/uptrace/bun"
)

type URL struct {
	bun.BaseModel `bun:"table:urls"`

	ID            int64     `bun:"id,pk,autoincrement"`
	URLHash       []byte    `bun:"url_hash"`
	NormalizedURL string    `bun:"normalized_url"`
	Host          string    `bun:"host"`
	CreatedAt     time.Time `bun:"created_at,nullzero,default:now()"`
}

type PageView struct {
	bun.BaseModel `bun:"table:page_views"`

	ID             uuid.UUID `bun:"id,pk"`
	DeviceID       uuid.UUID `bun:"device_id"`
	URLID          int64     `bun:"url_id"`
	TabSessionID   string    `bun:"tab_session_id,nullzero"`
	Title          string    `bun:"title,nullzero"`
	StartedAt      time.Time `bun:"started_at"`
	NavigationType string    `bun:"navigation_type"`
	ReferrerURLID  int64     `bun:"referrer_url_id,nullzero"`
	Private        bool      `bun:"private"`
	CreatedAt      time.Time `bun:"created_at,nullzero,default:now()"`
}

// ActivitySpan holds both browser spans (PageViewID set) and desktop spans
// (AppName set); the table's check constraint keeps it to exactly one.
type ActivitySpan struct {
	bun.BaseModel `bun:"table:activity_spans"`

	ID          uuid.UUID     `bun:"id,pk"`
	DeviceID    uuid.UUID     `bun:"device_id"`
	PageViewID  uuid.NullUUID `bun:"page_view_id"`
	AppName     string        `bun:"app_name,nullzero"`
	BundleID    string        `bun:"bundle_id,nullzero"`
	WindowTitle string        `bun:"window_title,nullzero"`
	StartedAt   time.Time     `bun:"started_at"`
	EndedAt     time.Time     `bun:"ended_at"`
	EndReason   string        `bun:"end_reason,nullzero"`
	CreatedAt   time.Time     `bun:"created_at,nullzero,default:now()"`
}

type RawHTMLBlob struct {
	bun.BaseModel `bun:"table:raw_html_blobs"`

	Hash        []byte    `bun:"hash,pk"`
	Codec       int16     `bun:"codec"`
	RawBytes    int       `bun:"raw_bytes"`
	StoredBytes int       `bun:"stored_bytes"`
	Payload     []byte    `bun:"payload"`
	CreatedAt   time.Time `bun:"created_at,nullzero,default:now()"`
}

type Capture struct {
	bun.BaseModel `bun:"table:captures"`

	ID           uuid.UUID `bun:"id,pk"`
	PageViewID   uuid.UUID `bun:"page_view_id"`
	DeviceID     uuid.UUID `bun:"device_id"`
	RawHash      []byte    `bun:"raw_hash"`
	Extractor    string    `bun:"extractor"`
	CapturedAt   time.Time `bun:"captured_at"`
	Reason       string    `bun:"reason"`
	URL          string    `bun:"url"`
	BrowserTitle string    `bun:"browser_title,nullzero"`
	RawCharCount int       `bun:"raw_char_count,nullzero"`
	CreatedAt    time.Time `bun:"created_at,nullzero,default:now()"`
}

const (
	StatusPending = "pending"
	StatusRunning = "running"
	StatusDone    = "done"
	StatusFailed  = "failed"
)

type Derivation struct {
	bun.BaseModel `bun:"table:derivations"`

	RawHash          []byte    `bun:"raw_hash,pk"`
	Extractor        string    `bun:"extractor,pk"`
	ExtractorVersion int       `bun:"extractor_version,pk"`
	Status           string    `bun:"status"`
	Attempts         int       `bun:"attempts"`
	ClaimedAt        time.Time `bun:"claimed_at,nullzero"`
	RetryAt          time.Time `bun:"retry_at,nullzero"`
	LastError        string    `bun:"last_error,nullzero"`
	ErrorClass       string    `bun:"error_class,nullzero"`
	RecordID         int64     `bun:"record_id,nullzero"`
	ProcessingMS     int       `bun:"processing_ms,nullzero"`
	CreatedAt        time.Time `bun:"created_at,nullzero,default:now()"`
	UpdatedAt        time.Time `bun:"updated_at,nullzero,default:now()"`
}

func (d Derivation) Key() DerivationKey {
	return DerivationKey{RawHash: d.RawHash, Extractor: d.Extractor, Version: d.ExtractorVersion}
}

type Record struct {
	bun.BaseModel `bun:"table:records"`

	ID           int64           `bun:"id,pk,autoincrement"`
	Extractor    string          `bun:"extractor"`
	RecordHash   []byte          `bun:"record_hash"`
	URLID        int64           `bun:"url_id"`
	CanonicalURL string          `bun:"canonical_url"`
	Title        string          `bun:"title,nullzero"`
	SearchText   string          `bun:"search_text"`
	Data         json.RawMessage `bun:"data,type:jsonb"`
	FirstSeenAt  time.Time       `bun:"first_seen_at"`
	LastSeenAt   time.Time       `bun:"last_seen_at"`
}
