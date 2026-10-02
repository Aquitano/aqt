package imapsync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"golang.org/x/sync/errgroup"

	"github.com/aquitano/aqt/apps/bank/internal/eml"
)

const uidWindow = 10000
const batchBytes = 16 << 20

type Importer func(context.Context, string, string, eml.MailImportContext) (eml.Result, error)

type Result struct {
	Fetched    int   `json:"fetched"`
	Inserted   int64 `json:"inserted"`
	Duplicates int64 `json:"duplicates"`
	Bytes      int64 `json:"bytes"`
}

type messageInfo struct {
	UID    imap.UID
	SeqNum uint32
	Size   int64
}

type downloaded struct {
	UID  imap.UID
	Path string
	Size int64
}

type observedLiteral struct {
	imap.LiteralReader
	readErr error
}

func (literal *observedLiteral) Read(buffer []byte) (int, error) {
	count, err := literal.LiteralReader.Read(buffer)
	literal.readErr = err
	return count, err
}

func (session *session) metadata(first, last uint32) ([]messageInfo, error) {
	stop := session.deadline()
	defer stop()
	set := imap.UIDSet{{Start: imap.UID(first), Stop: imap.UID(last)}}
	command := session.client.Fetch(set, &imap.FetchOptions{UID: true, RFC822Size: true})
	defer command.Close()
	messages := []messageInfo{}
	seen := make(map[imap.UID]bool)
	for message := command.Next(); message != nil; message = command.Next() {
		buffer, err := message.Collect()
		if err != nil {
			return nil, err
		}
		if buffer.UID < imap.UID(first) || buffer.UID > imap.UID(last) || seen[buffer.UID] {
			continue
		}
		seen[buffer.UID] = true
		messages = append(messages, messageInfo{UID: buffer.UID, SeqNum: buffer.SeqNum, Size: buffer.RFC822Size})
	}
	if err := command.Close(); err != nil {
		return nil, err
	}
	slices.SortFunc(messages, func(left, right messageInfo) int {
		if left.UID < right.UID {
			return -1
		}
		if left.UID > right.UID {
			return 1
		}
		return 0
	})
	return messages, nil
}

func (session *session) download(messages []messageInfo, dir string, limit int64) (files []downloaded, err error) {
	stop := session.deadline()
	defer stop()
	var set imap.SeqSet
	expected := make(map[imap.UID]int64, len(messages))
	for _, message := range messages {
		if message.SeqNum == 0 {
			return nil, fmt.Errorf("UID %d: missing message sequence number", message.UID)
		}
		set.AddNum(message.SeqNum)
		expected[message.UID] = message.Size
	}
	command := session.client.Fetch(set, &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{{Peek: true}}})
	defer func() {
		if err != nil {
			_ = session.conn.Close()
		}
		_ = command.Close()
	}()
	for message := command.Next(); message != nil; message = command.Next() {
		var uid imap.UID
		var path string
		var size int64
		var digest string
		for item := message.Next(); item != nil; item = message.Next() {
			switch item := item.(type) {
			case imapclient.FetchItemDataUID:
				uid = item.UID
			case imapclient.FetchItemDataBodySection:
				if path != "" || item.Literal == nil || item.Literal.Size() <= 0 || item.Literal.Size() > limit {
					return nil, fmt.Errorf("UID %d: missing, repeated or oversized message body", uid)
				}
				file, createErr := os.CreateTemp(dir, "message-*.eml")
				if createErr != nil {
					return nil, createErr
				}
				path = file.Name()
				var copyErr error
				hash := sha256.New()
				literal := &observedLiteral{LiteralReader: item.Literal}
				size, copyErr = io.Copy(io.MultiWriter(file, hash), io.LimitReader(literal, limit+1))
				if literal.readErr != nil && (!errors.Is(literal.readErr, io.EOF) || size != literal.Size()) {
					_ = session.conn.Close()
					_ = session.client.Close()
				}
				digest = hex.EncodeToString(hash.Sum(nil))
				syncErr := file.Sync()
				closeErr := file.Close()
				if copyErr != nil || syncErr != nil || closeErr != nil {
					return nil, errors.Join(copyErr, syncErr, closeErr)
				}
				if size != item.Literal.Size() || size > limit {
					return nil, fmt.Errorf("UID %d: truncated or oversized message body", uid)
				}
			}
		}
		want, requested := expected[uid]
		if !requested {
			if path != "" {
				return nil, fmt.Errorf("unexpected body for UID %d", uid)
			}
			continue
		}
		if path == "" || size != want {
			return nil, fmt.Errorf("UID %d: expected %d bytes, received %d", uid, want, size)
		}
		stablePath := filepath.Join(dir, digest+".eml")
		if err := publishMessage(path, stablePath); err != nil {
			return nil, err
		}
		files = append(files, downloaded{UID: uid, Path: stablePath, Size: size})
		delete(expected, uid)
	}
	if err := command.Close(); err != nil {
		return nil, err
	}
	if len(expected) != 0 {
		return nil, fmt.Errorf("%d requested messages disappeared during FETCH; retrying without advancing checkpoint", len(expected))
	}
	return files, nil
}

