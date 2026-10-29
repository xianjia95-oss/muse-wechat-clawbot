"""Rebuild only rc.5 and its credential-free recovery supplement, without publishing."""
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / 'versions/v0.4.0-rc.5'
revision = 'rc5-recovery-20261029-patrol1'
assert json.loads((source / 'package.json').read_text(encoding='utf-8'))['muse_link_recovery'] == revision
assert f"export const RECOVERY_REVISION = '{revision}';" in (source / 'src/config.mjs').read_text(encoding='utf-8')
subprocess.run([sys.executable, str(source / 'scripts/build_app_package.py')], check=True)
original = source / 'dist/muse-link-v0.4.0-rc.5.zip'
package = root / 'packages/muse-link-v0.4.0-rc.5-clean-install.zip'
with zipfile.ZipFile(original) as archive, zipfile.ZipFile(package, 'w') as output:
    for info in archive.infolist():
        assert info.filename.startswith('muse-link/')
        content = archive.read(info)
        info.filename = info.filename[len('muse-link/'):]
        output.writestr(info, content)
    file_count = len(archive.infolist())
digest = hashlib.sha256(package.read_bytes()).hexdigest()
manifest_path = root / 'versions.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
for version in manifest['versions']:
    if version['id'] == 'v0.4.0-rc.5':
        version.update(sha256=digest, file_count=file_count, recovery_revision=revision)
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
(root / 'SHA256SUMS.txt').write_text(''.join(f"{v['sha256']}  {v['archive']}\n" for v in manifest['versions']), encoding='ascii', newline='\n')
guide = root / 'guides/rc.5-入站多媒体部署验收.txt'
text = guide.read_text(encoding='utf-8').splitlines()
text[0] = f'安装 ZIP SHA256：{digest}'
guide.write_text('\n'.join(text) + '\n', encoding='utf-8', newline='\n')

# Keep the copy-to-Muse instruction and its external package hash in sync.
one_click = (source / 'docs/给Muse一键部署的指令.txt').read_text(encoding='utf-8')
(root / 'guides/rc.5-一键部署.txt').write_text(
    f'安装 ZIP SHA256：{digest}\n\n' + one_click,
    encoding='utf-8', newline='\n')

# Standalone helpers reuse the production config and jobs directory, but do not
# replace current, the daemon, native workers, service templates or credentials.
names = ['package.json', 'scripts/runtime-check.mjs', 'scripts/tool-job.mjs',
         'scripts/patrol.mjs', 'src/patrol.mjs', 'deploy/patrol.sh', 'deploy/wechat-hook.sh',
         'scripts/recover-service.mjs', 'scripts/http-tool.mjs',
         'src/runtime-check.mjs', 'src/config.mjs', 'src/errors.mjs', 'src/state-lock.mjs', 'src/tool-jobs.mjs',
         'src/service-recovery.mjs', 'src/http-tool.mjs',
         'deploy/repair-service.sh', 'deploy/muse-link.service.in', 'deploy/recover-service.sh', 'deploy/recovery-policy.example.json',
         'docs/BURST_MESSAGES.md', 'docs/RUNTIME_RECOVERY.md', 'docs/给Muse完善巡检的指令.txt']
payload = {name: (source / name).read_bytes() for name in names}
payload['SHA256SUMS.txt'] = ''.join(f'{hashlib.sha256(payload[name]).hexdigest()}  {name}\n' for name in sorted(payload)).encode('utf-8')
dist = root / 'dist'
dist.mkdir(exist_ok=True)
supplement = dist / f'muse-link-{revision}.zip'
with zipfile.ZipFile(supplement, 'w') as archive:
    for name, content in sorted(payload.items()):
        info = zipfile.ZipInfo(name, (2026, 10, 29, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | (0o755 if name.endswith('.sh') else 0o644)) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, content)
with zipfile.ZipFile(supplement) as archive:
    assert archive.testzip() is None
    for name, content in payload.items():
        assert archive.read(name) == content
supplement_hash = hashlib.sha256(supplement.read_bytes()).hexdigest()
supplement.with_suffix('.zip.sha256').write_text(f'{supplement_hash}  {supplement.name}\n', encoding='ascii', newline='\n')
print(f'rc.5 catalog package: {file_count} files, SHA256 {digest}')
print(f'Recovery supplement: {supplement}, SHA256 {supplement_hash}')
