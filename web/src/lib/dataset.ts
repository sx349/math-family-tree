/**
 * The whole Mathematics Genealogy advisor graph, in memory.
 *
 * Nodes are addressed by a dense index 0..N-1 assigned in ascending MGP id
 * order.  Everything the app does — search, neighbourhood expansion, lowest
 * common ancestors — works on those indices against flat typed arrays, so there
 * is no backend and no per-query network traffic.  MGP ids only appear at the
 * edges of the system: in URLs and in links back to genealogy.math.ndsu.nodak.edu.
 */

import { Reader, cumulative, fetchBinary, fetchJsonGz, prefixSum } from './binary';

export const STUB_FLAG = 1;
export const MULTI_DEGREE_FLAG = 2;

export interface Manifest {
  formatVersion: number;
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  stubCount: number;
  shardBits: number;
  shardCount: number;
  files: Record<string, number>;
  coreBytes: number;
  snapshot: { peopleFromSource: number | null; cyclesFound: number | null; sourceFile: string | null };
}

export interface Dicts {
  schools: string[];
  countries: string[];
  degreeTypes: string[];
  mscs: string[];
  mscLabels: Record<string, string>;
}

export interface DegreeDetail {
  type: string;
  year: number | null;
  msc: string;
  schools: string[];
  thesis: string;
  advisors: number[];
}

export interface PersonDetail {
  mrauth: string;
  degrees: DegreeDetail[];
}

export interface Person {
  index: number;
  id: number;
  family: string;
  given: string;
  other: string;
  /** True when MGP references this person but we have no record for them. */
  isStub: boolean;
  year: number | null;
  school: string;
  country: string;
  degreeType: string;
  msc: string;
  mscLabel: string;
  studentCount: number;
  advisorCount: number;
}

export type LoadStage = { label: string; loaded: number; total: number };

const CORE_FILES = [
  'graph.bin.gz',
  'names.bin.gz',
  'order.bin.gz',
  'meta.bin.gz',
  'dicts.json.gz',
  'fold-exceptions.json.gz',
] as const;

export class Dataset {
  readonly count: number;

  // Graph, CSR in both directions.
  readonly ids: Uint32Array;
  readonly childOffsets: Uint32Array;
  readonly childTargets: Uint32Array;
  readonly parentOffsets: Uint32Array;
  readonly parentTargets: Uint32Array;

  // Names: one UTF-8 blob, sliced on demand. Decoding all 332k names up front
  // would cost far more time and memory than the handful ever displayed.
  private readonly nameBlob: Uint8Array;
  private readonly nameOffsets: Uint32Array;
  private readonly decoder = new TextDecoder();
  private readonly nameCache = new Map<number, string[]>();

  /** Node indices sorted by folded name — the index prefix search binaries over. */
  readonly nameOrder: Uint32Array;
  /** Nodes whose folded name is more than a lowercase of the display form. */
  private readonly foldExceptions: Map<number, string>;

  readonly years: Uint16Array;
  readonly schoolIds: Uint16Array;
  readonly countryIds: Uint16Array;
  readonly degreeIds: Uint16Array;
  readonly mscIds: Uint16Array;
  readonly flags: Uint8Array;
  readonly studentCounts: Uint16Array;

  readonly dicts: Dicts;
  readonly manifest: Manifest;
  private readonly baseUrl: string;
  private readonly shardCache = new Map<number, Promise<Record<string, PersonDetail>>>();

  private constructor(init: {
    manifest: Manifest;
    baseUrl: string;
    graph: ArrayBuffer;
    names: ArrayBuffer;
    order: ArrayBuffer;
    meta: ArrayBuffer;
    dicts: Dicts;
    foldExceptions: { indices: number[]; folded: string[] };
  }) {
    this.manifest = init.manifest;
    this.baseUrl = init.baseUrl;
    this.dicts = init.dicts;

    const graph = new Reader(init.graph);
    graph.expectMagic('MGPG');
    const version = graph.u32();
    if (version !== 1) throw new Error(`Unsupported graph format version ${version}`);
    this.count = graph.u32();
    const edgeCount = graph.u32();
    this.ids = cumulative(graph.u32Array(this.count));
    this.childOffsets = prefixSum(graph.u16Array(this.count));
    this.childTargets = graph.u32Array(edgeCount);
    this.parentOffsets = prefixSum(graph.u16Array(this.count));
    this.parentTargets = graph.u32Array(edgeCount);

    const names = new Reader(init.names);
    names.expectMagic('MGPN');
    names.u32();
    const nameCount = names.u32();
    this.nameOffsets = prefixSum(names.u16Array(nameCount));
    const blobLength = names.u32();
    this.nameBlob = names.u8Array(blobLength);

    const order = new Reader(init.order);
    order.expectMagic('MGPO');
    order.u32();
    this.nameOrder = order.u32Array(order.u32());

    const meta = new Reader(init.meta);
    meta.expectMagic('MGPM');
    meta.u32();
    const metaCount = meta.u32();
    this.years = meta.u16Array(metaCount);
    this.schoolIds = meta.u16Array(metaCount);
    this.countryIds = meta.u16Array(metaCount);
    this.degreeIds = meta.u16Array(metaCount);
    this.mscIds = meta.u16Array(metaCount);
    this.flags = meta.u8Array(metaCount);
    this.studentCounts = meta.u16Array(metaCount);

    this.foldExceptions = new Map(
      init.foldExceptions.indices.map((index, i) => [index, init.foldExceptions.folded[i]]),
    );
  }

