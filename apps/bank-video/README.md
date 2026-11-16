# bank-video

Short films for bank, under its product name Siglum, made with Remotion. Each film's picture and score come from one plan, so every cut, ref stamp, keystroke and note lands on the same frame.

```sh
mise run bank-video:dev      # writes the scores, opens Remotion Studio
mise run bank-video:render   # writes the scores, renders all six films into out/
```

**Orbs** (`src/look/orbs/`) is the newest: every shot is one real round thing seen square-on (a coin, a petri-dish culture, an astrolabe, the Golden Record, a planet), each disc measured in its own file so all of them sit at the same centre and size. Words stand on the disc's top edge, and the film opens and ends on the Moon. Its images live in `public/orbs` and are listed in `src/look/orbs/orbs.ts`.

The images are not committed. `src/look/photos.ts` lists each one with its source page, the file that was downloaded, its licence (public domain or CC0, checked on the item's own record), its credit, and how the local file in `public/images` was cropped and resized.

## Six versions

All six share the score engine, and all but Line the 34-second plan (`src/look/plan.ts`). Search, Sources and Cited cut on the same frames to the same images and differ only in their words (`src/look/versions.ts`). Line has its own images and cascade:

- **Line**: 24.5 seconds on its own 11.5-bar arc (`quick` in `src/look/plan.ts`). It cuts only between horizons, each with a calm sky above the line and dense material below, and every image is registered so its edge crosses mid-frame exactly on the centre line. One held shot opens it. "What you wrote." plays over dusk on Earth, "What you received." over Earth's limb from the ISS, and "What you saved." over the Moon from Apollo, three shots each with no two neighbours alike. "Every answer" crosses all three worlds in four 12-frame cuts, and "has a source." runs over three lunar shots, the last held into the hard cut. Each word is set into the shot under it (`src/look/Lettered.tsx`, with one entry per image in `src/look/lettering.ts`). Shots that carry a word are held still, and a phrase stands on one line, the average of its shots' measured edges bent harder so the curve shows, so the word does not move at all while its phrase is on screen. Its baseline sits a fifth of an em above the line, so a y stays whole and its tail comes down to the edge. The word goes through the same grade, at the photograph's measured softness and grain, in an ink inside the photograph's own range, with the scene's light wrapping its edges. Glyphs are set at four times their size and scaled down, so the browser draws them as outlines and they cannot snap to pixels. The type is Source Serif 4 at optical size 30. After the cut to the opening horizon, the mark arrives one note of the motif at a time: its square stamps down with a soft knock and a glint along the horizon, its corners snap round it one after the other, and the name fades in letter by letter, each settling onto the horizon, on a full chord. The picture eases out over the last second and a half.
- **Search**: a query typed on the horizon; five hits from WhatsApp, Gmail, a drive, ChatGPT and YouTube, each with its ref; refs from every source passing through the cascade; then the answer and its ref.
- **Sources**: the sources by name, "One archive", the ways in (a terminal, a browser, an agent), and the claim.
- **Cited**: every image gets an edition-style footnote, numbered by source (`src/look/citations.ts`, built only from each image's manifest entry); the answer is the next footnote, with its ref.

Two are built differently:

- **Seam** (`src/look/seam/`): every frame is the top half of one record over the bottom half of another, meeting at the line; at the cut they become one image.
- **Frieze** (`src/look/frieze/`): no cuts; every image laid end to end along one horizon, the camera accelerating into motion blur, with the score's clicks on each passing join.

`bun scripts/score.ts <id>` writes one film's score; without an id it writes them all.

Every shot is cropped so one horizontal line in the photograph sits on the screen's centre line, and every word stands on it as a baseline. The push-in is anchored on that line, so it never moves.

## How it is built

The arc runs at 112.5 bpm, so a beat is 16 frames at 30 fps:

| Bars  | Part        | Picture                                                               | Sound                                                           |
| ----- | ----------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1-3   | Observation | Three slow shots: a horizon, a ledger's handwriting, the Milky Way    | A clock and foley band-limited to 300 Hz-2.5 kHz over room tone |
| 4-8   | Pattern     | A shot per one or two beats, rotating record, specimen and phenomenon | A felt-piano ostinato (A, E, G sharp, D Lydian) over a pulse    |
| 9-12  | Cascade     | Cuts of 12, 8, 6, then 4 frames                                       | Harmony, bells and foley double; the band opens to 20 Hz-20 kHz |
| 13-16 | Answer      | A hard cut back to the horizon, the answer on it, then the mark       | Silence for 1.5 s, then the three notes alone                   |

`scripts/score.ts` synthesises a WAV per film into `public/` (felt piano from damped partials, saw pads, FM bells, filtered-noise foley, Freeverb). The room tone and the pulse bypass the band filter that opens over the film. The scores are generated, not committed.

Each image's exposure is set so neighbouring cuts stay within a similar brightness: the cascade cuts at up to 7.5 per second, which must stay under the flash limits for photosensitive viewers.

The first, diagram-based cut is still the `Siglum` composition (`src/Film.tsx`, `src/shots/`) until one version is chosen.

All records are sample data. Refs use the forms bank prints today: `msg:` and `content:` with 16 hex digits, `activity:` shortened.
