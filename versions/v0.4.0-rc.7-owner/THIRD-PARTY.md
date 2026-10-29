# Third-party notices

Muse Link's own source and documentation are distributed under the [MIT license](LICENSE).
The notices below remain applicable to the corresponding third-party materials.

Runtime dependencies: undici (MIT), qrcode (MIT), and silk-wasm 3.7.1
(MIT, Copyright (c) 2024 idranme). Their license notices are
distributed with the respective npm packages installed by npm ci.

The iLink protocol behavior was checked against Tencent's documentation and
reference source. Its MIT notice, Copyright (C) 2026 Tencent, is retained in
[LICENSE.tencent](LICENSE.tencent). Muse Link's implementation is independently
written. Bidirectional media field formats and download/key variants were
checked against @tencent-weixin/openclaw-weixin 2.4.10; that reference package
is not a runtime dependency. silk-wasm supplies the actual SILK/WAV codec;
its original MIT notice is included in the installed npm package.
