"""Determine which Apple platforms still need an upload for this version."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

UPLOAD_STEPS = {"macos": "Upload to App Store Connect", "ios": "Upload to TestFlight"}


def api_pages(endpoint):
    try:
        result = subprocess.run(
            ["gh", "api", "--paginate", "--slurp", endpoint],
            check=True, capture_output=True, text=True, encoding="utf-8",
        )
    except subprocess.CalledProcessError as error:
        raise RuntimeError(error.stderr.strip()) from error
    return json.loads(result.stdout)


def store_version(tag):
    match = re.search(r"\d+(?:\.\d+)*", tag)
    if not match:
        return None
    parts = [int(part) for part in match[0].split(".")]
    return tuple((parts + [0, 0])[:3])


def successful_uploads(repository, previous_run, run_id, attempt):
    endpoint = f"repos/{repository}/actions/runs/{previous_run}/jobs?filter=all&per_page=100"
    platform_by_step = {name: platform for platform, name in UPLOAD_STEPS.items()}
    for page in api_pages(endpoint):
        for job in page["jobs"]:
            if previous_run == run_id and job["run_attempt"] >= attempt:
                continue
            for step in job["steps"] or []:
                platform = platform_by_step.get(step["name"])
                if platform is not None and step["conclusion"] == "success":
                    print(f"{platform}: upload succeeded in run {previous_run}")
                    yield platform


def plan_uploads(repository, tag, run_id, attempt):
    target = store_version(tag)
    if target is None:
        raise ValueError(f"No store version in tag {tag!r}")
    needed = {platform: True for platform in UPLOAD_STEPS}
    endpoint = f"repos/{repository}/actions/workflows/release.yml/runs?per_page=100"
    for page in api_pages(endpoint):
        for run in page["workflow_runs"]:
            if (run["event"] not in ("push", "workflow_dispatch")
                    or store_version(run["head_branch"] or "") != target):
                continue
            for platform in successful_uploads(repository, run["id"], run_id, attempt):
                needed[platform] = False
            if not any(needed.values()):
                return needed
    return needed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        needed = plan_uploads(args.repository, args.tag, args.run_id, args.attempt)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"apple uploads: {error}", file=sys.stderr)
        return 1
    with args.output.open("a", encoding="utf-8") as output:
        for platform, upload in needed.items():
            output.write(f"{platform}={str(upload).lower()}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
