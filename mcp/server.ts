#!/usr/bin/env bun
/**
 * chimera-film MCP server: an agent writes a movie spec (cast, sets, scenes, beats) and gets back a
 * film whose every voice, laugh, cough and heckle comes from CHIMERA's physical voice model, drawn
 * as x-ray heads on stick bodies in neon line sets. Tools: film_guide, check_film, hear_line,
 * film_stills, render_film. See ../GUIDE.md for the spec, ../README.md for setup.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, type Browser } from "playwright-core";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILM = resolve(HERE, "..");
const CHIMERA = resolve(process.env.CHIMERA_DIR ?? join(FILM, "chimera"));
const ENGINE_DIR = join(FILM, "engine");
const ENGINE = join(ENGINE_DIR, "target/release/chimera-film");
const OUT = resolve(process.env.FILM_OUT ?? join(FILM, "out"));
const PORT = Number(process.env.FILM_PORT ?? 5317);
const JOBS = join(CHIMERA, "public/film/jobs");
const GUIDE = readFileSync(join(FILM, "GUIDE.md"), "utf8");
const log = (...a: unknown[]) => console.error("[chimera-film]", ...a); // stdout is the protocol

// ---------------------------------------------------------------- the engine
function engine(args: string[]): { ok: boolean; [k: string]: any } {
  if (!existsSync(ENGINE)) {
    log("building the engine (first run, a minute or two)…");
    const b = spawnSync("cargo", ["build", "--release"], { cwd: ENGINE_DIR, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (b.status !== 0) return { ok: false, errors: ["cargo build failed: " + (b.stderr ?? "").slice(-2000)] };
  }
  const r = spawnSync(ENGINE, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { ok: false, errors: [(r.stderr || r.stdout || `engine exited ${r.status}`).slice(-2000)] };
  }
}

type Spec = Record<string, unknown>;
function readSpec(spec: unknown): Spec {
  if (typeof spec === "string") {
    const s = spec.trim();
    if (s.startsWith("{")) return JSON.parse(s);
    const p = isAbsolute(s) ? s : resolve(process.cwd(), s);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  if (spec && typeof spec === "object") return spec as Spec;
  throw new Error("spec must be the film spec as a JSON object, JSON text, or a path to a .json file");
}
const idOf = (spec: Spec) => createHash("sha1").update(JSON.stringify(spec)).digest("hex").slice(0, 12);
const tmpSpec = (spec: Spec) => {
  const dir = join(OUT, ".specs");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, idOf(spec) + ".json");
  writeFileSync(p, JSON.stringify(spec, null, 2));
  return p;
};

/** the sound and the timeline for a spec (cached by its content) */
function prepare(spec: Spec): { id: string; seconds: number } | { errors: string[] } {
  const id = idOf(spec);
  const dir = join(JOBS, id);
  if (existsSync(join(dir, "timeline.json")) && existsSync(join(dir, "audio.wav"))) {
    const tl = JSON.parse(readFileSync(join(dir, "timeline.json"), "utf8"));
    return { id, seconds: tl.duration };
  }
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "spec.json");
  writeFileSync(p, JSON.stringify(spec, null, 2));
  const r = engine(["render", p, dir]);
  if (!r.ok) return { errors: r.errors ?? ["render failed"] };
  return { id, seconds: r.seconds };
}

// ---------------------------------------------------------------- the picture (a page of the chimera app, in headless chromium)
/** the film page imports CHIMERA's own renderers, so it is served from inside the CHIMERA checkout:
 * copy it (and the WebM muxer) in. Copies, not links: Vite resolves links to their real path, and
 * the page's relative imports would then miss. */
