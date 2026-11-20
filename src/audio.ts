import { createHash } from "node:crypto";

export type Span =
  | Readonly<{ kind: "clip"; asset: string; offset: number; frames: number }>
  | Readonly<{ kind: "silence"; frames: number }>;

export type Revision = Readonly<{
  id: number;
  parent: number | null;
  restoredFrom: number | null;
  frames: number;
  spans: readonly Span[];
}>;

function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function encodeWav(samples: Int16Array, rate: number): Buffer {
  if (!integer(rate, 8_000, 192_000) || samples.length > 0x7fffffed) {
    throw new RangeError("Unsupported PCM dimensions");
  }
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let frame = 0; frame < samples.length; frame++) {
    wav.writeInt16LE(samples[frame]!, 44 + frame * 2);
  }
  return wav;
}

export class AssetStore {
  readonly #samples = new Map<string, Int16Array>();
  readonly #rate: number;

  constructor(rate: number) {
    if (!integer(rate, 8_000, 192_000))
      throw new RangeError("Unsupported sample rate");
    this.#rate = rate;
  }

  get rate(): number {
    return this.#rate;
  }

  add(samples: Int16Array): string {
    const copy = new Int16Array(samples);
    const id = sha256(encodeWav(copy, this.rate));
    if (!this.#samples.has(id)) this.#samples.set(id, copy);
    return id;
  }

  clip(asset: string, offset: number, frames: number): Span {
    const length = this.#get(asset).length;
    if (!integer(offset, 0, length) || !integer(frames, 1, length - offset)) {
      throw new RangeError("Clip outside its source asset");
    }
    return Object.freeze({ kind: "clip", asset, offset, frames });
  }

  copy(
    span: Extract<Span, { kind: "clip" }>,
    output: Int16Array,
    offset: number,
  ): void {
    output.set(
      this.#get(span.asset).subarray(span.offset, span.offset + span.frames),
      offset,
    );
  }

  #get(id: string): Int16Array {
    const asset = this.#samples.get(id);
    if (!asset) throw new Error("Unknown audio asset");
    return asset;
  }
}

// Slice the current timeline while retaining offsets into the original assets.
function slice(spans: readonly Span[], start: number, end: number): Span[] {
  const result: Span[] = [];
  let position = 0;
  for (const span of spans) {
    const from = Math.max(start, position);
    const to = Math.min(end, position + span.frames);
    if (from < to) {
      const frames = to - from;
      result.push(
        span.kind === "clip"
          ? { ...span, offset: span.offset + from - position, frames }
          : { kind: "silence", frames },
      );
    }
    position += span.frames;
    if (position >= end) break;
  }
  return result;
}

export class StaleRevisionError extends Error {}

export class Timeline {
  readonly #assets: AssetStore;
  readonly #revisions: Revision[] = [];

  constructor(assets: AssetStore, initial: readonly Span[]) {
    this.#assets = assets;
    this.#save(
      initial.map((span) => this.#validate(span)),
      null,
      null,
    );
  }

  get head(): Revision {
    return this.#revisions.at(-1)!;
  }

  get(id: number): Revision {
    if (!integer(id, 1, this.#revisions.length))
      throw new RangeError("Unknown revision");
    return this.#revisions[id - 1]!;
  }

  // Half-open frame coordinates in the audible timeline of expectedRevision.
  replace(
    expectedRevision: number,
    start: number,
    end: number,
    insert: readonly Span[],
  ): Revision {
    const current = this.#requireHead(expectedRevision);
    if (
      !integer(start, 0, current.frames) ||
      !integer(end, start, current.frames)
    ) {
      throw new RangeError("Invalid timeline range");
    }
    const spans = [
      ...slice(current.spans, 0, start),
      ...insert.map((span) => this.#validate(span)),
      ...slice(current.spans, end, current.frames),
    ];
    return this.#save(spans, current.id, null);
  }

  restore(expectedRevision: number, targetRevision: number): Revision {
    const current = this.#requireHead(expectedRevision);
    return this.#save(
      this.get(targetRevision).spans,
      current.id,
      targetRevision,
    );
  }

  render(id: number): Buffer {
    const revision = this.get(id);
    const output = new Int16Array(revision.frames);
    let offset = 0;
    for (const span of revision.spans) {
      if (span.kind === "clip") this.#assets.copy(span, output, offset);
      offset += span.frames;
    }
    return encodeWav(output, this.#assets.rate);
  }

  #validate(span: Span): Span {
    switch (span.kind) {
      case "clip":
        return this.#assets.clip(span.asset, span.offset, span.frames);
      case "silence":
        if (!integer(span.frames, 1, this.#assets.rate * 600)) {
          throw new RangeError("Invalid silence length");
        }
        return Object.freeze({ kind: "silence", frames: span.frames });
      default:
        throw new TypeError("Unknown span type");
    }
  }

  #requireHead(expected: number): Revision {
    if (this.head.id !== expected)
      throw new StaleRevisionError("The timeline has changed");
    return this.head;
  }

  #save(
    spans: readonly Span[],
    parent: number | null,
    restoredFrom: number | null,
  ): Revision {
    const frames = spans.reduce((total, span) => total + span.frames, 0);
    if (!integer(frames, 0, this.#assets.rate * 600))
      throw new RangeError("Timeline exceeds ten minutes");
    const revision = Object.freeze({
      id: this.#revisions.length + 1,
      parent,
      restoredFrom,
      frames,
      spans: Object.freeze(spans.map((span) => Object.freeze(span))),
    });
    this.#revisions.push(revision);
    return revision;
  }
}
