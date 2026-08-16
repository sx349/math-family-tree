#!/usr/bin/env python3
"""Fetch the Mathematics Genealogy Project database via their official API.

Run this on your own machine — it needs an MGP account, and the API host is not
reachable from CI.  Output is a `.jsonl` dump that `pipeline/normalize.py`
consumes directly.

    export MGP_EMAIL=you@example.com
    python3 scripts/mgp_fetch.py probe            # confirm the endpoint shape
    python3 scripts/mgp_fetch.py ceiling          # find the highest live id
    python3 scripts/mgp_fetch.py fetch --max-id 350000

Credentials
-----------
Pass a token via MGP_TOKEN, or an email/password via MGP_EMAIL/MGP_PASSWORD (the
password is prompted for if unset).  Tokens expire after two hours; with
email+password the script re-authenticates automatically when a 401 comes back,
so a full multi-hour run does not need babysitting.  Nothing is ever written to
disk except the fetched records.

Being a good citizen
--------------------
Defaults are deliberately gentle: 4 workers, a short delay between requests, and
exponential backoff on 429/5xx.  The run is resumable — progress is checkpointed
continuously, so interrupting and restarting picks up where it left off and
never refetches an id.  MGP is a small volunteer-run service; please do not
raise the concurrency much.

An id that is not in the database answers 502 rather than 404, and so does an
API that is down.  After 25 of them in a row the run asks for an id that
certainly exists, and stops if that fails too — otherwise an outage is recorded
as thousands of people who do not exist.  `--recheck-missing` re-asks whatever
was written off, afterwards.

Endpoint discovery
------------------
MGP's v2 API paths are documented behind their login, and this script was
written without access to that documentation.  `probe` tries the plausible
candidates against a known id and reports which shape works; if your account's
documentation shows a different path, set it with --endpoint and the rest of the
script works unchanged.  If the API exposes a bulk range query, --batch-size
uses it and cuts the run from hours to minutes.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from getpass import getpass
from pathlib import Path
from typing import Any, Iterable

try:
    import requests
except ImportError:
    sys.exit("This script needs `requests`:  pip install requests")

BASE_URL = "https://mathgenealogy.org:8000"
API_ROOT = "/api/v2/MGP"

# The documented single-record endpoint. It takes the id as a *query parameter*,
# and the path segment is "acad" rather than "academic".
DEFAULT_ENDPOINT = f"{API_ROOT}/acad?id={{id}}"

# Tried in order by `probe`, in case MGP changes the shape later.
ENDPOINT_CANDIDATES = [
    DEFAULT_ENDPOINT,
    f"{API_ROOT}/acad/{{id}}",
    f"{API_ROOT}/academic?id={{id}}",
    f"{API_ROOT}/id/{{id}}",
]

# Other endpoints the API documents, for reference:
#   /api/v2/MGP/search    family_name, given_name, other_names, school, year,
#                         thesis, country, msc, format=json|csv
#                         (json returns a bare list of ids)
#   /api/v2/MGP/siblings  id, window, format

DEFAULT_WORKERS = 4
DEFAULT_DELAY = 0.35  # seconds per worker between requests
CHECKPOINT_EVERY = 250

# `ceiling` asks whether a band of ids is populated, never whether one id is.
# A single id proves nothing near the top of the range, where MGP's ids thin out
# and a miss is ordinary; a band of 200 sampled at 20 points is decisive enough
# to search on, and the whole search costs a few hundred requests.
CEILING_WIDTH = 200
CEILING_SAMPLES = 20

# How far above the bisected answer to sweep before believing it, and at what
# spacing. 100,000 at 5,000 is twenty more bands — cheap next to a fetch that
# would otherwise stop short of the top and never say so.
CEILING_CONFIRM = 100_000
CEILING_STRIDE = 5_000

# A 502 means "no such id" — until it doesn't. After this many in a row, the
# run asks for someone who certainly exists before believing any more of them.
CANARY_ID = 7298  # Hilbert
CANARY_EVERY = 25


class OutageDetected(RuntimeError):
    """502s have stopped looking like absent ids and started looking like a
    database that is down."""


class Auth:
    """Holds the access token and transparently refreshes it when it expires."""

    def __init__(self, email: str | None, password: str | None, token: str | None):
        self.email, self.password, self.token = email, password, token
        self._lock = threading.Lock()
        self._generation = 0
        if not token and not email:
            sys.exit("Set MGP_TOKEN, or MGP_EMAIL (+MGP_PASSWORD) to log in.")
        if not token:
            self.refresh(0)

    @property
    def generation(self) -> int:
        return self._generation

    def headers(self) -> dict[str, str]:
        return {"x-access-token": self.token or ""}

    def refresh(self, seen_generation: int) -> None:
        """Re-authenticate, unless another thread already did it for us."""
        with self._lock:
            if seen_generation != self._generation:
                return  # someone else refreshed while we waited
            if not self.email:
                sys.exit("Token expired and no MGP_EMAIL is set to re-authenticate with.")
            if not self.password:
                self.password = os.environ.get("MGP_PASSWORD") or getpass("MGP password: ")
            response = requests.post(
                f"{BASE_URL}/login", data={"email": self.email, "password": self.password}, timeout=30
            )
            if not response.ok:
                sys.exit(f"Authentication failed ({response.status_code}). Check your credentials.")
            payload = response.json()
            token = payload.get("token") or payload.get("access_token")
            if not token:
                sys.exit(f"Login succeeded but no token in response: {list(payload)}")
            self.token = token
            self._generation += 1
            print(f"[auth] token refreshed (#{self._generation})", file=sys.stderr)


class Fetcher:
    def __init__(self, auth: Auth, endpoint: str, delay: float, timeout: float = 30.0):
        self.auth, self.endpoint, self.delay, self.timeout = auth, endpoint, delay, timeout
        self.session = requests.Session()
        self._canary_lock = threading.Lock()
        self._consecutive_502 = 0
        self._outage = False

    def looks_absent(self) -> bool:
        """Is this 502 an id that is not there, or an API that is not there?

        The two are indistinguishable at the status-code level, and reading the
        second as the first is not a small error: a six-hour outage recorded
        122,830 ids as nonexistent, silently, because every one of them came
        back 502 exactly like a genuine gap.

        Absent ids are scattered — about 2% of the range — so a long run of
        them is itself the signal. After CANARY_EVERY in a row, ask for an id
        that certainly exists. If that answers, the 502s are real gaps and the
        run continues. If it does not, the caller stops the run.

        The verdict latches. Checking only every 25th was not enough on its
        own: simulated against an API that failed from one id onward, the other
        24 of each 25 were still written off as absent, 101 of them in a
        151-id run.
        """
        with self._canary_lock:
            if self._outage:
                return False
            self._consecutive_502 += 1
            if self._consecutive_502 % CANARY_EVERY:
                return True

        try:
            response = self.session.get(
                f"{BASE_URL}{self.endpoint.format(id=CANARY_ID)}",
                headers=self.auth.headers(),
                timeout=self.timeout,
            )
            alive = response.ok and as_person_record(response.json()) is not None
        except (requests.RequestException, ValueError):
            alive = False

        if not alive:
            with self._canary_lock:
                self._outage = True
        return alive

    def get(self, url: str, attempts: int = 4, label: str = "") -> tuple[int, Any]:
        """GET with backoff on rate limits, server errors, and token expiry."""
        for attempt in range(attempts):
            generation = self.auth.generation
            try:
                response = self.session.get(
                    url, headers=self.auth.headers(), timeout=self.timeout
                )
            except requests.RequestException as exc:
                if attempt == attempts - 1:
                    return 0, {"error": str(exc)}
                time.sleep(min(2 ** attempt, 30) + random.random())
                continue

            if response.status_code == 401:
                self.auth.refresh(generation)
                continue
            if response.status_code == 404:
                return 404, None
            # MGP answers a request for an id that does not exist with 502
            # rather than 404 — 206, 323 and 415 do it every time, and MGP's
            # own web pages say those ids are not in the database. Roughly 2%
            # of the id range is absent, so retrying them finds nothing.
            # Reported as 404 so the caller counts them under `missing`.
            if response.status_code == 502:
                if not self.looks_absent():
                    raise OutageDetected(
                        f"{CANARY_EVERY} consecutive 502s, and id {CANARY_ID} has stopped "
                        "answering too"
                    )
                print(f"[warn] {label}HTTP 502, recording as absent", file=sys.stderr)
                return 404, None
            if response.status_code == 429 or response.status_code >= 500:
                wait = min(2 ** attempt, 60) + random.random()
                print(
                    f"[warn] {label}HTTP {response.status_code}, backing off {wait:.0f}s",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            if not response.ok:
                return response.status_code, None
            # A success ends the run of 502s, so scattered gaps never
            # accumulate towards the canary across the whole fetch.
            with self._canary_lock:
                self._consecutive_502 = 0
            try:
                return 200, response.json()
            except ValueError:
                return 200, None
        return 0, {"error": "retries exhausted"}

    def fetch_id(self, mgp_id: int) -> tuple[int, int, Any]:
        if self.delay:
            time.sleep(self.delay)
        status, payload = self.get(
            f"{BASE_URL}{self.endpoint.format(id=mgp_id)}", label=f"id {mgp_id}: "
        )
        return mgp_id, status, payload


def load_done(out_path: Path) -> set[int]:
    """Read ids already present in the output file so a rerun can resume."""
    done: set[int] = set()
    if not out_path.exists():
        return done
    opener = gzip.open if out_path.suffix == ".gz" else open
    with opener(out_path, "rt", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip().rstrip(",")
            if not line or line in ("[", "]", "null"):
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue  # torn final line from an interrupted run
            inner = record.get("MGP_academic", record) if isinstance(record, dict) else {}
            try:
                done.add(int(inner["ID"]))
            except (KeyError, TypeError, ValueError):
                pass
    return done


def as_person_record(payload: Any) -> dict[str, Any] | None:
    """Return the person record in `payload`, or None if there is not one.

    The API answers a good query with ``{"MGP_academic": {...}}``. What it
    answers for an id that does not exist is not documented, so anything lacking
    that shape is treated as "no such person" rather than trusted — and a sample
    of it is kept in the state file, so an unexpected response shape shows up as
    something to look at instead of silently turning every id into a miss.
    """
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    if not isinstance(payload, dict):
        return None
    inner = payload.get("MGP_academic")
    if isinstance(inner, dict) and inner.get("ID") is not None:
        return payload
    return None


def load_retryable(path: Path) -> set[int]:
    """Ids worth another attempt: ones that errored, not ones that 404'd."""
    if not path.exists():
        sys.exit(f"{path} not found — nothing to retry.")
    return {int(x) for x in json.loads(path.read_text()).get("errors", [])}


