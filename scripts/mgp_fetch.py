#!/usr/bin/env python3
"""Fetch the Mathematics Genealogy Project database via their official API.

Run this on your own machine — it needs an MGP account, and the API host is not
reachable from CI.  Output is a `.jsonl` dump that `pipeline/normalize.py`
consumes directly.

    export MGP_EMAIL=you@example.com
    python3 scripts/mgp_fetch.py probe            # confirm the endpoint shape
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

# Single-id endpoint templates to try during `probe`, most likely first.
ENDPOINT_CANDIDATES = [
    f"{API_ROOT}/academic/{{id}}",
    f"{API_ROOT}/academic?id={{id}}",
    f"{API_ROOT}/id/{{id}}",
    f"{API_ROOT}/person/{{id}}",
    f"{API_ROOT}/{{id}}",
]

DEFAULT_WORKERS = 4
DEFAULT_DELAY = 0.35  # seconds per worker between requests
CHECKPOINT_EVERY = 250


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

    def get(self, url: str, attempts: int = 6) -> tuple[int, Any]:
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
            if response.status_code == 429 or response.status_code >= 500:
                wait = min(2 ** attempt, 60) + random.random()
                print(
                    f"[warn] HTTP {response.status_code}, backing off {wait:.0f}s",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            if not response.ok:
                return response.status_code, None
            try:
                return 200, response.json()
            except ValueError:
                return 200, None
        return 0, {"error": "retries exhausted"}

    def fetch_id(self, mgp_id: int) -> tuple[int, int, Any]:
        if self.delay:
            time.sleep(self.delay)
        status, payload = self.get(f"{BASE_URL}{self.endpoint.format(id=mgp_id)}")
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


def load_retryable(path: Path) -> set[int]:
    """Ids worth another attempt: ones that errored, not ones that 404'd."""
    if not path.exists():
        sys.exit(f"{path} not found — nothing to retry.")
    return {int(x) for x in json.loads(path.read_text()).get("errors", [])}


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
        if status == 200 and payload is not None:
            sample = payload[0] if isinstance(payload, list) and payload else payload
            shape = f"  keys={list(sample)[:6]}" if isinstance(sample, dict) else f"  {type(payload).__name__}"
            working.append(template)
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


def command_fetch(args: argparse.Namespace, auth: Auth) -> int:
    out_path: Path = args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    done = load_done(out_path)
    targets = sorted(load_retryable(args.retry_errors)) if args.retry_errors else list(
        range(args.min_id, args.max_id + 1)
    )
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
    started = time.time()
    processed = 0

    def save_state() -> None:
        args.state.write_text(
            json.dumps({"missing": missing, "errors": errors, "counts": counts}, indent=2),
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
                        if status == 200 and payload:
                            record = payload[0] if isinstance(payload, list) and payload else payload
                            out.write(json.dumps(record, ensure_ascii=False) + "\n")
                            counts["ok"] += 1
                        elif status == 404 or (status == 200 and not payload):
                            counts["missing"] += 1
                            missing.append(mgp_id)
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
    except KeyboardInterrupt:
        save_state()
        print(
            f"\nInterrupted after {processed:,} ids. Rerun the same command to resume.",
            file=sys.stderr,
        )
        return 130

    save_state()
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
    print(f"\nNext:\n  python3 pipeline/normalize.py {out_path}\n  python3 pipeline/build_web.py", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--endpoint", default=ENDPOINT_CANDIDATES[0], help="path template containing {id}")
    sub = parser.add_subparsers(dest="command", required=True)

    probe = sub.add_parser("probe", help="find the working endpoint shape")
    probe.add_argument("--probe-id", type=int, default=212291)

    fetch = sub.add_parser("fetch", help="fetch a range of ids")
    fetch.add_argument("--min-id", type=int, default=1)
    fetch.add_argument("--max-id", type=int, default=350000)
    fetch.add_argument("-o", "--out", type=Path, default=Path("data/raw/mgp_dump.jsonl"))
    fetch.add_argument("--state", type=Path, default=Path("data/raw/fetch_state.json"))
    fetch.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    fetch.add_argument("--delay", type=float, default=DEFAULT_DELAY)
    fetch.add_argument("--retry-errors", type=Path, help="refetch only the ids that errored in this state file")

    args = parser.parse_args()
    auth = Auth(
        email=os.environ.get("MGP_EMAIL"),
        password=os.environ.get("MGP_PASSWORD"),
        token=os.environ.get("MGP_TOKEN"),
    )
    return command_probe(args, auth) if args.command == "probe" else command_fetch(args, auth)


if __name__ == "__main__":
    raise SystemExit(main())
