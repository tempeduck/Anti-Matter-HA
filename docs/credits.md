# Credits and licenses

Anti-Matter is a rewrite of [Rematters](https://github.com/Rematters/Rematters-HA) by Jesse Hulswit
([JesseFPV](https://rematters.casa/)), reworked into a cloud-free, local-only add-on. Full credit to Jesse for the
original Rematters add-on and its design.

This fork builds on [kedube/Anti-Matter-HA](https://github.com/kedube/Anti-Matter-HA), including its 3.0.1
redesign, scanner, 24 languages, tests and release tooling. Its original base is
[Cl3tus/Anti-Matter-HA](https://github.com/Cl3tus/Anti-Matter-HA), whose work still underlies much of the backend.
This fork adds scanner confirmations, Home Assistant discovery and import, automatic usage tracking, responsive code displays and standalone Docker packaging.

Anti-Matter builds on [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) (MIT) and
[zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) (Apache-2.0), [Lucide](https://lucide.dev) icons (ISC),
[Material Design Icons](https://pictogrammers.com/library/mdi/) (Pictogrammers Free License), the Manrope and
JetBrains Mono fonts (SIL OFL 1.1), the [zwave-js](https://github.com/zwave-js/node-zwave-js) device database (MIT),
[FastAPI](https://fastapi.tiangolo.com) and [python-qrcode](https://github.com/lincolnloop/python-qrcode). Their
licence files ship next to the vendored copies.

The standalone backup viewer bundles Kazuhiko Arase's
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), pinned to a reviewed commit.

## Trademarks

Matter, HomeKit, Z-Wave, Zigbee and Tuya (and their logos) are trademarks of their respective owners: the
Connectivity Standards Alliance, Apple Inc., the Z-Wave Alliance and Tuya Inc. They are used only to identify the
protocols a code belongs to. Anti-Matter is an independent project and is not affiliated with or endorsed by any of
them.

## License

MIT. See [LICENSE](../LICENSE).
