"""Repackage v0.3.0/rc.7 deployment docs, preserving all runtime ZIP bytes."""
from copy import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
GUIDES = {
    'v0.3.0': 'guides/v0.3.0-一键部署.txt',
    'v0.4.0-rc.5': 'guides/rc.5-一键部署.txt',
    'v0.4.0-rc.7-owner': 'guides/rc.7-负责人一键部署.txt',
}
manifest_path = ROOT / 'versions.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
for version in manifest['versions']:
    if version['id'] == 'v0.4.0-rc.5':
        continue
    source = ROOT / version['source']
    package = ROOT / version['archive']
    prefix = version['archive_root']
    entries = {}
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None
        for info in archive.infolist():
            assert info.filename.startswith(prefix)
            name = info.filename[len(prefix):]
            if not name or info.is_dir():
                continue
            path = PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in name
            assert name not in entries
            file = source.joinpath(*path.parts)
            assert file.is_file() and not file.is_symlink()
            current, original = file.read_bytes(), archive.read(info)
            documentation = name.startswith('docs/') or name == 'README.md'
            if not documentation:
                assert current == original or (
                    b'\0' not in current and b'\0' not in original
                    and current.replace(b'\r\n', b'\n') == original.replace(b'\r\n', b'\n')
                ), f'Refusing runtime change in doc-only package: {version["id"]}/{name}'
            entries[name] = (copy(info), current if documentation else original)
    instruction_name = 'docs/给Muse一键部署的指令.txt'
    if instruction_name not in entries:
        info = zipfile.ZipInfo(prefix + instruction_name, (2026, 10, 28, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        entries[instruction_name] = (info, (source / instruction_name).read_bytes())
    temporary = package.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temporary, 'w') as archive:
        for name, (info, content) in sorted(entries.items()):
            archive.writestr(info, content)
    with zipfile.ZipFile(temporary) as archive:
        assert archive.testzip() is None
        for name, (_, content) in entries.items():
            assert archive.read(prefix + name) == content
    temporary.replace(package)
    version['sha256'] = hashlib.sha256(package.read_bytes()).hexdigest()
    version['file_count'] = len(entries)
    print(f'{version["id"]}: {len(entries)} files; runtime archive bytes preserved')

manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
(ROOT / 'SHA256SUMS.txt').write_text(''.join(
    f'{version["sha256"]}  {version["archive"]}\n' for version in manifest['versions']
), encoding='ascii', newline='\n')
for version in manifest['versions']:
    instruction = (ROOT / version['source'] / 'docs/给Muse一键部署的指令.txt').read_text(encoding='utf-8')
    (ROOT / GUIDES[version['id']]).write_text(
        f'安装 ZIP SHA256：{version["sha256"]}\n\n' + instruction,
        encoding='utf-8', newline='\n')
print('All three external instructions synchronized with ZIP SHA256')
