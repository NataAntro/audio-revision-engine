import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AssetStore, Timeline, sha256 } from "./audio.ts";

const rate = 16_000;
const assets = new AssetStore(rate);

// An envelope keeps the demonstration tones from clicking at their edges.
function tone(hz: number, seconds: number): Int16Array {
  const count = Math.round(rate * seconds);
  return Int16Array.from({ length: count }, (_, i) => {
    const envelope = Math.min(1, i / 120, (count - 1 - i) / 120);
    return Math.round(
      Math.sin((2 * Math.PI * hz * i) / rate) * envelope * 6_000,
    );
  });
}

const low = assets.add(tone(330, 0.35));
const middle = assets.add(tone(440, 0.35));
const high = assets.add(tone(550, 0.35));
const pickup = assets.add(tone(660, 0.25));
const frames = Math.round(rate * 0.35);
const timeline = new Timeline(assets, [
  assets.clip(low, 0, frames),
  assets.clip(middle, 0, frames),
  assets.clip(high, 0, frames),
]);
const original = timeline.head;
const edited = timeline.replace(original.id, frames, frames * 2, [
  assets.clip(pickup, 0, rate / 4),
  { kind: "silence", frames: rate / 5 },
]);
const restored = timeline.restore(edited.id, original.id);

const output = "out";
await mkdir(output, { recursive: true });
const report = await Promise.all(
  (
    [
      ["original", original],
      ["edited", edited],
      ["restored", restored],
    ] as const
  ).map(async ([label, revision]) => {
    const wav = timeline.render(revision.id);
    const name = label + ".wav";
    await writeFile(join(output, name), wav);
    return { name, revision, sha256: sha256(wav) };
  }),
);
if (
  report[0]!.sha256 !== report[2]!.sha256 ||
  report[0]!.sha256 === report[1]!.sha256
) {
  throw new Error("Unexpected revision audio");
}
await writeFile(
  join(output, "revisions.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.table(
  report.map(({ name, revision, sha256 }) => ({
    name,
    revision: revision.id,
    parent: revision.parent,
    seconds: revision.frames / rate,
    sha256: sha256.slice(0, 12),
  })),
);
