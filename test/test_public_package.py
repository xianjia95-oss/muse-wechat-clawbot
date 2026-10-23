"""The source package must never auto-include local debug documents."""
import json
from pathlib import Path
import shutil
import secrets
import subprocess
import sys
import tempfile
import unittest
import zipfile

PROJECT = Path(__file__).resolve().parents[1]


class PublicPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="muse-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = json.loads((PROJECT / "scripts/public-files.json").read_text(encoding="utf-8"))
        for name in self.manifest:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PROJECT / name, target)

    def build(self, options=()):
        return subprocess.run([sys.executable, *options, str(self.root / "scripts/build_app_package.py")], capture_output=True)

    def test_unlisted_debug_data_is_excluded(self):
        canary = secrets.token_hex(32)
        for name in ("docs/local-session.md", "test/local-fixture.mjs", "config.json", "local-debug/report.txt"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(canary, encoding="utf-8")
        self.assertEqual(self.build().returncode, 0)
        archive = next((self.root / "dist").glob("*.zip"))
        with zipfile.ZipFile(archive) as bundle:
            self.assertEqual(set(bundle.namelist()), {f"muse-link/{name}" for name in self.manifest})
            self.assertFalse(any(canary.encode() in bundle.read(name) for name in bundle.namelist()))

    def test_unsafe_or_duplicate_manifest_cannot_replace_existing_archive(self):
        self.assertEqual(self.build().returncode, 0)
        archive = next((self.root / "dist").glob("*.zip"))
        original = archive.read_bytes()
        for extra in ("../outside.txt", "C:/private.txt", "docs/../config.json", self.manifest[0]):
            (self.root / "scripts/public-files.json").write_text(json.dumps(self.manifest + [extra]), encoding="utf-8")
            self.assertNotEqual(self.build().returncode, 0)
            self.assertNotEqual(self.build(("-O",)).returncode, 0)
            self.assertEqual(archive.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
