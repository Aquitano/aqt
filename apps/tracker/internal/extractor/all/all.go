// Package all registers every site extractor. Import it for its side
// effects; the binary then serves the full rule set and the worker can run
// any derivation it claims.
package all

import (
	_ "github.com/aquitano/aqt/apps/tracker/internal/extractor/article"
	_ "github.com/aquitano/aqt/apps/tracker/internal/extractor/github"
	_ "github.com/aquitano/aqt/apps/tracker/internal/extractor/hackernews"
	_ "github.com/aquitano/aqt/apps/tracker/internal/extractor/reddit"
	_ "github.com/aquitano/aqt/apps/tracker/internal/extractor/stackexchange"
	_ "github.com/aquitano/aqt/apps/tracker/internal/extractor/x"
	_ "github.com/aquitano/aqt/apps/tracker/internal/extractor/youtube"
)
