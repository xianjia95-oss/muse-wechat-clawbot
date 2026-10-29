"""Verify packages and sources, allowing Git's text line-ending normalization."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'versions.json').read_text(encoding='utf-8'))
expected = {'v0.3.0', 'v0.4.0-rc.5', 'v0.4.0-rc.7-owner'}
deployment_guides = {
    'v0.3.0': 'guides/v0.3.0-一键部署.txt',
    'v0.4.0-rc.5': 'guides/rc.5-一键部署.txt',
    'v0.4.0-rc.7-owner': 'guides/rc.7-负责人一键部署.txt',
}
assert manifest['format'] == 1
assert {v['id'] for v in manifest['versions']} == expected
assert len(manifest['versions']) == 3
assert {p.name for p in (ROOT / 'versions').iterdir() if p.is_dir()} == expected
assert {p.relative_to(ROOT).as_posix() for p in (ROOT / 'packages').iterdir()} == {v['archive'] for v in manifest['versions']}
checksums = ''
for version in manifest['versions']:
    directory = ROOT / version['source']
    archive_path = ROOT / version['archive']
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    assert digest == version['sha256'], f"Package checksum mismatch: {version['id']}"
    package = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
    assert package['version'] == version['version']
    if 'build' in version:
        assert package['muse_link_build'] == version['build']
    if 'recovery_revision' in version:
        assert package['muse_link_recovery'] == version['recovery_revision']
    instruction = (directory / 'docs/给Muse一键部署的指令.txt').read_text(encoding='utf-8')
    assert (ROOT / deployment_guides[version['id']]).read_text(encoding='utf-8') == f'安装 ZIP SHA256：{digest}\n\n' + instruction, f"One-click instruction/package checksum drift: {version['id']}"
    names = set()
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.testzip() is None
        for member in archive.infolist():
            assert member.filename.startswith(version['archive_root'])
            name = member.filename[len(version['archive_root']):]
            if not name or member.is_dir():
                continue
            path = PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in name
            assert not set(path.parts) & {'test', 'tests', '.github'}, 'Development files are not deliverable'
            assert not path.name.startswith(('AUDIT', 'VALIDATION', 'RELEASE_NOTES')), 'Reports are not deliverable'
            assert path.name not in {'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'TEST_API.md', 'ACCEPTANCE_CHECKLIST.md', 'OPEN_SOURCE.md'}
            assert not path.name.endswith('.test.mjs')
            assert name not in {'scripts/benchmark.mjs', 'scripts/demo.mjs', 'scripts/soak.mjs', 'scripts/test-client.mjs'}
            assert name not in names, 'Duplicate ZIP entry'
            assert not re.search(r'(?i)(^|/)(node_modules|\.git|\.env|session\.json|config\.json|claim\.[^/]*)(/|$)|\.(sqlite|db|log|pem|key)$', name)
            names.add(name)
            source_file = directory.joinpath(*path.parts)
            assert source_file.is_file() and not source_file.is_symlink()
            actual_bytes, archive_bytes = source_file.read_bytes(), archive.read(member)
            assert actual_bytes == archive_bytes or (b'\0' not in actual_bytes and b'\0' not in archive_bytes and actual_bytes.replace(b'\r\n', b'\n') == archive_bytes.replace(b'\r\n', b'\n')), f"Source/archive mismatch: {version['id']}/{name}"
    assert len(names) == version['file_count']
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file() and not set(p.relative_to(directory).parts) & {'node_modules', '__pycache__', 'dist', 'coverage'} and not p.name.endswith(('.log', '.pyc'))}
    assert actual == names, f"Unexpected source files: {version['id']}"
    checksums += f"{digest}  {version['archive']}\n"
    print(f"{version['id']}: {len(names)} source files and ZIP SHA256 verified")
assert (ROOT / 'SHA256SUMS.txt').read_text(encoding='utf-8') == checksums
print('Catalog verified: exactly three versions; no runtime state in archives.')