  static async load(
    baseUrl: string,
    onProgress?: (stage: LoadStage) => void,
    signal?: AbortSignal,
  ): Promise<Dataset> {
    const manifest = (await (await fetch(`${baseUrl}/manifest.json`, { signal })).json()) as Manifest;

    let loaded = 0;
    const total = CORE_FILES.reduce((sum, file) => sum + (manifest.files[file] ?? 0), 0);
    const track = async <T>(file: string, load: () => Promise<T>): Promise<T> => {
      const result = await load();
      loaded += manifest.files[file] ?? 0;
      onProgress?.({ label: file, loaded, total });
      return result;
    };

    // Fetched in parallel: six requests over one connection, and the browser
    // gunzips them concurrently.
    const [graph, names, order, meta, dicts, foldExceptions] = await Promise.all([
      track('graph.bin.gz', () => fetchBinary(`${baseUrl}/graph.bin.gz`, signal)),
      track('names.bin.gz', () => fetchBinary(`${baseUrl}/names.bin.gz`, signal)),
      track('order.bin.gz', () => fetchBinary(`${baseUrl}/order.bin.gz`, signal)),
      track('meta.bin.gz', () => fetchBinary(`${baseUrl}/meta.bin.gz`, signal)),
      track('dicts.json.gz', () => fetchJsonGz<Dicts>(`${baseUrl}/dicts.json.gz`, signal)),
      track('fold-exceptions.json.gz', () =>
        fetchJsonGz<{ indices: number[]; folded: string[] }>(`${baseUrl}/fold-exceptions.json.gz`, signal),
      ),
    ]);

    return new Dataset({ manifest, baseUrl, graph, names, order, meta, dicts, foldExceptions });
  }

  // ---------------------------------------------------------------- lookups

  /** MGP id -> dense index, by binary search over the ascending id column. */
  indexOfId(id: number): number {
    let low = 0;
    let high = this.count - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const value = this.ids[mid];
      if (value === id) return mid;
      if (value < id) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  /** `[family, given, other]` for a node. */
  nameParts(index: number): string[] {
    const cached = this.nameCache.get(index);
    if (cached) return cached;
    const start = this.nameOffsets[index];
    const parts = this.decoder
      .decode(this.nameBlob.subarray(start, this.nameOffsets[index + 1]))
      .split('\t');
    while (parts.length < 3) parts.push('');
    // Bounded so that scrolling long result lists cannot grow this without limit.
    if (this.nameCache.size > 20000) this.nameCache.clear();
    this.nameCache.set(index, parts);
    return parts;
  }

  /** "Deng, Yu" — the form MGP itself uses. */
  displayName(index: number): string {
    const [family, given, other] = this.nameParts(index);
    const rest = [given, other].filter(Boolean).join(' ');
    if (!family) return rest || `#${this.ids[index]}`;
    return rest ? `${family}, ${rest}` : family;
  }

  /** Name folded for search; matches `fold()` in the pipeline exactly. */
  foldedName(index: number): string {
    const exception = this.foldExceptions.get(index);
    if (exception !== undefined) return exception;
    const start = this.nameOffsets[index];
    return this.decoder
      .decode(this.nameBlob.subarray(start, this.nameOffsets[index + 1]))
      .toLowerCase();
  }

  isStub(index: number): boolean {
    return (this.flags[index] & STUB_FLAG) !== 0;
  }

  advisors(index: number): Uint32Array {
    return this.parentTargets.subarray(this.parentOffsets[index], this.parentOffsets[index + 1]);
  }

  students(index: number): Uint32Array {
    return this.childTargets.subarray(this.childOffsets[index], this.childOffsets[index + 1]);
  }

  person(index: number): Person {
    const [family, given, other] = this.nameParts(index);
    const msc = this.dicts.mscs[this.mscIds[index]] ?? '';
    const school = this.dicts.schools[this.schoolIds[index]] ?? '';
    return {
      index,
      id: this.ids[index],
      family,
      given,
      other,
      isStub: this.isStub(index),
      year: this.years[index] || null,
      // The country is baked into MGP's school string; strip it for display.
      school: school.includes(', ') ? school.slice(0, school.lastIndexOf(', ')) : school,
      country: this.dicts.countries[this.countryIds[index]] ?? '',
      degreeType: this.dicts.degreeTypes[this.degreeIds[index]] ?? '',
      msc,
      mscLabel: this.dicts.mscLabels[msc] ?? '',
      studentCount: this.students(index).length,
      advisorCount: this.advisors(index).length,
    };
  }

  /** Thesis titles and full degree history, fetched per 1024-node shard. */
  async detail(index: number): Promise<PersonDetail | null> {
    const shard = index >> this.manifest.shardBits;
    let pending = this.shardCache.get(shard);
    if (!pending) {
      const name = String(shard).padStart(4, '0');
      pending = fetchJsonGz<Record<string, PersonDetail>>(`${this.baseUrl}/detail/${name}.json.gz`);
      this.shardCache.set(shard, pending);
    }
    try {
      return (await pending)[String(index)] ?? null;
    } catch {
      this.shardCache.delete(shard); // allow a retry on transient failure
      return null;
    }
  }

  mgpUrl(index: number): string {
    return `https://www.genealogy.math.ndsu.nodak.edu/id.php?id=${this.ids[index]}`;
  }
}
