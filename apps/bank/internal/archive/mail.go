package archive

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxMailContextBytes = 16384
const maxMailContextRecordBytes = 128 << 10

type MailImportContext struct {
	Version      int    `json:"version"`
	Kind         string `json:"kind"`
	Mailbox      string `json:"mailbox"`
	RelativePath string `json:"relative_path"`
	AccountID    string `json:"account_id,omitempty"`
	// Version 2 adds the provider's thread ID and the further IMAP folders
	// the message was observed in, such as Gmail labels.
	ThreadID string   `json:"thread_id,omitempty"`
	Labels   []string `json:"labels,omitempty"`
}

func (context MailImportContext) Validate() error {
	if (context.Version != 1 && context.Version != 2) || (context.Kind != "export" && context.Kind != "imap") {
		return fmt.Errorf("mail context requires version 1 or 2 and kind export or imap")
	}
	if context.Version == 1 && (context.ThreadID != "" || len(context.Labels) > 0) {
		return fmt.Errorf("mail context version 1 cannot carry a thread ID or labels")
	}
	if len(context.Labels) > 0 && context.Kind != "imap" {
		return fmt.Errorf("mail context labels require kind imap")
	}
	for _, label := range context.Labels {
		if label == "" {
			return fmt.Errorf("mail context label is empty")
		}
	}
	for _, value := range append([]string{context.Mailbox, context.RelativePath, context.AccountID, context.ThreadID}, context.Labels...) {
		if len(value) > 4096 || !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("invalid or overlong mail context value")
		}
	}
	if context.Mailbox == "" || !safeMailPath(context.RelativePath) {
		return fmt.Errorf("mail context requires a mailbox and a safe relative input path")
	}
	if context.Kind == "export" && context.AccountID != "" {
		return fmt.Errorf("export context cannot contain an IMAP account id")
	}
	if context.AccountID != "" {
		return ValidSource(context.AccountID)
	}
	return nil
}

func safeMailPath(value string) bool {
	if value == "" || strings.ContainsAny(value, "\\:\x00") || path.IsAbs(value) {
		return false
	}
	for _, component := range strings.Split(value, "/") {
		if component == ".." || component == "." || component == "" {
			return false
		}
	}
	return true
}

func DecodeMailContext(raw []byte) (*MailImportContext, error) {
	if len(raw) > MaxMailContextBytes {
		return nil, fmt.Errorf("mail context exceeds %d bytes", MaxMailContextBytes)
	}
	var context MailImportContext
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&context); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return nil, fmt.Errorf("mail context must be one JSON object")
	}
	return &context, context.Validate()
}

type MailContextRecord struct {
	Version    int                `json:"version"`
	Source     string             `json:"source"`
	RawRef     string             `json:"raw_ref"`
	InputKind  string             `json:"input_kind"`
	Context    *MailImportContext `json:"context,omitempty"`
	ExternalID string             `json:"external_id,omitempty"`
	ThreadID   string             `json:"thread_id,omitempty"`
	SentAt     time.Time          `json:"sent_at,omitempty"`
}

func (record MailContextRecord) Validate() error {
	if err := ValidSource(record.Source); err != nil {
		return err
	}
	if record.Version != 1 || (record.InputKind != "eml" && record.InputKind != "mbox") {
		return fmt.Errorf("invalid mail context record version or input kind")
	}
	if !safeRawMailPath(record.RawRef) || !strings.HasPrefix(record.RawRef, record.Source+"/") || strings.Contains(record.RawRef, "/.mail-contexts/") {
		return fmt.Errorf("mail context raw reference must stay inside its source")
	}
	if len(record.ExternalID) > 4096 || len(record.ThreadID) > 4096 || strings.ContainsAny(record.ExternalID+record.ThreadID, "\x00\r\n") {
		return fmt.Errorf("invalid mail identity override")
	}
	if record.Context != nil {
		return record.Context.Validate()
	}
	return nil
}

func WriteMailContext(root string, record MailContextRecord) (string, error) {
	record.RawRef = filepath.ToSlash(record.RawRef)
	if err := record.Validate(); err != nil {
		return "", err
	}
	input, err := OpenMailRaw(root, record)
	if err != nil {
		return "", fmt.Errorf("context raw input: %w", err)
	}
	if err := input.Close(); err != nil {
		return "", err
	}
	raw, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	if len(raw) > maxMailContextRecordBytes {
		return "", fmt.Errorf("mail context record exceeds 128 KiB")
	}
	digest := sha256.Sum256(raw)
	rel := filepath.Join(record.Source, ".mail-contexts", hex.EncodeToString(digest[:])+".json")
	return writeAt(root, rel, bytes.NewReader(raw))
}

func ReadMailContext(root, source, name string) (MailContextRecord, error) {
	var record MailContextRecord
	if err := ValidSource(source); err != nil {
		return record, err
	}
	if len(name) != 69 || !strings.HasSuffix(name, ".json") {
		return record, fmt.Errorf("invalid mail context filename")
	}
	if _, err := hex.DecodeString(strings.TrimSuffix(name, ".json")); err != nil {
		return record, err
	}
	sourceRoot, err := openMailSource(root, source)
	if err != nil {
		return record, err
	}
	defer sourceRoot.Close()
	file, err := sourceRoot.Open(filepath.Join(".mail-contexts", name))
	if err != nil {
		return record, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxMailContextRecordBytes+1))
	if err != nil {
		return record, fmt.Errorf("read mail context record: %w", err)
	}
	if len(raw) > maxMailContextRecordBytes {
		return record, fmt.Errorf("mail context record exceeds 128 KiB")
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:])+".json" != name {
		return record, fmt.Errorf("mail context digest mismatch")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return record, err
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return record, fmt.Errorf("mail context record must be one JSON object")
	}
	if record.Source != source {
		return record, fmt.Errorf("mail context source mismatch")
	}
	return record, record.Validate()
}

func openMailSource(root, source string) (*os.Root, error) {
	if err := ValidSource(source); err != nil {
		return nil, err
	}
	archiveRoot, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer archiveRoot.Close()
	return archiveRoot.OpenRoot(source)
}

func safeRawMailPath(value string) bool {
	if !filepath.IsLocal(filepath.FromSlash(value)) || strings.ContainsRune(value, '\x00') {
		return false
	}
	if filepath.Separator == '\\' && strings.ContainsAny(value, "\\:") {
		return false
	}
	for _, component := range strings.Split(value, "/") {
		if component == "" || component == "." || component == ".." {
			return false
		}
	}
	return true
}

func OpenMailRaw(root string, record MailContextRecord) (*os.File, error) {
	if err := record.Validate(); err != nil {
		return nil, err
	}
	sourceRoot, err := openMailSource(root, record.Source)
	if err != nil {
		return nil, err
	}
	defer sourceRoot.Close()
	input, err := sourceRoot.Open(filepath.FromSlash(strings.TrimPrefix(record.RawRef, record.Source+"/")))
	if err != nil {
		return nil, err
	}
	info, err := input.Stat()
	if err != nil {
		_ = input.Close()
		return nil, fmt.Errorf("stat mail raw reference: %w", err)
	}
	if !info.Mode().IsRegular() {
		_ = input.Close()
		return nil, fmt.Errorf("mail raw reference is not a regular file")
	}
	return input, nil
}