def load_missing(path: Path) -> set[int]:
    """Ids the run concluded were not in the database.

    Worth a second look precisely because that conclusion is drawn from a 502,
    which is also what a momentary outage produces. Re-asking is one request
    per id and turns "probably lost nothing" into a checked statement.
    """
    if not path.exists():
        sys.exit(f"{path} not found — nothing to recheck.")
    return {int(x) for x in json.loads(path.read_text()).get("missing", [])}


def load_stale(path: Path) -> set[int]:
    """Ids whose stored record is known to be out of date.

    `pipeline/normalize.py` writes these to its report: they are the people
    whose own record fails to declare an advisor link that the other party
    declares, which is what a record that has changed since it was fetched looks
    like. Refetching just these reconciles an incremental pull with MGP without
    another pass over the whole database.
    """
    if not path.exists():
        sys.exit(f"{path} not found — run pipeline/normalize.py first.")
    report = json.loads(path.read_text())
    if "stale_ids" not in report:
        sys.exit(f"{path} has no 'stale_ids' — regenerate it with the current normalize.py.")
    return {int(x) for x in report["stale_ids"]}


def chunked(values: list[int], size: int) -> Iterable[list[int]]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def command_probe(args: argparse.Namespace, auth: Auth) -> int:
    fetcher = Fetcher(auth, "", delay=0)
    print(f"Probing {BASE_URL} with id={args.probe_id}\n")
    working = []
    for template in ENDPOINT_CANDIDATES:
        url = f"{BASE_URL}{template.format(id=args.probe_id)}"
        status, payload = fetcher.get(url, attempts=2)
        shape = ""
        if as_person_record(payload) is not None:
            person = as_person_record(payload)["MGP_academic"]
            shape = f"  -> {person.get('family_name')}, {person.get('given_name')}"
            working.append(template)
        elif status == 200 and payload is not None:
            shape = f"  (200 but no person record: {str(payload)[:60]})"
        print(f"  {status or 'ERR':>4}  {template}{shape}")

    if not working:
        print(
            "\nNone of the candidates worked. Check your MGP API documentation page for the\n"
            "correct path and pass it with --endpoint '/api/v2/MGP/whatever/{id}'.",
            file=sys.stderr,
        )
        return 1
    print(f"\nUse:  --endpoint '{working[0]}'")
    return 0


