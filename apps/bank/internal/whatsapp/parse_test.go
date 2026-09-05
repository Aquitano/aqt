package whatsapp

import (
	"strings"
	"testing"
	"time"
)

func TestParseAndroidDayFirst(t *testing.T) {
	chat := strings.Join([]string{
		"13/05/24, 21:07 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.",
		"13/05/24, 21:08 - Alice: hey Thomas",
		"how are you?",
		"13/05/24, 21:09 - Thomas: good!",
		"13/05/24, 21:10 - Alice: IMG-20240513-WA0001.jpg (file attached)",
		"look at this",
		"14/05/24, 09:00 - Alice: <Media omitted>",
	}, "\n")

	msgs, err := ParseChat(strings.NewReader(chat), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 4 {
		t.Fatalf("got %d messages, want 4: %+v", len(msgs), msgs)
	}
	if msgs[0].Body != "hey Thomas\nhow are you?" {
		t.Errorf("multiline body = %q", msgs[0].Body)
	}
	want := time.Date(2024, 5, 13, 21, 8, 0, 0, time.Local)
	if !msgs[0].SentAt.Equal(want) {
		t.Errorf("sent_at = %v, want %v", msgs[0].SentAt, want)
	}
	if msgs[2].AttachmentName != "IMG-20240513-WA0001.jpg" || msgs[2].Body != "look at this" {
		t.Errorf("attachment parse: name=%q body=%q", msgs[2].AttachmentName, msgs[2].Body)
	}
	if !IsMediaOmitted(msgs[3].Body) {
		t.Errorf("media omitted not detected: %q", msgs[3].Body)
	}
}

func TestParseIOSMonthFirst12h(t *testing.T) {
	chat := strings.Join([]string{
		"\u200e[05/13/24, 9:07:12 PM] Alice: hi",
		"[05/13/24, 9:08:01 PM] Alice: \u200e<attached: 00000012-PHOTO-2024-05-13.jpg>",
		"[05/14/24, 12:15:00 AM] Thomas: late reply",
	}, "\n")

	msgs, err := ParseChat(strings.NewReader(chat), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3: %+v", len(msgs), msgs)
	}
	want := time.Date(2024, 5, 13, 21, 7, 12, 0, time.Local)
	if !msgs[0].SentAt.Equal(want) {
		t.Errorf("sent_at = %v, want %v (month-first + PM)", msgs[0].SentAt, want)
	}
	if msgs[1].AttachmentName != "00000012-PHOTO-2024-05-13.jpg" {
		t.Errorf("ios attachment = %q", msgs[1].AttachmentName)
	}
	if h := msgs[2].SentAt.Hour(); h != 0 {
		t.Errorf("12 AM parsed as hour %d", h)
	}
}

// Localized exports translate the attachment markers. The structural fallback
// recognizes them, but only for names present in the export's media set — a
// parenthesized aside in ordinary message text must never become an attachment.
func TestParseLocalizedAttachments(t *testing.T) {
	chat := strings.Join([]string{
		"13/05/24, 21:08 - Alice: IMG-20240513-WA0001.jpg (Datei angehängt)",
		"schau mal",
		"[05/13/24, 9:09:00 PM] Alice: <Anhang: 00000012-PHOTO-2024-05-13.jpg>",
		"13/05/24, 21:10 - Thomas: klingt gut (glaube ich)",
		"13/05/24, 21:11 - Thomas: <so ein Ding: IMG-20240513-WA0001.jpg> nur Text",
	}, "\n")
	media := map[string]bool{
		"IMG-20240513-WA0001.jpg":       true,
		"00000012-PHOTO-2024-05-13.jpg": true,
	}
	msgs, err := ParseChat(strings.NewReader(chat), func(name string) bool { return media[name] })
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 4 {
		t.Fatalf("got %d messages, want 4: %+v", len(msgs), msgs)
	}
	if msgs[0].AttachmentName != "IMG-20240513-WA0001.jpg" || msgs[0].Body != "schau mal" {
		t.Errorf("android localized: name=%q body=%q", msgs[0].AttachmentName, msgs[0].Body)
	}
	if msgs[1].AttachmentName != "00000012-PHOTO-2024-05-13.jpg" {
		t.Errorf("ios localized: name=%q", msgs[1].AttachmentName)
	}
	if msgs[2].AttachmentName != "" || msgs[2].Body != "klingt gut (glaube ich)" {
		t.Errorf("plain text mangled: name=%q body=%q", msgs[2].AttachmentName, msgs[2].Body)
	}
	// A name that IS in the media set still counts when the marker word differs;
	// that is the point of validating against the set, not the words.
	if msgs[3].AttachmentName != "IMG-20240513-WA0001.jpg" {
		t.Errorf("angle-bracket localized: name=%q", msgs[3].AttachmentName)
	}
	// Without the predicate the localized markers stay plain text.
	msgs, err = ParseChat(strings.NewReader(chat), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range msgs {
		if m.AttachmentName != "" {
			t.Errorf("localized marker matched without a media set: %+v", m)
		}
	}
}

func TestMessageDigestStability(t *testing.T) {
	pm := ParsedMessage{Sender: "Alice", Body: "ok", SentAt: time.Date(2024, 5, 13, 21, 41, 0, 0, time.Local)}

	// Identical messages in the same minute must get distinct ids...
	seen := map[string]int{}
	first := messageDigest("Alice", pm, seen)
	second := messageDigest("Alice", pm, seen)
	if first == second {
		t.Error("identical messages collided — second would be dropped")
	}
	// ...and re-running the import must reproduce the same ids in order.
	seen2 := map[string]int{}
	if messageDigest("Alice", pm, seen2) != first || messageDigest("Alice", pm, seen2) != second {
		t.Error("digest not stable across re-imports")
	}
	// Timezone of the importing machine must not matter: the digest uses wall
	// time as written in the export.
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	pmBerlin := pm
	pmBerlin.SentAt = time.Date(2024, 5, 13, 21, 41, 0, 0, berlin)
	if messageDigest("Alice", pmBerlin, map[string]int{}) != first {
		t.Error("digest differs across import-machine timezones")
	}
}

func TestMessageDigestMediaOmittedMatchesMedia(t *testing.T) {
	at := time.Date(2024, 5, 13, 21, 41, 0, 0, time.Local)
	withMedia := ParsedMessage{Sender: "Alice", Body: "", AttachmentName: "IMG-0001.jpg", SentAt: at}
	omitted := ParsedMessage{Sender: "Alice", Body: "<Media omitted>", SentAt: at}
	if messageDigest("Alice", withMedia, map[string]int{}) != messageDigest("Alice", omitted, map[string]int{}) {
		t.Error("without-media and with-media exports of the same message must share an id, or healAttachment can never fire")
	}
}

func TestThreadName(t *testing.T) {
	for in, want := range map[string]string{
		"WhatsApp Chat with Alice Example.txt": "Alice Example",
		"WhatsApp Chat - Bob.zip":              "Bob",
		"WhatsApp Chat with Alice (1).zip":     "Alice",
		"random-export.txt":                    "random-export",
	} {
		if got := ThreadName(in); got != want {
			t.Errorf("ThreadName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSafeMediaName(t *testing.T) {
	unsafe := []string{
		"", ".", "..", "/etc/passwd", "../../.ssh/id_rsa", "sub/IMG-1.jpg",
		`..\windows\win.ini`, "~/secrets.txt",
	}
	for _, name := range unsafe {
		if safeMediaName(name) {
			t.Errorf("%q accepted", name)
		}
	}
	for _, name := range []string{"IMG-20240513-WA0001.jpg", "00000042-PHOTO-2024-05-13-21-08-00.jpg", "a b.pdf"} {
		if !safeMediaName(name) {
			t.Errorf("%q rejected", name)
		}
	}
}
