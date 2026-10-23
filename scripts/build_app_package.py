"""Create the public Muse Link source archive without local runtime data."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
output = root / "dist"
output.mkdir(exist_ok=True)
archive = output / f"muse-link-v{version}.zip"
# A document extension is not a public-data boundary. Only reviewed paths from
# this explicit manifest are eligible, including docs and test fixtures.
manifest = json.loads((root / "scripts/public-files.json").read_text(encoding="utf-8"))
require(isinstance(manifest, list) and manifest and all(isinstance(name, str) for name in manifest), "Invalid public manifest")
require(len(set(manifest)) == len(manifest), "Duplicate public path")
files = []
for name in manifest:
    relative = PurePosixPath(name)
    require(name == relative.as_posix() and not relative.is_absolute() and ".." not in relative.parts and "\\" not in name and ":" not in name, "Unsafe public path")
    path = root / name
    require(not any(root.joinpath(*relative.parts[:index]).is_symlink() for index in range(1, len(relative.parts) + 1)), "Symbolic public path")
    require(path.is_file() and path.stat().st_size > 0, f"Missing public source: {name}")
    require(root in path.resolve().parents, "Public source outside project")
    files.append(path)
temporary = archive.with_suffix(".zip.tmp")
with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for path in sorted(files, key=lambda value: value.relative_to(root).as_posix()):
        content = path.read_bytes()
        relative = path.relative_to(root).as_posix()
        require(not path.is_symlink(), "Symbolic public source")
        require(path.stat().st_size > 0, "Empty public source")
        entry = zipfile.ZipInfo(f"muse-link/{relative}", (2026, 10, 21, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = (stat.S_IFREG | (0o755 if path.suffix == ".sh" or relative == "src/cli.mjs" else 0o644)) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        bundle.writestr(entry, content)
with zipfile.ZipFile(temporary) as bundle:
    require(bundle.testzip() is None, "Archive integrity failure")
    for name in bundle.namelist():
        source = root / Path(name).relative_to("muse-link")
        require(bundle.read(name) == source.read_bytes(), "Archive content differs from source")
temporary.replace(archive)
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
print(f"Built {archive}: {len(files)} files, {archive.stat().st_size} bytes")
print(f"SHA256 {digest}")
