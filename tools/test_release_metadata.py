"""Run the release workflow's metadata step against an isolated Git remote."""

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from tools.test_changelog import CHANGELOG, PUBLISHED

ROOT = Path(__file__).resolve().parents[1]
BASH = (
    str(Path(shutil.which("git")).resolve().parents[1] / "bin/bash.exe")
    if os.name == "nt"
    else shutil.which("bash")
)


class ReleaseMetadataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="novalist-release-metadata-")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.output = base / "output"
        self.checkout = base / "checkout"
        self.checkout.mkdir()
        remote = base / "origin.git"
        self.run_command("git", "init", "--bare", "--initial-branch=main", str(remote))
        self.run_command("git", "init", "--initial-branch=main")
        self.run_command("git", "remote", "add", "origin", str(remote))
        self.run_command("git", "config", "user.name", "Release test")
        self.run_command("git", "config", "user.email", "release@example.test")
        (self.checkout / "tools").mkdir()
        shutil.copyfile(ROOT / "tools/changelog.py", self.checkout / "tools/changelog.py")
        (self.checkout / "CHANGELOG.md").write_text(CHANGELOG, encoding="utf-8")
        (self.checkout / "app").mkdir()
        package = {"name": "release-test", "version": "3.3.0", "private": True}
        self.write_json("app/package.json", package)
        self.write_json("app/package-lock.json", {
            "name": package["name"], "version": package["version"],
            "lockfileVersion": 3, "requires": True, "packages": {"": package}
        })
        (self.checkout / "Novalist.Sdk").mkdir()
        (self.checkout / "Novalist.Sdk/Novalist.Sdk.csproj").write_text(
            '<Project>\n  <PropertyGroup>\n    <VersionPrefix>15.1.0</VersionPrefix>\n'
            '  </PropertyGroup>\n</Project>\n', encoding="utf-8"
        )
        self.run_command("git", "add", ".")
        self.run_command("git", "commit", "-m", "Release fixture")
        self.run_command("git", "push", "-u", "origin", "main")
        hook = remote / "hooks/pre-receive"
        hook.write_text(
            '#!/bin/sh\n'
            'while read old new ref; do\n'
            '  if [ "$ref" = refs/heads/main ] && [ "$TEST_MERGED_PR" != true ]; then\n'
            '    echo "GH013: Changes must be made through a pull request." >&2\n'
            '    exit 1\n'
            '  fi\n'
            'done\n', encoding="utf-8", newline="\n"
        )
        hook.chmod(0o755)
        self.initial_commit = self.run_command("git", "rev-parse", "HEAD")

    def write_json(self, name, value):
        (self.checkout / name).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def run_command(self, *command, env=None):
        result = subprocess.run(
            command, cwd=self.checkout, env=env, capture_output=True,
            text=True, encoding="utf-8", check=False
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout.strip()

    def stamp(self, version, existing_pr=""):
        self.run_step("Stamp the changelog and package version", {
            "version": version, "date": "2026-10-17", "previous_tag": "v3.5.1"
        }, {"GITHUB_REF_NAME": "v" + version, "TEST_PR_URL": existing_pr})

    def run_step(self, name, outputs, env=None):
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        step = workflow.split("      - name: " + name + "\n", 1)[1]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0])
        for key, value in outputs.items():
            script = script.replace("${{ steps.version.outputs." + key + " }}", value)
            script = script.replace("${{ steps.calc_version.outputs." + key + " }}", value)
        script = script.replace("python3", shlex.quote(Path(sys.executable).as_posix()))
        script = 'gh() { [ "$1 $2" = "pr list" ] || return 64; printf "%s" "$TEST_PR_URL"; };\n' + script
        self.output.write_text("", encoding="utf-8")
        self.run_command(BASH, "-c", script, env={
            **os.environ, "GITHUB_OUTPUT": self.output.as_posix(),
            "GITHUB_REPOSITORY": "example/novalist", **(env or {})
        })

    def assert_metadata(self, version, package_version):
        for name in ("app/package.json", "app/package-lock.json"):
            document = json.loads((self.checkout / name).read_text(encoding="utf-8"))
            self.assertEqual(document["version"], package_version)
            if "packages" in document:
                self.assertEqual(document["packages"][""]["version"], package_version)
        changelog = (self.checkout / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertIn(f"## [{version}] - 2026-10-17", changelog)
        self.assertIn(PUBLISHED.split("[Unreleased]:")[0], changelog)

    def assert_prepared_for_pr(self):
        changed = self.run_command("git", "diff", "--name-only", "HEAD")
        self.assertEqual(set(changed.splitlines()), {"CHANGELOG.md", "app/package.json", "app/package-lock.json"})
        self.assertEqual(self.run_command("git", "rev-parse", "HEAD"), self.initial_commit)
        self.assertEqual(self.run_command("git", "rev-parse", "origin/main"), self.initial_commit)
        self.assertIn("changed=true", self.output.read_text(encoding="utf-8"))

    def test_full_version_is_prepared_without_pushing_to_protected_main(self):
        self.stamp("3.6.1")
        self.assert_metadata("3.6.1", "3.6.1")
        self.assert_prepared_for_pr()

    def test_short_version_is_padded_for_npm(self):
        self.stamp("3.6")
        self.assert_metadata("3.6", "3.6.0")
        self.assert_prepared_for_pr()

    def test_reruns_do_not_consume_notes_or_downgrade_package_version(self):
        self.stamp("3.6.1")
        self.run_command("git", "add", ".")
        self.run_command("git", "commit", "-m", "Merge release metadata PR")
        self.run_command("git", "push", "origin", "main",
                         env={**os.environ, "TEST_MERGED_PR": "true"})
        commit = self.run_command("git", "rev-parse", "HEAD")
        for version in ("3.6.1", "3.5.1"):
            self.stamp(version)
            self.assertEqual(self.run_command("git", "rev-parse", "HEAD"), commit)
            self.assert_metadata("3.6.1", "3.6.1")
            self.assertEqual(self.run_command("git", "status", "--porcelain"), "")

    def test_sdk_version_is_prepared_without_pushing_to_protected_main(self):
        self.run_step("Update SDK csproj version", {"new_sdk_version": "15.2.0"})
        project = (self.checkout / "Novalist.Sdk/Novalist.Sdk.csproj").read_text(encoding="utf-8")
        self.assertIn("<VersionPrefix>15.2.0</VersionPrefix>", project)
        self.assertEqual(self.run_command("git", "diff", "--name-only", "HEAD"),
                         "Novalist.Sdk/Novalist.Sdk.csproj")
        self.assertEqual(self.run_command("git", "rev-parse", "origin/main"), self.initial_commit)

    def test_pending_release_pr_is_not_regenerated_from_later_notes(self):
        self.stamp("3.6.1", existing_pr="https://github.com/example/novalist/pull/42")
        self.assertEqual((self.checkout / "CHANGELOG.md").read_text(encoding="utf-8"), CHANGELOG)
        self.assertEqual(self.run_command("git", "status", "--porcelain"), "")
        self.assertNotIn("changed=true", self.output.read_text(encoding="utf-8"))

    def test_sdk_update_keeps_an_equal_or_newer_version_on_main(self):
        for version in ("15.0.0", "15.1.0"):
            with self.subTest(version=version):
                self.run_step("Update SDK csproj version", {"new_sdk_version": version})
                self.assertEqual(self.run_command("git", "status", "--porcelain"), "")


if __name__ == "__main__":
    unittest.main()
