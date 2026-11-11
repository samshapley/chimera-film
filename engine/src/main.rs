//! chimera-film: a movie spec in, every sound of it out of the CHIMERA voice engine.
//!
//! `chimera-film check <spec.json>`          validate and plan (no audio): JSON report on stdout
//! `chimera-film render <spec.json> <dir>`   <dir>/audio.wav and <dir>/timeline.json (what the picture is drawn from)
//! `chimera-film line <spec.json> <who> <text> <out.wav> [mood]`   one line, to hear a voice or a word
//! `chimera-film ipa <text>…`                what the dictionary makes of some words

use chimera::anatomy::human::{ArticKey, BodyMix};
use chimera::control::score::{ControlKey, Gesture, Targets};
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::planner::{PhraseInput, PlanOptions, plan_phrases};
use chimera::voice::human_voice::{HumanVoice, SourcePatch, VoiceTelemetry};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Read;

const FS: f64 = 48000.0;
const HOP: usize = 480; // articulator frames at 100 Hz

/// sets and how much room each one's voices carry
const SETS: &[(&str, f32)] = &[
    ("club", 0.22), ("bar", 0.18), ("living-room", 0.1), ("kitchen", 0.12), ("office", 0.12), ("classroom", 0.16),
    ("newsroom", 0.07), ("hospital", 0.14), ("street", 0.05), ("park", 0.04), ("car", 0.03), ("void", 0.2),
];
const ACTS: &[&str] = &["cough", "laugh", "sigh", "gasp", "scream", "groan", "hmm"];
/// crowd reactions: kind, default people, level, how long the scene waits (s)
const CROWDS: &[(&str, usize, f64, f64)] = &[
    ("laugh", 12, 0.8, 2.2), ("one", 1, 0.6, 0.9), ("groan", 5, 0.6, 1.4), ("aww", 8, 0.7, 1.5), ("woo", 2, 0.5, 1.2),
    ("who", 8, 0.8, 1.1), ("cough", 1, 0.5, 1.4), ("gasp", 7, 0.7, 1.0), ("cheer", 9, 0.8, 2.0), ("boo", 7, 0.7, 1.8),
];
const MOODS: &[&str] = &["neutral", "happy", "excited", "sad", "angry", "shout", "whisper", "nervous", "deadpan", "scared"];
const VOICES: &[&str] = &["man", "woman", "boy", "girl", "old-man", "old-woman"];
const COLORS: &[&str] = &["white", "blue", "amber", "red", "green"];
const PROPS: &[&str] = &["mic-stand", "mic", "cards", "drink", "phone", "book", "crate", "briefcase", "newspaper"];
const BUILDS: &[&str] = &["average", "thin", "round"];
const CAMERAS: &[&str] = &["auto", "wide", "follow"];

