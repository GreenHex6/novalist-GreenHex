import importlib.util
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import locale_targets


def load_doctor(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DoctorArtifactTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / "Extension.ts"
        self.source.write_text("t('real.key'); rpc.request('scenes/read')", encoding="utf-8")
        self.artifact = self.root / "artifacts" / "copied-project" / "Old.ts"
        self.artifact.parent.mkdir(parents=True)
        self.artifact.write_text("t('obsolete.key'); rpc.request('obsolete/call')", encoding="utf-8")

    def test_locale_references_ignore_artifact_copies(self):
        target = locale_targets.Target(
            name="extension", locales_dir=self.root / "Locales", scan_roots=[self.root],
            scan_exts={".ts"}, literal_patterns=[re.compile(r"\bt\('([^']+)'\)")],
            dynamic_prefixes=set(),
        )
        refs = load_doctor("locale-doctor").scan_references(target, {"real.key"})
        self.assertEqual({"real.key"}, refs)

    def test_extension_discovery_ignores_copied_locales(self):
        locales = self.root / "Locales"
        copied = self.artifact.parent / "Locales"
        for path in (locales, copied):
            path.mkdir()
            (path / "en.json").write_text('{"real":{"key":"Real"}}', encoding="utf-8")
        with patch.object(locale_targets, "EXTENSION_WORKSPACES", [self.root]):
            targets = locale_targets.extension_targets()
        self.assertEqual([locales], [target.locales_dir for target in targets])

    def test_rpc_discovery_keeps_source_and_ignores_artifact_copies(self):
        paths = load_doctor("rpc-doctor").walk(self.root, (".ts",))
        self.assertEqual([self.source], paths)


if __name__ == "__main__":
    unittest.main()
