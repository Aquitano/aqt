// Package sources is the list of kinds the archive imports. A source is added
// by writing its package below this one and registering it here: the CLI
// command, the server's import route, the inbox sweep and replay all read
// this list.
package sources

import (
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/sources/aichat"
	"github.com/aquitano/aqt/apps/bank/internal/sources/discord"
	"github.com/aquitano/aqt/apps/bank/internal/sources/eml"
	"github.com/aquitano/aqt/apps/bank/internal/sources/generic"
	"github.com/aquitano/aqt/apps/bank/internal/sources/linkedin"
	"github.com/aquitano/aqt/apps/bank/internal/sources/media"
	"github.com/aquitano/aqt/apps/bank/internal/sources/whatsapp"
)

var All = importer.Registry{
	importer.Register(whatsapp.Source{}, "WhatsApp 'Export chat' file: the zip with its media, or a bare .txt."),
	importer.Register(eml.EML{}, "One .eml file, or a directory of them such as proton-mail-export output."),
	importer.Register(eml.Mbox{}, "One mbox file, such as Gmail Takeout's."),
	importer.Register(discord.Source{}, "Discord GDPR data package (zip or directory)."),
	importer.Register(linkedin.Source{}, "LinkedIn data export (zip, csv or directory)."),
	importer.Register(aichat.ChatGPT{}, "ChatGPT data export (zip, json or directory)."),
	importer.Register(aichat.Claude{}, "Claude.ai data export (zip, json or directory)."),
	importer.Register(generic.Source{}, "Messages as a JSON array, object or NDJSON, attachments inline as base64."),
	importer.Register(media.Netflix{}, "Netflix viewing activity CSV."),
	importer.Register(media.YouTube{}, "YouTube history, playlists and music library from Google Takeout."),
	importer.Register(media.Bundle{}, "Versioned media library bundle (JSON)."),
	importer.Register(media.Markdown{}, "Markdown page publication as bank library index builds it (JSON)."),
}
