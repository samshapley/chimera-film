/**
 * A film from a chimera-film timeline (engine/): every voice from the engine, every mouth the same
 * model that made its sound, drawn as the app's side-view heads on stick bodies in line-drawn sets.
 * Served from inside the CHIMERA checkout (the MCP server copies it there), since it imports
 * CHIMERA's renderers. `?job=<id>` reads /film/jobs/<id>/{timeline.json,audio.wav}. Plays live
 * on click; `?still&at=1,5` keeps JPEG frames; `?render`
 * encodes it to WebM offline (WebCodecs).
 */
import "./ui/styles.css";
import { initChimera } from "./wasm/chimera.ts";

type P2 = [number, number];
interface Line { who: string; text: string; do: string | null; where: "stage" | "audience" | "voiceover" | "off"; t0: number; t1: number; scene: number; frames: number[][]; shot: string | null }
interface Member { t0: number; t1: number; female: boolean; frames: number[][] }
interface Crowd { kind: string; n: number; t0: number; t1: number; hold: number; visible: boolean; scene: number; members: Member[] }
interface Move { who: string; t0: number; t1: number; from: number; to: number; facing: string; after: string; on: boolean; scene: number }
interface PoseEv { who: string; t: number; pose?: string; facing?: string; scene: number }
interface Card { t0: number; t1: number; text: string }
interface Shot { t0: number; t1: number; shot: string; scene: number }
interface ScenePerson { who: string; x: number; pose: string; facing: string; on: boolean }
interface Scene { set: string; camera: string; audience: { seats: number; members: string[] } | null; t0: number; t1: number; people: ScenePerson[] }
interface CastMember { mix: [number, number]; voice: string; height: number | null; build: string; nervous: number; stiff: boolean; props: string[]; color: string }
interface Timeline { rest: number[]; title: string | null; captions: boolean; duration: number; cast: Record<string, CastMember>; scenes: Scene[]; lines: Line[]; crowd: Crowd[]; moves: Move[]; poses: PoseEv[]; cards: Card[]; shots: Shot[] }

const W = 1280, H = 720, FPS = 30;
const BLUE = "#4fb6f2", AMBER = "#ffb340", RED = "#ff5d40", WHITE = "#effbff", GREEN = "#5be381";
const DIM = "#1f5f8c", FRAME = "#16425f";
const COLOR: Record<string, string> = { white: WHITE, blue: BLUE, amber: AMBER, red: RED, green: GREEN };
const FLOOR = 600;
const X = (x: number) => 140 + x * 1000;

