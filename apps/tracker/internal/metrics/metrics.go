// Package metrics holds the Prometheus collectors. Every label set is bounded
// by construction: routes, event types, extractor names, result classes.
// Never a URL or a host.
package metrics

import (
	"context"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	HTTPRequests         *prometheus.CounterVec
	HTTPDuration         *prometheus.HistogramVec
	EventsIngested       *prometheus.CounterVec
	EventsDropped        *prometheus.CounterVec
	CapturesIngested     *prometheus.CounterVec
	CaptureRawBytes      prometheus.Counter
	CaptureStoredBytes   prometheus.Counter
	Derivations          *prometheus.CounterVec
	Records              *prometheus.CounterVec
	ExtractDuration      *prometheus.HistogramVec
	DerivationsPending   prometheus.Gauge
	DerivationsOldestAge prometheus.Gauge
	TableBytes           *prometheus.GaugeVec
}

func New() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		HTTPRequests: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "tracker_http_requests_total"},
			[]string{"route", "status"}),
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "tracker_http_request_duration_seconds",
			Buckets: prometheus.DefBuckets}, []string{"route"}),
		EventsIngested: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "tracker_events_ingested_total"}, []string{"type"}),
		EventsDropped:  prometheus.NewCounterVec(prometheus.CounterOpts{Name: "tracker_events_dropped_total"}, []string{"type"}),
		CapturesIngested: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "tracker_captures_ingested_total"},
			[]string{"extractor", "dedup"}),
		CaptureRawBytes:    prometheus.NewCounter(prometheus.CounterOpts{Name: "tracker_capture_raw_bytes_total"}),
		CaptureStoredBytes: prometheus.NewCounter(prometheus.CounterOpts{Name: "tracker_capture_stored_bytes_total"}),
		Derivations: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "tracker_derivations_total"},
			[]string{"extractor", "result"}),
		Records: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "tracker_records_total"}, []string{"extractor", "dedup"}),
		ExtractDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "tracker_extract_duration_seconds",
			Buckets: prometheus.ExponentialBuckets(0.001, 4, 8)}, []string{"extractor"}),
		DerivationsPending:   prometheus.NewGauge(prometheus.GaugeOpts{Name: "tracker_derivations_pending"}),
		DerivationsOldestAge: prometheus.NewGauge(prometheus.GaugeOpts{Name: "tracker_derivations_oldest_age_seconds"}),
		TableBytes:           prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "tracker_table_bytes"}, []string{"table"}),
	}
	m.registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.HTTPRequests, m.HTTPDuration, m.EventsIngested, m.EventsDropped, m.CapturesIngested,
		m.CaptureRawBytes, m.CaptureStoredBytes, m.Derivations, m.Records, m.ExtractDuration,
		m.DerivationsPending, m.DerivationsOldestAge, m.TableBytes)
	return m
}

func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

type GaugeSource interface {
	QueueStats(ctx context.Context) (pending int64, oldest time.Duration, err error)
	TableBytes(ctx context.Context) (map[string]int64, error)
}

// Refresh keeps the queue and table gauges current until ctx ends. Errors are
// reported through onErr and the loop carries on: a database hiccup must not
// take the scrape endpoint with it.
func (m *Metrics) Refresh(ctx context.Context, src GaugeSource, every time.Duration, onErr func(error)) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		if err := m.refreshOnce(ctx, src); err != nil && ctx.Err() == nil {
			onErr(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (m *Metrics) refreshOnce(ctx context.Context, src GaugeSource) error {
	pending, oldest, err := src.QueueStats(ctx)
	if err != nil {
		return err
	}
	m.DerivationsPending.Set(float64(pending))
	m.DerivationsOldestAge.Set(oldest.Seconds())
	sizes, err := src.TableBytes(ctx)
	if err != nil {
		return err
	}
	for table, n := range sizes {
		m.TableBytes.WithLabelValues(table).Set(float64(n))
	}
	return nil
}
