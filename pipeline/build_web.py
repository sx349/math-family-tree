#!/usr/bin/env python3
"""Build the static data artifacts the web app loads.

The entire advisor DAG plus every name fits in a few megabytes gzipped, so the
site ships the whole graph to the browser and does all traversal locally.  There
is no backend and no per-query server work.

Artifacts (all gzip, decompressed in the browser via DecompressionStream):

  manifest.json          plain JSON; counts, snapshot date, file list
  graph.bin.gz           node ids + child/parent adjacency in CSR form
  names.bin.gz           "family\\tgiven\\tother" per node, in node-id order
  order.bin.gz           node indices sorted by folded name (prefix search)
  fold-exceptions.json.gz  nodes whose folded name is not just lowercase
  meta.bin.gz            per-node year/school/country/degree/MSC, column-major
  dicts.json.gz          string tables the meta columns index into
  detail/NNNN.json.gz    full degree records, sharded by node index

Nodes are addressed by a dense index 0..N-1 assigned in ascending MGP id order,
so every array here is parallel and lookups are O(1) without a hash map.

Name folding is split between this script and the browser: 92.5% of names fold
to a plain lowercase of the display form, so only the remaining exceptions are
shipped.  That keeps the browser from having to run Unicode normalization over
the whole name table on every page load, and guarantees the folding used for
search exactly matches the precomputed sort order.
"""

from __future__ import annotations

import argparse
import gzip
import json
import struct
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

FORMAT_VERSION = 1
SHARD_BITS = 10  # 1024 nodes per detail shard

# Characters Unicode NFKD does not decompose but that searchers expect to be
# interchangeable with their ASCII forms ("Gauß" must be findable as "gauss").
FOLD_MAP = {
    "ß": "ss", "ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe",
    "đ": "d", "Đ": "d", "ł": "l", "Ł": "l", "ð": "d", "Ð": "d", "þ": "th",
    "Þ": "th", "ı": "i", "İ": "i", "ŉ": "n",
}

# Top-level Mathematics Subject Classification headings, so the site can show
# "Fluid mechanics" rather than the bare code MGP stores.
MSC_LABELS = {
    "00": "General and overarching topics", "01": "History and biography",
    "03": "Mathematical logic and foundations", "05": "Combinatorics",
    "06": "Order, lattices, ordered algebraic structures", "08": "General algebraic systems",
    "11": "Number theory", "12": "Field theory and polynomials",
    "13": "Commutative algebra", "14": "Algebraic geometry",
    "15": "Linear and multilinear algebra; matrix theory", "16": "Associative rings and algebras",
    "17": "Nonassociative rings and algebras", "18": "Category theory; homological algebra",
    "19": "K-theory", "20": "Group theory and generalizations",
    "22": "Topological groups, Lie groups", "26": "Real functions",
    "28": "Measure and integration", "30": "Functions of a complex variable",
    "31": "Potential theory", "32": "Several complex variables and analytic spaces",
    "33": "Special functions", "34": "Ordinary differential equations",
    "35": "Partial differential equations", "37": "Dynamical systems and ergodic theory",
    "39": "Difference and functional equations", "40": "Sequences, series, summability",
    "41": "Approximations and expansions", "42": "Harmonic analysis on Euclidean spaces",
    "43": "Abstract harmonic analysis", "44": "Integral transforms, operational calculus",
    "45": "Integral equations", "46": "Functional analysis",
    "47": "Operator theory", "49": "Calculus of variations and optimal control",
    "51": "Geometry", "52": "Convex and discrete geometry",
    "53": "Differential geometry", "54": "General topology",
    "55": "Algebraic topology", "57": "Manifolds and cell complexes",
    "58": "Global analysis, analysis on manifolds", "60": "Probability theory and stochastic processes",
    "62": "Statistics", "65": "Numerical analysis",
    "68": "Computer science", "70": "Mechanics of particles and systems",
    "74": "Mechanics of deformable solids", "76": "Fluid mechanics",
    "78": "Optics, electromagnetic theory", "80": "Classical thermodynamics, heat transfer",
    "81": "Quantum theory", "82": "Statistical mechanics, structure of matter",
    "83": "Relativity and gravitational theory", "85": "Astronomy and astrophysics",
    "86": "Geophysics", "90": "Operations research, mathematical programming",
    "91": "Game theory, economics, social and behavioral sciences",
    "92": "Biology and other natural sciences", "93": "Systems theory; control",
    "94": "Information and communication theory, circuits", "97": "Mathematics education",
}