async function main() {
  await initChimera();
  const { VoiceModel } = await import("./ui/analysis.ts");
  const { AnatomyRenderer } = await import("./ui/render/anatomy.ts");
  const { Glow, label, wrapLabel, seg, ring, beamPts } = await import("./ui/render/vector.ts");
  await Promise.all([document.fonts.load('300 20px "Hershey"'), document.fonts.load('500 20px "Hershey"')]);
  const params = new URLSearchParams(location.search);
  const base = `/film/jobs/${params.get("job") ?? "demo"}/`;
  const tl: Timeline = await (await fetch(base + "timeline.json")).json();

  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const glow = new Glow();
  const FLAGS = { pressure: false, particles: false, grid: false, calipers: false };

  // ------------------------------------------------------------ heads
  const HS = 600; // heads are drawn at this size (the renderer's full layout) and scaled when placed
  class Head {
    readonly cv = document.createElement("canvas");
    private readonly c: CanvasRenderingContext2D;
    private readonly r = new AnatomyRenderer();
    private readonly model: InstanceType<typeof VoiceModel>;
    neck: P2 | null = null;
    mouth: P2 = [361, 282];
    drawnAt = -1;
    constructor(mix: [number, number]) {
      this.cv.width = this.cv.height = HS;
      this.c = this.cv.getContext("2d", { willReadFrequently: false })!;
      this.model = new VoiceModel({ female: mix[0], child: mix[1] }, 48000);
      this.r.resize(HS, HS);
      (this.r as any).drawHandles = () => {}; // no drag handles in a film
    }
    draw(artic: number[], dt: number): void {
      const a = VoiceModel.articFromArray(artic);
      const f = this.model.frame(a);
      this.c.setTransform(1, 0, 0, 1, 0, 0);
      this.c.fillStyle = "#000";
      this.c.fillRect(0, 0, HS, HS);
      this.r.face.update(null, dt);
      this.r.draw(this.c, this.model, f, a, null, FLAGS, { hover: null, drag: null, dt, formants: [], slots: [], info: [] });
      if (!this.neck) this.measure();
    }
    private measure(): void {
      const d = this.c.getImageData(0, 0, HS, HS).data;
      const lit = (x: number, y: number) => d[(y * HS + x) * 4] + d[(y * HS + x) * 4 + 1] + d[(y * HS + x) * 4 + 2] > 90;
      let y = HS - 1;
      for (; y > HS / 2; y--) {
        let n = 0;
        for (let x = 0; x < HS; x++) if (lit(x, y)) n++;
        if (n >= 3) break;
      }
      this.neck = [130, y - 8];
      let mx = 0, my = 0;
      for (let yy = Math.round(HS * 0.47); yy < HS * 0.6; yy++) for (let x = HS - 1; x > mx; x--) if (lit(x, yy)) { mx = x; my = yy; break; }
      if (mx > 200) this.mouth = [mx, my];
    }
  }
  /** place a head so its neck ends at (nx, ny), facing dir (1 right, −1 left), tilted back by `back`
   * (rad); returns where its mouth is */
  const put = (h: Head, nx: number, ny: number, size: number, dir: number, back = 0): P2 => {
    const s = size / HS, n = h.neck ?? [130, 580];
    const rot = -dir * back;
    ctx.save();
    ctx.translate(nx, ny);
    ctx.rotate(rot);
    ctx.scale(dir < 0 ? -s : s, s);
    ctx.globalCompositeOperation = "lighter";
    const times = size * zoomNow < 250 ? 3 : size * zoomNow < 450 ? 2 : 1; // thin lines dim when scaled down
    for (let i = 0; i < times; i++) ctx.drawImage(h.cv, -n[0], -n[1]);
    ctx.restore();
    const dx = (h.mouth[0] - n[0]) * s * dir, dy = (h.mouth[1] - n[1]) * s;
    return [nx + dx * Math.cos(rot) - dy * Math.sin(rot), ny + dx * Math.sin(rot) + dy * Math.cos(rot)];
  };
  const castHeads = new Map<string, Head>();
  const headOf = (who: string) => {
    let h = castHeads.get(who);
    if (!h) castHeads.set(who, (h = new Head(tl.cast[who]?.mix ?? [0, 0])));
    return h;
  };
  const SEAT_MIX: [number, number][] = [[0, 0], [0.9, 0], [0.1, 0.1], [1, 0], [0.8, 0.05], [0.05, 0], [1, 0], [0, 0], [0.7, 0], [0.2, 0], [1, 0.1], [0, 0.05]];
  const seatHeads = SEAT_MIX.map((m) => new Head(m));

  const REST = tl.rest;
  const at = (c: { t0: number; frames: number[][] }, t: number) => c.frames.length ? c.frames[Math.max(0, Math.min(c.frames.length - 1, Math.floor((t - c.t0) * 100)))] : REST;

  // ------------------------------------------------------------ drawing kit
  let zoomNow = 1;
  const L = (a: P2, b: P2, color: string, w = 1.6, alpha = 1) => seg(ctx, a[0], a[1], b[0], b[1], color, w, { alpha });
  const path = (pts: P2[], color: string, w = 1.6, alpha = 1) => beamPts(ctx, pts, color, w, { alpha });
  const box = (x: number, y: number, w: number, h: number, color: string, lw = 1.2, alpha = 1) => path([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], color, lw, alpha);
  const circle = (x: number, y: number, r: number, color: string, w = 1.4, alpha = 1, n = 28) => path(Array.from({ length: n + 1 }, (_, k) => [x + r * Math.cos((k / n) * 2 * Math.PI), y + r * Math.sin((k / n) * 2 * Math.PI)] as P2), color, w, alpha);
  const tag = (text: string, x: number, y: number, color: string, align: "left" | "right" | "center" = "left", size = 22) => label(ctx, text, x, y, { size, color, align, ls: 0.18 });
  /** a two-bone limb from a to the hand b, bending toward `bend` (±1) */
  const limb = (a: P2, b: P2, len: number, bend: number, color: string, w = 1.9): void => {
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.min(len * 1.98, Math.hypot(dx, dy)) || 1;
    const h = Math.sqrt(Math.max(0, len * len - (d / 2) * (d / 2)));
    const k: P2 = [a[0] + dx / 2 - (dy / d) * h * bend, a[1] + dy / 2 + (dx / d) * h * bend];
    L(a, k, color, w);
    L(k, b, color, w);
  };
  const BRICKS: P2[] = [];
  {
    let s = 11;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 46; i++) BRICKS.push([Math.round(rnd() * 24) * 52 + (i % 2) * 26, Math.round(rnd() * 22) * 24 + 8]);
  }
  const bricks = (y1: number) => { for (const [x, y] of BRICKS) if (y + 20 < y1) box(x, y, 50, 20, FRAME, 1, 0.75); };
  const glass = (x: number, y: number, h: number, color: string, fill = 0.6) => {
    const w = h * 0.5;
    path([[x - w / 2, y - h], [x - w * 0.4, y], [x + w * 0.4, y], [x + w / 2, y - h]], color, 1.3);
    L([x - w * 0.45, y - h * fill], [x + w * 0.45, y - h * fill], AMBER, 1.1, 0.9);
  };
  const table = (x: number, top: number, floor: number, w: number, color: string) => {
    L([x - w / 2, top], [x + w / 2, top], color, 1.6);
    L([x, top], [x, floor], color, 1.4);
    L([x - w * 0.3, floor], [x + w * 0.3, floor], color, 1.4);
  };
  const chair = (hx: number, seat: number, floor: number, dir: number, k = 1) => {
    // seat under the hips, back behind them
    L([hx + dir * 40 * k, seat + 5 * k], [hx - dir * 24 * k, seat + 5 * k], DIM, 1.5);
    L([hx - dir * 24 * k, seat + 5 * k], [hx - dir * 34 * k, seat - 82 * k], DIM, 1.5);
    L([hx + dir * 36 * k, seat + 5 * k], [hx + dir * 36 * k, floor], DIM, 1.3);
    L([hx - dir * 26 * k, seat + 5 * k], [hx - dir * 26 * k, floor], DIM, 1.3);
  };

  // ------------------------------------------------------------ sets (world 1280×720, floor at 600)
  interface SetDef { draw: (t: number) => void; front?: (t: number) => void; seat?: [number, number, number]; mic?: number; camera?: string }
  const floorLine = (c = BLUE) => L([0, FLOOR], [W, FLOOR], c, 1.8);
  const window_ = (x: number, y: number, w: number, h: number, night = true) => {
    box(x, y, w, h, BLUE, 1.5);
    L([x + w / 2, y], [x + w / 2, y + h], BLUE, 1.2);
    L([x, y + h / 2], [x + w, y + h / 2], BLUE, 1.2);
    if (night) { circle(x + w * 0.72, y + h * 0.28, 14, AMBER, 1.3, 0.9); for (const [sx, sy] of [[0.2, 0.2], [0.35, 0.7], [0.85, 0.75], [0.12, 0.62]]) circle(x + w * sx, y + h * sy, 1.5, WHITE, 1, 0.7, 6); }
  };
  const frame_ = (x: number, y: number, w: number, h: number) => {
    box(x, y, w, h, AMBER, 1.3, 0.8);
    path([[x + 10, y + h - 12], [x + w * 0.4, y + h * 0.4], [x + w * 0.6, y + h * 0.65], [x + w * 0.75, y + h * 0.3], [x + w - 10, y + h - 12]], DIM, 1.1);
  };
  const lamp = (x: number, floor: number, h: number) => {
    L([x, floor], [x, floor - h], DIM, 1.4);
    L([x - 20, floor], [x + 20, floor], DIM, 1.4);
    path([[x - 30, floor - h], [x - 18, floor - h - 44], [x + 18, floor - h - 44], [x + 30, floor - h], [x - 30, floor - h]], AMBER, 1.4);
    path([[x - 30, floor - h], [x - 70, floor - 10]], AMBER, 0.8, 0.25);
    path([[x + 30, floor - h], [x + 70, floor - 10]], AMBER, 0.8, 0.25);
  };
  const plant = (x: number, floor: number) => {
    path([[x - 22, floor - 50], [x - 16, floor], [x + 16, floor], [x + 22, floor - 50], [x - 22, floor - 50]], BLUE, 1.3);
    for (const a of [-1.1, -0.6, -0.1, 0.4, 0.9]) path([[x, floor - 50], [x + 40 * Math.sin(a), floor - 50 - 50 * Math.cos(a) * 0.9], [x + 70 * Math.sin(a), floor - 50 - 70 * Math.cos(a)]], GREEN, 1.2, 0.85);
  };
  const clock = (x: number, y: number, t: number) => {
    circle(x, y, 26, WHITE, 1.4);
    const m = t / 8, h = t / 96;
    L([x, y], [x + 18 * Math.sin(m), y - 18 * Math.cos(m)], WHITE, 1.2);
    L([x, y], [x + 11 * Math.sin(h + 2), y - 11 * Math.cos(h + 2)], WHITE, 1.6);
  };
  let stageName = "";
  const SETS: Record<string, SetDef> = {
    club: {
      mic: 0.5,
      draw: (t) => {
        bricks(FLOOR - 30);
        for (let i = 0; i < 6; i++) {
          const x = 18 + i * 22;
          path(Array.from({ length: 12 }, (_, k) => [x + 7 * Math.sin(k * 0.9 + i * 1.7 + 0.25 * Math.sin(t * 0.7 + i)), k * (FLOOR / 11)] as P2), DIM, 1.2, 0.9);
        }
        L([0, FLOOR], [1060, FLOOR], BLUE, 1.8);
        L([1060, FLOOR], [1060, FLOOR + 34], BLUE, 1.8);
        L([1060, FLOOR + 34], [W, FLOOR + 34], DIM, 1.4);
        for (let x = 60; x < 1060; x += 95) L([x, FLOOR + 8], [x, FLOOR + 30], FRAME, 1);
        const sx = X(0.42);
        path([[sx - 40, 0], [sx - 190, FLOOR]], AMBER, 1, 0.28);
        path([[sx + 40, 0], [sx + 190, FLOOR]], AMBER, 1, 0.28);
        path(Array.from({ length: 41 }, (_, k) => [sx + 190 * Math.cos((k / 40) * 2 * Math.PI), FLOOR + 7 * Math.sin((k / 40) * 2 * Math.PI)] as P2), AMBER, 1, 0.4);
        const st = 205;
        L([st - 26, FLOOR - 96], [st + 26, FLOOR - 96], BLUE, 1.6);
        L([st - 20, FLOOR - 96], [st - 30, FLOOR], DIM, 1.4);
        L([st + 20, FLOOR - 96], [st + 30, FLOOR], DIM, 1.4);
        L([st - 25, FLOOR - 40], [st + 25, FLOOR - 40], DIM, 1.2);
        glass(st, FLOOR - 97, 30, WHITE, 0.7);
        const on = Math.sin(t * 1.3) > -0.93 || Math.sin(t * 47) > 0;
        box(902, 50, 300, 104, on ? RED : DIM, 1.6, on ? 1 : 0.6);
        tag("OPEN MIC", 1052, 100, on ? RED : DIM, "center", 34);
        tag("NIGHT", 1052, 136, on ? AMBER : DIM, "center", 22);
        box(932, 236, 240, 96, BLUE, 1.3);
        L([960, 332], [930, FLOOR + 34], DIM, 1.2);
        L([1144, 332], [1174, FLOOR + 34], DIM, 1.2);
        tag("NOW ON STAGE", 1052, 270, BLUE, "center", 15);
        if (stageName) tag(stageName.toUpperCase(), 1052, 310, GREEN, "center", stageName.length > 9 ? 22 : 30);
      },
      front: () => {
        for (const [i, x] of [1120, 1240, 960].entries()) {
          const y = 700 + (i % 2) * 8;
          ring(ctx, x, y - 26, 34, DIM, 1.6);
          path([[x - 78, H + 30], [x - 60, y + 16], [x - 26, y + 6]], DIM, 1.6);
          path([[x + 78, H + 30], [x + 60, y + 16], [x + 26, y + 6]], DIM, 1.6);
        }
      },
    },
    bar: {
      draw: (t) => {
        bricks(250);
        for (const y of [120, 200]) {
          L([60, y], [1220, y], DIM, 1.4);
          for (let x = 90; x < 1200; x += 46 + ((x * 7) % 23)) { const h = 30 + ((x * 13) % 30); box(x, y - h, 16, h, (x % 3) ? BLUE : AMBER, 1.1, 0.8); L([x + 5, y - h], [x + 5, y - h - 12], DIM, 1); L([x + 11, y - h], [x + 11, y - h - 12], DIM, 1); }
        }
        L([0, 430], [W, 430], BLUE, 1.8);
        L([0, 444], [W, 444], DIM, 1.2);
        for (let x = 40; x < W; x += 160) L([x, 444], [x, FLOOR], FRAME, 1);
        const on = Math.sin(t * 0.9) > -0.95;
        tag("BAR", 640, 70, on ? RED : DIM, "center", 38);
        for (const x of [300, 980]) { L([x, 0], [x, 40], DIM, 1.2); path([[x - 30, 70], [x - 12, 40], [x + 12, 40], [x + 30, 70], [x - 30, 70]], AMBER, 1.3); }
        floorLine();
      },
      seat: [0, 1, FLOOR - 120],
    },
    "living-room": {
      draw: () => {
        window_(120, 110, 220, 190);
        for (const s of [-1, 1]) path(Array.from({ length: 8 }, (_, k) => [230 + s * (125 + 6 * Math.sin(k)), 90 + k * 35] as P2), DIM, 1.3);
        frame_(560, 130, 150, 110);
        frame_(740, 160, 90, 70);
        lamp(1090, FLOOR, 250);
        // the couch
        const x0 = X(0.28), x1 = X(0.74);
        path([[x0, FLOOR - 70], [x0, FLOOR - 190], [x1, FLOOR - 190], [x1, FLOOR - 70]], BLUE, 1.6);
        L([x0 - 30, FLOOR - 70], [x1 + 30, FLOOR - 70], BLUE, 1.8);
        for (const x of [x0 - 30, x1 + 30]) box(x - 10, FLOOR - 120, 40, 50, BLUE, 1.4);
        L([(x0 + x1) / 2, FLOOR - 70], [(x0 + x1) / 2, FLOOR - 180], DIM, 1.2);
        for (const x of [x0 - 10, x1 + 10]) L([x, FLOOR - 70], [x, FLOOR], DIM, 1.4);
        path(Array.from({ length: 41 }, (_, k) => [640 + 470 * Math.cos((k / 40) * 2 * Math.PI), FLOOR + 22 + 12 * Math.sin((k / 40) * 2 * Math.PI)] as P2), FRAME, 1.2, 0.9);
        floorLine(DIM);
      },
      seat: [0.24, 0.78, FLOOR - 72],
    },
    kitchen: {
      draw: (t) => {
        for (let x = 80; x < 1020; x += 120) box(x, 80, 110, 130, BLUE, 1.3);
        window_(440, 240, 200, 130, false);
        clock(820, 300, t);
        L([60, 440], [1040, 440], BLUE, 1.8);
        for (let x = 80; x < 1020; x += 120) { box(x, 452, 110, 140, DIM, 1.2); L([x + 90, 500], [x + 90, 530], BLUE, 1.2); }
        L([500, 440], [500, 400], WHITE, 1.3); L([500, 400], [530, 400], WHITE, 1.3);
        box(1070, 160, 160, 440, WHITE, 1.5); L([1070, 330], [1230, 330], WHITE, 1.2); L([1090, 200], [1090, 290], WHITE, 1.6); L([1090, 370], [1090, 460], WHITE, 1.6);
        floorLine();
      },
    },
    office: {
      draw: (t) => {
        box(90, 90, 340, 230, BLUE, 1.4);
        for (let y = 104; y < 320; y += 14) L([96, y], [424, y], DIM, 1, 0.9);
        box(560, 110, 200, 130, AMBER, 1.3, 0.9);
        tag("SYNERGY", 660, 165, AMBER, "center", 20);
        path([[600, 225], [640, 190], [680, 205], [720, 160]], GREEN, 1.3);
        clock(880, 150, t);
        for (const x of [180, 980]) {
          L([x - 110, 440], [x + 110, 440], BLUE, 1.8);
          L([x - 100, 440], [x - 100, FLOOR], DIM, 1.4); L([x + 100, 440], [x + 100, FLOOR], DIM, 1.4);
          box(x - 50, 352, 92, 64, BLUE, 1.4); L([x - 4, 416], [x - 4, 440], BLUE, 1.4);
          path(Array.from({ length: 20 }, (_, k) => [x - 44 + k * 4, 384 + 8 * Math.sin(k * 0.8 + t * 3)] as P2), GREEN, 1, 0.8);
        }
        box(1150, 300, 70, 70, WHITE, 1.3); L([1185, 370], [1185, FLOOR], WHITE, 1.3); L([1160, FLOOR], [1210, FLOOR], WHITE, 1.3);
        plant(560, FLOOR);
        floorLine();
      },
    },
    classroom: {
      draw: (t) => {
        box(180, 90, 760, 300, GREEN, 1.6, 0.8);
        tag("2 + 2 = ?", 330, 170, WHITE, "left", 34);
        path(Array.from({ length: 30 }, (_, k) => [330 + k * 15, 250 + 10 * Math.sin(k * 1.3)] as P2), WHITE, 1, 0.6);
        path(Array.from({ length: 22 }, (_, k) => [330 + k * 15, 300 + 8 * Math.sin(k * 1.9)] as P2), WHITE, 1, 0.6);
        L([180, 404], [940, 404], DIM, 1.4);
        clock(1070, 140, t);
        L([1020, 470], [1220, 470], BLUE, 1.8); box(1035, 470, 170, 130, DIM, 1.3);
        floorLine();
      },
    },
    newsroom: {
      draw: (t) => {
        box(260, 80, 760, 310, BLUE, 1.5);
        tag("NEWS 9", 380, 136, RED, "left", 36);
        for (let i = 0; i < 5; i++) L([300, 180 + i * 40], [980, 180 + i * 40], FRAME, 1);
        circle(860, 230, 80, DIM, 1.3); L([780, 230], [940, 230], DIM, 1); L([860, 150], [860, 310], DIM, 1);
        box(-4, 8, W + 8, 40, RED, 1.4);
        const msg = "BREAKING  ·  LOCAL MAN HAS OPINION  ·  WEATHER: SOME  ·  ";
        const off = (t * 120) % 900;
        tag(msg + msg, 40 - off, 36, WHITE, "left", 18);
        floorLine(DIM);
      },
      front: () => {
        path([[X(0.14), 450], [X(0.86), 450], [X(0.82), FLOOR], [X(0.18), FLOOR], [X(0.14), 450]], BLUE, 1.8);
        L([X(0.16), 470], [X(0.84), 470], DIM, 1.2);
        tag("NEWS 9", 640, 540, BLUE, "center", 26);
      },
    },
    hospital: {
      draw: (t) => {
        for (let k = 0; k < 8; k++) path(Array.from({ length: 10 }, (_, j) => [80 + k * 30 + 6 * Math.sin(j + k), 60 + j * 52] as P2), DIM, 1.2, 0.9);
        L([60, 60], [340, 60], DIM, 1.4);
        box(840, 120, 200, 140, GREEN, 1.5);
        const pts: P2[] = [];
        for (let i = 0; i <= 60; i++) { const ph = ((i / 60) * 3 + t * 1.2) % 1; const y = ph > 0.45 && ph < 0.5 ? -50 : ph > 0.5 && ph < 0.55 ? 30 : 0; pts.push([850 + i * 3, 200 + y]); }
        path(pts, GREEN, 1.4);
        L([940, 260], [940, FLOOR], DIM, 1.3);
        L([1140, 140], [1140, FLOOR], WHITE, 1.3); L([1110, 140], [1170, 140], WHITE, 1.3); path([[1150, 150], [1176, 150], [1176, 200], [1150, 200], [1150, 150]], BLUE, 1.2);
        path([[X(0.32), 470], [X(0.78), 470], [X(0.78), 430], [X(0.84), 430], [X(0.84), FLOOR]], WHITE, 1.6);
        L([X(0.32), 430], [X(0.32), FLOOR], WHITE, 1.6);
        floorLine();
      },
    },
    street: {
      draw: (t) => {
        const bld: [number, number, number][] = [[0, 180, 230], [240, 90, 200], [450, 240, 170], [640, 130, 260], [920, 60, 180], [1110, 200, 170]];
        for (const [x, top, w] of bld) {
          path([[x, FLOOR - 60], [x, top], [x + w, top], [x + w, FLOOR - 60]], FRAME, 1.4);
          for (let wy = top + 30; wy < FLOOR - 100; wy += 60) for (let wx = x + 25; wx < x + w - 30; wx += 55) box(wx, wy, 26, 30, ((wx * 3 + wy) % 7) < 2 ? AMBER : FRAME, 1.1, ((wx + wy) % 5) < 2 ? 0.9 : 0.6);
        }
        circle(1060, 50, 22, AMBER, 1.3);
        L([0, FLOOR - 60], [W, FLOOR - 60], DIM, 1.2);
        L([X(0.86), FLOOR], [X(0.86), 250], BLUE, 1.6); path([[X(0.86), 250], [X(0.86) - 40, 240]], BLUE, 1.6);
        path([[X(0.86) - 52, 246], [X(0.86) - 100, FLOOR]], AMBER, 0.8, 0.35); path([[X(0.86) - 28, 246], [X(0.86) + 30, FLOOR]], AMBER, 0.8, 0.35);
        floorLine();
        L([0, FLOOR + 30], [W, FLOOR + 30], DIM, 1.2);
        for (let x = (-(t * 0) % 120); x < W; x += 120) L([x, FLOOR + 70], [x + 60, FLOOR + 70], DIM, 1.4, 0.7);
      },
    },
    park: {
      draw: (t) => {
        circle(980, 90, 34, AMBER, 1.4);
        for (const [sx, sy] of [[120, 60], [300, 120], [520, 40], [700, 140], [1180, 60], [860, 30]]) circle(sx, sy, 1.6, WHITE, 1, 0.5 + 0.5 * Math.sin(t * 2 + sx), 6);
        L([150, FLOOR], [170, 300], BLUE, 2); L([190, FLOOR], [176, 300], BLUE, 2);
        for (let k = 0; k < 9; k++) circle(170 + 90 * Math.cos(k * 0.7), 250 + 50 * Math.sin(k * 1.3) - 20, 60 + (k % 3) * 10, GREEN, 1.2, 0.6);
        // the bench
        const x0 = X(0.3), x1 = X(0.65);
        L([x0, FLOOR - 62], [x1, FLOOR - 62], BLUE, 1.8);
        L([x0, FLOOR - 120], [x1, FLOOR - 120], BLUE, 1.6); L([x0, FLOOR - 100], [x1, FLOOR - 100], BLUE, 1.4);
        for (const x of [x0 + 10, x1 - 10]) { L([x, FLOOR - 62], [x, FLOOR], DIM, 1.5); L([x, FLOOR - 62], [x, FLOOR - 125], DIM, 1.3); }
        for (const x of [1080, 1180]) circle(x, FLOOR - 26, 30, GREEN, 1.2, 0.7);
        floorLine(DIM);
      },
      seat: [0.28, 0.67, FLOOR - 64],
    },
    car: {
      draw: (t) => {
        for (let k = 0; k < 5; k++) {
          const x = W - ((t * 420 + k * 330) % (W + 330));
          L([x, FLOOR - 40], [x, 160], DIM, 1.4); L([x, 160], [x - 30, 150], DIM, 1.4); circle(x - 36, 156, 6, AMBER, 1, 0.8, 8);
        }
        for (let k = 0; k < 10; k++) { const x = W - ((t * 900 + k * 160) % (W + 160)); L([x, FLOOR + 50], [x + 70, FLOOR + 50], DIM, 1.4); }
        L([0, FLOOR + 20], [W, FLOOR + 20], DIM, 1.2);
      },
      front: (t) => {
        // the car from the side, nose to the right: a cabin tall enough for the heads
        const b = Math.sin(t * 9) * 1.5;
        const y = (v: number) => v + b;
        path([[110, y(590)], [120, y(470)], [190, y(455)], [265, y(70)], [850, y(62)], [1060, y(430)], [1205, y(462)], [1215, y(590)], [110, y(590)]], BLUE, 2);
        L([640, y(66)], [632, y(462)], BLUE, 1.5);
        L([120, y(470)], [1205, y(470)], DIM, 1.2);
        L([150, y(530)], [1180, y(530)], DIM, 1);
        path(Array.from({ length: 25 }, (_, k) => [930 + 14 * Math.cos((k / 24) * 2 * Math.PI), y(395) + 48 * Math.sin((k / 24) * 2 * Math.PI)] as P2), WHITE, 1.6);
        L([930, y(395)], [1000, y(460)], DIM, 1.4);
        for (const x of [300, 1030]) { circle(x, y(595), 56, WHITE, 1.8); circle(x, y(595), 20, DIM, 1.2); const a = t * 14; L([x, y(595)], [x + 44 * Math.cos(a), y(595) + 44 * Math.sin(a)], DIM, 1.2); }
        box(1190, y(486), 24, 18, AMBER, 1.2);
        box(108, y(486), 16, 18, RED, 1.2);
      },
      seat: [0.25, 0.85, 470],
      camera: "wide",
    },
    void: { draw: () => floorLine(DIM) },
  };

  // ------------------------------------------------------------ who is where
  interface Body { torso: number; legs: number; head: number; belly: number; shake: number; crate: number; stiff: boolean; props: string[]; color: string }
  const bodyOf = (who: string): Body => {
    const c = tl.cast[who];
    const child = c && (c.voice === "boy" || c.voice === "girl");
    const h = c?.height ?? (child ? 0.62 : c?.voice === "woman" || c?.voice === "old-woman" ? 0.95 : 1);
    return {
      torso: 120 * h, legs: 132 * h, head: 270 * (0.5 + 0.5 * h), belly: c?.build === "round" ? 1 : 0, shake: c?.nervous ?? 0,
      crate: c?.props.includes("crate") ? 56 : 0, stiff: !!c?.stiff, props: c?.props ?? [], color: COLOR[c?.color ?? "white"] ?? WHITE,
    };
  };
  interface State { x: number; on: boolean; pose: string; facing: number; walking: boolean; stride: number }
  const stateAt = (si: number, who: string, t: number): State | null => {
    const sc = tl.scenes[si];
    if (si !== lastScene) { lastScene = si; lastStageCam = lastCam = WIDE; }
    const p0 = sc.people.find((p) => p.who === who);
    if (!p0) return null;
    const s: State = { x: p0.x, on: p0.on, pose: p0.pose, facing: p0.facing === "left" ? -1 : 1, walking: false, stride: 0 };
    type E = { t: number; f: () => void };
    const es: E[] = [];
    for (const m of tl.moves) if (m.scene === si && m.who === who && m.t0 <= t) es.push({ t: m.t0, f: () => {
      if (t >= m.t1) { s.x = m.to; s.on = m.on; s.facing = m.after === "left" ? -1 : 1; s.pose = "stand"; s.walking = false; }
      else { const u = (t - m.t0) / (m.t1 - m.t0); s.x = m.from + (m.to - m.from) * u; s.on = true; s.facing = m.facing === "left" ? -1 : 1; s.pose = "stand"; s.walking = true; s.stride = Math.abs(s.x - m.from) * 1000 / 34; }
    } });
    for (const p of tl.poses) if (p.scene === si && p.who === who && p.t <= t) es.push({ t: p.t, f: () => { if (p.pose) s.pose = p.pose; if (p.facing) s.facing = p.facing === "left" ? -1 : 1; } });
    es.sort((a, b) => a.t - b.t).forEach((e) => e.f());
    return s;
  };

  // ------------------------------------------------------------ bodies
  type Mood = "idle" | "talk" | "laugh" | "one" | "groan" | "aww" | "woo" | "who" | "cough" | "gasp" | "cheer" | "boo" | "sigh" | "scream" | "hmm";
  /** someone standing (or walking) at foot x, facing dir; returns their mouth */
  function standing(who: string, fx: number, dir: number, artic: number[], mood: Mood, t: number, dt: number, st: State, micX: number | null): P2 {
    const b = bodyOf(who);
    const floor = FLOOR - (b.crate && !st.walking ? b.crate : 0);
    const sh = st.walking ? 0 : b.shake * 2.2;
    const sway = b.stiff || st.walking ? 0 : 3 * Math.sin(t * 1.1 + fx);
    const bob = st.walking ? -Math.abs(Math.sin(st.stride)) * 5 : 0;
    const hip: P2 = [fx - dir * 6 + sway * 0.4, floor - b.legs + bob];
    let lean = 0;
    if (mood === "laugh" || mood === "one") lean = -0.06 + 0.05 * Math.sin(t * 9);
    else if (mood === "cough" || mood === "groan") lean = 0.18 + (mood === "cough" ? 0.08 * Math.max(0, Math.sin(t * 15)) : 0);
    else if (mood === "sigh") lean = 0.08;
    else if (mood === "gasp" || mood === "scream") lean = -0.1;
    const neck: P2 = [hip[0] + dir * b.torso * Math.sin(lean) + sway, hip[1] - b.torso * Math.cos(lean)];
    if (b.crate && !st.walking) {
      box(fx - 62, floor, 116, b.crate, BLUE, 1.5);
      L([fx - 62, floor], [fx + 54, floor + b.crate], DIM, 1);
      L([fx + 54, floor], [fx - 62, floor + b.crate], DIM, 1);
    }
    const back = mood === "laugh" ? 0.18 + 0.06 * Math.sin(t * 9) : mood === "scream" ? 0.25 : mood === "gasp" ? 0.15 : mood === "cough" || mood === "groan" ? -0.2 : 0;
    const tilt = b.shake && !st.walking ? 0.012 * Math.sin(t * 31) : 0;
    const head = headOf(who);
    if (head.drawnAt !== t) { head.draw(artic, dt); head.drawnAt = t; }
    const mouth = put(head, neck[0], neck[1] + 4, b.head, dir, back + tilt);
    if (b.belly) path(Array.from({ length: 13 }, (_, k) => { const u = k / 12; return [neck[0] + (hip[0] - neck[0]) * u + dir * 58 * Math.sin(Math.PI * u) ** 0.8 * (0.35 + 0.65 * u), neck[1] + (hip[1] - neck[1]) * u] as P2; }), b.color, 1.9);
    L(neck, hip, b.color, 1.9);
    // legs: a stride while walking, shaking knees when nervous
    for (const [i, dx] of ([[0, -24], [1, 16]] as const)) {
      let foot: P2, knee: P2;
      if (st.walking) {
        const ph = st.stride + i * Math.PI;
        foot = [hip[0] + dir * 30 * Math.sin(ph), floor - Math.max(0, Math.cos(ph)) * 10];
        knee = [(hip[0] + foot[0]) / 2 + dir * 14, hip[1] + b.legs * 0.5];
      } else {
        foot = [hip[0] + dx * 0.8, floor];
        knee = [hip[0] + dx * 0.55 + sh * Math.sin(t * 38 + dx), hip[1] + b.legs * 0.5];
      }
      L(hip, knee, b.color, 1.9);
      L(knee, foot, b.color, 1.9);
      L(foot, [foot[0] + dir * 22, foot[1]], b.color, 1.9);
    }
    // arms
    const S: P2 = [neck[0] - dir * 2, neck[1] + 16];
    const arm = b.torso * 0.5;
    const swing = st.walking ? Math.sin(st.stride) * 26 : 0;
    const far: P2 = b.stiff ? [S[0] - dir * 6, S[1] + arm * 1.95] : [S[0] - dir * (22 - swing) + 4 * Math.sin(t * 2.1), S[1] + arm * 1.85];
    limb(S, far, arm, dir, b.color);
    const held = b.props.find((p) => p !== "crate" && p !== "mic-stand");
    let hand: P2;
    if (mood === "cough" || mood === "gasp") hand = [mouth[0] - dir * 6, mouth[1] + 12];
    else if (mood === "groan") hand = [mouth[0] - dir * 30, mouth[1] - 50];
    else if (held === "mic") hand = [mouth[0] + dir * 14, mouth[1] + 22];
    else if (held === "phone" && mood === "talk") hand = [neck[0] + dir * 10, neck[1] - b.head * 0.25];
    else if (b.stiff) hand = [S[0] + dir * 8, S[1] + arm * 1.95];
    else if (held === "cards" || held === "book" || held === "newspaper") hand = [S[0] + dir * 62, S[1] + 34 + 3 * Math.sin(t * 2)];
    else if (st.walking) hand = [S[0] + dir * swing, S[1] + arm * 1.85];
    else if (mood === "talk") hand = [S[0] + dir * (60 + (b.belly ? 34 : 16) * Math.sin(t * 5.3)), S[1] + 30 + (b.belly ? 30 : 14) * Math.sin(t * 7.1 + 1)];
    else if (mood === "laugh") hand = [S[0] + dir * 30, S[1] + arm * 1.4 + 10 * Math.sin(t * 9)];
    else hand = b.shake ? [S[0] + dir * 30, S[1] + 62 + 3 * Math.sin(t * 33)] : [S[0] + dir * 18, S[1] + arm * 1.9];
    limb(S, hand, arm, -dir, b.color);
    heldProp(held, hand, dir, mouth);
    // a microphone on a stand, brought to whoever stands at it
    if (micX !== null || b.props.includes("mic-stand")) {
      const mic: P2 = micX !== null && Math.abs(fx + dir * b.head * 0.38 - micX) > 60 ? [micX, FLOOR - 300] : [mouth[0] + dir * 34, mouth[1] + 6];
      micStand(mic, dir);
    }
    if (b.shake && !st.walking && mood !== "talk") {
      const u = (t * 0.9) % 1;
      const dx = neck[0] - dir * 30, dy = neck[1] - b.head * 0.85 + u * 60;
      path([[dx, dy], [dx - 5, dy + 10], [dx, dy + 16], [dx + 5, dy + 10], [dx, dy]], BLUE, 1.2, 1 - u);
    }
    return mouth;
  }
  const micStand = (mic: P2, dir: number) => {
    const base = mic[0] + dir * 46;
    L([base, FLOOR], [base, mic[1] + 40], BLUE, 1.7);
    L([base - 30, FLOOR], [base + 30, FLOOR], BLUE, 2);
    L([base, mic[1] + 40], [mic[0] + dir * 10, mic[1] + 6], BLUE, 1.7);
    ring(ctx, mic[0], mic[1], 12, WHITE, 1.7);
    L([mic[0] - 8, mic[1]], [mic[0] + 8, mic[1]], BLUE, 1);
    L([mic[0], mic[1] - 8], [mic[0], mic[1] + 8], BLUE, 1);
  };
  function heldProp(p: string | undefined, hand: P2, dir: number, mouth: P2) {
    if (!p) return;
    const [x, y] = hand;
    if (p === "cards") { box(x - 2, y - 30, 34 * dir, 26, GREEN, 1.3); L([x + dir * 4, y - 21], [x + dir * 26, y - 21], GREEN, 1, 0.8); L([x + dir * 4, y - 14], [x + dir * 22, y - 14], GREEN, 1, 0.8); }
    else if (p === "drink") glass(x + dir * 4, y + 4, 34, BLUE, 0.5);
    else if (p === "mic") { L([x, y], [mouth[0] + dir * 8, mouth[1] + 6], DIM, 2.2); ring(ctx, mouth[0] + dir * 10, mouth[1] + 2, 8, WHITE, 1.5); }
    else if (p === "phone") box(x - 6, y - 24, 12, 26, WHITE, 1.3);
    else if (p === "book") { path([[x, y - 36], [x + dir * 26, y - 30], [x + dir * 26, y + 4], [x, y - 2], [x, y - 36]], AMBER, 1.3); path([[x, y - 36], [x - dir * 4, y - 30], [x - dir * 4, y + 4], [x, y - 2]], AMBER, 1.1); }
    else if (p === "newspaper") { box(x - dir * 8, y - 70, dir * 70, 90, WHITE, 1.3); for (let k = 0; k < 5; k++) L([x, y - 58 + k * 14], [x + dir * 50, y - 58 + k * 14], DIM, 1); }
    else if (p === "briefcase") { box(x - 26, y + 8, 52, 38, AMBER, 1.4); path([[x - 10, y + 8], [x - 8, y], [x + 8, y], [x + 10, y + 8]], AMBER, 1.2); }
  }
  /** someone in a seat, facing dir: hips at (hx, seat); returns their mouth */
  function seated(head: Head, artic: number[], hx: number, seat: number, floor: number, k: number, dir: number, mood: Mood, t: number, dt: number, ph: number, color: string, drawChair: boolean, props: string[] = [], size = 150): P2 {
    const T = 104 * k;
    let lean = 0.04, tilt = 0, bob = 0;
    if (mood === "laugh" || mood === "one") { lean = 0.02 + 0.13 * Math.sin(t * 9 + ph); tilt = 0.16 + 0.07 * Math.sin(t * 9 + ph); bob = 3 * k * Math.sin(t * 18 + ph); }
    else if (mood === "groan" || mood === "boo") { lean = 0.3; tilt = -0.3; }
    else if (mood === "aww" || mood === "sigh") { lean = 0.1; tilt = -0.2 + 0.04 * Math.sin(t * 3 + ph); }
    else if (mood === "woo" || mood === "cheer") { lean = -0.05; tilt = 0.15; }
    else if (mood === "who" || mood === "talk") { lean = 0.18; }
    else if (mood === "cough") { const j = Math.max(0, Math.sin(t * 15 + ph)); lean = 0.2 + 0.14 * j; tilt = -0.18 - 0.1 * j; }
    else if (mood === "gasp" || mood === "scream") { lean = -0.12; tilt = 0.2; }
    else { lean = 0.04 + 0.015 * Math.sin(t * 0.9 + ph); }
    const hip: P2 = [hx, seat];
    const neck: P2 = [hx + dir * T * Math.sin(lean), seat - T * Math.cos(lean) + bob];
    if (drawChair) chair(hx, seat, floor, dir, k);
    if (head.drawnAt !== t) { head.draw(artic, dt); head.drawnAt = t; }
    const mouth = put(head, neck[0], neck[1] + 3 * k, size * k, dir, tilt);
    L(neck, hip, color, 2.2);
    const knee: P2 = [hx + dir * 60 * k, seat - 2 * k];
    L(hip, knee, color, 1.9);
    L(knee, [hx + dir * 56 * k, floor], color, 1.9);
    L([hx + dir * 56 * k, floor], [hx + dir * 76 * k, floor], color, 1.9);
    const S: P2 = [neck[0] + (hip[0] - neck[0]) * 0.14, neck[1] + (hip[1] - neck[1]) * 0.14];
    const a = 52 * k;
    const lap: P2 = [hx + dir * 38 * k, seat - 10 * k];
    let h1: P2 = lap, h2: P2 = [lap[0] - dir * 8 * k, lap[1] + 2 * k];
    if (mood === "laugh") { const c = Math.abs(Math.sin(t * 13 + ph)) * 16 * k; const m: P2 = [S[0] + dir * 66 * k, S[1] + 30 * k + bob]; h1 = [m[0], m[1] - c]; h2 = [m[0] - dir * 3 * k, m[1] + c]; }
    else if (mood === "woo" || mood === "cheer") { h1 = [S[0] + dir * 20 * k, S[1] - 78 * k + 6 * Math.sin(t * 12 + ph)]; h2 = [S[0] - dir * 16 * k, S[1] - 80 * k + 6 * Math.sin(t * 12 + ph + 1)]; }
    else if (mood === "cough" || mood === "who" || mood === "gasp") { h1 = [mouth[0] - dir * 10 * k, mouth[1] + 10 * k]; }
    else if (mood === "groan") { h1 = [mouth[0] - dir * 16 * k, mouth[1] - 44 * k]; h2 = [S[0] + dir * 4 * k, S[1] + 84 * k]; }
    else if (mood === "talk") { h1 = [S[0] + dir * (50 + 12 * Math.sin(t * 5)) * k, S[1] + (36 + 10 * Math.sin(t * 7)) * k]; }
    limb(S, h1, a, -dir, color, 2.2);
    limb(S, h2, a, -dir, color, 2.2);
    const held = props.find((p) => p !== "crate" && p !== "mic-stand");
    if (held && mood !== "laugh") heldProp(held, h2, dir, mouth);
    return mouth;
  }

  // ------------------------------------------------------------ the camera
  interface Cam { world: "stage" | "house"; cx: number; cy: number; zoom: number }
  const WIDE: Cam = { world: "stage", cx: W / 2, cy: H / 2, zoom: 1 };
  const clampCam = (c: Cam): Cam => {
    const hw = W / 2 / c.zoom, hh = H / 2 / c.zoom;
    return { ...c, cx: Math.max(hw, Math.min(W - hw, c.cx)), cy: Math.max(hh, Math.min(H - hh, c.cy)) };
  };
  const headCentre = (who: string, st: State): P2 => {
    const b = bodyOf(who);
    const fx = X(st.x);
    if (st.pose === "sit") return [fx + st.facing * 40, seatY(st.x) - 104 - b.head * 0.25];
    return [fx + st.facing * b.head * 0.12, FLOOR - (b.crate ?? 0) - b.legs - b.torso - b.head * 0.35];
  };
  let curSet: SetDef = SETS.void;
  const seatY = (x: number) => (curSet.seat && x >= curSet.seat[0] && x <= curSet.seat[1] ? curSet.seat[2] : FLOOR - 64);

  // the house: the audience's seats, two tiers facing the stage (to the left)
  const seatPos = (sc: Scene, i: number): { hx: number; floor: number } => {
    const n = sc.audience!.seats;
    const rows = n <= 4 ? 1 : 2, per = Math.ceil(n / rows);
    const row = Math.floor(i / per), col = i % per;
    const floor = rows === 1 ? 600 : row === 0 ? 334 : 672;
    const span = 1060 / per;
    return { hx: 200 + span * (col + 0.5) + (rows === 2 && row === 0 ? 30 : 0), floor };
  };
  const CROWD_CAPTION: Record<string, string> = { laugh: "[ LAUGHTER ]", one: "[ ONE LAUGH ]", groan: "[ GROANS ]", aww: "[ AWW ]", woo: "[ A WOO ]", who: "[ WHO'S THERE? ]", cough: "[ COUGHING ]", gasp: "[ GASPS ]", cheer: "[ CHEERING ]", boo: "[ BOOING ]" };
  const ACT_CAPTION: Record<string, string> = { cough: "COUGHS", laugh: "LAUGHS", sigh: "SIGHS", gasp: "GASPS", scream: "SCREAMS", groan: "GROANS", hmm: "HMMS" };
  const SEAT_PHASE = [0.3, 2.1, 4.4, 1.2, 5.3, 3.3, 0.9, 2.7, 1.7, 4.9, 0.1, 3.8];
  const soloSeat = new Map<number, number>();
  tl.crowd.forEach((c, k) => soloSeat.set(c.t0, [2, 5, 0, 4, 1, 6, 3][k % 7]));

  function house(sc: Scene, crowds: Crowd[], line: Line | undefined, t: number, dt: number): Record<string, P2> {
    bricks(H);
    box(1150, 22, 96, 40, GREEN, 1.4);
    tag("EXIT", 1198, 51, GREEN, "center", 20);
    const n = sc.audience!.seats, members = sc.audience!.members;
    const anon = n - members.length;
    const rows = n <= 4 ? 1 : 2;
    for (let r = 0; r < rows; r++) {
      const floor = rows === 1 ? 600 : r === 0 ? 334 : 672;
      L([r === 0 && rows === 2 ? 60 : 0, floor], [W, floor], BLUE, 1.7);
      if (r === 0 && rows === 2) { L([60, floor], [60, floor + 26], BLUE, 1.7); L([60, floor + 26], [W, floor + 26], DIM, 1.2); }
    }
    const heads: Record<string, P2> = {};
    for (let i = 0; i < n; i++) {
      const { hx, floor } = seatPos(sc, i);
      const named = i >= anon ? members[i - anon] : null;
      let a = REST, mood: Mood = "idle";
      if (named) {
        if (line && line.who === named) { a = at(line, t); mood = line.do ? (line.do as Mood) : "talk"; }
      } else {
        for (const c of crowds) {
          const m = c.members.find((m, k) => (c.n === 1 ? i === (soloSeat.get(c.t0) ?? 0) % anon : k % anon === i) && t >= m.t0 && t <= m.t1 + 0.15);
          if (m) { a = at(m, Math.min(t, m.t1)); mood = c.kind as Mood; }
        }
      }
      const color = named ? bodyOf(named).color : WHITE;
      table(hx - 112, floor - 78, floor, 64, DIM);
      glass(hx - 112 + (i % 3) * 8 - 8, floor - 79, i % 2 ? 26 : 34, named ? color : BLUE, 0.3 + 0.1 * (i % 5));
      const head = named ? headOf(named) : seatHeads[i % seatHeads.length];
      const mouth = seated(head, a, hx, floor - 64, floor, 1, -1, mood, t, dt, SEAT_PHASE[i % SEAT_PHASE.length], color, true, named ? bodyOf(named).props : []);
      if (named) heads[named] = [mouth[0] + 30, mouth[1] - 20];
    }
    return heads;
  }

  // ------------------------------------------------------------ captions
  const caption = (text: string, color: string, size = 28) => {
    const lines = wrapLabel(ctx, text, W - 260, { size, ls: 0.06 });
    const y = H - 30 - (lines.length - 1) * size * 1.35;
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(110, y - size * 1.15, W - 220, lines.length * size * 1.35 + size * 0.5);
    lines.forEach((s, i) => label(ctx, s, W / 2, y + i * size * 1.35, { size, color, align: "center", ls: 0.06 }));
  };
  const firstLine = new Map<string, Line>();
  for (const l of tl.lines) if (!firstLine.has(l.who) && l.where !== "voiceover") firstLine.set(l.who, l);

  // ------------------------------------------------------------ a frame
  let lastStageCam: Cam = WIDE;
  let lastCam: Cam = WIDE;
  let quiet = 0;
  let lastScene = -1;
  function draw(t: number, dt: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    for (const h of castHeads.values()) h.drawnAt = -1;
    for (const h of seatHeads) h.drawnAt = -1;

    const card = tl.cards.find((c) => t >= c.t0 && t < c.t1);
    if (card) {
      const lines = wrapLabel(ctx, card.text.toUpperCase(), W - 300, { size: 46, ls: 0.12 });
      lines.forEach((s, i) => label(ctx, s, W / 2, H / 2 - (lines.length - 1) * 30 + i * 60, { size: 46, color: WHITE, align: "center", ls: 0.12 }));
      L([W / 2 - 160, H / 2 + lines.length * 30 + 10], [W / 2 + 160, H / 2 + lines.length * 30 + 10], AMBER, 1.6);
      glow.apply(canvas, ctx, 1);
      return;
    }
    let si = tl.scenes.findIndex((s) => t >= s.t0 && t < s.t1);
    if (si < 0) si = t < (tl.scenes[0]?.t0 ?? 0) ? 0 : tl.scenes.length - 1;
    const sc = tl.scenes[si];
    if (si !== lastScene) { lastScene = si; lastStageCam = lastCam = WIDE; }
    curSet = SETS[sc.set] ?? SETS.void;
    const line = tl.lines.find((l) => l.scene === si && t >= l.t0 - 0.12 && t <= l.t1 + 0.25);
    const crowds = tl.crowd.filter((c) => c.scene === si && t >= c.t0 - 0.05 && t <= c.t1 + 0.1);
    const crowd = crowds[crowds.length - 1];
    quiet = line || crowd ? 0 : quiet + dt;
    const people = sc.people.map((p) => ({ who: p.who, st: stateAt(si, p.who, t)! })).filter((p) => p.st && p.st.on);
    const walking = people.some((p) => p.st.walking);
    const onStage = (who: string) => people.find((p) => p.who === who);

    // who the camera is on
    let cam: Cam = lastStageCam;
    const shotOver = tl.shots.find((s) => s.scene === si && t >= s.t0 && t <= s.t1)?.shot ?? (line ? line.shot : null);
    const closeOn = (who: string): Cam | null => {
      const p = onStage(who);
      if (p) { const [cx, cy] = headCentre(who, p.st); return clampCam({ world: "stage", cx, cy: cy + 40, zoom: 1.4 }); }
      if (sc.audience && sc.audience.members.includes(who)) {
        const i = sc.audience.seats - sc.audience.members.length + sc.audience.members.indexOf(who);
        const { hx, floor } = seatPos(sc, i);
        return clampCam({ world: "house", cx: hx - 30, cy: floor - 200, zoom: 2.1 });
      }
      return null;
    };
    if (shotOver === "wide") cam = WIDE;
    else if (shotOver === "audience" && sc.audience) cam = { world: "house", cx: W / 2, cy: H / 2, zoom: 1 };
    else if (shotOver === "close" && line) cam = closeOn(line.who) ?? lastCam;
    else if (shotOver && tl.cast[shotOver]) cam = closeOn(shotOver) ?? lastCam;
    else if (line && line.where === "audience") cam = closeOn(line.who) ?? lastCam;
    else if (line && line.where === "stage") {
      const mode = sc.camera === "auto" && curSet.camera ? curSet.camera : sc.camera;
      if (mode === "wide" || walking) cam = WIDE;
      else if (mode === "follow" || people.length >= 2) cam = closeOn(line.who) ?? WIDE;
      else cam = WIDE;
    } else if (line) cam = lastCam;
    else if (crowd && crowd.visible && sc.audience) cam = { world: "house", cx: W / 2, cy: H / 2, zoom: 1 };
    else if (walking) cam = WIDE;
    else cam = lastStageCam;
    if (cam.world === "stage") lastStageCam = cam;
    lastCam = cam;
    zoomNow = cam.zoom;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.cx, -cam.cy);
    if (cam.world === "house" && sc.audience) house(sc, crowds, line, t, dt);
    else {
      // the act at the club's microphone: whoever stands nearest it
      const micAt = curSet.mic !== undefined ? X(curSet.mic) : null;
      let atMic: string | null = null;
      if (micAt !== null) {
        let best = 1e9;
        for (const p of people) { const d = Math.abs(X(p.st.x) + bodyOf(p.who).head * 0.38 - micAt); if (p.st.pose === "stand" && !p.st.walking && p.st.facing > 0 && d < 90 && d < best) { best = d; atMic = p.who; } }
        const near = people.filter((p) => p.st.pose === "stand").sort((a, b) => Math.abs(X(a.st.x) - micAt) - Math.abs(X(b.st.x) - micAt))[0];
        stageName = atMic ?? near?.who ?? stageName;
      }
      curSet.draw(t);
      if (micAt !== null && !atMic) micStand([micAt - 34, FLOOR - 300], 1);
      // everyone, back to front by x so overlaps read
      for (const p of people.sort((a, b) => a.st.x - b.st.x)) {
        const speaking = line && line.who === p.who && line.where === "stage" ? line : undefined;
        const a = speaking ? at(speaking, t) : REST;
        const mood: Mood = speaking ? ((speaking.do as Mood) ?? "talk") : crowd && !crowd.visible && crowd.kind === "laugh" ? "idle" : "idle";
        const b = bodyOf(p.who);
        if (p.st.pose === "sit") {
          const inSeat = !!(curSet.seat && p.st.x >= curSet.seat[0] && p.st.x <= curSet.seat[1]);
          const seat = seatY(p.st.x);
          const k = b.torso / 120;
          seated(headOf(p.who), a, X(p.st.x), seat, FLOOR, Math.max(0.6, k), p.st.facing, speaking ? mood : "idle", t, dt, p.who.length, b.color, !inSeat, b.props, b.head / Math.max(0.6, k));
        } else {
          standing(p.who, X(p.st.x), p.st.facing, a, mood, t, dt, p.st, atMic === p.who ? micAt : null);
        }
      }
      curSet.front?.(t);
    }
    ctx.restore();

    // name tags the first time someone speaks
    if (line && firstLine.get(line.who) === line && line.where !== "voiceover") {
      const c = bodyOf(line.who).color;
      tag(line.who.toUpperCase(), 60, 70, c, "left", 26);
      L([60, 84], [60 + Math.min(300, 20 * line.who.length + 40), 84], c, 1.4, 0.8);
    }
    if (tl.captions) {
      if (line) {
        const c = bodyOf(line.who).color;
        if (line.do) caption(`[ ${line.who.toUpperCase()} ${ACT_CAPTION[line.do] ?? line.do.toUpperCase()} ]`, AMBER, 24);
        else caption((line.where === "voiceover" ? `${line.who.toUpperCase()} (V.O.): ` : line.where === "off" ? `${line.who.toUpperCase()} (OFF): ` : "") + line.text.toUpperCase(), c === WHITE ? WHITE : c);
      } else if (crowd) caption(CROWD_CAPTION[crowd.kind] ?? "", AMBER, 24);
      else if (quiet > 1.1 && sc.audience && !walking) caption("[ SILENCE ]", AMBER, 24);
    }
    glow.apply(canvas, ctx, 1);
  }

  // ------------------------------------------------------------ play or encode
  if (params.has("render")) {
    const { Muxer, ArrayBufferTarget } = await import(/* @vite-ignore */ `${location.origin}/film/webm-muxer.mjs`);
    const ac = new OfflineAudioContext(2, 48000, 48000);
    const audio = await ac.decodeAudioData(await (await fetch(base + "audio.wav")).arrayBuffer());
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "V_VP9", width: W, height: H, frameRate: FPS }, audio: { codec: "A_OPUS", sampleRate: 48000, numberOfChannels: 2 }, firstTimestampBehavior: "offset" });
    const fail = (e: unknown) => ((window as any).__error = String(e));
    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: fail });
    venc.configure({ codec: "vp09.00.31.08", width: W, height: H, bitrate: 3_000_000, framerate: FPS });
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: fail });
    aenc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 160_000 });
    const n = audio.length, CH = 4800;
    const Lc = audio.getChannelData(0), Rc = audio.getChannelData(1);
    for (let i = 0; i < n; i += CH) {
      const len = Math.min(CH, n - i);
      const data = new Float32Array(len * 2);
      data.set(Lc.subarray(i, i + len), 0);
      data.set(Rc.subarray(i, i + len), len);
      const ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round((i / 48000) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    const frames = Math.floor(tl.duration * FPS);
    for (let i = 0; i < frames; i++) {
      const t = i / FPS;
      draw(t, 1 / FPS);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
      venc.encode(vf, { keyFrame: i % 60 === 0 });
      vf.close();
      while (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
      if (i % 30 === 0) (window as any).__progress = t / tl.duration;
    }
    await venc.flush();
    await aenc.flush();
    muxer.finalize();
    (window as any).__video = new Uint8Array(muxer.target.buffer);
    (window as any).__done = true;
    return;
  }
  // stills: ?still&at=1,5,9 draws each time and keeps a PNG of it
  if (params.has("still")) {
    const ts = (params.get("at") ?? "1").split(",").map(Number);
    const out: string[] = [];
    for (const t of ts) {
      // run the half second before so faces and blinks settle
      for (let k = 15; k >= 1; k--) draw(Math.max(0, t - k / FPS), 1 / FPS);
      draw(t, 1 / FPS);
      out.push(canvas.toDataURL("image/jpeg", 0.88));
    }
    (window as any).__stills = out;
    (window as any).__done = true;
    return;
  }
  const audio = new Audio(base + "audio.wav");
  audio.currentTime = Number(params.get("t") ?? 0);
  canvas.onclick = () => (audio.paused ? void audio.play() : audio.pause());
  (window as any).__seek = (t: number) => { audio.currentTime = t; draw(t, 1 / FPS); };
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    draw(audio.currentTime, dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void main().catch((e) => {
  (window as any).__error = String(e?.stack ?? e);
  console.error(e);
});
