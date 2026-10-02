# x

Reads a status page on x.com / twitter.com / mobile.x.com out of the rendered DOM the extension captures (X serves an empty shell to any plain fetch): the focal tweet's id, author handle and name, text with emoji from `img alt` and newlines kept, timestamp, replied-to and quoted status ids, media count, language. Around it, the conversation the page renders: `ancestors`, the tweets above it (the thread it answers, the nearest being the replied-to one), and `replies`, the tweets below, each with id, author handle and name, text and timestamp, and all of it in `search_text`. An article without a timestamp linking to its own status is skipped.

Everything is keyed off `data-testid` (`tweet`, `User-Name`, `tweetText`, `tweetPhoto`, `videoPlayer`) plus `role="link"` for the quote card, never obfuscated class names; no article carrying the URL's status id, or an article with no text div, is `ErrNoMatch` (login wall, "post is unavailable").

Only `testdata/logged-out.html` is real: `x.com/jack/status/20` rendered by headless Chromium 151 on 2026-10-02 while logged out (the post, three replies, then a login prompt), dumped without the doctype, with script and style blocks removed. X now serves logged-out visitors a separate client (`x-web`: Tailwind classes, no `data-testid`, no `<time>`, `article` per post with the post URL on a `data-href` wrapper), so that page is `ErrNoMatch`. Whether the logged-in app the extension sees still carries the `data-testid` markup is unverified.

**`status-photo.html` and `reply-quote.html` are synthetic**: hand-written from the DOM description above, not captured from X, so every expectation drawn from them is unverified until they are replaced with an extension capture.

To replace one: load a real status page with the extension installed, dwell past `dwell_ms` so `tracker` stores the blob, then write out its most recent capture:

```sh
tracker blob https://x.com/<handle>/status/<id> > testdata/status-photo.html
```
