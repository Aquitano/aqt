# reddit

Reads a thread on www.reddit.com or old.reddit.com, out of whichever front end rendered it: the post's id, subreddit, title, link (none for a self post), author, score, time and text, and every comment the page shows with its id, author, text, score, time and nesting depth, all of it in `search_text`. www.reddit.com is read from the attributes of its `shreddit-post` and `shreddit-comment` elements, old.reddit.com from the `data-*` attributes of its `.thing` elements. A thread is keyed as `https://www.reddit.com/r/<sub>/comments/<id>/`; a comment permalink, which shows only that comment's subtree, is a record of its own at `https://www.reddit.com/r/<sub>/comments/<id>/comment/<comment-id>/`, so visiting it never replaces the thread's record. On old.reddit.com, comments deleted outright (`[deleted]` or `[removed]`, no author) are left out, and a comment whose author deleted their account keeps its text under `[deleted]`; the www fixture has no deleted comment, so how shreddit marks one is unverified.

**The thread fixtures are not live captures.** Reddit answers every request from the machine the fixtures were made on with a 403 network-policy block ("whoa there, pardner!"), headless Chromium 151 included, on www and old alike. `testdata/blocked.html` is that page, as served for old.reddit.com on 2026-10-02, script and style blocks removed.

The two threads are the Wayback Machine's raw snapshots of logged-out pages (the `id_` form, without the archive's toolbar or rewritten links), loaded in headless Chromium 151 on 2026-10-02 and dumped without the doctype, as the extension's outerHTML would be, with script and style blocks removed:

- `www-thread.html`: <https://web.archive.org/web/20260925125343id_/https://www.reddit.com/r/golang/comments/1wplslx/can_you_build_a_kernel_with_go/>
- `old-thread.html`: <https://web.archive.org/web/20260626090651id_/https://old.reddit.com/r/golang/comments/10b9tto/is_it_just_me_or_does_nobody_really_know_what/>

The markup is Reddit's, but Reddit's own scripts ran from the archive's origin, not reddit.com, and logged out. Whether the logged-in page the extension captures carries the same `shreddit-*` attributes is unverified; replace the fixtures with an extension capture to check:

```sh
tracker blob https://www.reddit.com/r/<sub>/comments/<id>/<slug>/ > testdata/www-thread.html
```
