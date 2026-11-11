// Drives the server the way an agent would, over stdio.
// Usage: bun test-client.ts <spec.json> [stills t,t,…] [render name]   (stills go to /tmp/chimera-film-stills)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [specPath, at, render] = process.argv.slice(2);
const c = new Client({ name: "test", version: "0" });
await c.connect(new StdioClientTransport({ command: "bun", args: [fileURLToPath(new URL("./server.ts", import.meta.url))], stderr: "inherit" }));
console.log("tools:", (await c.listTools()).tools.map((t) => t.name).join(", "));
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const show = (r: any) => r.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
console.log(show(await c.callTool({ name: "check_film", arguments: { spec } })));
if (at) {
  const r: any = await c.callTool({ name: "film_stills", arguments: { spec, at: at.split(",").map(Number) } });
  mkdirSync("/tmp/chimera-film-stills", { recursive: true });
  let k = 0;
  for (const x of r.content) if (x.type === "image") writeFileSync(`/tmp/chimera-film-stills/${k++}.jpg`, Buffer.from(x.data, "base64"));
  console.log(show(r), `\n${k} stills in /tmp/chimera-film-stills`);
}
if (render) console.log(show(await c.callTool({ name: "render_film", arguments: { spec, name: render } }, undefined, { timeout: 3_600_000, onprogress: (p) => process.stderr.write(`\r${p.progress}% ${p.message}   `) })));
await c.close();
