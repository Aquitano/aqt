package youtube

import (
	"bytes"
	"time"
)

type HistoryEvent struct {
	ExternalID string
	VideoID    string
	Title      string
	URL        string
	Channel    string
	ChannelID  string
	WatchedAt  time.Time
}

type History struct {
	Events  []HistoryEvent
	Ads     int
	Skipped int
}

func ParseHistory(raw []byte, name string) (History, error) {
	watches, ads, skipped, err := parse(bytes.NewReader(raw), name)
	if err != nil {
		return History{}, err
	}
	result := History{Events: make([]HistoryEvent, 0, len(watches)), Ads: ads, Skipped: skipped}
	seen := map[string]int{}
	for _, w := range watches {
		result.Events = append(result.Events, HistoryEvent{
			ExternalID: watchDigest(w, seen), VideoID: w.VideoID, Title: w.Title,
			URL: w.URL, Channel: w.Channel, ChannelID: w.ChannelID, WatchedAt: w.WatchedAt,
		})
	}
	return result, nil
}
