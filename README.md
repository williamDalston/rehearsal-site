# The House That AI Built — rehearsal tool

A single-page practice site for the Drupal GovCon 2026 talk. Real slide images, the podium
script beside each one, and one video take per slide recorded straight in the browser.

## Deploy to GitHub Pages

1. Create a repo (public or private — Pages works on private repos for paid plans).
2. Drop these files in the root:

```
index.html
app.js
data.js
manifest.webmanifest
sw.js
icon.svg
.nojekyll
slides/01.jpg … 43.jpg
```

3. Push, then **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.
4. Wait a minute. It lands at `https://<you>.github.io/<repo>/`.

Nothing to build, no dependencies to install, no CDN. Every path is relative, so it works
in a subfolder without changes.

## Things that matter for deployment

**The camera needs HTTPS.** GitHub Pages is HTTPS, so it works there. It will *not* work if
you double-click `index.html` and open it as `file://` — browsers block camera access on
non-secure origins. To test locally, run `python3 -m http.server` in this folder and open
`http://localhost:8000`, which browsers treat as secure.

**Use Chrome, Edge or Firefox on a laptop.** Recording relies on `MediaRecorder`. Safari's
support is newer and patchier, and iOS Safari in particular is unreliable for in-page video
capture. The code falls back to MP4 where WebM isn't supported and to audio-only if there's
no camera, but the good experience is a desktop Chromium browser.

**Recordings never leave your machine.** They're stored in IndexedDB in that browser, on that
device. Nothing uploads anywhere. Consequences worth knowing:

- Takes don't sync between your laptop and your phone.
- Clearing site data or "Clear browsing data" for the site deletes them.
- Safari private browsing restricts IndexedDB, so takes may not persist there.
- Use **Download** on any take you actually want to keep.

**It works offline.** A service worker (`sw.js`) caches the app and — once you've viewed
them — the slides, so the tool keeps running with no network. That is the point at a
conference: rehearse on the plane, present in a room with dead Wi-Fi. The app shell is
network-first, so any update you push shows up the moment you're back online; bump `VERSION`
in `sw.js` to force every browser to drop the old cache. The worker needs HTTPS or
`localhost`, same as the camera, so it simply stays dormant on `file://`. You can also
"Install" the page as a standalone app from the browser's address bar (`manifest.webmanifest`).

**`.nojekyll` is included** so GitHub Pages serves the files as-is rather than running them
through Jekyll. Keep it.

**Paths are case-sensitive** on GitHub Pages even if they aren't on your Mac. The slide files
are zero-padded lowercase — `slides/04.jpg`, not `slides/4.JPG`.

## Using it

| Key | Action |
|---|---|
| `Space` | Start / stop recording |
| `←` `→` | Previous / next slide |
| `F` | Flag the slide for review |
| `S` | Toggle shuffle |
| `Esc` | Close the playback window |

The record button sits in the fixed bottom bar and never scrolls away. One take per slide;
recording again replaces it. **Watch take** opens playback over the page, so you never lose
your place in the deck.

**The camera preview is draggable.** Grab it anywhere (except the ✕) and drop it wherever it's
least in the way — over dead space on a slide, off to one side. It's clamped to the window and
remembers where you left it. Works with a mouse or a finger.

**Play all** runs every recorded take back-to-back in **slide order** (1 → 43; unrecorded
slides are skipped). During a run the matching slide sits **beside the video**. Use the speed
menu (0.5×–2×) to listen faster or slower; `←` / `→` skip takes. **Download run** saves one
video with the **slide on the left and your take on the right** (encodes in real time — keep
the tab open). If the browser can't stitch that file, you get a zip of the takes in order.

**Timing is baked in.** Each slide carries a target length (the `len` field). While you
record, the timer turns amber the moment you run past that target. After you stop, the take
shows its actual length against the goal — `0:47 / 0:50 · 3s under` — so you can feel where
you rush and where you drag. The header shows the deck's total target runtime, and the
counter by the shortcuts (`12 / 43`) tracks how many slides you've recorded.

**Shuffle** is for memory work — it randomises the order so you're recalling the beat rather
than riding the sequence. Combine it with the filters: *Capture slides* drills the five you
must not narrate over, *Not yet recorded* shows what you still owe, and *Flagged for review*
is whatever you marked with `F`.

Flags persist in `localStorage`. Takes persist in IndexedDB.

## Updating the slides

If the deck changes, re-export the images at the same names:

```bash
soffice --headless --convert-to pdf deck.pptx
pdftoppm -jpeg -r 105 -jpegopt quality=82 deck.pdf s
# rename s-01.jpg → slides/01.jpg, etc.
```

Script text lives in `data.js` as plain JSON. Each slide has `items`, and consecutive lines
from the same speaker are grouped into one `say` run so the name is printed once, not before
every sentence. Stage directions are `do`, quiet reminders are `note`, and optional trims are
`cut`.