def command_ceiling(args: argparse.Namespace, auth: Auth) -> int:
    """Find the highest id MGP currently answers for.

    Ids run well above the number of people — the June 2026 dump referenced
    346,142 — and `fetch --max-id` should sit above the top rather than be
    guessed at, since everything past the end costs one 404 each and everything
    short of it is silently missing people.

    The search gallops upward by doubling until a band comes back empty, then
    bisects the gap, then sweeps the stretch above what it found to confirm the
    answer. The sweep is not ceremony: bisection assumes ids stop once and stay
    stopped, and finds the *first* empty band rather than the last live one, so
    a long unassigned stretch below the top is reported as the top. Simulated
    against a database with a 30,000-id gap under its ceiling, bisection alone
    answered 299,995 for a top of 346,142 — a quiet 46,000-person shortfall in
    the fetch that follows. The sweep catches that and re-bisects above it.
    """
    fetcher = Fetcher(auth, args.endpoint, args.delay)
    step = max(1, args.width // max(args.samples, 1))
    probed = 0
    highest = 0

    with ThreadPoolExecutor(max_workers=args.workers) as pool:

        def live_in(start: int) -> int | None:
            """Highest live id sampled in [start, start+width), or None if empty."""
            nonlocal probed, highest
            ids = [i for i in range(max(start, 1), start + args.width, step)]
            probed += len(ids)
            found = [
                mgp_id
                for mgp_id, status, payload in pool.map(fetcher.fetch_id, ids)
                if status == 200 and as_person_record(payload) is not None
            ]
            if not found:
                print(f"  {start:>9,} … empty", file=sys.stderr)
                return None
            highest = max(highest, *found)
            print(f"  {start:>9,} … {len(found)}/{len(ids)} alive", file=sys.stderr)
            return max(found)

        print(f"Searching for the highest live id, in bands of {args.width}:", file=sys.stderr)
        low = args.start
        if live_in(low) is None:
            print(
                f"\nNothing alive in [{low:,}, {low + args.width:,}) — that band should be dense.\n"
                "Check your credentials and rerun `probe` before trusting anything here.",
                file=sys.stderr,
            )
            return 1

        # Gallop. The ceiling is found as a bracket [low live, high empty), not
        # as a point, so the doubling only has to overshoot once.
        high = low
        while high < args.limit:
            high *= 2
            if live_in(high) is None:
                break
            low = high
        else:
            print(f"\nStill alive at {high:,}, the --limit. Raise it and rerun.", file=sys.stderr)
            return 1

        while True:
            while high - low > args.width:
                mid = (low + high) // 2
                if live_in(mid) is None:
                    high = mid
                else:
                    low = mid

            # Confirm, by walking the stretch above the candidate at a coarser
            # stride. Scanning all of it rather than stopping at the first hit
            # gives back a fresh live/empty bracket to bisect between.
            print(f"  confirming the {args.confirm:,} ids above are empty:", file=sys.stderr)
            last_live: int | None = None
            next_empty: int | None = None
            for probe in range(high + args.stride, high + args.confirm, args.stride):
                if live_in(probe) is not None:
                    last_live, next_empty = probe, None
                elif last_live is not None and next_empty is None:
                    next_empty = probe
            if last_live is None:
                break
            low = last_live
            high = next_empty if next_empty is not None else last_live + args.stride

    # The bands are sampled, not swept, so the true top sits a little above the
    # highest id actually seen. The suggestion carries margin for that: an id
    # past the end costs one 404, an id short of it costs a person.
    suggested = -(-int(highest * 1.05) // 10_000) * 10_000
    print(
        f"\nHighest live id seen: {highest:,}  ({probed:,} ids probed)\n"
        f"Empty from {high:,} up, and at every {args.stride:,} ids across the "
        f"{args.confirm:,} above that.\n"
        f"If that looks low, MGP may have a gap wider than the sweep — rerun with a "
        f"larger --confirm.\n\n"
        f"Next:\n  python3 {sys.argv[0]} fetch --max-id {suggested}",
        file=sys.stderr,
    )
    return 0


def command_fetch(args: argparse.Namespace, auth: Auth) -> int:
    out_path: Path = args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if args.refresh_ids:
        # A refresh deliberately refetches ids the output file already holds;
        # normalize.py takes the last record for a person, so the fresh copy
        # supersedes the stale one when appended.
        todo = sorted(load_stale(args.refresh_ids))
        done = set()
    else:
        done = load_done(out_path)
        if args.recheck_missing:
            targets = sorted(load_missing(args.recheck_missing))
        elif args.retry_errors:
            targets = sorted(load_retryable(args.retry_errors))
        else:
            targets = list(range(args.min_id, args.max_id + 1))
        todo = [i for i in targets if i not in done]

    print(
        f"endpoint : {args.endpoint}\n"
        f"output   : {out_path}\n"
        f"known    : {len(done):,} ids already fetched\n"
        f"to fetch : {len(todo):,} ids\n"
        f"workers  : {args.workers} @ {args.delay}s delay "
        f"(~{len(todo) * args.delay / max(args.workers, 1) / 3600:.1f}h)\n",
        file=sys.stderr,
    )
    if not todo:
        print("Nothing to do.", file=sys.stderr)
        return 0

    fetcher = Fetcher(auth, args.endpoint, args.delay)
    counts = {"ok": 0, "missing": 0, "error": 0}
    missing: list[int] = []
    errors: list[int] = []
    unexpected: list[dict[str, Any]] = []
    started = time.time()
    processed = 0

    def save_state() -> None:
        args.state.write_text(
            json.dumps(
                {
                    "missing": missing,
                    "errors": errors,
                    "counts": counts,
                    "unexpected_samples": unexpected[:5],
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    # Appending as we go, in id-batches rather than one big map(), keeps memory
    # flat over a 350k-id run and means a kill -9 costs at most one batch.
    try:
        with open(out_path, "a", encoding="utf-8") as out:
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                for batch in chunked(todo, CHECKPOINT_EVERY * 4):
                    for mgp_id, status, payload in pool.map(fetcher.fetch_id, batch):
                        processed += 1
                        record = as_person_record(payload) if status == 200 else None
                        if record is not None:
                            out.write(json.dumps(record, ensure_ascii=False) + "\n")
                            counts["ok"] += 1
                        elif status in (200, 404):
                            counts["missing"] += 1
                            missing.append(mgp_id)
                            if status == 200 and payload and len(unexpected) < 5:
                                unexpected.append({"id": mgp_id, "body": str(payload)[:300]})
                        else:
                            counts["error"] += 1
                            errors.append(mgp_id)

                    out.flush()
                    save_state()
                    rate = processed / max(time.time() - started, 1e-9)
                    print(
                        f"  {processed:,}/{len(todo):,}  ok={counts['ok']:,} "
                        f"missing={counts['missing']:,} err={counts['error']:,}  "
                        f"{rate:.1f}/s  ~{(len(todo) - processed) / max(rate, 1e-9) / 3600:.1f}h left",
                        file=sys.stderr,
                    )
    except OutageDetected as exc:
        save_state()
        print(
            f"\n\nSTOPPED after {processed:,} ids: {exc}.\n\n"
            "MGP is answering 502 for ids that exist, which this run would otherwise\n"
            "record as people who are not in the database. Check\n"
            "https://www.mathgenealogy.org/ and rerun the same command once it is back.\n\n"
            f"The last few ids before the stop may have been filed as absent; "
            f"`fetch --recheck-missing {args.state}` re-asks them.",
            file=sys.stderr,
        )
        return 3
    except KeyboardInterrupt:
        save_state()
        print(
            f"\nInterrupted after {processed:,} ids. Rerun the same command to resume.",
            file=sys.stderr,
        )
        return 130

    save_state()
    # MGP ids are densely populated, so a run that finds almost nobody means the
    # endpoint or the response shape is wrong — not that the database is empty.
    if processed >= 100 and counts["ok"] < processed * 0.5:
        print(
            f"\nWARNING: only {counts['ok']:,} of {processed:,} ids returned a person record.\n"
            "That usually means the endpoint is wrong or the API answers in a shape this\n"
            f"script does not recognise. Check 'unexpected_samples' in {args.state}, and\n"
            "rerun `probe` to confirm the endpoint.",
            file=sys.stderr,
        )

    print(
        f"\nDone in {(time.time() - started) / 3600:.2f}h: "
        f"{counts['ok']:,} fetched, {counts['missing']:,} absent, {counts['error']:,} failed.\n"
        f"State written to {args.state}."
        + (
            f"\n\n{counts['error']:,} ids failed; retry just those with:\n"
            f"  python3 {sys.argv[0]} fetch --retry-errors {args.state}"
            if counts["error"]
            else ""
        ),
        file=sys.stderr,
    )
    # An absent id is an id that answered 502, and so is an id asked for during
    # a bad minute. Re-asking is one request each and settles which it was.
    print(
        "\nNext:\n"
        + (
            f"  python3 {sys.argv[0]} fetch --recheck-missing {args.state} -o {out_path}\n"
            if counts["missing"] and not args.recheck_missing
            else ""
        )
        + f"  python3 pipeline/normalize.py {out_path}\n  python3 pipeline/build_web.py",
        file=sys.stderr,
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="path template containing {id}")
    sub = parser.add_subparsers(dest="command", required=True)

    probe = sub.add_parser("probe", help="find the working endpoint shape")
    probe.add_argument("--probe-id", type=int, default=212291)

    ceiling = sub.add_parser("ceiling", help="find the highest id MGP answers for")
    ceiling.add_argument("--start", type=int, default=1000, help="a band start known to be populated")
    ceiling.add_argument("--limit", type=int, default=8_000_000, help="give up above this id")
    ceiling.add_argument("--width", type=int, default=CEILING_WIDTH)
    ceiling.add_argument("--samples", type=int, default=CEILING_SAMPLES)
    ceiling.add_argument("--confirm", type=int, default=CEILING_CONFIRM, help="how far above the candidate to sweep")
    ceiling.add_argument("--stride", type=int, default=CEILING_STRIDE, help="spacing of the confirming sweep")
    ceiling.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    ceiling.add_argument("--delay", type=float, default=DEFAULT_DELAY)

    fetch = sub.add_parser("fetch", help="fetch a range of ids")
    fetch.add_argument("--min-id", type=int, default=1)
    fetch.add_argument("--max-id", type=int, default=350000)
    fetch.add_argument("-o", "--out", type=Path, default=Path("data/raw/mgp_dump.jsonl"))
    fetch.add_argument("--state", type=Path, default=Path("data/raw/fetch_state.json"))
    fetch.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    fetch.add_argument("--delay", type=float, default=DEFAULT_DELAY)
    fetch.add_argument("--retry-errors", type=Path, help="refetch only the ids that errored in this state file")
    fetch.add_argument(
        "--recheck-missing",
        type=Path,
        metavar="STATE",
        help="re-ask the ids this state file recorded as absent, to confirm they really are",
    )
    fetch.add_argument(
        "--refresh-ids",
        type=Path,
        metavar="REPORT",
        help="refetch the stale_ids listed in a normalize.py report.json, ignoring what is already fetched",
    )

    args = parser.parse_args()
    auth = Auth(
        email=os.environ.get("MGP_EMAIL"),
        password=os.environ.get("MGP_PASSWORD"),
        token=os.environ.get("MGP_TOKEN"),
    )
    commands = {"probe": command_probe, "ceiling": command_ceiling, "fetch": command_fetch}
    return commands[args.command](args, auth)


if __name__ == "__main__":
    raise SystemExit(main())
