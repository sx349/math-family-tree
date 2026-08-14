#!/usr/bin/env python3
"""Normalize a raw Mathematics Genealogy Project dump into a stable snapshot.

Input is whatever the MGP API hands back: a JSON array (or JSONL) of records
shaped like ``{"MGP_academic": {...}}``.  Both the pretty-printed-array form
used by existing public dumps and the line-delimited form written by
``scripts/mgp_fetch.py`` are accepted.

Output is ``snapshot.jsonl.gz`` — one person per line, in a flat schema that the
web builder consumes and that does not change when MGP changes their API:

    {"id": 1, "family": "Anderson", "given": "Ernest", "other": "Willard",
     "mrauth": "", "stub": false,
     "degrees": [{"type": "Ph.D.", "year": 1933, "msc": "74",
                  "schools": ["Iowa State University, United States"],
                  "thesis": "...", "advisors": [258]}],
     "advisors": [258], "students": [11, 28, 31]}

Two properties of the source data drive the interesting parts of this script:

1. Advisor edges appear twice — once as ``advised by`` on the student and once
   as ``advisees`` on the advisor.  When both endpoints are present the two
   directions agree exactly, so the union is safe and any disagreement is a
   genuine anomaly worth reporting.

2. A partial dump refers to people it does not contain.  Those references carry
   the person's *name*, so a missing person is reconstructed as a name-only
   "stub" node rather than dropped.  Dropping them would silently break paths
   through the graph; stubs keep the topology honest and are rendered
   distinctly by the site.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterator

# MGP lists a handful of people as their own advisor.  These are data-entry
# errors upstream; left in place they turn the DAG into a cyclic graph.
DROP_SELF_LOOPS = True

# MGP encodes "this person's advisor is not known" as a reference to ID 0, named
# "Unknown".  It is a sentinel, not a person, and it appears tens of thousands of
# times — admitting it would create one enormous hub that makes every mathematician
# with an unknown advisor a sibling of every other, wrecking both neighbourhood
# expansion and lowest-common-ancestor results.
SENTINEL_IDS = frozenset({0})


def iter_raw_records(path: Path) -> Iterator[dict[str, Any]]:
    """Yield raw MGP records from a JSON array, JSONL, or one-per-line array."""
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        first = handle.readline()
        handle.seek(0)
        stripped = first.strip()

        # Fast path: array with one record per line (how MGP dumps are shaped).
        # Falls back to a whole-file parse if that assumption turns out wrong.
        if stripped.startswith("[") and len(stripped) < 8:
            for line in handle:
                line = line.strip().rstrip(",")
                if line in ("[", "]", "", "null"):
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    handle.seek(0)
                    for record in json.load(handle):
                        if record:
                            yield record
                    return
            return

        if stripped.startswith("["):
            for record in json.load(handle):
                if record:
                    yield record
            return

        for line in handle:  # JSONL
            line = line.strip().rstrip(",")
            if line and line != "null":
                yield json.loads(line)


def unwrap(record: dict[str, Any]) -> dict[str, Any] | None:
    """Strip the ``MGP_academic`` envelope if present."""
    if not isinstance(record, dict):
        return None
    inner = record.get("MGP_academic", record)
    return inner if isinstance(inner, dict) and "ID" in inner else None


def as_int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def clean(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())


def split_listing_name(listing: str) -> tuple[str, str, str]:
    """Split an MGP cross-reference name ("Holl, Dio Lewis") into name parts.

    Cross-references are the only name information available for people missing
    from the dump, so this is how stub nodes get labelled.
    """
    listing = clean(listing)
    if not listing:
        return "", "", ""
    family, _, rest = listing.partition(",")
    parts = rest.split()
    return clean(family), (parts[0] if parts else ""), " ".join(parts[1:])


def parse_year(value: Any) -> int | None:
    """Pull a 4-digit year out of MGP's free-text year field."""
    text = clean(value)
    if not text or not (match := re.search(r"\b(1[0-9]{3}|20[0-9]{2})\b", text)):
        return None
    return int(match.group(1))


