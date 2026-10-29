"""Rebuild the three reviewed public packages and synchronize their guides."""
from copy import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
GUIDES = {
    'v0.3.0': 'guides/v0.3.0-一键部署.txt',
    'v0.4.0-rc.5': 'guides/rc.5-一键部署.txt',
    'v0.4.0-rc.7-owner': 'guides/rc.7-负责人一键部署.txt',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    manifest_path = ROOT / 'versions.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    versions = manifest['versions']
    require(len(versions) == 3 and {item['id'] for item in versions} == set(GUIDES),
            'Expected exactly the three retained versions')
    # Stage and verify every archive before replacing any catalog artifact.
    with tempfile.TemporaryDirectory(prefix='muse-catalog-build-') as temporary:
        staged = []
        for item in versions:
            source = ROOT / item['source']
            subprocess.run([sys.executable, str(source / 'scripts/build_app_package.py')], check=True)
            original = source / f'dist/muse-link-v{item["version"]}.zip'
            package = Path(temporary) / Path(item['archive']).name
            reviewed = json.loads((source / 'scripts/public-files.json').read_text(encoding='utf-8'))
            prefix = item['archive_root']
            require(prefix in ('', 'muse-link/'), 'Unexpected archive root')
            with zipfile.ZipFile(original) as archive, zipfile.ZipFile(package, 'w') as output:
                require(archive.testzip() is None, 'Invalid source archive')
                for member in archive.infolist():
                    require(member.filename.startswith('muse-link/'), 'Unexpected source archive member')
                    name = member.filename[len('muse-link/'):]
                    require(name in reviewed, 'Unreviewed source archive member')
                    info = copy(member)
                    info.filename = prefix + name
                    output.writestr(info, archive.read(member))
            with zipfile.ZipFile(package) as archive:
                require(archive.testzip() is None, 'Invalid catalog archive')
                require(len(archive.infolist()) == len(reviewed) and
                        set(archive.namelist()) == {prefix + name for name in reviewed},
                        'Catalog inventory differs from public manifest')
                for name in reviewed:
                    require(archive.read(prefix + name) == (source / name).read_bytes(),
                            'Catalog content differs from source')
            item.update(sha256=hashlib.sha256(package.read_bytes()).hexdigest(), file_count=len(reviewed))
            staged.append((package, ROOT / item['archive']))
        for package, destination in staged:
            replacement = destination.with_suffix('.zip.tmp')
            replacement.write_bytes(package.read_bytes())
            replacement.replace(destination)

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n',
                             encoding='utf-8', newline='\n')
    (ROOT / 'SHA256SUMS.txt').write_text(''.join(
        f'{item["sha256"]}  {item["archive"]}\n' for item in versions), encoding='ascii', newline='\n')
    for item in versions:
        instruction = (ROOT / item['source'] / 'docs/给Muse一键部署的指令.txt').read_text(encoding='utf-8')
        (ROOT / GUIDES[item['id']]).write_text(f'安装 ZIP SHA256：{item["sha256"]}\n\n' + instruction,
                                             encoding='utf-8', newline='\n')
        if item['id'] == 'v0.4.0-rc.5':
            acceptance = ROOT / 'guides/rc.5-入站多媒体部署验收.txt'
            lines = acceptance.read_text(encoding='utf-8').splitlines()
            lines[0] = f'安装 ZIP SHA256：{item["sha256"]}'
            acceptance.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
        print(f'{item["id"]}: {item["file_count"]} reviewed files; SHA256 {item["sha256"]}')
    subprocess.run([sys.executable, str(ROOT / 'scripts/check_catalog.py')], check=True)


if __name__ == '__main__':
    main()
