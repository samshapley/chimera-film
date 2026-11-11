# chimera-film

Write a film as JSON; get an MP4 whose every voice, laugh, cough and heckle is synthesized by
[CHIMERA](https://github.com/jamesondh/chimera-vocal-synth)'s physical model of the human voice,
and whose every face is that same model's x-ray head (so the lip sync is exact), on stick bodies in
neon line-drawn sets. Behind an MCP server, so any agent can make one.

The voice engine and the head renderer are Jameson Hodge's CHIMERA (MIT), included as a submodule
pinned to a known commit. This repo adds the film engine, the film page, the MCP server and the
spec format.

```
GUIDE.md        the spec format (also what the film_guide tool returns)
engine/         Rust: spec → audio.wav + timeline.json (chimera-film check | render | line | ipa)
web/            the film page (film.html, film.ts): draws a timeline with CHIMERA's head renderer
mcp/server.ts   the MCP server (stdio)
examples/       open-mic.json, sitcom.json, interview.json
chimera/        CHIMERA (submodule)
out/            rendered films (git-ignored)
```

## Setup

Needs Rust (via rustup), [Bun](https://bun.sh) and git; ffmpeg for MP4 (`brew install ffmpeg`).

```bash
git clone --recurse-submodules <this repo> && cd chimera-film
./setup.sh
claude mcp add chimera-film -- bun "$PWD/mcp/server.ts"
```

Any other MCP client: `{"command": "bun", "args": ["<path>/mcp/server.ts"]}`.

Environment: `CHIMERA_DIR` (default `./chimera`), `FILM_OUT` (default `./out`), `FILM_PORT`
(default 5317; the server starts CHIMERA's Vite dev server there if nothing answers).

## Tools

| tool | what it does | time |
|---|---|---|
| `film_guide` | the spec format | — |
| `check_film` | validates and plans: errors, length, each line's timing and IPA, warnings (words said as spelt, overlapping heads, voice-overs) | < 1 s |
| `hear_line` | one line or body sound to a WAV, with its IPA | ~1 s |
| `film_stills` | frames at given times, as images | ~10 s for a 2-minute film |
| `render_film` | the film as a 1080p H.264 MP4 (or WebM) | about the film's length |

Try it without an agent: `cd mcp && bun test-client.ts ../examples/interview.json 5,20,40 the-interview`
checks the spec, saves three stills and renders `out/the-interview.mp4`.

## How it works

`chimera-film render` lays the beats end to end, synthesizes every voice in parallel (one
`HumanVoice` per line or crowd member, scheduled by CHIMERA's phoneme planner or, for coughs and
gasps, hand-built glottal gestures: a sealed glottis under lung pressure blown open), mixes them
(stage voices in their set's room, the crowd far back, voice-over dry), and records each speaker's
articulators at 100 Hz. The page replays those articulators through CHIMERA's anatomy renderer for
each face, puts the heads on stick bodies, cuts the camera (wide, the speaker, the audience) and
encodes with WebCodecs in headless Chromium; ffmpeg makes the MP4. Specs are cached by content, so
stills and renders of an unchanged spec skip the synthesis.

The page imports CHIMERA's own renderers, so the server copies `web/` into the CHIMERA checkout
and serves it from there with CHIMERA's Vite config.
