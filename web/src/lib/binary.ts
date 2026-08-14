/**
 * Readers for the binary artifacts written by `pipeline/build_web.py`.
 *
 * Every array in those files starts at a 4-byte aligned offset, which lets us
 * map them as typed-array views over the fetched buffer with no copying — the
 * whole 332k-node graph becomes usable without allocating per-node objects.
 */

/** Fetch and gunzip an artifact. */
export async function fetchBinary(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load ${url} (HTTP ${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // A host that serves .gz with `Content-Encoding: gzip` will have already
  // decompressed this for us, so decompress only if the magic number is intact.
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return buffer;

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser lacks DecompressionStream; please use a current browser.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

export async function fetchJsonGz<T>(url: string, signal?: AbortSignal): Promise<T> {
  const buffer = await fetchBinary(url, signal);
  return JSON.parse(new TextDecoder().decode(buffer)) as T;
}

/** Sequential reader mirroring the writer's alignment rule. */
export class Reader {
  private offset = 0;

  constructor(private readonly buffer: ArrayBuffer) {}

  private align(bytes: number): void {
    this.offset = Math.ceil(this.offset / bytes) * bytes;
  }

  expectMagic(magic: string): void {
    const actual = String.fromCharCode(...new Uint8Array(this.buffer, 0, 4));
    if (actual !== magic) {
      throw new Error(`Bad artifact header: expected ${magic}, got ${actual}`);
    }
    this.offset = 4;
  }

  u32(): number {
    this.align(4);
    const value = new DataView(this.buffer).getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u32Array(length: number): Uint32Array {
    this.align(4);
    const view = new Uint32Array(this.buffer, this.offset, length);
    this.offset += length * 4;
    return view;
  }

  u16Array(length: number): Uint16Array {
    this.align(4);
    const view = new Uint16Array(this.buffer, this.offset, length);
    this.offset += length * 2;
    return view;
  }

  u8Array(length: number): Uint8Array {
    this.align(4);
    const view = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return view;
  }
}

/**
 * Turn per-node neighbour counts into CSR offsets.
 *
 * The artifacts ship counts rather than cumulative offsets because small
 * repetitive numbers compress dramatically better; this is the one pass needed
 * to get back to a directly indexable structure.
 */
export function prefixSum(counts: Uint16Array): Uint32Array {
  const offsets = new Uint32Array(counts.length + 1);
  let total = 0;
  for (let i = 0; i < counts.length; i++) {
    offsets[i] = total;
    total += counts[i];
  }
  offsets[counts.length] = total;
  return offsets;
}

/** Undo the delta encoding of the ascending MGP id column. */
export function cumulative(deltas: Uint32Array): Uint32Array {
  const values = new Uint32Array(deltas.length);
  let running = 0;
  for (let i = 0; i < deltas.length; i++) {
    running += deltas[i];
    values[i] = running;
  }
  return values;
}
