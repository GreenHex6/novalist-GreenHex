"""Check Apple retry decisions against recorded GitHub upload outcomes."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import apple_release_uploads as uploads


def run(run_id, tag="v3.7.1", event="push"):
    return {"id": run_id, "head_branch": tag, "event": event}


def job(platform, conclusion="success", attempt=1):
    step = {"macos": "Upload to App Store Connect", "ios": "Upload to TestFlight"}[platform]
    return {"run_attempt": attempt, "steps": [
        {"name": step, "conclusion": conclusion}
    ]}


class AppleReleaseUploadsTests(unittest.TestCase):
    def plan(self, runs, jobs, attempt=1):
        def pages(endpoint):
            if "/jobs?" in endpoint:
                run_id = int(endpoint.split("/runs/", 1)[1].split("/", 1)[0])
                return iter([{"jobs": jobs[run_id]}])
            return iter([{"workflow_runs": runs}])

        with patch.object(uploads, "api_pages", side_effect=pages):
            return uploads.plan_uploads("example/novalist", "v3.7.1", 200, attempt)

    def test_no_previous_upload_keeps_both_platforms_enabled(self):
        self.assertEqual(self.plan([], {}), {"macos": True, "ios": True})

    def test_successful_upload_skips_only_that_platform(self):
        result = self.plan([run(100)], {100: [job("macos"), job("ios", "failure")]})
        self.assertEqual(result, {"macos": False, "ios": True})

    def test_both_successful_uploads_skip_both_platforms(self):
        result = self.plan([run(100)], {100: [job("macos"), job("ios")]})
        self.assertEqual(result, {"macos": False, "ios": False})

    def test_upload_success_counts_even_if_later_job_steps_failed(self):
        recorded = job("ios")
        recorded["conclusion"] = "failure"
        recorded["steps"].append({"name": "Upload IPA artifact", "conclusion": "failure"})
        self.assertEqual(self.plan([run(100)], {100: [recorded]}),
                         {"macos": True, "ios": False})

    def test_other_versions_and_manual_builds_do_not_count(self):
        runs = [run(100, "v3.7.0"), run(101, event="workflow_dispatch")]
        jobs = {101: [job("macos", "skipped"), job("ios", "skipped")]}
        self.assertEqual(self.plan(runs, jobs), {"macos": True, "ios": True})

    def test_older_run_retry_counts_uploads_from_a_newer_run(self):
        self.assertEqual(self.plan([run(201)], {201: [job("macos")]}),
                         {"macos": False, "ios": True})

    def test_successful_upload_from_an_older_manual_run_counts(self):
        self.assertEqual(self.plan([run(100, event="workflow_dispatch")], {100: [job("ios")]}),
                         {"macos": True, "ios": False})

    def test_same_version_on_ios_tag_counts_for_ios(self):
        self.assertEqual(self.plan([run(100, "ios-v3.7.1")], {100: [job("ios")]}),
                         {"macos": True, "ios": False})

    def test_previous_attempt_counts_but_current_attempt_does_not(self):
        result = self.plan([run(200)], {200: [job("macos", attempt=1), job("ios", attempt=2)]}, attempt=2)
        self.assertEqual(result, {"macos": False, "ios": True})

    def test_skipped_and_unfinished_steps_do_not_count(self):
        jobs = [job("macos", "skipped"), job("ios", None), {"run_attempt": 1, "steps": None}]
        self.assertEqual(self.plan([run(100)], {100: jobs}), {"macos": True, "ios": True})

    def test_short_and_full_versions_match(self):
        self.assertEqual(uploads.store_version("v3.7"), uploads.store_version("ios-v3.7.0"))

    def test_cli_writes_action_outputs_only_after_successful_check(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            args = ["--repository", "example/novalist", "--tag", "v3.7.1",
                    "--run-id", "200", "--attempt", "1", "--output", str(output)]
            with patch.object(uploads, "plan_uploads", return_value={"macos": False, "ios": True}):
                self.assertEqual(uploads.main(args), 0)
            self.assertEqual(output.read_text(encoding="utf-8"), "macos=false\nios=true\n")
            with patch.object(uploads, "plan_uploads", side_effect=RuntimeError("GitHub unavailable")):
                self.assertEqual(uploads.main(args), 1)
            self.assertEqual(output.read_text(encoding="utf-8"), "macos=false\nios=true\n")


if __name__ == "__main__":
    unittest.main()