def normalize(raw_path: Path, out_dir: Path) -> dict[str, Any]:
    people: dict[int, dict[str, Any]] = {}
    # Cross-referenced names, kept so missing people can become stub nodes.
    referenced_names: dict[int, str] = {}

    # Edges are kept per *declaring* person rather than in one global set, so
    # that re-reading someone's record replaces what they declare instead of
    # merging with it. That is what makes an incremental refresh able to drop a
    # link MGP has since deleted, not just add ones it has gained.
    declared_advisors: dict[int, set[int]] = defaultdict(set)
    declared_students: dict[int, set[int]] = defaultdict(set)

    stats = Counter()
    malformed: list[str] = []

    for raw in iter_raw_records(raw_path):
        record = unwrap(raw)
        if record is None:
            stats["records_unparseable"] += 1
            continue
        person_id = as_int(record.get("ID"))
        if person_id is None:
            stats["records_without_id"] += 1
            continue
        if person_id in SENTINEL_IDS:
            stats["sentinel_records_dropped"] += 1
            continue
        if person_id in people:
            # A later record for the same person is a refresh: it wins outright,
            # and its declarations replace the earlier ones.
            stats["records_superseded"] += 1
            declared_advisors.pop(person_id, None)
            declared_students.pop(person_id, None)

        student_data = record.get("student_data") or {}
        degrees = []
        for degree in student_data.get("degrees") or []:
            if not degree:
                continue
            advisor_ids = []
            for advisor_id, advisor_name in (degree.get("advised by") or {}).items():
                advisor = as_int(advisor_id)
                if advisor is None:
                    continue
                if advisor in SENTINEL_IDS:
                    stats["unknown_advisor_refs_dropped"] += 1
                    continue
                if advisor == person_id and DROP_SELF_LOOPS:
                    stats["self_loops_dropped"] += 1
                    continue
                advisor_ids.append(advisor)
                declared_advisors[person_id].add(advisor)
                referenced_names.setdefault(advisor, clean(advisor_name))
            degrees.append(
                {
                    "type": clean(degree.get("degree_type")),
                    "year": parse_year(degree.get("degree_year")),
                    "msc": clean(degree.get("degree_msc")),
                    "schools": [clean(s) for s in (degree.get("schools") or []) if clean(s)],
                    "thesis": clean(degree.get("thesis_title")),
                    "advisors": sorted(set(advisor_ids)),
                }
            )

        for advisee in (student_data.get("descendants") or {}).get("advisees") or []:
            # Absent advisees are encoded as [""] rather than an empty list.
            if not advisee or not isinstance(advisee, (list, tuple)) or len(advisee) < 1:
                continue
            student = as_int(advisee[0])
            if student is None:
                continue
            if student in SENTINEL_IDS:
                stats["sentinel_student_refs_dropped"] += 1
                continue
            if student == person_id and DROP_SELF_LOOPS:
                stats["self_loops_dropped"] += 1
                continue
            declared_students[person_id].add(student)
            if len(advisee) > 1:
                referenced_names.setdefault(student, clean(advisee[1]))

        people[person_id] = {
            "id": person_id,
            "family": clean(record.get("family_name")),
            "given": clean(record.get("given_name")),
            "other": clean(record.get("other_names")),
            "mrauth": clean(record.get("mrauth_id")),
            "stub": False,
            "degrees": degrees,
        }

    edges_up = {(advisor, pid) for pid, advisors in declared_advisors.items() for advisor in advisors}
    edges_down = {(pid, student) for pid, students in declared_students.items() for student in students}

    # --- integrity: do the two edge directions agree where both ends exist? ---
    # A disagreement means one person's record knows about a link and the other
    # person's record does not. In a single complete dump that should never
    # happen. After an incremental refresh it happens exactly where an older
    # record has gone stale, which makes it a precise list of who to refetch.
    both_present = lambda edges: {e for e in edges if e[0] in people and e[1] in people}
    up_known, down_known = both_present(edges_up), both_present(edges_down)
    disagreements = sorted((up_known ^ down_known))
    stats["edges_only_in_advised_by"] = len(up_known - down_known)
    stats["edges_only_in_advisees"] = len(down_known - up_known)

    # The stale party is whichever side failed to declare the link.
    stale_ids: set[int] = set()
    for advisor, student in up_known - down_known:
        stale_ids.add(advisor)  # the student named them; their own record did not
    for advisor, student in down_known - up_known:
        stale_ids.add(student)  # the advisor named them; their own record did not

    edges = edges_up | edges_down

    # --- reconstruct people referenced but not included in the dump ---
    for person_id in {n for edge in edges for n in edge} - set(people):
        family, given, other = split_listing_name(referenced_names.get(person_id, ""))
        people[person_id] = {
            "id": person_id,
            "family": family,
            "given": given,
            "other": other,
            "mrauth": "",
            "stub": True,
            "degrees": [],
        }
        stats["stub_nodes_created"] += 1

    children: dict[int, set[int]] = defaultdict(set)
    parents: dict[int, set[int]] = defaultdict(set)
    for advisor, student in edges:
        children[advisor].add(student)
        parents[student].add(advisor)

    cycles = find_cycles(people.keys(), children)

    out_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = out_dir / "snapshot.jsonl.gz"
    with gzip.open(snapshot_path, "wt", encoding="utf-8", compresslevel=6) as out:
        for person_id in sorted(people):
            person = people[person_id]
            person["advisors"] = sorted(parents[person_id])
            person["students"] = sorted(children[person_id])
            out.write(json.dumps(person, ensure_ascii=False, separators=(",", ":")) + "\n")

    real = [p for p in people.values() if not p["stub"]]
    report = {
        "source_file": raw_path.name,
        "people_total": len(people),
        "people_from_source": len(real),
        "people_stub": len(people) - len(real),
        "edges": len(edges),
        "roots_no_advisor": sum(1 for i in people if not parents[i]),
        "leaves_no_student": sum(1 for i in people if not children[i]),
        "id_min": min(people) if people else None,
        "id_max": max(people) if people else None,
        "max_advisors": max((len(parents[i]) for i in people), default=0),
        "max_students": max((len(children[i]) for i in people), default=0),
        "cycles_found": len(cycles),
        "cycle_samples": cycles[:10],
        "edge_direction_disagreements": len(disagreements),
        "edge_disagreement_samples": disagreements[:10],
        # Feed straight back into: mgp_fetch.py fetch --refresh-ids report.json
        "stale_ids": sorted(stale_ids),
        "counters": dict(stats),
        "malformed_samples": malformed[:10],
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def find_cycles(nodes, children: dict[int, set[int]], limit: int = 50) -> list[list[int]]:
    """Iterative DFS cycle detection.

    Advisor relationships should be acyclic; anything found here is bad upstream
    data and would otherwise make ancestor traversal non-terminating.
    """
    UNVISITED, ACTIVE, DONE = 0, 1, 2
    colour: dict[int, int] = {}
    cycles: list[list[int]] = []

    for start in nodes:
        if colour.get(start, UNVISITED) != UNVISITED:
            continue
        colour[start] = ACTIVE
        stack = [(start, iter(sorted(children[start])))]
        path = [start]
        while stack:
            node, child_iter = stack[-1]
            child = next(child_iter, None)
            if child is None:
                colour[node] = DONE
                stack.pop()
                path.pop()
                continue
            state = colour.get(child, UNVISITED)
            if state == UNVISITED:
                colour[child] = ACTIVE
                stack.append((child, iter(sorted(children[child]))))
                path.append(child)
            elif state == ACTIVE and len(cycles) < limit:
                cycles.append(path[path.index(child):] + [child])
    return cycles


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("raw", type=Path, help="raw MGP dump (.json / .jsonl / .gz)")
    parser.add_argument("-o", "--out", type=Path, default=Path("data/snapshot"))
    args = parser.parse_args()

    if not args.raw.exists():
        print(f"error: {args.raw} not found", file=sys.stderr)
        return 1

    report = normalize(args.raw, args.out)
    print(json.dumps(report, indent=2))
    if report["cycles_found"]:
        print(f"\nWARNING: {report['cycles_found']} cycle(s) in the advisor graph.", file=sys.stderr)
    if report["edge_direction_disagreements"]:
        print(
            f"WARNING: {report['edge_direction_disagreements']} advisor edge(s) present in only "
            "one direction despite both people being in the dump.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