def fold(text: str) -> str:
    """Normalize a name for case- and diacritic-insensitive search.

    The browser reimplements this as `lowercase + exception lookup`; any change
    here must keep that equivalence intact.
    """
    text = "".join(FOLD_MAP.get(c, c) for c in text)
    text = unicodedata.normalize("NFKD", text)
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def read_snapshot(path: Path) -> Iterator[dict[str, Any]]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def write_gz(path: Path, payload: bytes) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 keeps rebuilds byte-identical when the data has not changed,
    # which keeps Git LFS from storing a new object on every run.
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as out:
        out.write(payload)
    return path.stat().st_size


class StringTable:
    """Interns strings, reserving index 0 for "absent"."""

    def __init__(self) -> None:
        self._index: dict[str, int] = {}
        self.values: list[str] = [""]

    def intern(self, value: str) -> int:
        if not value:
            return 0
        if (existing := self._index.get(value)) is not None:
            return existing
        self._index[value] = len(self.values)
        self.values.append(value)
        return len(self.values) - 1


def country_of(school: str) -> str:
    """MGP stores school and country as one string: "MIT, United States"."""
    return school.rsplit(", ", 1)[-1].strip() if ", " in school else ""


def build(snapshot_path: Path, out_dir: Path) -> dict[str, Any]:
    people = sorted(read_snapshot(snapshot_path), key=lambda p: p["id"])
    count = len(people)
    index_of = {person["id"]: i for i, person in enumerate(people)}

    # ---------------- graph: CSR adjacency in both directions ----------------
    children: list[list[int]] = [[] for _ in range(count)]
    parents: list[list[int]] = [[] for _ in range(count)]
    for i, person in enumerate(people):
        for student_id in person["students"]:
            if (j := index_of.get(student_id)) is not None:
                children[i].append(j)
        for advisor_id in person["advisors"]:
            if (j := index_of.get(advisor_id)) is not None:
                parents[i].append(j)
    for lst in children:
        lst.sort()
    for lst in parents:
        lst.sort()

    # Neighbour *counts* are shipped rather than cumulative offsets, and ids as
    # successive deltas: both are small, highly repetitive numbers that gzip
    # crushes, whereas the monotonically increasing forms are near-incompressible.
    # The browser prefix-sums them back into CSR offsets in a single pass.
    def csr(adjacency: list[list[int]]) -> tuple[bytes, bytes, int]:
        flat = [node for neighbours in adjacency for node in neighbours]
        return (
            struct.pack(f"<{len(adjacency)}H", *(len(n) for n in adjacency)),
            struct.pack(f"<{len(flat)}I", *flat),
            len(flat),
        )

    child_counts, child_targets, edge_count = csr(children)
    parent_counts, parent_targets, _ = csr(parents)

    ids = [p["id"] for p in people]
    id_deltas = [ids[0]] + [ids[i] - ids[i - 1] for i in range(1, count)]

    graph = b"".join([
        b"MGPG",
        struct.pack("<III", FORMAT_VERSION, count, edge_count),
        struct.pack(f"<{count}I", *id_deltas),
        child_counts, child_targets,
        parent_counts, parent_targets,
    ])

    # ---------------- names + search order ----------------
    display = [f"{p['family']}\t{p['given']}\t{p['other']}" for p in people]
    folded = [fold(d) for d in display]

    # Byte lengths rather than offsets, for the same compression reason as above.
    blob = "".join(display).encode("utf-8")
    lengths = [len(text.encode("utf-8")) for text in display]
    if max(lengths, default=0) > 65535:
        raise ValueError("a name exceeds the uint16 length field")
    names = b"".join([
        b"MGPN",
        struct.pack("<II", FORMAT_VERSION, count),
        struct.pack(f"<{count}H", *lengths),
        struct.pack("<I", len(blob)),
        blob,
    ])

    order = sorted(range(count), key=lambda i: (folded[i], i))
    order_bytes = b"MGPO" + struct.pack("<II", FORMAT_VERSION, count) + struct.pack(
        f"<{count}I", *order
    )

    exceptions = {i: folded[i] for i in range(count) if display[i].lower() != folded[i]}
    fold_exceptions = {
        "indices": list(exceptions),
        "folded": list(exceptions.values()),
    }

    # ---------------- per-node metadata, stored column-major ----------------
    # Column-major (all years, then all schools, ...) compresses far better than
    # interleaved records because each column is a low-entropy run.
    schools, countries, degree_types, mscs = (StringTable() for _ in range(4))
    years, school_ids, country_ids, degree_ids, msc_ids, flags, student_counts = (
        [] for _ in range(7)
    )

    for person in people:
        degrees = person["degrees"]
        # The primary degree is the earliest dated one; it is what the site
        # labels a node with and what search filters match against.
        primary = min(
            degrees, key=lambda d: (d["year"] is None, d["year"] or 0)
        ) if degrees else {}
        school = (primary.get("schools") or [""])[0]
        years.append(primary.get("year") or 0)
        school_ids.append(schools.intern(school))
        country_ids.append(countries.intern(country_of(school)))
        degree_ids.append(degree_types.intern(primary.get("type") or ""))
        msc = primary.get("msc") or ""
        msc_ids.append(mscs.intern("" if msc.lower() == "unknown" else msc))
        flags.append((1 if person["stub"] else 0) | (2 if len(degrees) > 1 else 0))
        student_counts.append(min(len(person["students"]), 65535))

    def column(values: list[int], fmt: str) -> bytes:
        return struct.pack(f"<{len(values)}{fmt}", *values)

    for table, name in ((schools, "schools"), (countries, "countries")):
        if len(table.values) > 65535:
            raise ValueError(f"{name} table exceeds uint16 range")

    meta = b"".join([
        b"MGPM",
        struct.pack("<II", FORMAT_VERSION, count),
        column(years, "H"),
        column(school_ids, "H"),
        column(country_ids, "H"),
        column(degree_ids, "H"),
        column(msc_ids, "H"),
        column(flags, "B"),
        column(student_counts, "H"),
    ])

    dicts = {
        "schools": schools.values,
        "countries": countries.values,
        "degreeTypes": degree_types.values,
        "mscs": mscs.values,
        "mscLabels": MSC_LABELS,
    }

    # ---------------- detail shards ----------------
    # Thesis titles are 20 MB of text — far too much for the initial load, and
    # only ever needed for the one person whose page is open.
    shard_dir = out_dir / "detail"
    shard_count, shard_bytes = 0, 0
    shard_size = 1 << SHARD_BITS
    for start in range(0, count, shard_size):
        chunk = people[start:start + shard_size]
        payload = {}
        for offset, person in enumerate(chunk):
            if not person["degrees"] and not person["mrauth"]:
                continue  # stub: nothing beyond what the core bundle carries
            payload[str(start + offset)] = {
                "mrauth": person["mrauth"],
                "degrees": [
                    {
                        "type": d["type"], "year": d["year"], "msc": d["msc"],
                        "schools": d["schools"], "thesis": d["thesis"],
                        "advisors": [index_of[a] for a in d["advisors"] if a in index_of],
                    }
                    for d in person["degrees"]
                ],
            }
        name = f"{start >> SHARD_BITS:04d}.json.gz"
        shard_bytes += write_gz(shard_dir / name, json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        shard_count += 1

    # ---------------- write everything ----------------
    files = {
        "graph.bin.gz": write_gz(out_dir / "graph.bin.gz", graph),
        "names.bin.gz": write_gz(out_dir / "names.bin.gz", names),
        "order.bin.gz": write_gz(out_dir / "order.bin.gz", order_bytes),
        "fold-exceptions.json.gz": write_gz(
            out_dir / "fold-exceptions.json.gz",
            json.dumps(fold_exceptions, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        ),
        "meta.bin.gz": write_gz(out_dir / "meta.bin.gz", meta),
        "dicts.json.gz": write_gz(
            out_dir / "dicts.json.gz",
            json.dumps(dicts, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        ),
    }

    report_path = snapshot_path.parent / "report.json"
    source_report = json.loads(report_path.read_text()) if report_path.exists() else {}

    manifest = {
        "formatVersion": FORMAT_VERSION,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "nodeCount": count,
        "edgeCount": edge_count,
        "stubCount": sum(1 for p in people if p["stub"]),
        "shardBits": SHARD_BITS,
        "shardCount": shard_count,
        "files": files,
        "coreBytes": sum(files.values()),
        "detailBytes": shard_bytes,
        "snapshot": {
            "peopleFromSource": source_report.get("people_from_source"),
            "cyclesFound": source_report.get("cycles_found"),
            "sourceFile": source_report.get("source_file"),
        },
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("snapshot", type=Path, nargs="?", default=Path("data/snapshot/snapshot.jsonl.gz"))
    parser.add_argument("-o", "--out", type=Path, default=Path("data/web"))
    args = parser.parse_args()

    manifest = build(args.snapshot, args.out)
    core_mb = manifest["coreBytes"] / 1e6
    detail_mb = manifest["detailBytes"] / 1e6
    print(json.dumps(manifest, indent=2))
    print(f"\ncore bundle {core_mb:.2f} MB in {len(manifest['files'])} files")
    print(f"detail shards {detail_mb:.2f} MB in {manifest['shardCount']} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
