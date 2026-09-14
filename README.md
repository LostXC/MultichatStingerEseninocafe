# Eseninocafe — Multichat Stingers

One overlay page (`index.html`) that hosts three stingers:

| Stinger | What it does | Assets |
|---|---|---|
| **Tip jar (bits)** | Jar intro animation, persistent bit gems, arc bit throws | `assets/tip-jar-stinger/`, `assets/gems/`, `assets/collision.js` |
| **Sub** | 500x600 paw-stamps-skull-card sequence @ 25fps, played over the jar | `assets/sub-stinger/sub-stinger.00.svg … .64.svg` |
| **Donation** | 400x400 sequence @ 25fps, overlaid exactly on the jar | `assets/donation-stinger/donation-stinger.00.svg … .34.svg` |

## Files

- `index.html` / `style.css` / `script.js` — the split-up overlay (no config page; everything auto-loads)
- `assets/tip-jar-stinger/stroke/` — the jar animation, 36 frames @ 400x400
  (`tip-jar.00–35.svg`, stroke-only export). `assets/tip-jar-stinger/fill/` is GENERATED
  from it (same paths, white fill + white stroke = the silhouette drawn behind the gems).
  If you replace the animation: drop new strokes in, then re-trace the walls into
  `assets/collision.js`. Frame count and canvas size are read from it — nothing to
  update in script.js.
- `assets/collision.js` — the traced jar geometry, as a JS global
  (`window.TIPJAR_COLLISION`) rather than JSON, because `fetch()` is blocked on
  `file://`. This is the only copy; edit it in place.
