package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

type Volume struct {
	ID           string    `json:"id"`
	Label        string    `json:"label"`
	FS           string    `json:"fs"`
	Serial       string    `json:"serial"`
	PartitionID  string    `json:"partition_id,omitempty"`
	DeviceSerial string    `json:"device_serial,omitempty"`
	Size         int64     `json:"size"`
	StableIDs    bool      `json:"stable_ids"`
	MountPath    string    `json:"mount_path"`
	FirstSeen    time.Time `json:"first_seen"`
	LastSeen     time.Time `json:"last_seen"`
}

// AmbiguousVolumeError stops a scan whose fingerprint fits more than one
// known volume, or fits one only partly: a clone shares the serial and the
// partition GUID but not the device serial. Guessing would merge two disks'
// catalogues, so the caller has to say which it is.
type AmbiguousVolumeError struct {
	Fingerprint disk.Fingerprint
	Candidates  []Volume
}

func (e *AmbiguousVolumeError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s volume %s (serial %s, device %q) resembles %d known volume(s) without matching exactly:",
		e.Fingerprint.FS, e.Fingerprint.Label, e.Fingerprint.Serial, e.Fingerprint.DeviceSerial, len(e.Candidates))
	for _, c := range e.Candidates {
		fmt.Fprintf(&b, "\n  %s %q device %q, last mounted at %s on %s", c.ID, c.Label, c.DeviceSerial,
			c.MountPath, c.LastSeen.Format("2006-01-02"))
	}
	b.WriteString("\nrerun with --volume <id> if it is one of these, or --new-volume if it is a different disk")
	return b.String()
}

const volumeColumns = `id, label, fs_type, serial, partition_id, device_serial, size_bytes, stable_ids, mount_path, first_seen, last_seen`

func scanVolume(row pgx.Row) (Volume, error) {
	var v Volume
	err := row.Scan(&v.ID, &v.Label, &v.FS, &v.Serial, &v.PartitionID, &v.DeviceSerial, &v.Size, &v.StableIDs,
		&v.MountPath, &v.FirstSeen, &v.LastSeen)
	return v, err
}

// Holds reports whether a mounted fingerprint is this volume. A partition
// GUID or device serial only disqualifies when both sides recorded one: some
// USB bridges report no serial at all. A clone fails it on the device serial.
func (v Volume) Holds(fp disk.Fingerprint) bool {
	return v.FS == fp.FS && v.Serial == fp.Serial &&
		agree(v.PartitionID, fp.PartitionID) && agree(v.DeviceSerial, fp.DeviceSerial)
}

// chooseVolume picks the known volume, among those sharing the fingerprint's
// serial, that the fingerprint belongs to.
func chooseVolume(fp disk.Fingerprint, candidates []Volume) (*Volume, bool) {
	var fits []int
	for i, c := range candidates {
		if c.Holds(fp) {
			fits = append(fits, i)
		}
	}
	switch {
	case len(candidates) == 0:
		return nil, false
	case len(fits) == 1:
		return &candidates[fits[0]], false
	default:
		return nil, true
	}
}

func agree(known, seen string) bool { return known == "" || seen == "" || known == seen }

// ResolveVolume finds or records the volume a mounted fingerprint belongs to.
// forceID names the volume explicitly; forceNew records a new one even when
// the fingerprint resembles a known volume.
func (s *Store) ResolveVolume(ctx context.Context, mounted disk.Volume, forceID string, forceNew bool) (Volume, error) {
	fp := mounted.Fingerprint
	if forceNew {
		return s.insertVolume(ctx, mounted)
	}
	if forceID != "" {
		v, err := scanVolume(s.pool.QueryRow(ctx, `select `+volumeColumns+` from volumes where id::text = $1`, forceID))
		if errors.Is(err, pgx.ErrNoRows) {
			return v, fmt.Errorf("no volume %s", forceID)
		}
		if err != nil {
			return v, err
		}
		if v.FS != fp.FS || v.Serial != fp.Serial {
			return v, fmt.Errorf("volume %s is %s serial %s, but the mounted one is %s serial %s", v.ID, v.FS, v.Serial, fp.FS, fp.Serial)
		}
		return s.touchVolume(ctx, v.ID, mounted)
	}
	rows, err := s.pool.Query(ctx, `select `+volumeColumns+` from volumes where fs_type = $1 and serial = $2`, fp.FS, fp.Serial)
	if err != nil {
		return Volume{}, err
	}
	candidates, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Volume, error) { return scanVolume(r) })
	if err != nil {
		return Volume{}, err
	}
	match, ambiguous := chooseVolume(fp, candidates)
	switch {
	case ambiguous:
		return Volume{}, &AmbiguousVolumeError{Fingerprint: fp, Candidates: candidates}
	case match == nil:
		return s.insertVolume(ctx, mounted)
	default:
		return s.touchVolume(ctx, match.ID, mounted)
	}
}

func (s *Store) insertVolume(ctx context.Context, m disk.Volume) (Volume, error) {
	return scanVolume(s.pool.QueryRow(ctx, `
		insert into volumes (label, fs_type, serial, partition_id, device_serial, size_bytes, stable_ids, mount_path)
		values ($1, $2, $3, $4, $5, $6, $7, $8)
		returning `+volumeColumns,
		cleanText(m.Label), m.FS, m.Serial, m.PartitionID, m.DeviceSerial, m.Size, m.StableIDs, cleanText(m.Root)))
}

// touchVolume records where and as what the volume was just seen. A device
// serial can legitimately change when a disk moves to another enclosure, and
// the user has confirmed the volume by then.
func (s *Store) touchVolume(ctx context.Context, id string, m disk.Volume) (Volume, error) {
	return scanVolume(s.pool.QueryRow(ctx, `
		update volumes set label = $2, partition_id = coalesce(nullif($3, ''), partition_id),
		       device_serial = coalesce(nullif($4, ''), device_serial), size_bytes = $5, mount_path = $6, last_seen = now()
		where id = $1
		returning `+volumeColumns,
		id, cleanText(m.Label), m.PartitionID, m.DeviceSerial, m.Size, cleanText(m.Root)))
}

// FindVolume resolves a volume by id or label, as typed on the command line.
func (s *Store) FindVolume(ctx context.Context, idOrLabel string) (Volume, error) {
	rows, err := s.pool.Query(ctx, `select `+volumeColumns+` from volumes where id::text = $1 or lower(label) = lower($1)`, idOrLabel)
	if err != nil {
		return Volume{}, err
	}
	found, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Volume, error) { return scanVolume(r) })
	if err != nil {
		return Volume{}, err
	}
	switch len(found) {
	case 0:
		return Volume{}, fmt.Errorf("no volume %q: %w", idOrLabel, ErrNotFound)
	case 1:
		return found[0], nil
	default:
		return Volume{}, fmt.Errorf("%d volumes are labelled %q; use the id from 'attic volumes'", len(found), idOrLabel)
	}
}