function syncPage(): void {
  if (!existsSync(join(CHIMERA, "src/ui/render/anatomy.ts"))) throw new Error(`no CHIMERA checkout at ${CHIMERA} (run ./setup.sh, or set CHIMERA_DIR)`);
  copyFileSync(join(FILM, "web/film.html"), join(CHIMERA, "film.html"));
  copyFileSync(join(FILM, "web/film.ts"), join(CHIMERA, "src/film.ts"));
  mkdirSync(join(CHIMERA, "public/film/jobs"), { recursive: true });
  copyFileSync(join(HERE, "node_modules/webm-muxer/build/webm-muxer.mjs"), join(CHIMERA, "public/film/webm-muxer.mjs"));
}
let vite: ChildProcess | null = null;
const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/film.html`)).ok; } catch { return false; } };
let synced = false;
async function ensureServer(): Promise<void> {
  if (!synced) { syncPage(); synced = true; }
  if (await up()) return;
  if (!vite) {
    log(`starting the picture server on ${PORT}…`);
    vite = spawn("bunx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: CHIMERA, stdio: ["ignore", "ignore", "inherit"] });
    vite.on("exit", () => (vite = null));
  }
  for (let i = 0; i < 120; i++) {
    if (await up()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the picture server didn't come up on port ${PORT} (run \`bunx vite --port ${PORT}\` in ${CHIMERA} to see why)`);
}
let browser: Browser | null = null;
async function page() {
  await ensureServer();
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  p.on("console", (m) => { if (m.type() === "error") log("page:", m.text()); });
  return p;
}
/** wait for the page to finish; fail if it stops making progress for two minutes */
async function waitDone(p: Awaited<ReturnType<typeof page>>, onProgress?: (f: number) => void) {
  let last: unknown = undefined, since = Date.now();
  for (;;) {
    const s = await p.evaluate(() => ({ d: (window as any).__done, e: (window as any).__error, pr: (window as any).__progress }));
    if (s.e) throw new Error("picture: " + s.e);
    if (s.d) return;
    if (s.pr !== last) { last = s.pr; since = Date.now(); }
    else if (Date.now() - since > 120_000) throw new Error(`picture: stuck at ${typeof s.pr === "number" ? Math.round(s.pr * 100) + "%" : "loading"} for two minutes`);
    if (onProgress && typeof s.pr === "number") onProgress(s.pr);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => { const r = queue.then(f, f); queue = r.catch(() => {}); return r; };

async function stills(id: string, at: number[]) {
  const p = await page();
  try {
    await p.goto(`http://127.0.0.1:${PORT}/film.html?still&job=${id}&at=${at.join(",")}`);
    await waitDone(p);
    return (await p.evaluate(() => (window as any).__stills as string[])).map((u) => u.slice(u.indexOf(",") + 1));
  } finally {
    await p.close();
  }
}

async function video(id: string, onProgress: (f: number) => void): Promise<Buffer> {
  const p = await page();
  try {
    await p.goto(`http://127.0.0.1:${PORT}/film.html?render&job=${id}`);
    await waitDone(p, onProgress);
    const n: number = await p.evaluate(() => (window as any).__video.length);
    const parts: Buffer[] = [];
    for (let o = 0; o < n; o += 4_000_000) {
      const s = await p.evaluate(([o]) => {
        const v = (window as any).__video.subarray(o, o + 4_000_000);
        let r = "";
        for (let i = 0; i < v.length; i += 32768) r += String.fromCharCode(...v.subarray(i, i + 32768));
        return btoa(r);
      }, [o]);
      parts.push(Buffer.from(s, "base64"));
    }
    return Buffer.concat(parts);
  } finally {
    await p.close();
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "film";
const text = (t: string) => ({ type: "text" as const, text: t });
const fail = (msg: string) => ({ content: [text(msg)], isError: true });
const specArg = z.union([z.record(z.string(), z.any()), z.string()]).describe("the film spec: a JSON object (see film_guide), JSON text, or a path to a .json file");

// ---------------------------------------------------------------- tools
const server = new McpServer(
  { name: "chimera-film", version: "0.1.0" },
  { instructions: "Makes short films in one style: x-ray side-view heads on stick bodies in neon line-drawn sets, every voice synthesized by a physical model of the human voice. Read film_guide for the spec format, then check_film → film_stills → render_film." },
);

server.registerTool("film_guide", {
  title: "How to write a film spec",
  description: "The film spec format: cast (voices, bodies, props), sets, scenes, beats (lines, coughs, crowd reactions, walking on and off, sitting, title cards), moods, camera and timing tips. Read this before writing a spec.",
  annotations: { readOnlyHint: true },
}, async () => ({ content: [text(GUIDE)] }));

server.registerTool("check_film", {
  title: "Check a film spec",
  description: "Validate a spec and plan it without rendering (under a second): errors, the film's length, every line's timing and IPA pronunciation, and warnings (words missing from the dictionary, heads that overlap, voice-overs). Fix everything it reports before rendering.",
  inputSchema: { spec: specArg },
  annotations: { readOnlyHint: true },
}, async ({ spec }) => {
  let s: Spec;
  try { s = readSpec(spec); } catch (e) { return fail(String(e)); }
  const r = engine(["check", tmpSpec(s)]);
  if (!r.ok) return fail("The spec has errors:\n- " + (r.errors ?? []).join("\n- "));
  const lines = (r.lines as any[]).map((l) => `${l.t0.toFixed(1).padStart(6)}s  ${l.who}${l.where !== "stage" ? ` (${l.where})` : ""}: ${l.do ? `[${l.do}]` : l.text}  /${l.ipa}/`).join("\n");
  const warn = (r.warnings as string[]).length ? "\n\nWarnings:\n- " + (r.warnings as string[]).join("\n- ") : "\n\nNo warnings.";
  return { content: [text(`OK: ${r.seconds} s, ${r.voices} voices.${warn}\n\nLines:\n${lines}`)] };
});

server.registerTool("hear_line", {
  title: "Render one line",
  description: "Render one cast member saying one line (or a body sound: cough, laugh, sigh, gasp, scream, groan, hmm) to a WAV, with its IPA. Use it to check a respelling in `pronounce` or a voice before rendering the film.",
  inputSchema: { spec: specArg, who: z.string().describe("a cast name"), text: z.string().describe("the line, or a body sound's name"), mood: z.string().optional().describe("neutral, happy, excited, sad, angry, shout, whisper, nervous, deadpan, scared") },
}, async ({ spec, who, text: line, mood }) => {
  let s: Spec;
  try { s = readSpec(spec); } catch (e) { return fail(String(e)); }
  const dir = join(OUT, "lines");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${slug(who)}-${createHash("sha1").update(line + (mood ?? "")).digest("hex").slice(0, 6)}.wav`);
  const r = engine(["line", tmpSpec(s), who, line, out, mood ?? "neutral"]);
  if (!r.ok) return fail((r.errors ?? []).join("\n"));
  return { content: [text(`${who}: "${line}"  /${r.ipa}/  ${r.seconds} s\nWAV: ${out}`)] };
});

server.registerTool("film_stills", {
  title: "See frames of a film",
  description: "Render the film's sound and timeline (seconds; cached) and return frames at the given times as images, to check staging, camera and captions before the full render. check_film gives each line's start time.",
  inputSchema: { spec: specArg, at: z.array(z.number()).min(1).max(8).describe("times in seconds, up to 8") },
  annotations: { readOnlyHint: true },
}, async ({ spec, at }) => {
  let s: Spec;
  try { s = readSpec(spec); } catch (e) { return fail(String(e)); }
  return serial(async () => {
    const j = prepare(s);
    if ("errors" in j) return fail("The spec has errors:\n- " + j.errors.join("\n- "));
    const ts = at.map((t) => Math.max(0, Math.min(j.seconds - 0.05, t)));
    const imgs = await stills(j.id, ts);
    const content: any[] = [text(`${j.seconds.toFixed(1)} s film. Frames at ${ts.map((t) => t.toFixed(1) + " s").join(", ")}:`)];
    imgs.forEach((data, i) => { content.push(text(`t = ${ts[i].toFixed(1)} s`)); content.push({ type: "image", data, mimeType: "image/jpeg" }); });
    return { content };
  });
});

server.registerTool("render_film", {
  title: "Render a film",
  description: "Render the whole film to a video file (1080p H.264 MP4 by default). Takes about the film's length again, plus a few seconds. Returns the file's path.",
  inputSchema: {
    spec: specArg,
    name: z.string().optional().describe("file name without extension (default: from the title)"),
    out_dir: z.string().optional().describe("folder for the video (default: the server's out folder)"),
    format: z.enum(["mp4", "webm"]).optional().describe("mp4 (default; needs ffmpeg) or webm (720p, no conversion)"),
    hd: z.boolean().optional().describe("mp4 at 1920×1080 (default true) or 1280×720"),
  },
}, async ({ spec, name, out_dir, format, hd }, extra) => {
  let s: Spec;
  try { s = readSpec(spec); } catch (e) { return fail(String(e)); }
  const token = extra._meta?.progressToken;
  const progress = (f: number, message: string) => { if (token !== undefined) void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.round(f * 100), total: 100, message } }); };
  return serial(async () => {
    const t0 = Date.now();
    progress(0.01, "voices");
    const j = prepare(s);
    if ("errors" in j) return fail("The spec has errors:\n- " + j.errors.join("\n- "));
    progress(0.1, "picture");
    const webm = await video(j.id, (f) => progress(0.1 + 0.8 * f, "picture"));
    const dir = resolve(out_dir ?? OUT);
    mkdirSync(dir, { recursive: true });
    const base = join(dir, slug(name ?? String(s.title ?? "film")));
    writeFileSync(base + ".webm", webm);
    let file = base + ".webm", note = "";
    if ((format ?? "mp4") === "mp4") {
      progress(0.92, "mp4");
      const scale = hd === false ? [] : ["-vf", "scale=1920:1080:flags=lanczos"];
      const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", base + ".webm", ...scale, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", base + ".mp4"], { encoding: "utf8" });
      if (r.status === 0) file = base + ".mp4";
      else note = `\n(MP4 conversion failed, so this is the WebM: ${(r.error?.message ?? r.stderr ?? "").slice(0, 300)}. Install ffmpeg for MP4.)`;
    }
    progress(1, "done");
    const mb = (statSync(file).size / 1e6).toFixed(1);
    return { content: [text(`Rendered ${j.seconds.toFixed(1)} s film in ${((Date.now() - t0) / 1000).toFixed(0)} s.\n${file} (${mb} MB)${note}`)] };
  });
});

const shutdown = async () => { try { await browser?.close(); } catch {} vite?.kill(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
await server.connect(new StdioServerTransport());
log("ready");