// ---------------------------------------------------------------- the spec

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Spec {
    title: Option<String>,
    seed: Option<u64>,
    captions: Option<bool>,
    cast: BTreeMap<String, CastSpec>,
    #[serde(default)]
    pronounce: BTreeMap<String, String>,
    scenes: Vec<SceneSpec>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct CastSpec {
    voice: Option<String>,
    pitch: Option<f64>,
    rate: Option<f64>,
    breathy: Option<f64>,
    rough: Option<f64>,
    creak: Option<f64>,
    expressive: Option<f64>,
    height: Option<f64>,
    build: Option<String>,
    nervous: Option<f64>,
    stiff: Option<bool>,
    #[serde(default)]
    props: Vec<String>,
    color: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SceneSpec {
    set: String,
    #[serde(default)]
    people: Vec<Place>,
    audience: Option<AudienceSpec>,
    camera: Option<String>,
    beats: Vec<Beat>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Place {
    who: String,
    pose: Option<String>,
    x: Option<f64>,
    facing: Option<String>,
    #[serde(default)]
    offstage: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AudienceSpec {
    seats: Option<usize>,
    #[serde(default)]
    members: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Beat {
    say: Option<String>,
    text: Option<String>,
    mood: Option<String>,
    #[serde(rename = "do")]
    act: Option<String>,
    who: Option<String>,
    times: Option<usize>,
    crowd: Option<String>,
    n: Option<usize>,
    level: Option<f64>,
    hold: Option<f64>,
    wait: Option<f64>,
    enter: Option<String>,
    exit: Option<String>,
    #[serde(rename = "move")]
    mov: Option<String>,
    to: Option<f64>,
    side: Option<String>,
    speed: Option<f64>,
    sit: Option<String>,
    stand: Option<String>,
    turn: Option<String>,
    facing: Option<String>,
    card: Option<String>,
    gap: Option<f64>,
    shot: Option<String>,
}

// ---------------------------------------------------------------- voices

#[derive(Clone)]
struct Person {
    mix: (f64, f64),
    f0: f64,
    rate: f64,
    accent: f64,
    breath: f64,
    rough: f64,
    fry: f64,
    pressure: f64,
    voiced: bool,
}

fn person(name: &str, c: &CastSpec) -> Result<Person, String> {
    let v = c.voice.as_deref().unwrap_or("man");
    let (mix, f0, rate, breath, rough) = match v {
        "man" => ((0.0, 0.0), 110.0, 1.0, 0.12, 0.08),
        "woman" => ((1.0, 0.0), 200.0, 1.0, 0.15, 0.06),
        "boy" => ((0.0, 1.0), 265.0, 1.0, 0.15, 0.05),
        "girl" => ((1.0, 1.0), 290.0, 1.0, 0.15, 0.05),
        "old-man" => ((0.0, 0.0), 100.0, 0.85, 0.25, 0.3),
        "old-woman" => ((1.0, 0.0), 180.0, 0.85, 0.3, 0.28),
        _ => return Err(format!("cast \"{name}\": voice \"{v}\" is not one of {VOICES:?}")),
    };
    let r = |x: Option<f64>, lo: f64, hi: f64, d: f64, what: &str| -> Result<f64, String> {
        match x {
            None => Ok(d),
            Some(x) if x.is_finite() && x >= lo && x <= hi => Ok(x),
            Some(x) => Err(format!("cast \"{name}\": {what} {x} is outside {lo}…{hi}")),
        }
    };
    Ok(Person {
        mix,
        f0: r(c.pitch, 60.0, 450.0, f0, "pitch")?,
        rate: r(c.rate, 0.5, 1.8, rate, "rate")?,
        accent: r(c.expressive, 0.0, 0.6, 0.22, "expressive")?,
        breath: r(c.breathy, 0.0, 0.8, breath, "breathy")?,
        rough: r(c.rough, 0.0, 0.8, rough, "rough")?,
        fry: r(c.creak, 0.0, 0.6, 0.0, "creak")?,
        pressure: 8.0,
        voiced: true,
    })
}

fn moody(p: &Person, mood: &str) -> Person {
    let mut q = p.clone();
    match mood {
        "happy" => { q.f0 *= 1.12; q.rate *= 1.05; q.accent += 0.12; }
        "excited" => { q.f0 *= 1.25; q.rate *= 1.15; q.accent += 0.25; q.pressure *= 1.3; }
        "sad" => { q.f0 *= 0.9; q.rate *= 0.8; q.breath += 0.15; q.accent *= 0.4; }
        "angry" => { q.f0 *= 1.1; q.rate *= 1.05; q.rough += 0.15; q.pressure *= 1.5; q.accent += 0.1; }
        "shout" => { q.f0 *= 1.35; q.pressure *= 2.0; q.accent += 0.2; q.rate *= 0.95; }
        "whisper" => { q.voiced = false; q.pressure *= 0.7; q.breath = 0.6; }
        "nervous" => { q.rate *= 1.15; q.f0 *= 1.08; q.breath += 0.1; }
        "deadpan" => { q.accent = 0.02; q.rate *= 0.95; q.f0 *= 0.97; }
        "scared" => { q.f0 *= 1.2; q.rate *= 1.2; q.breath += 0.2; }
        _ => {}
    }
    q
}

struct Clip {
    out: Vec<f32>,
    frames: Vec<Vec<f32>>,
    dur: f64,
    ipa: String,
}

/// a voice set up and scheduled, not yet run
struct Prepared {
    voice: HumanVoice,
    end: f64,
    ipa: String,
}

fn voice_for(p: &Person) -> (BodyMix, HumanVoice) {
    let mix = BodyMix::new(p.mix.0, p.mix.1);
    let mut voice = HumanVoice::new(FS, mix.body(), 2);
    voice.set_source(&SourcePatch::f0(p.f0));
    voice.set_source(&SourcePatch { breathiness: Some(p.breath.min(0.9)), roughness: Some(p.rough.min(0.9)), fry: Some(p.fry), pressure: Some(p.pressure), voiced: Some(p.voiced), ..Default::default() });
    (mix, voice)
}

/// respell words the dictionary gets wrong (the spec's table over the built-in one), keeping punctuation
fn respell(text: &str, pron: &BTreeMap<String, String>) -> String {
    let (mut out, mut word) = (String::new(), String::new());
    let flush = |w: &mut String, out: &mut String| {
        if !w.is_empty() {
            let k = w.to_lowercase();
            out.push_str(pron.iter().find(|(kk, _)| kk.to_lowercase() == k).map(|(_, s)| s.as_str()).unwrap_or(match k.as_str() { "mic" => "mike", "mics" => "mikes", _ => w.as_str() }));
            w.clear();
        }
    };
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '\'' || ch == '’' {
            word.push(ch);
        } else {
            flush(&mut word, &mut out);
            out.push(ch);
        }
    }
    flush(&mut word, &mut out);
    out
}

fn plan_speech(g: &EnglishG2P, pron: &BTreeMap<String, String>, p: &Person, text: &str) -> Prepared {
    let (mix, mut voice) = voice_for(p);
    let phrases = g.to_phrases(&respell(text, pron));
    let ipa = phrases.iter().map(|p| p.segments.iter().map(|s| s.ipa.clone()).collect::<String>()).collect::<Vec<_>>().join(" | ");
    let inputs: Vec<PhraseInput> = phrases.iter().map(|p| PhraseInput { segments: p.segments.clone(), intonation: Some(p.intonation), pause: Some(p.pause) }).collect();
    let plan = plan_phrases(&inputs, &PlanOptions { body: mix, t0: 0.05, f0: Some(p.f0), rate: Some(p.rate), accent: Some(p.accent.min(0.6)), ..Default::default() });
    voice.schedule(&plan.gestures);
    Prepared { voice, end: plan.end, ipa }
}

/// the articulator targets of a vowel, to hold the mouth open through a cough or a gasp
fn mouth(g: &EnglishG2P, mix: BodyMix, p: &Person, vowel: &str) -> Targets {
    let phrases = g.to_phrases(vowel);
    let inputs: Vec<PhraseInput> = phrases.iter().map(|p| PhraseInput { segments: p.segments.clone(), intonation: Some(p.intonation), pause: Some(p.pause) }).collect();
    let plan = plan_phrases(&inputs, &PlanOptions { body: mix, t0: 0.05, f0: Some(p.f0), rate: Some(1.0), ..Default::default() });
    let mut m = Targets::default();
    for ge in &plan.gestures {
        for (k, x) in ge.targets.iter() {
            if matches!(k, ControlKey::Artic(_)) {
                m.set(k, x);
            }
        }
    }
    m
}

fn one(k: ControlKey, x: f64) -> Targets {
    Targets::default().with(k, x)
}

/// A cough as the body does it: a quick breath in, the glottis sealed while the lungs press against
/// it (~35 cmH2O), the seal blown open (turbulent air through wide-open folds), then the folds falling
/// back together into a short, rough, falling voiced grunt. One per level in `levels`.
fn plan_cough(g: &EnglishG2P, p: &Person, levels: &[f64]) -> Prepared {
    let (mix, mut voice) = voice_for(p);
    let k2 = mix.body().scale * mix.body().scale;
    voice.set_source(&SourcePatch { pressure: Some(34.0), roughness: Some(0.8), tension: Some(0.75), breathiness: Some(0.35), fry: Some(0.0), drift: Some(30.0), voiced: Some(true), ..Default::default() });
    voice.glottis.params.chaos = 0.45;
    voice.airway.noise_gain.glottis *= 10.0;
    let m = mouth(g, mix, p, "uh");
    let mut gs = vec![
        Gesture::new(0.02, 0.26, 0.04, 0.03, 6.0, one(ControlKey::ABDUCTION, 0.45 * k2)),
        Gesture::new(0.03, 0.24, 0.05, 0.04, 2.0, one(ControlKey::BREATH, -0.1)),
    ];
    let mut at = 0.44;
    for (i, lv) in levels.iter().enumerate() {
        gs.push(Gesture::new(at - 0.14, at, 0.02, 0.003, 8.0, one(ControlKey::CLOSURE, 1.0)));
        gs.push(Gesture::new(at - 0.11, at + 0.03 + 0.05 * lv, 0.03, 0.11, 2.0, one(ControlKey::BREATH, *lv)));
        gs.push(Gesture::new(at - 0.002, at + 0.03 + 0.02 * lv, 0.003, 0.05, 6.0, one(ControlKey::ABDUCTION, 0.6 * k2)));
        gs.push(Gesture::new(at, at + 0.1, 0.01, 0.05, 3.0, one(ControlKey::F0, p.f0 * 1.5)));
        gs.push(Gesture::new(at + 0.1, at + 0.35, 0.05, 0.05, 3.0, one(ControlKey::F0, p.f0 * 0.75)));
        at += 0.3 + 0.1 * lv + if i == 0 { 0.04 } else { 0.0 };
    }
    let end = at + 0.1;
    let mut mg = Gesture::new(0.0, end, 0.05, 0.12, 3.0, m);
    mg.targets.set(ControlKey::Artic(ArticKey::Jaw), m.get(ControlKey::Artic(ArticKey::Jaw)).unwrap_or(0.5));
    gs.push(mg);
    voice.schedule(&gs);
    Prepared { voice, end, ipa: "(cough)".into() }
}

/// A gasp: folds flung open and air pulled in hard through an open mouth (an ingressive breath).
fn plan_gasp(g: &EnglishG2P, p: &Person, strength: f64) -> Prepared {
    let (mix, mut voice) = voice_for(p);
    let k2 = mix.body().scale * mix.body().scale;
    voice.airway.noise_gain.glottis *= 6.0;
    let m = mouth(g, mix, p, "ah");
    let gs = vec![
        Gesture::new(0.04, 0.42, 0.03, 0.08, 6.0, one(ControlKey::ABDUCTION, 0.55 * k2)),
        Gesture::new(0.06, 0.36, 0.03, 0.1, 3.0, one(ControlKey::BREATH, -0.45 * strength)),
        Gesture::new(0.0, 0.55, 0.05, 0.12, 3.0, m),
    ];
    voice.schedule(&gs);
    Prepared { voice, end: 0.55, ipa: "(gasp)".into() }
}

fn plan_act(g: &EnglishG2P, pron: &BTreeMap<String, String>, p: &Person, act: &str, times: usize) -> Prepared {
    let times = times.max(1);
    let mut q = p.clone();
    match act {
        "cough" => {
            let lv = [1.0, 0.65, 0.5, 0.45, 0.6, 0.4];
            return plan_cough(g, p, &lv[..times.min(lv.len())]);
        }
        "gasp" => return plan_gasp(g, p, 1.0),
        "laugh" => {
            q.rate = 1.9;
            q.f0 *= 1.25;
            let t = vec!["ha"; 3 + 2 * times].join(" ");
            plan_speech(g, pron, &q, &t)
        }
        "sigh" => {
            q.rate = 0.35;
            q.breath = 0.6;
            q.f0 *= 0.85;
            plan_speech(g, pron, &q, "Hah.")
        }
        "scream" => {
            q.f0 *= 2.3;
            q.pressure *= 2.2;
            q.rough += 0.2;
            q.rate = 0.25;
            plan_speech(g, pron, &q, "Ah!")
        }
        "groan" => {
            q.rate = 0.35;
            q.f0 *= 0.8;
            plan_speech(g, pron, &q, "Ugh.")
        }
        _ => {
            q.rate = 0.5;
            plan_speech(g, pron, &q, "Hmm.")
        }
    }
}

fn run(prep: Prepared, track: bool) -> Clip {
    let Prepared { mut voice, end, ipa } = prep;
    let total = (FS * (end + 0.3)).round() as usize;
    let mut out = vec![0f32; total];
    let mut frames = Vec::new();
    let mut t = VoiceTelemetry::default();
    for chunk in out.chunks_mut(HOP) {
        for b in chunk.chunks_mut(128) {
            voice.render(b);
        }
        if track {
            voice.telemetry(&mut t);
            frames.push(ArticKey::ALL.iter().map(|k| ((voice.artic.x.get(*k) * 1e3).round() / 1e3) as f32).collect());
        }
    }
    Clip { out, frames, dur: end, ipa }
}

struct Rng(u64);
impl Rng {
    fn f(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) as f64) / (1u64 << 31) as f64
    }
    fn r(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.f()
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[(self.f() * xs.len() as f64) as usize % xs.len()]
    }
}

/// What a member of a crowd says for a reaction, and when after it starts.
enum Utter {
    Speech(String),
    Act(&'static str, usize),
}

fn member(kind: &str, rng: &mut Rng) -> (Person, Utter, f64, f64, f64) {
    let female = rng.f() < 0.45;
    let mut p = Person {
        mix: (if female { rng.r(0.7, 1.0) } else { rng.r(0.0, 0.3) }, rng.r(0.0, 0.12)),
        f0: if female { rng.r(175.0, 250.0) } else { rng.r(92.0, 150.0) },
        rate: 1.0,
        accent: rng.r(0.1, 0.35),
        breath: rng.r(0.15, 0.5),
        rough: rng.r(0.05, 0.3),
        fry: 0.0,
        pressure: 8.0,
        voiced: true,
    };
    let pan = rng.r(-0.9, 0.9);
    let s = |x: &str| Utter::Speech(x.to_string());
    let (u, delay) = match kind {
        "laugh" => {
            p.rate = rng.r(1.5, 2.3);
            p.f0 *= rng.r(1.1, 1.5);
            let a = rng.pick(&["ha ha ha ha ha ha", "ha ha ha ha", "he he he he he", "ah ha ha ha ha", "ho ho ho ho", "ha ha ha ha ha ha ha ha"]);
            let b = rng.pick(&["", ". Ha ha ha ha.", ". He he he.", ". Ah ha ha ha ha ha."]);
            (s(&format!("{a}{b}")), rng.r(0.0, 0.7))
        }
        "one" => {
            p.rate = 0.9;
            (s("Ha."), 0.0)
        }
        "groan" => {
            p.rate = rng.r(0.3, 0.45);
            p.f0 *= 0.85;
            (s(rng.pick(&["Oh.", "Aw.", "Oh no.", "Ugh."])), rng.r(0.0, 0.35))
        }
        "aww" => {
            p.rate = rng.r(0.28, 0.4);
            p.f0 *= 1.15;
            (s("Aw."), rng.r(0.0, 0.3))
        }
        "woo" => {
            p.rate = rng.r(0.35, 0.5);
            p.f0 *= 1.6;
            (s("Woo."), rng.r(0.0, 0.3))
        }
        "who" => {
            p.rate = rng.r(0.8, 1.0);
            (s("Who's there?"), rng.r(0.0, 0.18))
        }
        "cheer" => {
            p.rate = rng.r(0.5, 0.8);
            p.f0 *= rng.r(1.3, 1.7);
            p.pressure = 14.0;
            (s(rng.pick(&["Yeah!", "Woo!", "Yes!", "Woo hoo!", "Yeah! Woo!"])), rng.r(0.0, 0.5))
        }
        "boo" => {
            p.rate = rng.r(0.3, 0.45);
            p.f0 *= 0.95;
            (s(rng.pick(&["Boo.", "Boo boo.", "Boo."])), rng.r(0.0, 0.5))
        }
        "gasp" => (Utter::Act("gasp", 1), rng.r(0.0, 0.15)),
        _ => {
            let n = [1, 2, 2, 3][(rng.f() * 4.0) as usize % 4];
            (Utter::Act("cough", n), 0.0)
        }
    };
    (p, u, delay, rng.r(0.6, 1.0), pan)
}

// ---------------------------------------------------------------- timing

#[derive(Clone, Copy, PartialEq)]
enum Bus {
    Stage,
    Crowd,
    Dry,
}

struct Job {
    p: Person,
    utter: Utter,
    at: f64,
    gain: f64,
    pan: f64,
    bus: Bus,
    wet: f32,
    ev: usize,
    track: bool,
    member: bool,
}

#[derive(Clone)]
struct Who {
    x: f64,
    pose: String,
    facing: String,
    on: bool,
    /// facing chosen by the film (turns toward the others as people come and go), not the spec
    auto: bool,
}

enum Kind {
    Line { who: String, text: String, act: Option<String>, place: &'static str },
    Crowd { kind: String, n: usize, hold: f64, visible: bool },
    Wait(f64),
    Move { who: String, from: f64, to: f64, dur: f64, facing: String, after: String, on_after: bool },
    Pose { who: String, pose: String },
    Turn { who: String, facing: String },
    Card { text: String, hold: f64 },
}

struct Ev {
    scene: usize,
    kind: Kind,
    gap: f64,
    shot: Option<String>,
}

struct Film {
    spec: Spec,
    people: BTreeMap<String, Person>,
    evs: Vec<Ev>,
    jobs: Vec<Job>,
    scenes: Vec<Value>,
    scene_start: Vec<BTreeMap<String, Who>>,
    errors: Vec<String>,
    warnings: Vec<String>,
}

/// heads are big: two people facing each other need ~0.4 of the stage between them
fn spacing(st: &BTreeMap<String, Who>, at: &str, warnings: &mut Vec<String>) {
    let on: Vec<(&String, &Who)> = st.iter().filter(|(_, w)| w.on && (-0.05..=1.05).contains(&w.x)).collect();
    for (i, (a, wa)) in on.iter().enumerate() {
        for (b, wb) in &on[i + 1..] {
            let (l, r, wl, wr) = if wa.x <= wb.x { (a, b, wa, wb) } else { (b, a, wb, wa) };
            let d = wr.x - wl.x;
            let need = if wl.facing == "right" && wr.facing == "left" { 0.4 } else if wl.facing == "left" && wr.facing == "right" { 0.2 } else { 0.3 };
            if d + 1e-9 < need {
                warnings.push(format!("{at}: {l} and {r} are {d:.2} apart, so their heads overlap (keep them {need} apart)"));
            }
        }
    }
}

fn side_x(side: &str) -> f64 {
    if side == "right" { 1.15 } else { -0.15 }
}

fn face_toward(st: &BTreeMap<String, Who>, who: &str, x: f64, dflt: &str) -> String {
    let others: Vec<f64> = st.iter().filter(|(k, w)| k.as_str() != who && w.on).map(|(_, w)| w.x).collect();
    if others.is_empty() {
        return dflt.to_string();
    }
    let c = others.iter().sum::<f64>() / others.len() as f64;
    if c >= x { "right".into() } else { "left".into() }
}

fn build(spec: Spec) -> Film {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut people = BTreeMap::new();
    for (name, c) in &spec.cast {
        match person(name, c) {
            Ok(p) => {
                people.insert(name.clone(), p);
            }
            Err(e) => errors.push(e),
        }
        if let Some(b) = &c.build { if !BUILDS.contains(&b.as_str()) { errors.push(format!("cast \"{name}\": build \"{b}\" is not one of {BUILDS:?}")); } }
        if let Some(col) = &c.color { if !COLORS.contains(&col.as_str()) { errors.push(format!("cast \"{name}\": color \"{col}\" is not one of {COLORS:?}")); } }
        for pr in &c.props { if !PROPS.contains(&pr.as_str()) { errors.push(format!("cast \"{name}\": prop \"{pr}\" is not one of {PROPS:?}")); } }
        if let Some(h) = c.height { if !(0.4..=1.3).contains(&h) { errors.push(format!("cast \"{name}\": height {h} is outside 0.4…1.3")); } }
    }
    let known = |w: &str, errors: &mut Vec<String>, at: &str| -> bool {
        if spec.cast.contains_key(w) { true } else { errors.push(format!("{at}: \"{w}\" is not in the cast ({:?})", spec.cast.keys().collect::<Vec<_>>())); false }
    };
    let mut rng = Rng(spec.seed.unwrap_or(7));
    let mut evs = Vec::new();
    let mut jobs = Vec::new();
    let mut scenes = Vec::new();
    let mut scene_start = Vec::new();
    if spec.scenes.is_empty() {
        errors.push("the spec has no scenes".into());
    }
    for (si, sc) in spec.scenes.iter().enumerate() {
        let at = format!("scene {}", si + 1);
        let wet = match SETS.iter().find(|s| s.0 == sc.set) {
            Some(s) => s.1,
            None => {
                errors.push(format!("{at}: set \"{}\" is not one of {:?}", sc.set, SETS.iter().map(|s| s.0).collect::<Vec<_>>()));
                0.1
            }
        };
        if let Some(c) = &sc.camera { if !CAMERAS.contains(&c.as_str()) { errors.push(format!("{at}: camera \"{c}\" is not one of {CAMERAS:?}")); } }
        // who is where at the start
        let mut st: BTreeMap<String, Who> = BTreeMap::new();
        let on: Vec<&Place> = sc.people.iter().filter(|p| !p.offstage).collect();
        let n = on.len();
        let mut k = 0;
        for p in &sc.people {
            if !known(&p.who, &mut errors, &at) { continue; }
            let x = p.x.unwrap_or_else(|| {
                if p.offstage { return -0.15; }
                let x = if n <= 1 { 0.45 } else { let (a, b) = if n >= 4 { (0.15, 0.85) } else { (0.25, 0.75) }; a + (b - a) * k as f64 / (n - 1) as f64 };
                k += 1;
                x
            });
            let pose = p.pose.clone().unwrap_or("stand".into());
            if pose != "stand" && pose != "sit" { errors.push(format!("{at}: {}'s pose \"{pose}\" is not stand or sit", p.who)); }
            st.insert(p.who.clone(), Who { x, pose, facing: String::new(), on: !p.offstage, auto: p.facing.is_none() });
        }
        let only = st.values().filter(|w| w.on).count() <= 1;
        for p in &sc.people {
            if let Some(w) = st.get(&p.who).cloned() {
                let f = match &p.facing {
                    Some(f) if f == "left" || f == "right" => f.clone(),
                    Some(f) => { errors.push(format!("{at}: facing \"{f}\" is not left or right")); "right".into() }
                    None if only => "right".into(),
                    None => face_toward(&st, &p.who, w.x, if w.x < 0.5 { "right" } else { "left" }),
                };
                st.get_mut(&p.who).unwrap().facing = f;
            }
        }
        let audience = sc.audience.as_ref();
        let members: Vec<String> = audience.map(|a| a.members.clone()).unwrap_or_default();
        for m in &members { known(m, &mut errors, &at); }
        let seats = audience.map(|a| a.seats.unwrap_or(8).clamp(members.len().max(2), 12)).unwrap_or(0);
        let start = st.clone();
        spacing(&st, &format!("{at} start"), &mut warnings);
        for (bi, b) in sc.beats.iter().enumerate() {
            let at = format!("scene {} beat {}", si + 1, bi + 1);
            let gap = b.gap.unwrap_or(0.0);
            let shot = b.shot.clone();
            let actions = [b.say.is_some(), b.act.is_some(), b.crowd.is_some(), b.wait.is_some(), b.enter.is_some(), b.exit.is_some(), b.mov.is_some(), b.sit.is_some(), b.stand.is_some(), b.turn.is_some(), b.card.is_some()].iter().filter(|x| **x).count();
            if actions != 1 {
                errors.push(format!("{at}: a beat does exactly one of say, do, crowd, wait, enter, exit, move, sit, stand, turn, card (this one has {actions})"));
                continue;
            }
            if let Some(s) = &shot {
                if !["wide", "close", "audience"].contains(&s.as_str()) && !spec.cast.contains_key(s) {
                    errors.push(format!("{at}: shot \"{s}\" is not wide, close, audience or a cast name"));
                }
            }
            let ev = evs.len();
            let mut place_of = |who: &str, st: &BTreeMap<String, Who>| -> (&'static str, Bus, f64, f64) {
                match st.get(who) {
                    Some(w) if w.on => ("stage", Bus::Stage, (w.x - 0.5) * 0.5, 1.0),
                    Some(w) => ("off", Bus::Stage, if w.x > 0.5 { 0.8 } else { -0.8 }, 0.55),
                    None if members.iter().any(|m| m == who) => ("audience", Bus::Crowd, 0.6, 0.85),
                    None => { let _ = &mut rng; ("voiceover", Bus::Dry, 0.0, 0.9) }
                }
            };
            if let Some(who) = &b.say {
                if !known(who, &mut errors, &at) { continue; }
                let Some(text) = b.text.clone().filter(|t| !t.trim().is_empty()) else { errors.push(format!("{at}: say needs text")); continue };
                let mood = b.mood.clone().unwrap_or("neutral".into());
                if !MOODS.contains(&mood.as_str()) { errors.push(format!("{at}: mood \"{mood}\" is not one of {MOODS:?}")); }
                let (place, bus, pan, gain) = place_of(who, &st);
                let p = moody(&people.get(who).cloned().unwrap_or(person("x", &CastSpec::default()).unwrap()), &mood);
                jobs.push(Job { p, utter: Utter::Speech(text.clone()), at: 0.0, gain, pan, bus, wet, ev, track: place != "voiceover", member: false });
                evs.push(Ev { scene: si, kind: Kind::Line { who: who.clone(), text, act: None, place }, gap, shot });
            } else if let Some(act) = &b.act {
                let Some(who) = &b.who else { errors.push(format!("{at}: do needs who")); continue };
                if !known(who, &mut errors, &at) { continue; }
                let Some(a) = ACTS.iter().find(|a| **a == act.as_str()) else { errors.push(format!("{at}: do \"{act}\" is not one of {ACTS:?}")); continue };
                let (place, bus, pan, gain) = place_of(who, &st);
                let p = people.get(who).cloned().unwrap_or(person("x", &CastSpec::default()).unwrap());
                jobs.push(Job { p, utter: Utter::Act(a, b.times.unwrap_or(if *a == "cough" { 2 } else { 1 })), at: 0.0, gain, pan, bus, wet, ev, track: place != "voiceover", member: false });
                evs.push(Ev { scene: si, kind: Kind::Line { who: who.clone(), text: String::new(), act: Some(a.to_string()), place }, gap, shot });
            } else if let Some(kind) = &b.crowd {
                let Some(c) = CROWDS.iter().find(|c| c.0 == kind.as_str()) else { errors.push(format!("{at}: crowd \"{kind}\" is not one of {:?}", CROWDS.iter().map(|c| c.0).collect::<Vec<_>>())); continue };
                let n = b.n.unwrap_or(c.1).clamp(1, 30);
                let level = b.level.unwrap_or(c.2).clamp(0.05, 1.5);
                for _ in 0..n {
                    let (p, utter, delay, gg, pan) = member(c.0, &mut rng);
                    jobs.push(Job { p, utter, at: delay, gain: gg * level * 0.5 / (n as f64).sqrt().max(1.0), pan, bus: Bus::Crowd, wet, ev, track: seats > 0, member: true });
                }
                evs.push(Ev { scene: si, kind: Kind::Crowd { kind: c.0.into(), n, hold: b.hold.unwrap_or(c.3), visible: seats > 0 }, gap, shot });
            } else if let Some(w) = b.wait {
                evs.push(Ev { scene: si, kind: Kind::Wait(w.clamp(0.0, 30.0)), gap, shot });
            } else if let Some(card) = &b.card {
                evs.push(Ev { scene: si, kind: Kind::Card { text: card.clone(), hold: b.hold.unwrap_or(2.5).clamp(0.5, 15.0) }, gap, shot });
            } else if b.enter.is_some() || b.exit.is_some() || b.mov.is_some() {
                let who = b.enter.as_ref().or(b.exit.as_ref()).or(b.mov.as_ref()).unwrap().clone();
                if !known(&who, &mut errors, &at) { continue; }
                let side = b.side.clone().unwrap_or_default();
                if !side.is_empty() && side != "left" && side != "right" { errors.push(format!("{at}: side \"{side}\" is not left or right")); }
                let cur = st.get(&who).cloned();
                let (from, to, on_after) = if b.enter.is_some() {
                    let from = if cur.as_ref().is_some_and(|w| !w.on) && side.is_empty() { cur.as_ref().unwrap().x } else { side_x(if side.is_empty() { "left" } else { &side }) };
                    (from, b.to.unwrap_or(0.5), true)
                } else if b.exit.is_some() {
                    let Some(w) = cur.as_ref().filter(|w| w.on) else { errors.push(format!("{at}: {who} is not on stage to exit")); continue };
                    let s = if side.is_empty() { if w.x > 0.5 { "right" } else { "left" } } else { &side };
                    (w.x, side_x(s), false)
                } else {
                    let Some(w) = cur.as_ref().filter(|w| w.on) else { errors.push(format!("{at}: {who} is not on stage to move")); continue };
                    let Some(to) = b.to else { errors.push(format!("{at}: move needs to (0…1)")); continue };
                    (w.x, to, true)
                };
                if !(-0.3..=1.3).contains(&to) { errors.push(format!("{at}: to {to} is outside 0…1")); }
                let speed = b.speed.unwrap_or(1.0).clamp(0.3, 3.0) * 260.0;
                let dur = ((to - from).abs() * 1100.0 / speed).max(0.3);
                let facing = if to >= from { "right" } else { "left" }.to_string();
                let mut w = cur.unwrap_or(Who { x: from, pose: "stand".into(), facing: facing.clone(), on: false, auto: true });
                if !st.contains_key(&who) {
                    // someone who walks on without being listed starts the scene off at that side
                    let mut s0 = w.clone();
                    s0.on = false;
                    s0.x = from;
                }
                w.x = to;
                w.on = on_after;
                w.pose = "stand".into();
                st.insert(who.clone(), w);
                // on arrival they face whoever else is on, or the room (to the right) when alone
                let after = if on_after { face_toward(&st, &who, to, "right") } else { facing.clone() };
                st.get_mut(&who).unwrap().facing = after.clone();
                spacing(&st, &at, &mut warnings);
                evs.push(Ev { scene: si, kind: Kind::Move { who: who.clone(), from, to, dur, facing, after, on_after }, gap, shot });
                // everyone else turns to the company as it changes (unless the spec says which way they face)
                let others: Vec<String> = st.iter().filter(|(k, w)| **k != who && w.on && w.auto).map(|(k, _)| k.clone()).collect();
                for k in others {
                    let w = &st[&k];
                    let f = face_toward(&st, &k, w.x, &w.facing);
                    if f != w.facing {
                        st.get_mut(&k).unwrap().facing = f.clone();
                        evs.push(Ev { scene: si, kind: Kind::Turn { who: k, facing: f }, gap: 0.0, shot: None });
                    }
                }
            } else if let Some(who) = b.sit.as_ref().or(b.stand.as_ref()) {
                if !known(who, &mut errors, &at) { continue; }
                let pose = if b.sit.is_some() { "sit" } else { "stand" };
                match st.get_mut(who) { Some(w) => w.pose = pose.into(), None => { errors.push(format!("{at}: {who} is not in this scene")); continue } }
                evs.push(Ev { scene: si, kind: Kind::Pose { who: who.clone(), pose: pose.into() }, gap, shot });
            } else if let Some(who) = &b.turn {
                if !known(who, &mut errors, &at) { continue; }
                let f = b.facing.clone().unwrap_or_default();
                if f != "left" && f != "right" { errors.push(format!("{at}: turn needs facing left or right")); continue; }
                match st.get_mut(who) { Some(w) => { w.facing = f.clone(); w.auto = false; } None => { errors.push(format!("{at}: {who} is not in this scene")); continue } }
                evs.push(Ev { scene: si, kind: Kind::Turn { who: who.clone(), facing: f }, gap, shot });
            }
        }
        // the scene's opening state: everyone listed, plus anyone who walked on unlisted (they start off)
        let mut start = start;
        for (k, w) in st.iter() {
            if !start.contains_key(k) {
                let mut s0 = w.clone();
                s0.on = false;
                s0.x = st_first_x(&evs, si, k).unwrap_or(-0.15);
                start.insert(k.clone(), s0);
            }
        }
        scenes.push(json!({
            "set": sc.set, "camera": sc.camera.clone().unwrap_or("auto".into()),
            "audience": if seats > 0 { json!({"seats": seats, "members": members}) } else { Value::Null },
        }));
        scene_start.push(start);
    }
    Film { spec, people, evs, jobs, scenes, scene_start, errors, warnings }
}


/// where someone first walks on from, in a scene
fn st_first_x(evs: &[Ev], si: usize, who: &str) -> Option<f64> {
    evs.iter().filter(|e| e.scene == si).find_map(|e| match &e.kind {
        Kind::Move { who: w, from, .. } if w == who => Some(*from),
        _ => None,
    })
}

fn prepare(g: &EnglishG2P, pron: &BTreeMap<String, String>, j: &Job) -> Prepared {
    match &j.utter {
        Utter::Speech(t) => plan_speech(g, pron, &j.p, t),
        Utter::Act(a, n) => plan_act(g, pron, &j.p, a, *n),
    }
}

/// lay the beats end to end; returns each event's start and the end of the film
fn layout(f: &Film, durs: &[f64]) -> (Vec<f64>, Vec<f64>, f64) {
    let mut cursor = 0.4f64;
    let mut starts = vec![0.0; f.evs.len()];
    let mut ends = vec![0.0; f.evs.len()];
    let mut scene = usize::MAX;
    for (i, e) in f.evs.iter().enumerate() {
        if e.scene != scene {
            scene = e.scene;
            if i > 0 { cursor += 0.6; }
        }
        let t0 = (cursor + e.gap).max(0.0);
        starts[i] = t0;
        let d = match &e.kind {
            Kind::Line { .. } => f.jobs.iter().position(|j| j.ev == i).map(|k| durs[k]).unwrap_or(0.0),
            Kind::Crowd { hold, .. } => *hold,
            Kind::Wait(w) => *w,
            Kind::Move { dur, .. } => *dur,
            Kind::Card { hold, .. } => *hold,
            _ => 0.0,
        };
        ends[i] = t0 + d;
        cursor = cursor.max(t0 + d);
        if let Kind::Line { .. } = e.kind { cursor = t0 + d; }
    }
    (starts, ends, cursor + 1.2)
}

fn g2p() -> EnglishG2P {
    g2p_words().0
}

/// the G2P with the dictionary loaded, and the dictionary's words (to warn about guessed ones)
fn g2p_words() -> (EnglishG2P, std::collections::HashSet<String>) {
    let path = std::env::var("CHIMERA_CMUDICT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../chimera/public/data/cmudict.txt.gz").into());
    let gz = std::fs::read(&path).unwrap_or_else(|_| panic!("can't read the pronouncing dictionary at {path}"));
    let mut text = String::new();
    flate2::read::GzDecoder::new(&gz[..]).read_to_string(&mut text).unwrap();
    let words = text.lines().filter_map(|l| l.split(['\t', ' ']).next()).map(|w| w.to_lowercase()).collect();
    let mut g = EnglishG2P::new();
    g.load_dict(&text);
    (g, words)
}

/// words the dictionary doesn't have (their sound is guessed from the spelling)
fn unknown_words(text: &str, words: &std::collections::HashSet<String>) -> Vec<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’'))
        .filter(|w| !w.is_empty() && !w.chars().any(|c| c.is_ascii_digit()))
        .map(|w| w.to_lowercase().replace('’', "'"))
        .filter(|w| !words.contains(w) && !words.contains(w.trim_end_matches("'s")))
        .collect()
}

/// A small Schroeder reverb (four combs, two allpasses), mixed in at `wet`.
fn reverb(x: &mut [f32], wet: f32, seed: usize) {
    if wet <= 0.0 { return; }
    let mut acc = vec![0f32; x.len()];
    for (k, d) in [1557usize, 1617, 1491, 1422].iter().enumerate() {
        let d = d * 2 + seed * 37 + k;
        let mut buf = vec![0f32; d];
        let (mut i, mut lp) = (0, 0f32);
        for (n, s) in x.iter().enumerate() {
            let y = buf[i];
            lp = y * 0.6 + lp * 0.4;
            buf[i] = s + lp * 0.8;
            i = (i + 1) % d;
            acc[n] += y * 0.25;
        }
    }
    for d in [225usize * 2 + seed, 556 * 2] {
        let mut buf = vec![0f32; d];
        let mut i = 0;
        for s in acc.iter_mut() {
            let b = buf[i];
            let y = -*s * 0.5 + b;
            buf[i] = *s + b * 0.5;
            i = (i + 1) % d;
            *s = y;
        }
    }
    for (s, a) in x.iter_mut().zip(&acc) {
        *s += a * wet;
    }
}

fn wav(path: &str, x: &[f32], ch: u16) {
    let mut b = Vec::with_capacity(44 + x.len() * 2);
    let bytes = (x.len() * 2) as u32;
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + bytes).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&ch.to_le_bytes());
    b.extend_from_slice(&48000u32.to_le_bytes());
    b.extend_from_slice(&(48000u32 * 2 * ch as u32).to_le_bytes());
    b.extend_from_slice(&(2 * ch).to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&bytes.to_le_bytes());
    for s in x {
        b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
}

fn load(path: &str) -> Result<Film, Vec<String>> {
    let text = std::fs::read_to_string(path).map_err(|e| vec![format!("can't read {path}: {e}")])?;
    let spec: Spec = serde_json::from_str(&text).map_err(|e| vec![format!("spec: {e}")])?;
    let f = build(spec);
    if f.errors.is_empty() { Ok(f) } else { Err(f.errors) }
}

fn fail(errors: Vec<String>) -> ! {
    println!("{}", json!({"ok": false, "errors": errors}));
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");
    match cmd {
        "ipa" => {
            let g = g2p();
            for t in &args[2..] {
                let ph = g.to_phrases(&respell(t, &BTreeMap::new()));
                println!("{t}: /{}/", ph.iter().map(|p| p.segments.iter().map(|s| s.ipa.clone()).collect::<String>()).collect::<Vec<_>>().join(" | "));
            }
        }
        "line" => {
            if args.len() < 6 { fail(vec!["usage: line <spec.json> <who> <text> <out.wav> [mood]".into()]); }
            let f = load(&args[2]).unwrap_or_else(|e| fail(e));
            let Some(p) = f.people.get(&args[3]) else { fail(vec![format!("\"{}\" is not in the cast", args[3])]) };
            let p = moody(p, args.get(6).map(|s| s.as_str()).unwrap_or("neutral"));
            let g = g2p();
            let text = &args[4];
            let prep = match ACTS.iter().find(|a| text.trim_matches(|c| c == '*' || c == '(' || c == ')') == **a) {
                Some(a) => plan_act(&g, &f.spec.pronounce, &p, a, 2),
                None => plan_speech(&g, &f.spec.pronounce, &p, text),
            };
            let c = run(prep, false);
            let peak = c.out.iter().fold(0f32, |m, s| m.max(s.abs())).max(1e-6);
            let out: Vec<f32> = c.out.iter().map(|s| s * 0.89 / peak).collect();
            wav(&args[5], &out, 1);
            println!("{}", json!({"ok": true, "ipa": c.ipa, "seconds": (c.dur * 100.0).round() / 100.0, "wav": args[5]}));
        }
        "check" | "render" => {
            let f = load(args.get(2).map(|s| s.as_str()).unwrap_or("")).unwrap_or_else(|e| fail(e));
            let (g, words) = g2p_words();
            let pron = &f.spec.pronounce;
            let preps: Vec<(f64, String)> = std::thread::scope(|s| {
                let hs: Vec<_> = f.jobs.iter().map(|j| { let g = &g; s.spawn(move || { let p = prepare(g, pron, j); (p.end, p.ipa) }) }).collect();
                hs.into_iter().map(|h| h.join().unwrap()).collect()
            });
            let durs: Vec<f64> = preps.iter().map(|p| p.0).collect();
            let (starts, ends, total_s) = layout(&f, &durs);
            let lines: Vec<Value> = f.evs.iter().enumerate().filter_map(|(i, e)| match &e.kind {
                Kind::Line { who, text, act, place } => {
                    let k = f.jobs.iter().position(|j| j.ev == i)?;
                    Some(json!({"who": who, "text": text, "do": act, "where": place, "ipa": preps[k].1, "t0": (starts[i] * 100.0).round() / 100.0, "seconds": (durs[k] * 100.0).round() / 100.0}))
                }
                _ => None,
            }).collect();
            if cmd == "check" {
                let mut warnings = f.warnings.clone();
                let mut unknown: Vec<String> = Vec::new();
                for e in &f.evs {
                    if let Kind::Line { text, .. } = &e.kind {
                        for w in unknown_words(&respell(text, pron), &words) {
                            let respelt = pron.values().any(|v| v.to_lowercase().split_whitespace().any(|x| x == w));
                            if !respelt && !unknown.contains(&w) { unknown.push(w); }
                        }
                    }
                }
                if !unknown.is_empty() {
                    warnings.push(format!("not in the dictionary, so said as spelt (check their ipa; respell them in \"pronounce\" if wrong): {}", unknown.join(", ")));
                }
                for l in &lines {
                    if l["where"] == "voiceover" { warnings.push(format!("{} is not in the scene at {}s, so they are heard as a voice-over", l["who"].as_str().unwrap_or(""), l["t0"])); }
                }
                println!("{}", serde_json::to_string_pretty(&json!({"ok": true, "seconds": (total_s * 10.0).round() / 10.0, "voices": f.jobs.len(), "lines": lines, "warnings": warnings})).unwrap());
                return;
            }
            let dir = args.get(3).cloned().unwrap_or("out".into());
            std::fs::create_dir_all(&dir).unwrap();
            eprintln!("rendering {} voices…", f.jobs.len());
            let clips: Vec<Clip> = std::thread::scope(|s| {
                let hs: Vec<_> = f.jobs.iter().map(|j| { let g = &g; s.spawn(move || run(prepare(g, pron, j), j.track)) }).collect();
                hs.into_iter().map(|h| h.join().unwrap()).collect()
            });
            let total = (total_s * FS) as usize;
            let mut bus = [[vec![0f32; total], vec![0f32; total]], [vec![0f32; total], vec![0f32; total]]];
            let mut lines = Vec::new();
            let mut crowd_members: BTreeMap<usize, Vec<Value>> = BTreeMap::new();
            for (j, c) in f.jobs.iter().zip(&clips) {
                let t0 = starts[j.ev] + j.at;
                let at = (t0 * FS) as usize;
                let (l, r) = (((1.0 - j.pan) * 0.5).sqrt() * j.gain, ((1.0 + j.pan) * 0.5).sqrt() * j.gain);
                // a stage voice carries its own room; the crowd shares one far, dull room; voice-over is dry
                let mut x = c.out.clone();
                if j.bus == Bus::Stage {
                    x.extend(std::iter::repeat_n(0.0, (FS * 1.2) as usize));
                }
                let mut xr = x.clone();
                if j.bus == Bus::Stage {
                    reverb(&mut x, j.wet, 2);
                    reverb(&mut xr, j.wet, 3);
                }
                let b = if j.bus == Bus::Crowd { 1 } else { 0 };
                for n in 0..x.len() {
                    if at + n >= total { break; }
                    bus[b][0][at + n] += x[n] * l as f32;
                    bus[b][1][at + n] += xr[n] * r as f32;
                }
                if j.member {
                    crowd_members.entry(j.ev).or_default().push(json!({"t0": t0, "t1": t0 + c.dur, "female": j.p.mix.0 > 0.5, "frames": c.frames}));
                } else if let Kind::Line { who, text, act, place } = &f.evs[j.ev].kind {
                    lines.push(json!({"who": who, "text": text, "do": act, "where": place, "ipa": c.ipa, "t0": t0, "t1": t0 + c.dur, "scene": f.evs[j.ev].scene, "frames": c.frames, "shot": f.evs[j.ev].shot}));
                }
            }
            let mut crowd = Vec::new();
            let mut moves = Vec::new();
            let mut poses = Vec::new();
            let mut cards = Vec::new();
            let mut shots = Vec::new();
            let mut scene_t = vec![(f64::MAX, 0.0f64); f.scenes.len()];
            for (i, e) in f.evs.iter().enumerate() {
                let (t0, t1) = (starts[i], ends[i]);
                scene_t[e.scene].0 = scene_t[e.scene].0.min(t0 - e.gap.max(0.0));
                scene_t[e.scene].1 = scene_t[e.scene].1.max(t1);
                if let Some(s) = &e.shot {
                    if !matches!(e.kind, Kind::Line { .. }) { shots.push(json!({"t0": t0, "t1": t1.max(t0 + 0.5), "shot": s, "scene": e.scene})); }
                }
                match &e.kind {
                    Kind::Crowd { kind, n, hold, visible } => {
                        let m = crowd_members.remove(&i).unwrap_or_default();
                        let end = m.iter().map(|m| m["t1"].as_f64().unwrap_or(t0)).fold(t0, f64::max);
                        crowd.push(json!({"kind": kind, "n": n, "t0": t0, "t1": end, "hold": hold, "visible": visible, "scene": e.scene, "members": m}));
                    }
                    Kind::Move { who, from, to, dur, facing, after, on_after } => moves.push(json!({"who": who, "t0": t0, "t1": t0 + dur, "from": from, "to": to, "facing": facing, "after": after, "on": on_after, "scene": e.scene})),
                    Kind::Pose { who, pose } => poses.push(json!({"who": who, "t": t0, "pose": pose, "scene": e.scene})),
                    Kind::Turn { who, facing } => poses.push(json!({"who": who, "t": t0, "facing": facing, "scene": e.scene})),
                    Kind::Card { text, hold } => cards.push(json!({"t0": t0, "t1": t0 + hold, "text": text})),
                    _ => {}
                }
            }
            // scenes run back to back: each from its first beat to the next one's
            let n = f.scenes.len();
            let mut scenes = Vec::new();
            for (k, s) in f.scenes.iter().enumerate() {
                let t0 = if k == 0 { 0.0 } else { scene_t[k].0 };
                let t1 = if k + 1 == n { total_s } else { scene_t[k + 1].0 };
                let mut s = s.clone();
                s["t0"] = json!(t0);
                s["t1"] = json!(t1);
                s["people"] = json!(f.scene_start[k].iter().map(|(who, w)| json!({"who": who, "x": w.x, "pose": w.pose, "facing": w.facing, "on": w.on})).collect::<Vec<_>>());
                scenes.push(s);
            }
            for ch in 0..2 {
                let mut lp = 0f32;
                for s in bus[1][ch].iter_mut() {
                    lp += 0.32 * (*s - lp);
                    *s = lp;
                }
                reverb(&mut bus[1][ch], 0.9, ch);
            }
            let mut peak = 0f32;
            let mut mixed = vec![0f32; total * 2];
            for n in 0..total {
                for ch in 0..2 {
                    let v = bus[0][ch][n] + bus[1][ch][n];
                    mixed[n * 2 + ch] = v;
                    peak = peak.max(v.abs());
                }
            }
            let k = 0.89 / peak.max(1e-6);
            for s in mixed.iter_mut() { *s *= k; }
            wav(&format!("{dir}/audio.wav"), &mixed, 2);
            let cast: BTreeMap<&String, Value> = f.spec.cast.iter().map(|(name, c)| {
                let p = &f.people[name];
                (name, json!({"mix": [p.mix.0, p.mix.1], "voice": c.voice.clone().unwrap_or("man".into()), "height": c.height, "build": c.build.clone().unwrap_or("average".into()), "nervous": c.nervous.unwrap_or(0.0), "stiff": c.stiff.unwrap_or(false), "props": c.props, "color": c.color.clone().unwrap_or("white".into())}))
            }).collect();
            // the articulators at rest: a face for anyone not speaking
            let rest: Vec<f32> = {
                let (_, mut v) = voice_for(&person("x", &CastSpec::default()).unwrap());
                let mut b = [0f32; 128];
                for _ in 0..40 { v.render(&mut b); }
                ArticKey::ALL.iter().map(|k| ((v.artic.x.get(*k) * 1e3).round() / 1e3) as f32).collect()
            };
            let tl = json!({"rest": rest, "title": f.spec.title, "captions": f.spec.captions.unwrap_or(true), "duration": total_s, "keys": ArticKey::NAMES, "cast": cast, "scenes": scenes, "lines": lines, "crowd": crowd, "moves": moves, "poses": poses, "cards": cards, "shots": shots});
            std::fs::write(format!("{dir}/timeline.json"), serde_json::to_string(&tl).unwrap()).unwrap();
            println!("{}", json!({"ok": true, "seconds": (total_s * 10.0).round() / 10.0, "voices": f.jobs.len(), "dir": dir}));
        }
        _ => {
            eprintln!("usage: chimera-film check <spec.json> | render <spec.json> <dir> | line <spec.json> <who> <text> <out.wav> [mood] | ipa <text>…");
            std::process::exit(1);
        }
    }
}
