#!/usr/bin/env python3
"""Start-of-work preflight doctor (**small plugin**, issue #10): process / port liveness.

"All file invariants green" != "the environment is still alive" -- two real
incidents (Octave-Full-Wasm HISTORY §5.86 / §5.83): after a machine reboot
the acceptance site and the build container both vanished; every file-level
invariant held true, but the acceptance baseline was unusable, and a whole
round was wasted before anyone noticed; in another repo a dev server had
taken the experiment port, the probe connected to someone else's page =>
misjudged as "the new build won't come up". git, gates, and witnesses all
govern files and artifacts; service processes, container state, and port
occupancy fall under no mechanism -- this plugin fills that gap: roll call
**before work starts**.

Policy is **data** (same pattern as #7); the mechanism provides only the
engine + contract:

    { "checks": [
      { "kind": "http", "url": "http://127.0.0.1:8761/",
        "expect_status": 200,
        "expect_headers": {"Cross-Origin-Opener-Policy": "same-origin"} },
      { "kind": "docker", "container": "o113", "state": "running" },
      { "kind": "port-free", "port": 8868 } ] }

Both kinds of assertion are needed: "must be alive" (http / docker) and
"must be free" (port-free). Output obeys the **stdout bare-value contract**:
`ok` / `DOWN: <which check>` (`ok` is printed only when everything is alive).
Everything is **harmless**: read-only GET / `docker inspect` / connect probe.

**Every probe must carry a timeout** (`REFLECT_DOCTOR_TIMEOUT`,
default 2 seconds): connect against a dead port waits until the end of
time -- that is the probe's own failure mode and must be decoupled from
the thing being probed (the same lesson as "probes stay off the boot path").

**Not wired into pre-commit** (the issue says so): it checks **things that
die**, the wrong frequency for a commit hook, and it would slow every
commit. So this file is **not** a `check_*.py` -- the discovery roster
(`for g in zreflect/check_*.py`) never scans it, and pre-commit doesn't
run it; `gates-selftest.sh` names it once to prove it can go red (same
plugin pattern as einfacht-env.sh). Run by hand before work starts:

    python3 zreflect/doctor.py

Pluggable: `REFLECT_DOCTOR` unset and the default `doctor.json` absent =>
state plainly that it is off, return 0. Explicitly configured but pointing
at a missing file => FATAL, exit 2 (a dangling pointer is not "disabled").
Liveness is a transient fact => **not entered into the ledger replay**
(running it fresh at each start of work is enough; the ledger's bare-value
contract can't hold things that die).

**Boundary (stated in the issue, not hidden)**: doctor only does **liveness**
probing, no content validation (content is governed by existing gates /
acceptance); "which services must be alive, which ports must be exclusive"
is **policy**, configured per repo (spec data). Zero-value guards: empty
list / missing kind / unknown kind => all reported (an unknown
criterion = silent pass).

Usage (run directly, cwd=repo root):
    python3 zreflect/doctor.py [--selftest]
Exit codes: 0=all alive (or disabled) / 1=some DOWN / 2=configuration or
environment broken (a malformed spec shape != a failed check).
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402
import i18n  # noqa: E402
import knobs  # noqa: E402
from gate import fatal, main_selftest_or, meta  # noqa: E402
from i18n import M  # noqa: E402

# Derived from the knob registry (single source of truth) -- a handwritten
# literal would drift from it (the most expensive kind of debt in this repo).
# DEFAULT_TIMEOUT used to be a bare `2.0` on the next line after this very
# comment -- the second origin of `REGISTRY["REFLECT_DOCTOR_TIMEOUT"]`'s
# default ("2"), contradicting its own rationale on the spot.
DEFAULT_SPEC = knobs.REGISTRY["REFLECT_DOCTOR"][1]
DEFAULT_TIMEOUT = float(knobs.REGISTRY["REFLECT_DOCTOR_TIMEOUT"][1])


# ---- Pure criteria (selftest can inject fake responses; return (satisfied?, reason)) ----

def _http_verdict(status, headers, check):
    """Does the HTTP response satisfy the criteria. Header keys are lowercased."""
    want = check.get("expect_status")
    if want is not None and status != want:
        return False, M("doctor.http_status_mismatch", actual=status, expected=want)
    for k, v in (check.get("expect_headers") or {}).items():
        got = headers.get(k.lower())
        if got != v:
            return False, M("doctor.http_header_mismatch",
                            header=k, actual=got, expected=v)
    return True, ""


def _docker_verdict(stdout):
    ok = stdout.strip() == "true"
    return ok, "" if ok else \
        M("doctor.container_not_running", actual=stdout.strip())


def _port_free_verdict(connect_succeeded):
    """connect succeeded = occupied; connection refused = free."""
    return (not connect_succeeded,
            "" if not connect_succeeded else M("doctor.port_in_use"))


# ---- Real transports (thin layer; the selftest never runs them, the selftest must be network- and docker-free) ----

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _http_probe(check, timeout):
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        req = urllib.request.Request(check["url"], method="GET")
        with opener.open(req, timeout=timeout) as resp:
            return _http_verdict(
                resp.status,
                {k.lower(): v for k, v in resp.headers.items()},
                check)
    except urllib.error.HTTPError as e:
        return _http_verdict(
            e.code,
            {k.lower(): v for k, v in (e.headers.items() if e.headers else ())},
            check)
    # URLError is a subclass of OSError; no need to list it separately.
    except (OSError, ValueError) as e:
        return False, M("doctor.get_failed", error=e)


def _docker_probe(check, timeout):
    try:
        r = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}",
             check["container"]],
            capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, M("doctor.docker_inspect_failed", error=e)
    return _docker_verdict(r.stdout)


def _can_bind_exclusive(host, port):
    if os.name != "nt":
        return False
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(fam, socket.SOCK_STREAM) as s:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            s.bind((host, port))
        return True
    except OSError:
        return False


def _port_free_probe(check, timeout):
    last_err: OSError | None = None
    for host in ("127.0.0.1", "::1"):
        try:
            socket.create_connection((host, check["port"]), timeout=timeout).close()
            return _port_free_verdict(True)
        except ConnectionRefusedError:
            continue
        except TimeoutError as e:
            if _can_bind_exclusive(host, check["port"]):
                continue
            last_err = e
        except OSError as e:
            last_err = e
    if last_err is not None:
        return False, M("doctor.probe_inconclusive", error=last_err)
    return True, ""


_PROBES = {"http": _http_probe, "docker": _docker_probe,
           "port-free": _port_free_probe}


def label(check):
    """Label for a DOWN line: kind:target."""
    target = check.get("url") or check.get("container") \
        or check.get("port")
    return "%s:%s" % (check.get("kind"), target)


# ---- Spec validation (pure functions: zero-value guards + shape criteria) ----

def _http_shape_problems(c):
    """Field criteria for an http check (missing/bad-scheme url / non-int expect_status / expect_headers shape)."""
    url = str(c.get("url") or "").strip()
    if not url or not url.startswith(("http://", "https://")):
        return [M("doctor.http_missing_url", check=label(c))]
    es = c.get("expect_status")
    if es is not None and (isinstance(es, bool) or not isinstance(es, int)):
        return [M("doctor.http_status_not_int", check=label(c))]
    eh = c.get("expect_headers")
    if eh is not None and (not isinstance(eh, dict) or any(
            not isinstance(k, str) or not isinstance(v, str)
            for k, v in eh.items())):
        return [M("doctor.http_headers_not_object", check=label(c))]
    return []


def _docker_shape_problems(c):
    """Field criteria for a docker check (missing container / state only supports running)."""
    if not str(c.get("container") or "").strip():
        return [M("doctor.docker_missing_container", check=label(c))]
    if str(c.get("state") or "").strip() != "running":
        return [M("doctor.docker_bad_state",
                  check=label(c), actual=c.get("state"))]
    return []


def _port_free_shape_problems(c):
    """Field criteria for a port-free check (port must be an integer in 1-65535)."""
    port = c.get("port")
    if (not isinstance(port, int) or isinstance(port, bool)
            or not 1 <= port <= 65535):
        return [M("doctor.port_not_in_range", check=label(c), actual=port)]
    return []


# kind → that kind's field-criteria function (a new kind adds one row, main loop untouched)
_KIND_SHAPE = {
    "http": _http_shape_problems,
    "docker": _docker_shape_problems,
    "port-free": _port_free_shape_problems,
}


def spec_problems(checks):
    """Pure function: list of spec-shape problems (empty = shape is valid).

    issue #22 remediation: split along "one layer of criteria = one function" --
    each kind's field criteria became its own function (one `_KIND_SHAPE` table),
    the main function does only the generic parts (non-object / missing kind /
    unknown kind / missing why) + dispatch. Message wording and order preserved.
    """
    if not isinstance(checks, list) or not checks:
        return [M("doctor.empty_spec")]
    out = []
    for c in checks:
        if not isinstance(c, dict):
            out.append(M("doctor.not_object", check=c))
            continue
        kind = str(c.get("kind") or "").strip()

        if not kind:
            out.append(M("doctor.missing_kind", check=c))
            continue
        if kind not in _PROBES:
            out.append(M("doctor.unknown_kind",
                         kind=kind, supported=", ".join(sorted(_PROBES))))
            continue
        out += _KIND_SHAPE[kind](c)
    return out


# ---- Orchestration (probe injectable: selftest uses fake probes, no network / docker) ----

def _timeout():
    """Positive timeout seconds; `_timeout_problem()` validates before probing."""
    raw = (knobs.raw("REFLECT_DOCTOR_TIMEOUT") or "").strip()
    if not raw:
        return DEFAULT_TIMEOUT
    return float(raw)


def down_labels(checks, probe=None, timeout=None):
    """Returns the list of DOWN labels (empty = all alive). Every probe carries
    a timeout (timeout=None => read the knob / default)."""
    probe = probe or _dispatch
    t = _timeout() if timeout is None else timeout
    downs = []
    for c in checks:
        ok, detail = probe(c, t)
        if not ok:
            downs.append(M("doctor.down_label", label=label(c), detail=detail))
    return downs


def _dispatch(check, timeout):
    return _PROBES[check["kind"]](check, timeout)


# ---- Entry ----

def _timeout_problem():
    """`REFLECT_DOCTOR_TIMEOUT` must be a positive number. Returns a problem or None."""
    raw = (knobs.raw("REFLECT_DOCTOR_TIMEOUT") or "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return M("doctor.bad_timeout", value=raw)
    if value <= 0:
        return M("doctor.bad_timeout", value=raw)
    return None


def _load_checks(argv):
    spec, _name, rc = gate.load_gate_spec(
        argv, "REFLECT_DOCTOR",
        off_msg=lambda n: M("doctor.off", name=n or DEFAULT_SPEC),
        missing_msg=lambda _n: M("doctor.spec_missing"),
    )
    if rc is not None:
        return None, rc
    return (spec.get("checks") if isinstance(spec, dict) else None), None


def run(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    bad = _timeout_problem()
    if bad:
        return fatal(bad)
    checks, done_rc = _load_checks(argv)
    if done_rc is not None:
        return done_rc
    probs = spec_problems(checks)
    if probs:
        print(M("doctor.spec_problems", count=len(probs)), file=sys.stderr)
        for x in probs:
            print("  · " + x, file=sys.stderr)
        return 2
    downs = down_labels(checks)
    if downs:
        print(i18n.emit("down", ", ".join(downs)))
        return 1
    print("ok")
    return 0


def _cases_fixture():
    """Probe fixtures + spec bodies. Returns a dict fed to the five group functions."""
    ok_probe = lambda c, t: (True, "")           # noqa: E731

    def down_probe(c, t):
        return (False, "fake DOWN")

    # Fixtures (spec bodies) are in English: they are the validated **input**, not core output.
    good = [
        {"kind": "http", "url": "http://127.0.0.1:8761/",
         "expect_status": 200,
         "expect_headers": {"Cross-Origin-Opener-Policy":
                            "same-origin"},
         "why": "acceptance baseline"},
        {"kind": "docker", "container": "o113",
         "state": "running", "why": "build lane"},
        {"kind": "port-free", "port": 8868,
         "why": "experiment-only port"},
    ]

    def timeout_threaded():
        """Falsifiable assertion that every probe carries a timeout: the probe
        receives the configured timeout value (not None, not 0)."""
        seen = []

        def p(c, t):
            seen.append(t)
            return (True, "")
        down_labels(good, probe=p, timeout=5.5)
        return seen == [5.5, 5.5, 5.5]

    return {"ok_probe": ok_probe, "down_probe": down_probe,
            "good": good, "timeout_threaded": timeout_threaded}


def _cases_spec(fx):
    """See `_cases()`: this group has 6 cases."""
    ok_probe = fx["ok_probe"]
    good = fx["good"]
    return [
    # (1) healthy input reports nothing
    ("doctor.valid_spec_all_alive",
     lambda: spec_problems(good) == []
     and down_labels(good, probe=ok_probe) == []),
    ("★ doctor.empty_spec",
     lambda: [p.code for p in spec_problems([])] == ["doctor.empty_spec"]),
    ("★ doctor.missing_kind",
     lambda: [p.code for p in spec_problems([{"why": "w"}])
              ] == ["doctor.missing_kind"]),
    ("★ doctor.unknown_kind",
     lambda: [p.code for p in spec_problems(
         [{"kind": "smtp"}])] == ["doctor.unknown_kind"]),
    # (3) empty input must be reported
    ("★ doctor.empty_spec_none",
     lambda: [p.code for p in spec_problems(None)] == ["doctor.empty_spec"]),
    ]


def _cases_http(fx):
    """See `_cases()`: this group has 7 cases."""
    good = fx["good"]
    return [
    ("doctor.http_verdict_ok",
     lambda: _http_verdict(
         200, {"cross-origin-opener-policy": "same-origin"},
         good[0]) == (True, "")),
    # (2) what should be reported must be reported
    ("★ doctor.http_status_mismatch",
     lambda: _http_verdict(500, {}, good[0])[0] is False
     and _http_verdict(500, {}, good[0])[1].code
     == "doctor.http_status_mismatch"),
    ("★ doctor.http_header_missing",
     lambda: _http_verdict(200, {}, good[0])[0] is False
     and _http_verdict(200, {}, good[0])[1].code
     == "doctor.http_header_mismatch"),
    ("★ doctor.http_header_value_mismatch",
     lambda: _http_verdict(
         200, {"cross-origin-opener-policy": "credentials"},
         good[0])[0] is False),
    ("★ doctor.http_missing_url",
     lambda: [p.code for p in spec_problems(
         [{"kind": "http"}])] == ["doctor.http_missing_url"]),
    ("★ doctor.http_status_not_int",
     lambda: [p.code for p in spec_problems(
         [{"kind": "http", "url": "http://x/",
           "expect_status": "200"}])
         ] == ["doctor.http_status_not_int"]),
    ("★ doctor.http_headers_not_object",
     lambda: [p.code for p in spec_problems(
         [{"kind": "http", "url": "http://x/",
           "expect_headers": ["a"]}])
         ] == ["doctor.http_headers_not_object"]),
    ]


def _cases_docker(fx):
    """See `_cases()`: this group has 4 cases."""
    return [
    ("doctor.docker_verdict_ok",
     lambda: _docker_verdict("true\n") == (True, "")),
    ("★ doctor.container_not_running",
     lambda: _docker_verdict("false")[0] is False
     and _docker_verdict("false")[1].code
     == "doctor.container_not_running"),
    ("★ doctor.docker_bad_state",
     lambda: [p.code for p in spec_problems(
         [{"kind": "docker", "container": "c",
           "state": "paused"}])] == ["doctor.docker_bad_state"]),
    ("★ doctor.docker_missing_container",
     lambda: [p.code for p in spec_problems(
         [{"kind": "docker", "state": "running"}])
         ] == ["doctor.docker_missing_container"]),
    ]


def _cases_port(fx):
    """See `_cases()`: this group has 3 cases."""
    return [
    ("doctor.port_free_verdict_ok",
     lambda: _port_free_verdict(False) == (True, "")),
    ("★ doctor.port_in_use",
     lambda: _port_free_verdict(True)[0] is False
     and _port_free_verdict(True)[1].code == "doctor.port_in_use"),
    ("★ doctor.port_not_in_range",
     lambda: [p.code for p in spec_problems(
         [{"kind": "port-free", "port": 70000,
           "why": "w"}])] == ["doctor.port_not_in_range"]),
    ]


def _cases_misc(fx):
    """See `_cases()`: this group has 2 cases."""
    down_probe = fx["down_probe"]
    good = fx["good"]
    timeout_threaded = fx["timeout_threaded"]
    return [
    ("★ doctor.down_label_names_the_target",
     # Pin only what the **case name claims** (label names the target); `detail`
     # is a pass-through from the fixture probe -- pinning the whole dict would
     # make this assertion go red whenever the fixture's wording changes.
     lambda: [p.code for p in down_labels([good[1]], probe=down_probe)
              ] == ["doctor.down_label"]
     and down_labels([good[1]], probe=down_probe)[0].params["label"]
     == "docker:o113"),
    ("★ doctor.timeout_passed_to_every_probe",
     lambda: timeout_threaded()),
    ]


def _cases():
    """Assemble the five groups of fixture assertions. **Assemble only** -- the criteria live in the group functions."""
    fx = _cases_fixture()
    return (
    _cases_spec(fx)
    + _cases_http(fx)
    + _cases_docker(fx)
    + _cases_port(fx)
    + _cases_misc(fx)
    )


GATE = meta("start-of-work doctor",
            "process / port liveness (probes things that can die => "
            "runs_at=start-of-work, not in pre-commit)",
            knobs=("REFLECT_DOCTOR", "REFLECT_DOCTOR_TIMEOUT"),
            runs_at="start-of-work",
            off_reason="this repo has no doctor.json spec: no process/port "
                       "liveness is checked => state it is off")

if __name__ == "__main__":
    sys.exit(main_selftest_or(sys.argv[1:],
                              M("gate.title.doctor"),
                              _cases(), run))
