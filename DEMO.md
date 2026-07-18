# Motionaire — AI Editing Demo Script

A repeatable, ordered script. Every prompt below is verified working by the
e2e suite (the flagship is `dev:r1p5_flagship_test`, run on every `npm test`).

## Setup (once, ~2 minutes)

1. **Provider**: ⌘, → *AI — chat provider*. Pick **Anthropic** or **OpenAI**,
   paste your API key (it goes straight to the macOS keychain — the UI only
   ever knows *whether* one is saved), pick a model, hit **Test connection**.
   No key handy? Pick **Mock (offline)** — deterministic, free, and it runs
   this exact script's prompts 1, 2, and 6.
2. **Footage**: two clips work best — a screen recording on V1 and a webcam
   clip on V2 (fullscreen over it), each ≥ 50s. For a self-contained rig, the
   dev build generates a 60s pair (`spike_long_fixtures`).
3. Open the **AI assistant** from the left rail (speech-bubble icon).

## The script

Each prompt lands as ONE undo step — after any of them, ⌘Z (or the inline
"Undo this") reverts the whole thing. That's the trust model; show it early.

1. **"Cut the first 3 seconds"**
   Warm-up: ripple cut across all tracks, gap closed. Show the diff card,
   then click *Undo this* and run it again. Instant trust.

2. ★ **"From 0:10 to 0:45 shrink my face to 10%, rounded corners, bottom
   right, screen share fills the rest, then back to fullscreen."**
   THE demo. One sentence → 30 coordinated keyframes across both tracks
   (pip in at 0:10, hold, back to fullscreen at 0:45). Scrub across 0:10 —
   the move animates live in the preview. Point at the keyframe diamonds on
   the timeline: these are ordinary keyframes the user can drag in the graph
   editor. The AI edited the *document*, not the pixels.

3. **"Make that window start at 0:08 instead"** *(real provider)*
   Follow-up references "that window" — the conversation carries context.

4. **"Add a title that says "Welcome" at the start"**
   Text lands on the top track, styled, animated.

5. **"Add a dissolve between the first two clips and fade the audio in"**
   *(real provider)* Transitions + audio fade in one turn.

6. **"Add a title that says "Thanks for watching""**
   (Mock-safe variant of 4 — use when offline.)

7. **Export** — File ▸ Export, or ask: the pip edit survives to the file.
   `dev:r1p5_flagship_test` proves this on every suite run by exporting
   28–32s and probing the result.

## Evidence from the automated run

- `FLAGSHIP-app.png` — the typed prompt, the diff cards ("pip layout at
  10.00s … 20 keyframes on 2 clips"), the preview at 0:30 showing the
  rounded 10% pip bottom-right, and the keyframe diamonds on both tracks.
- `FLAGSHIP-exported-frame.png` — a frame extracted from the exported MP4:
  the same composition, surviving in the encoded file.

## Notes for the presenter

- Every AI edit uses the same store mutations as the UI: locked tracks
  refuse politely, collisions reject, times frame-snap.
- If a prompt fails (rate limit, bad key), the real provider error renders
  in the chat — fix the key in ⌘, and resend; the conversation survives.
- Chat history persists in the project bundle (`history.jsonl`) and reloads
  with the project.
