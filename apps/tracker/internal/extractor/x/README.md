# x

Reads a status page on x.com / twitter.com / mobile.x.com out of the rendered DOM the extension captures (X serves an empty shell to any plain fetch): the focal tweet's id, author handle and name, text with emoji from `img alt` and newlines kept, timestamp, replied-to and quoted status ids, media count, language.

Everything is keyed off `data-testid` (`tweet`, `User-Name`, `tweetText`, `tweetPhoto`, `videoPlayer`, `reply-context`) plus `role="link"` for the quote card, never obfuscated class names; no article carrying the URL's status id, or an article with no text div, is `ErrNoMatch` (login wall, "post is unavailable").

**The fixtures under `testdata/` are synthetic** — hand-written from that DOM description, not captured from X — so every expectation in `x_test.go` is unverified until they are replaced.

To replace one: load a real status page with the extension installed, dwell past `dwell_ms` so `tracker` stores the blob, get its hash (`select raw_hash from captures where url like '%status/<id>%'`), and pull the payload — until a `tracker blob <hash>` subcommand exists:

```sh
psql "$TRACKER_DATABASE_URL" -At -c "select encode(payload,'base64') from raw_html_blobs where hash='\x<hex>'" | base64 -d | zstd -d > testdata/status-photo.html
```
