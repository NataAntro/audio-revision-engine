import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssetStore,
  StaleRevisionError,
  Timeline,
  sha256,
} from "../src/audio.ts";

function fixture() {
  const assets = new AssetStore(16_000);
  const base = assets.add(Int16Array.of(10, 20, 30, 40, 50, 60));
  const pickup = assets.add(Int16Array.of(-7, -8));
  return {
    assets,
    pickup,
    timeline: new Timeline(assets, [assets.clip(base, 0, 6)]),
  };
}

function samples(wav: Buffer): number[] {
  return Array.from({ length: wav.readUInt32LE(40) / 2 }, (_, i) =>
    wav.readInt16LE(44 + 2 * i),
  );
}

test("writes standard mono PCM headers and replaces exactly the selected frames", () => {
  const { assets, pickup, timeline } = fixture();
  const rev = timeline.replace(1, 1, 4, [
    assets.clip(pickup, 0, 2),
    { kind: "silence", frames: 2 },
  ]);
  const wav = timeline.render(rev.id);
  assert.equal(wav.toString("ascii", 0, 12).slice(8), "WAVE");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(samples(wav), [10, -7, -8, 0, 0, 50, 60]);
  assert.deepEqual(samples(timeline.render(1)), [10, 20, 30, 40, 50, 60]);
});

test("edits across an existing splice in current timeline coordinates", () => {
  const { assets, pickup, timeline } = fixture();
  timeline.replace(1, 0, 0, [assets.clip(pickup, 0, 2)]);
  timeline.replace(2, 1, 4, []);
  assert.deepEqual(samples(timeline.render(3)), [-7, 30, 40, 50, 60]);
});

test("restore records a new revision and recreates the original WAV byte for byte", () => {
  const { timeline } = fixture();
  timeline.replace(1, 0, 3, []);
  const restored = timeline.restore(2, 1);
  assert.deepEqual(
    [restored.id, restored.parent, restored.restoredFrom],
    [3, 2, 1],
  );
  assert.equal(sha256(timeline.render(3)), sha256(timeline.render(1)));
  assert.deepEqual(samples(timeline.render(2)), [40, 50, 60]);
});

test("stale edits, invalid assets, and invalid ranges do not advance the head", () => {
  const { timeline } = fixture();
  timeline.replace(1, 6, 6, [{ kind: "silence", frames: 1 }]);
  assert.throws(() => timeline.replace(1, 0, 1, []), StaleRevisionError);
  assert.throws(() => timeline.replace(2, 3, 8, []), RangeError);
  assert.throws(
    () =>
      timeline.replace(2, 0, 1, [
        { kind: "clip", asset: "missing", offset: 0, frames: 1 },
      ]),
    /Unknown audio asset/,
  );
  assert.throws(() => timeline.restore(2, 3), RangeError);
  assert.equal(timeline.head.id, 2);
});

test("source buffers and caller-provided spans cannot mutate history", () => {
  const store = new AssetStore(16_000);
  const input = Int16Array.of(-1, 2);
  const id = store.add(input);
  assert.equal(store.add(Int16Array.of(-1, 2)), id);
  const span = { kind: "clip" as const, asset: id, offset: 0, frames: 2 };
  const timeline = new Timeline(store, [span]);
  input.fill(9);
  span.frames = 1;
  assert.ok(Object.isFrozen(timeline.head.spans[0]));
  assert.deepEqual(samples(timeline.render(1)), [-1, 2]);
});
