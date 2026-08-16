# Mathematics Genealogy Visualizer

A visualisation of advisor–student lineages from the
[Mathematics Genealogy Project](https://www.genealogy.math.ndsu.nodak.edu/) (MGP).

Two things it does that the MGP site does not:

- **Neighbourhood graphs.** Every mathematician has a page showing their advisors and
  students as a diagram, widened a generation at a time.
- **Common ancestors.** Pick up to five people and see the lowest advisor they all descend
  from, with only the connecting paths drawn.

Search here also differs from MGP's: fields are combined with **and**, so a first *and* last
name narrows the result instead of returning everyone matching either.

The site is fully static. The whole graph is loaded into the browser once (~7 MB gzipped),
after which search, neighbourhood expansion and ancestor queries all run locally with no
server round-trips.

It is set as a printed page — laid ecru paper, green-black ink, Caslon Open Face for the
wordmark — after the cover of the *Annals of Mathematics*. Light only: paper has no honest
inversion, and a flipped-token dark mode would read as a different design rather than the
same one at night.

## Repository layout

```
pipeline/normalize.py   raw MGP dump  ->  data/snapshot/snapshot.jsonl.gz
pipeline/build_web.py   snapshot      ->  data/web/*  (binary artifacts the site loads)
scripts/mgp_fetch.py    MGP API fetcher, run manually to refresh the data
web/                    Vite + React + TypeScript + Cytoscape front end
data/                   snapshot and built artifacts, committed directly
```

## Running the site

```bash
cd web
npm install
npm run dev
```

That is the whole setup — the data artifacts are committed, and `npm run dev` links
`data/web` into place for you before starting.

`npm test` runs the engine tests, which load the real artifacts from `data/web` and check
traversal results against values computed independently in Python.

The data artifacts are committed as ordinary git objects (about 47 MB in total), so a clone
can run the site with no extra fetch step. They are already gzipped, so git cannot compress
them further and each refresh adds a full copy to history; if that becomes a problem, move
`data/**/*.gz` to Git LFS with `git lfs migrate import`.

## Publishing

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`,
and can be run by hand from the Actions tab — useful for redeploying after a data refresh
without a code change.

It needs one setting, once: **Settings → Pages → Source: GitHub Actions**.

The workflow typechecks and runs the tests before building, so a broken commit fails rather
than being published. It derives the base path from the repository name — `/<repo>/` for a
project site, `/` for a `*.github.io` one — so nothing needs editing if the repository moves.
It also copies `index.html` to `404.html`, because Pages serves static files and a deep link
like `/person/7298` has no file behind it; Pages falls back to `404.html`, and serving the app
from there lets the router take over, so shared links and hard refreshes work.

Each visitor downloads about 7 MB on first load, cached afterwards. That is well within Pages'
limits, but it is a real number if the site is shared widely.

To build for a subpath by hand: `SITE_BASE=/math-family-tree/ npm run build`.

## Refreshing the data

The data is a **static snapshot**, updated by hand — the site never contacts MGP at runtime.
MGP offers an official API to registered users, which is far kinder to their servers than
scraping `id.php`, and returns richer records.

```bash
export MGP_EMAIL=you@example.com          # password prompted, or MGP_PASSWORD
python3 scripts/mgp_fetch.py probe        # confirm the API endpoint shape
python3 scripts/mgp_fetch.py ceiling      # find the highest live id
python3 scripts/mgp_fetch.py fetch --max-id 350000
```

Every subcommand logs in for itself from those two variables, so there is no token to
export or paste. `MGP_TOKEN` works too if you already have one, but it expires after two
hours and cannot be renewed without the password.

Records come from `/api/v2/MGP/acad?id=N`, which returns the `{"MGP_academic": {...}}`
shape the normalizer expects. The API also documents `/api/v2/MGP/search` (returns a list of
ids) and `/api/v2/MGP/siblings`, neither of which the fetch needs.

An id that is not in MGP's database comes back **502**, not 404 — ids 206, 323 and 415
do it every time, and MGP's own pages confirm those ids do not exist. About 2% of the id
range is absent, so they are written off after a single request rather than retried.

An outage looks exactly the same from outside, and reading one as the other is not a
small error. In August 2026 the API stopped answering three hours into a run and the
fetch recorded **122,830 people as nonexistent** over the following six hours, silently,
because every id came back 502 exactly like a genuine gap.

Two things guard against a repeat. During the run, 25 consecutive 502s trigger a request
for an id known to exist; if that fails too, the fetch stops rather than carrying on
(exit code 3). Simulated against an API that failed partway, that caps the damage at 24
ids instead of everything remaining. And after the run, `--recheck-missing` re-asks
everything written off — one request each, and it turns "probably lost nothing" into a
checked statement, which matters because the point of a full pull is
`edge_direction_disagreements` coming out at 0.

The count on [MGP's home page](https://www.mathgenealogy.org/) is the other check worth
making: a complete pull should hold about that many records.

```bash
python3 scripts/mgp_fetch.py fetch --recheck-missing data/raw/fetch_state.json \
  -o data/raw/mgp_dump.jsonl
python3 pipeline/normalize.py data/raw/mgp_dump.jsonl
python3 pipeline/build_web.py
cd web && npm run build
```

### Establishing a baseline

Walk the whole id range. A complete pull is the only version of this dataset that can be
checked: `edge_direction_disagreements` comes out at 0, because every advisor link is
declared by both people it connects, and that zero is a real integrity test over the whole
graph.

Find the current ceiling first — ids run well above the number of people, and the June 2026
dump already referenced id 346,142. `ceiling` gallops upward by doubling, bisects, then
sweeps the 100,000 ids above its answer to make sure it has not stopped at a gap. It costs
about 800 requests and a couple of minutes, and ends by printing the `--max-id` to use:

```bash
python3 scripts/mgp_fetch.py ceiling
```

### Updating an existing snapshot

Pointing `--out` at a file that already holds a previous dump makes the fetcher skip those
ids and append only what is new. Advisor links are read from both endpoints of each edge, so
a person added since the last pull brings their own `advised by` with them and the link lands
even though their advisor's older record never mentions them.

The limit of this is worth being clear about. An edit touching two records that both predate
the pull — a second advisor added to an old thesis, a link deleted — produces no
contradiction, because neither record was refetched. It cannot be detected, only outrun by
keeping the window between updates short.

What can be detected is an old record sitting next to a newly fetched one: if one person
declares a link and the other does not, the silent party has changed since it was stored.
`report.json` lists those under `stale_ids`, and refetching them picks up whatever else moved
on those records:

```bash
python3 scripts/mgp_fetch.py fetch --refresh-ids data/snapshot/report.json -o data/raw/mgp_dump.jsonl
python3 pipeline/normalize.py data/raw/mgp_dump.jsonl
```

Records are last-wins, so an appended fresh copy supersedes the older one, and links it no
longer declares are dropped rather than kept. Note that on an incremental snapshot
`edge_direction_disagreements` is expected to be non-zero, so it stops working as an
integrity check — which is why a baseline should be a full pull.

The fetch is resumable: interrupt it and rerun the same command, and it continues without
refetching any id. Defaults are 4 workers with a delay between requests. Please do not raise
those much — MGP is a small volunteer-run service.

Tokens last two hours; supplying `MGP_EMAIL`/`MGP_PASSWORD` lets the script re-authenticate
itself so a long run does not need supervision. Credentials are never written to disk.

## What the data looks like

Measured on the snapshot currently committed here:

| | |
|---|---|
| People | 332,527 |
| Advisor links | 376,552 |
| People with 2 advisors | 55,201 |
| People with 3 advisors | 5,112 (max 6) |
| Most students | 181 |
| Cycles | none — it is a clean DAG |

### Things worth knowing about MGP's data

These all come from measuring the real dump, and each one shaped part of the pipeline:

- **ID 0 is a sentinel, not a person.** MGP records "advisor unknown" as a reference to id 0,
  named "Unknown", 25,543 times. Treating it as a person creates a hub with 25,000 students
  that makes everyone with an unknown advisor a sibling of everyone else, which quietly
  ruins both neighbourhood expansion and common-ancestor results. It is excluded.

- **The graph is acyclic, but not quite clean.** Eight people are recorded as their own
  advisor; those self-loops are dropped. Beyond that there are no cycles, so ancestor
  traversal always terminates.

- **The two edge directions agree exactly.** Advisor links appear both as `advised by` on the
  student and `advisees` on the advisor, and across all 359,437 links where both people are
  present, the two never disagree. The normalizer still checks and reports any that do.

- **A partial dump references people it does not contain**, but those references carry names.
  Rather than dropping them and silently breaking paths, they become name-only "stub" nodes —
  13,874 of them, preserving about 17,000 links. The site draws them dashed and links to MGP.

- **People can appear twice.** Abraham Kästner is in MGP as both #21235 and #66476, with one
  recorded as the other's advisor. Duplicates like this are upstream data, left as-is;
  corrections belong with MGP.

## Design notes

**Why no backend.** The graph is 332k nodes and 377k edges. Stored as CSR adjacency with
neighbour *counts* rather than cumulative offsets (small repetitive integers compress far
better than monotonic ones), the entire graph plus every name and the search index comes to
7.2 MB gzipped. That is small enough to ship to the browser once, which makes every query
instant and the hosting free. Thesis titles are another 20 MB of text, so those are sharded
1,024 people to a file and fetched only for the page being viewed.

**Why depth alone does not work.** Depth is a radius in the undirected graph, so depth 1 is
exactly a person's advisors and students. But Hilbert has 82 people at depth 1, 544 at depth
2, 2,770 at depth 3 and 10,891 at depth 4. Expansion is therefore governed by a node budget:
whole generations are admitted while they fit, and the first that would overflow is left out
and summarised as `+N` handles. Opening a handle has its own separate budget, so one click
cannot cascade past every limit. A requested depth of 5 may resolve to 2 for Hilbert and a
full 5 for someone with a sparser lineage.

**Why generations get wrapped.** A prolific advisor puts dozens of students on one rank, which
dagre lays out as a single row thousands of pixels wide — legible only when zoomed out past
the point of reading the names. Over-wide generations are wrapped into stacked sub-rows within
the same generation, so parent–child edges vary in length but the diagram keeps a sane shape.

**Why "the LCA" is a set.** On a tree the lowest common ancestor is one node. This is a DAG:
tens of thousands of people have several advisors, and someone can advise both a student and
that student's own student. So there can be several incomparable lowest common ancestors, and
all of them are shown. Selections that share no ancestry within the depth limit are
partitioned into groups and drawn as a forest rather than reported as "no result".

## Not included

- **Thesis keyword search.** Titles live in the per-page shards, so searching them would mean
  loading all 20 MB. Everything else on MGP's search form is supported.
- **Live data.** By design; see "Refreshing the data".

## Credits

All genealogy data is from the Mathematics Genealogy Project at North Dakota State University.
This is an independent visualisation, not affiliated with them. The initial snapshot was
seeded from [pablit0o/MGP-visualizer](https://github.com/pablit0o/MGP-visualizer)'s API-derived
dump (June 2026); [j2kun/math-genealogy-scraper](https://github.com/j2kun/math-genealogy-scraper)
is the prior art for scraping the site directly.
