# Writing a film spec

A film is a JSON spec: a cast, some scenes, and in each scene a list of beats played one after
another. Every voice, laugh, cough and heckle is synthesized by CHIMERA's physical model of a human
voice (lungs, vocal folds, tongue, lips), and every face on screen is that same model's x-ray head,
so the lip sync is exact. People are stick bodies with those heads, in line-drawn neon sets.

Workflow: `check_film` (fast: catches errors, mispronounced names, overlapping heads, gives the
length) → `film_stills` (see a few frames) → `render_film` (the MP4). Renders take roughly the
film's length again.

## Spec

```json
{
  "title": "Flatmates",
  "seed": 7,
  "captions": true,
  "cast": {
    "Tom":   { "voice": "man", "pitch": 120, "color": "blue", "build": "thin" },
    "Priya": { "voice": "woman", "expressive": 0.35, "color": "amber", "props": ["drink"] }
  },
  "pronounce": { "Priya": "pre ya" },
  "scenes": [
    {
      "set": "living-room",
      "people": [ { "who": "Priya", "pose": "sit", "x": 0.55 } ],
      "beats": [
        { "enter": "Tom", "side": "left", "to": 0.15 },
        { "say": "Tom", "text": "Did you pay the rent?" },
        { "say": "Priya", "text": "I thought you paid the rent.", "gap": 0.3 },
        { "crowd": "laugh" }
      ]
    }
  ]
}
```

### cast — name → person (every field optional)

| field | values | default |
|---|---|---|
| `voice` | `man` `woman` `boy` `girl` `old-man` `old-woman` | `man` |
| `pitch` | speaking pitch, Hz (60–450) | man 110, woman 200, boy 265, girl 290, old-man 100, old-woman 180 |
| `rate` | speed × (0.5–1.8) | 1 (old 0.85) |
| `expressive` | pitch movement on stressed words (0 flat … 0.6 sing-song) | 0.22 |
| `breathy` `rough` `creak` | voice quality (0–0.8, 0–0.8, 0–0.6) | per voice |
| `height` | body height × (0.4–1.3) | 1 (children 0.62) |
| `build` | `average` `thin` `round` (a belly) | `average` |
| `nervous` | 0–1: shaking knees, sweat | 0 |
| `stiff` | true: arms pinned to the sides | false |
| `props` | any of `mic-stand` `mic` `cards` `drink` `phone` `book` `crate` `briefcase` `newspaper` (`crate`: stands on a box) | none |
| `color` | `white` `blue` `amber` `red` `green` (body, captions, name tag) | `white` |

### pronounce — word → respelling

Names and slang missing from the dictionary are said as spelt and often come out wrong; `check_film`
lists them. Respell with ordinary words: `"Priya": "pre ya"`, `"mic": "mike"` (built in),
`"on": "awn"` (a full vowel where the dictionary reduces it). Check a respelling with `hear_line`.

### scenes

| field | meaning |
|---|---|
| `set` | `club` (stage, spotlight, mic stand, neon sign) `bar` `living-room` (couch) `kitchen` `office` `classroom` `newsroom` (desk in front) `hospital` (heart monitor) `street` (night) `park` (bench) `car` (driving, side view) `void` |
| `people` | who is in the scene at the start: `{ "who", "x": 0…1 across the stage, "pose": "stand"/"sit", "facing": "left"/"right", "offstage": true }`. x and facing are optional (spread out, facing each other). Anyone can also `enter` without being listed. |
| `audience` | `{ "seats": 2–12, "members": ["Heckler"] }`: a seated, visible audience in a room facing the stage; crowd reactions cut to it, and named members speak from their seats (the camera finds them). Without it, `crowd` beats are an unseen studio audience (a laugh track). |
| `camera` | `auto` (default: wide with one person or while anyone walks, medium on the speaker otherwise), `wide`, `follow` (always on the speaker) |
| `beats` | the scene's events in order (below) |

Heads are big: keep two people who face each other at least 0.4 apart in x (0.3 if they face the
same way); `check_film` warns otherwise. A sitting person in the living-room (0.24–0.78), park
(0.28–0.67), bar or car sits on the furniture; elsewhere they get a chair.

### beats — each does exactly one thing

| beat | example |
|---|---|
| say a line | `{ "say": "Tom", "text": "Did you pay the rent?", "mood": "nervous" }` |
| a body sound | `{ "do": "cough", "who": "Tom", "times": 2 }` — `cough` `laugh` `sigh` `gasp` `scream` `groan` `hmm` |
| the crowd | `{ "crowd": "laugh", "n": 12, "level": 0.8, "hold": 2.2 }` — `laugh` `one` (a single "ha") `groan` `aww` `woo` `who` ("who's there?") `cough` `gasp` `cheer` `boo` |
| wait | `{ "wait": 1.5 }` — silence is funny |
| walk on | `{ "enter": "Gary", "side": "left", "to": 0.4, "speed": 0.8 }` |
| walk off | `{ "exit": "Gary", "side": "right" }` |
| walk across | `{ "move": "Gary", "to": 0.7 }` |
| sit / stand | `{ "sit": "Tom" }` `{ "stand": "Tom" }` |
| turn | `{ "turn": "Tom", "facing": "left" }` |
| title card | `{ "card": "Episode one: the rent", "hold": 2.5 }` |

Every beat also takes `gap` (seconds before it starts; negative overlaps the beat before, e.g. a
heckle over the end of a line, or a crowd that woos while someone walks off) and `shot` (`wide`,
`close` on the speaker, `audience`, or a cast name for a reaction shot).

Moods: `neutral` `happy` `excited` `sad` `angry` `shout` `whisper` `nervous` `deadpan` `scared`.

Someone who speaks without being in the scene is heard as a voice-over (narrator), captioned
"NAME (V.O.)". Someone listed but offstage is heard off-camera.

## What works

- Short lines. Long speeches lose the pitch shape; break them into sentences with gaps.
- Comedy timing lives in `gap`, `wait` and crowd `hold`. Awkward silence, a single cough, a
  laugh that comes in late (`gap`), a heckle that cuts in (negative `gap`).
- Plain words. Punctuation shapes the intonation: `?` rises, `.` falls, `,` pauses.
- 30 s – 3 min. Rendering runs at about real time.