func syncFolder(ctx context.Context, session *session, st *state, config Config, account Account, folder string, importer Importer, result *Result, progress func(uint32)) error {
	selected, err := session.selectFolder(folder)
	if err != nil {
		return err
	}
	if selected.UIDValidity == 0 || selected.UIDNext == 0 {
		return fmt.Errorf("server did not supply UIDVALIDITY and UIDNEXT")
	}
	point, err := st.load(ctx, account.ID, folder)
	if err != nil {
		return err
	}
	if point.Validity != selected.UIDValidity {
		point = checkpoint{Validity: selected.UIDValidity}
		if err := st.save(ctx, account.ID, folder, point); err != nil {
			return err
		}
	}
	last := uint32(selected.UIDNext) - 1
	if point.UID > last {
		return fmt.Errorf("UIDNEXT moved backwards without a UIDVALIDITY change")
	}
	for point.UID < last {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := uint32(min(uint64(point.UID)+uidWindow, uint64(last)))
		messages, err := session.metadata(point.UID+1, end)
		if err != nil {
			return err
		}
		for len(messages) > 0 {
			count := 0
			var size int64
			for count < len(messages) && count < config.BatchSize {
				message := messages[count]
				if message.Size <= 0 || message.Size > config.MaxMessageBytes {
					if count > 0 {
						break
					}
					return fmt.Errorf("UID %d has %d bytes, outside max_message_bytes=%d; checkpoint retained", message.UID, message.Size, config.MaxMessageBytes)
				}
				if count > 0 && size+message.Size > batchBytes {
					break
				}
				size += message.Size
				count++
			}
			batch := messages[:count]
			if err := syncBatch(ctx, session, st, config, account, folder, point.Validity, batch, importer, result); err != nil {
				return err
			}
			point.UID = uint32(batch[len(batch)-1].UID)
			progress(point.UID)
			messages = messages[count:]
		}
		point.UID = end
		if err := st.save(ctx, account.ID, folder, point); err != nil {
			return err
		}
	}
	return nil
}

func syncBatch(ctx context.Context, session *session, st *state, config Config, account Account, folder string, validity uint32, messages []messageInfo, importer Importer, result *Result) error {
	dir, err := os.MkdirTemp(config.StateDir, "fetch-*")
	if err != nil {
		return err
	}
	staged := false
	defer func() {
		if !staged {
			_ = os.RemoveAll(dir)
		}
	}()
	files, err := session.download(messages, dir, config.MaxMessageBytes)
	if err != nil {
		return err
	}
	result.Fetched += len(files)
	for _, file := range files {
		result.Bytes += file.Size
	}
	staged = true
	if err := st.stage(ctx, account.ID, folder, validity, files); err != nil {
		return err
	}
	_, err = flushQueued(ctx, st, config, account, folder, importer, result)
	return err
}

func flushQueued(ctx context.Context, st *state, config Config, account Account, folder string, importer Importer, result *Result) (checkpoint, error) {
	files, point, err := st.queued(ctx, account.ID, folder)
	if err != nil || len(files) == 0 {
		return point, err
	}
	for _, file := range files {
		info, err := os.Stat(file.Path)
		if err != nil {
			return point, fmt.Errorf("read queued UID %d: %w", file.UID, err)
		}
		if info.Size() != file.Size {
			return point, fmt.Errorf("queued UID %d changed size; restore the pending file before retrying", file.UID)
		}
	}
	timeout, _ := time.ParseDuration(config.Timeout)
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(config.Workers)
	var inserted, duplicates atomic.Int64
	for _, file := range files {
		group.Go(func() error {
			requestCtx, cancel := context.WithTimeout(groupCtx, timeout)
			defer cancel()
			observation := eml.MailImportContext{Version: 1, Kind: "imap", Mailbox: folder, RelativePath: filepath.Base(file.Path), AccountID: account.ID}
			outcome, err := importer(requestCtx, account.Source, file.Path, observation)
			if err != nil {
				return fmt.Errorf("UID %d import failed: %w", file.UID, err)
			}
			if outcome.MailContextVersion != 1 {
				return fmt.Errorf("UID %d mail context was not acknowledged; upgrade Bank before retrying", file.UID)
			}
			if outcome.Rejected != 0 || outcome.Inserted+outcome.Duplicates != 1 {
				return fmt.Errorf("UID %d was not acknowledged as one imported message (inserted=%d duplicates=%d rejected=%d)", file.UID, outcome.Inserted, outcome.Duplicates, outcome.Rejected)
			}
			inserted.Add(int64(outcome.Inserted))
			duplicates.Add(int64(outcome.Duplicates))
			return nil
		})
	}
	err = group.Wait()
	result.Inserted += inserted.Load()
	result.Duplicates += duplicates.Load()
	if err != nil {
		return point, err
	}
	if err := st.acknowledge(ctx, account.ID, folder, point); err != nil {
		return point, err
	}
	directories := make(map[string]bool)
	for _, file := range files {
		directories[filepath.Dir(file.Path)] = true
	}
	for dir := range directories {
		if err := os.RemoveAll(dir); err != nil {
			return point, err
		}
	}
	return point, nil
}
