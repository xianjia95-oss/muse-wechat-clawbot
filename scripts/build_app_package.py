"""Create the public Muse Link source archive without local runtime data."""
import hashlib
import json
from pathlib import Path
import stat
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
output = root / "dist"
output.mkdir(exist_ok=True)
archive = output / f"muse-link-v{version}.zip"
files = [root / path for path in (
    ".gitignore", ".gitattributes", "package.json", "package-lock.json", "README.md",
    "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "config.example.json", "THIRD-PARTY.md",
    "LICENSE", "LICENSE.tencent", "scripts/benchmark.mjs",
    "scripts/demo.mjs", "scripts/soak.mjs", "scripts/observe.mjs", "scripts/diagnose.mjs", "scripts/build_app_package.py",
)]
# Restrict included directories and extensions; do not recursively bundle arbitrary
# JSON, databases, media, environment files or other data saved beside the source.
for directory, extensions in (
    ("src", {".mjs"}), ("deploy", {".sh", ".in"}), ("docs", {".md", ".txt"}),
    ("test", {".mjs", ".sh"}), (".github/workflows", {".yml", ".yaml"}),
):
    files.extend(path for path in (root / directory).rglob("*") if path.is_file() and path.suffix in extensions)
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for path in sorted(files, key=lambda value: value.relative_to(root).as_posix()):
        content = path.read_bytes()
        relative = path.relative_to(root).as_posix()
        assert not path.is_symlink(), path
        assert path.stat().st_size > 0, path
        entry = zipfile.ZipInfo(f"muse-link/{relative}", (2026, 10, 21, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = (stat.S_IFREG | (0o755 if path.suffix == ".sh" or relative == "src/cli.mjs" else 0o644)) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        bundle.writestr(entry, content)
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    for name in bundle.namelist():
        source = root / Path(name).relative_to("muse-link")
        assert bundle.read(name) == source.read_bytes()
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
print(f"Built {archive}: {len(files)} files, {archive.stat().st_size} bytes")
print(f"SHA256 {digest}")
