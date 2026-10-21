# Third-party protocol references

Muse Link's own source and documentation are distributed under the [MIT license](LICENSE).
The notices below remain applicable to the corresponding third-party materials.

Runtime dependencies: undici (MIT) and qrcode (MIT). Their license notices are
distributed with the respective npm packages installed by npm ci.

Additional documentation references checked on 2026-10-20:

- [Tencent openclaw-weixin protocol](https://github.com/tencent/openclaw-weixin/blob/HEAD/docs/protocol_zh_CN.md)
  and [QR login reference](https://github.com/tencent/openclaw-weixin/blob/HEAD/src/auth/login-qr.ts),
  for long-poll semantics and phone verification status handling. Implementations
  in this project are independently written.
  Tencent's reference project is MIT-licensed, Copyright (C) 2026 Tencent;
  its notice is retained in [LICENSE.tencent](LICENSE.tencent).
- [UPGPTs Muse / WeChat tutorial](https://upgpts.com/en/tutorials/muse/muse-wechat),
  for the separate listener and tool-worker deployment workflow. Differences and
  verification limits are described in [docs/REFERENCE.md](docs/REFERENCE.md).

Media protocol behavior was additionally checked on 2026-10-21 against Tencent's
protocol documentation, src/messaging/send.ts, src/cdn/upload.ts,
src/cdn/cdn-upload.ts and src/cdn/cdn-url.ts. Muse Link independently implements
streamed encrypted snapshots, bounded uploads, persisted recovery and media
reply routing; Tencent's TypeScript implementation is not bundled or executed.

Protocol identity values preserve wire compatibility and do not imply an
affiliation with Tencent, OpenClaw, or Meta. This project has not yet been tested
against a logged-in real WeChat account.