- `assets/vendor/matter.min.js` — local Matter.js, no CDN dependency
- `assets/sub-stinger/` — reprocessed from the original 1920x1080 export:
  whole scene mirrored (paw enters from the left), cropped to 500x600 bottom-anchored
  and centered on the skull card, with the skull card itself counter-flipped so it reads
  exactly as drawn (the original 1920x1080 export lives in this repo's git history)
- `assets/notes/` — the two music-note glyphs extracted from `music-effect.svg`
- All throw arcs, note arcs, gem and sub-stinger sizes were authored in the original
  500x650 mock space; `MAP` in script.js anchors them to the jar's final backBox, so
  they follow the art automatically whenever the animation changes size.

## Bits behaviour

- Count starts at **0** and is persisted in `localStorage` (`eseninocafe.tipjar.bits`) —
  reloads keep the jar filled. `defaultBits: 12` in `CFG` is the demo-fill amount.
- Thrown bits spawn one-by-one on the front bottom arc (bigger near the center = closer to
  camera, 124–134px), fly a cubic bezier over the rim, shrinking to 72px at the jar mouth.
  The three guide curves from `bit-throw-structure.svg` are interpolated with a quadratic
  Lagrange basis, so every spawn point gets a mathematically consistent arc.
- In flight a bit is pure animation on the front-most plane (it can't shove jar gems);
  physics takes over at 80% of the arc (`physicsHandoff`), just above the mouth, so the
  gem genuinely drops in, shoves the pile, and can bounce out — escapees land on the
  ground, rest ~3s, and fade away.
- Every landed bit pops a music note (75% eighth note, 25% quaver, extracted from
  `music-effect.svg`) that floats up one of the two side arcs — one at a time,
  alternating sides, scaling up and tilting as it goes, drawn behind the gems.
- Jar capacity is computed from the cup area vs gem size at boot (`computeJarCapacity`);
  `maxJarGems` in CFG is only the upper clamp. Beyond capacity the oldest gems are
  quietly culled. Gems that bounce/topple out land on the ground, rest ~3s, and fade.
- The collision walls are inset by the sprite/physics-circle difference
  (`GEM*OVERLAP/2`) so gems can't visually poke through the drawn walls, and the
  intro gems ride a rigid fit of the cup-floor arc (the 7-point wallSegments
  polyline — frame-stable and traced from the art, so no wobble and no lag; the
  smoothed backBox is only a fallback). Frame deltas are clamped to 100ms so an
  OBS-throttled source pauses the intro instead of teleporting it.

## Testing

Open `index.html` (any local server, or directly in OBS). Debug HUD: add `?debug` or press **H**.

- Keys: **T** throw 1 · **Y** throw 10 · **S** sub stinger · **D** donation · **R** replay intro
- URL params: `?debug` show HUD · `?bits=N` force the bit count (also overwrites the saved one)
- The HUD's number field + **Cheer** button runs the tier logic below with any amount.

## Cheer tiers

`stinger.cheer(amount)` decomposes a cheered bits amount into typed gem throws using
`CFG.bitTiers` (Twitch cheermote colors):

| Tier | Gem |
|---|---|
| 10000+ | red |
| 5000+ | blue |
| 1000+ | green |
| 100+ | purple |
| remainder (1–99) | 1x gray |

Biggest tier first, one gem per full tier amount, remainder flows down. Each
big-tier gem also brings a `flourish` — a shower of celebration bits (red +9,
blue +6, green +3; colors picked from `flourishColors`) so a 10000 cheer is a
whole volley, not one lonely red. Examples: `cheer(100)` → 1 purple ·
`cheer(1234)` → 1 green + 3-bit shower + 2 purple + 1 gray ·
`cheer(10000)` → 1 red + 9-bit shower. Total throws are clamped to
`maxQueuedThrows`. Edit thresholds/colors/flourish in `CFG.bitTiers` (sorted
biggest-first; the last entry is the remainder tier and always throws one).

## Streamer.bot

The page connects to Streamer.bot automatically on load and reacts live:

| Twitch event | Reaction |
|---|---|
| `Twitch.Cheer` | `stinger.cheer(bits)` — cheered amount fills the tip jar |
| `Twitch.Sub` / `Twitch.ReSub` / `Twitch.GiftSub` | `stinger.playSub()` — sub stinger |

The donation stinger is intentionally **not** wired to any event yet.

### OBS setup

1. In Streamer.bot, enable the WebSocket server (Servers/Clients → WebSocket Server,
   default `127.0.0.1:8080`). No actions or sub-actions needed — the overlay subscribes
   to the events itself.
2. Add a **Browser source** in OBS pointing at the deployed `index.html`, size **400x400**.
   Because OBS and Streamer.bot run on the same machine, the default `127.0.0.1:8080`
   just works — no config.

### Connection URL params (all optional)

| Param | Default | Purpose |
|---|---|---|
| `address` | `127.0.0.1` | Streamer.bot host |
| `port` | `8080` | Streamer.bot WebSocket port |
| `showCheers` | `true` | set `false` to ignore cheers |
| `showSubs` | `true` | set `false` to ignore subs |

The connection lives at the bottom of `script.js` (`connectStreamerbot`) and uses the
official [`@streamerbot/client`](https://unpkg.com/@streamerbot/client) loaded from a CDN
in `index.html`. It auto-reconnects, so start order between OBS and Streamer.bot doesn't
matter. If the client can't load (offline), the page still runs in manual/HUD mode.

### Chat overlay sync

The sibling chat overlay (`MultichatOverlayEseninocafe`) can fade itself out of the
way while a stinger plays and only show the alert card afterwards. The two are
**separate OBS browser sources** layered over each other, and OBS isolates browser
sources (no shared storage / messaging), so they don't talk to each other — instead
**both subscribe to the same Streamer.bot events and run halves of one fixed shared
timeline.** Since both receive an event at the same instant, they stay in lockstep.

On a sub/cheer: chat fades out → stinger fades in and plays → stinger fades out
exactly as the chat fades back in → the chat renders its alert card.

The shared timing lives in a `STINGER_SYNC` constant plus a `stingerContentMs()`
calculator, both **duplicated in both projects' `script.js` and kept logically
identical** (the `#stage` opacity transition here and the `#mainContainer`
transition in the overlay must match the fade values).

The on-screen time is **not fixed** — `stingerContentMs(kind, data)` computes how
long the stinger actually needs for each event, so the chat stays hidden exactly
that long and nothing gets cut off:

- **sub / resub / gift / bomb** → the frame-sequence length (`subFrames/fps` + a hold).
- **cheer** → depends on the bit amount: it mirrors the jar's own tier decomposition
  to get the number of gems thrown, then `intro + throws×stagger + last flight +
  settle`. A 100-bit cheer (1 gem) reserves ~3.4s; a 1234-bit cheer (6 gems) ~4.3s;
  a 9999-bit cheer (23 gems) ~7.2s. Both projects run the same formula on the same
  event, so they agree without talking to each other.

If you retune the jar (`CFG.throwStaggerMs`, `throwDurationMs`, `waitBeforeFadeMs`,
the frame count, `bitTiers`), update the mirrored numbers in `STINGER_SYNC` /
`stingerContentMs` in **both** `script.js` files so the windows still match.

Enable it from the overlay's settings page ("Enable Stingers"); this stinger source
needs no extra flag. The stinger always fades in/out regardless, so it also looks
fine on its own if the chat isn't set to coordinate.

Both connection handlers log to the console (open the page with `?debug`), e.g.
`[stinger] Twitch.Sub received → sub stinger, window 3450ms` — handy for confirming
whether Streamer.bot is actually delivering sub/cheer events.

### Trigger API

`window.stinger` is also callable directly (HUD, console, or a Streamer.bot
Execute-JS action if you ever want manual control):

```js
stinger.cheer(1234);            // cheered amount -> tiered gem throws
stinger.throwBits(5, 'red');    // raw throws; color optional (random if omitted)
stinger.playSub();              // sub stinger
stinger.playDonation();         // donation stinger (once frames exist)
stinger.replayIntro();
stinger.setBits(n); stinger.resetBits(); stinger.bits;
```
