# Changelog

All notable changes to this project will be documented in this file.

## [0.0.3](https://github.com/vemonet/light-chat/releases/tag/v0.0.3) - 2026-11-11

### Miscellaneous

- Python package renamed `light-chat-ui`, imported as `light_chat_ui`, PyPI rejecting `light-chat` as too similar to the existing `lightchat`. The server and pdn-agent depend on and import it, the build task and release hook use `--package light-chat-ui`, and the Dockerfiles filter on `@vemonet/light-chat`, still on the old npm name since its rename ([32a97d9](https://github.com/vemonet/light-chat/commit/32a97d95f74a330e0b4349ef5ca88e2fd3e1d2c3))

## [0.0.2](https://github.com/vemonet/light-chat/releases/tag/v0.0.2) - 2026-11-11

### Features

- **solid:** MCP Apps get the style variables of the spec in their host context, as Claude and Codex send them, e.g. `--color-background-primary`, `--color-text-primary`, `--color-border-primary`, `--font-sans`, defined on `.lc-root` from the `--lc-*` variables and resolved for the current theme, sent again when the OS theme changes while following it. Tool UIs get their own background from the new `--lc-widget-bg`, a bit lighter than the user bubble, and `--lc-widget-panel` for panels inside them, and the demo weather app uses them ([b698b03](https://github.com/vemonet/light-chat/commit/b698b03f3443eaccc58e0df1bce43c39e57a5769))
- **solid:** Model and effort of the last message saved with the conversation and picked again in the toolbar when it is opened from the history, a new session keeping the model of the one open, instead of the same model for all conversations whatever they were run with. The restored model is not written to localStorage, which keeps the model picked by the user as the default after a reload ([f62fc9b](https://github.com/vemonet/light-chat/commit/f62fc9bfa4ac1429fd7a48b06c82725ceeb91a27))
- **solid:** Tooltip component replacing the native `title` tooltips, a small dark label shown after 400ms hover or on keyboard focus, instant when moving between buttons, with the keyboard shortcut doing the same action shown as dimmed key chips, e.g. "New session Cmd Shift O" or "Send Enter", placed on a preferred side and flipped or clamped to stay in the viewport, in the top layer so it is never clipped by the sidebar or hidden under a full screen widget ([f23cb6e](https://github.com/vemonet/light-chat/commit/f23cb6e996577dffece5b4da7810704b3e54d6f1))
- **solid:** Interactive views of tool results captioned with the name the MCP App gives itself on initialize, e.g. "GEO series explorer" or "STRING network", above the view and on the full screen bar, with the tool name on hover, instead of no hint of what the view shows ([bbdd318](https://github.com/vemonet/light-chat/commit/bbdd31871b8ffc32acfdf799bb5c5cf71781c8b5))
- **pdn-agent:** Links to resources in the widget headers show the official logo of each resource, e.g. STRING, UniProt, Ensembl, BRC Analytics, inlined from `widgets/logos.js` since the widget CSP blocks external images ([e266f94](https://github.com/vemonet/light-chat/commit/e266f94462780793e4d9cf97ae0c7d56219d254e))
- **solid:** Responses keep streaming in the background when switching conversation, so several conversations can run at the same time, marked by a pulsing dot in the sidebar ([fcfcf83](https://github.com/vemonet/light-chat/commit/fcfcf838b837c945b1dac8f98417945e70cbbdf9))
- **pdn-agent:** Each call to a tool of the local MCP server, from the agent or MCP clients on `/mcp`, appended with its args and result to `data/mcp_logs.jsonl` (`MCP_LOG_FILE`) ([8ff7ff8](https://github.com/vemonet/light-chat/commit/8ff7ff8303ffe5676d4bcb0b62e05f6a563f2196))
- **pdn-agent:** Favicon of the Pathogen Data Network website on every route, linked by the chat page and set as the icon of the MCP server ([57f3458](https://github.com/vemonet/light-chat/commit/57f345809caf3ef7c9a2258f234d35a2c6569b86))
- **pdn-agent:** MCP tools hidden from the model until it finds them with the `search_tools` tool of Pydantic AI tool search, about 4 times fewer input tokens, `DEFER_TOOLS=false` sends them all ([719ea1c](https://github.com/vemonet/light-chat/commit/719ea1c75cc60fcc189a2773dc4685337ec86010))
- **pdn-agent:** MCP tools hidden from the model until it finds them with the `search_tools` tool of Pydantic AI tool search, about 4 times fewer input tokens, `DEFER_TOOLS=false` sends them all ([035889a](https://github.com/vemonet/light-chat/commit/035889a9023af040297f02dabdf917c13c52047f))
- **pdn-agent:** Widgets use the host style variables and fonts of the MCP Apps spec, so their background blends in the chat of any host ([fad4acd](https://github.com/vemonet/light-chat/commit/fad4acd401ef5b22bb45ce1e5e6202b581f84ced))
- Reasoning effort levels per model ([c7b60aa](https://github.com/vemonet/light-chat/commit/c7b60aab2ef22efe1629f3bbfb2096979e79daf1))
- MCP Apps widgets for the PDN agent servers, and provenance graph ([1354c91](https://github.com/vemonet/light-chat/commit/1354c915dfbf389f0497ecfcec223922492ca606))
- Pathogen Data Network agent federating the codeathon MCP servers ([9f7aae1](https://github.com/vemonet/light-chat/commit/9f7aae1228ae4d47465ad040a5c6f3add2409052))
- UniProt variant explorer and annotation matrix, drop Hugging Face Space ([a2a1583](https://github.com/vemonet/light-chat/commit/a2a1583d5c01d8fc59ef056207a65915610770e9))
- MCP Apps widgets, AG-UI events, Python package and UniProt demo ([e299698](https://github.com/vemonet/light-chat/commit/e299698bd31db7c50a9e55e5f7467f5d07a581ea))
- Initial commit ([2b1c5b2](https://github.com/vemonet/light-chat/commit/2b1c5b248b459baebb9df22569d310b07a070818))

### Bug Fixes

- **pdn-agent:** LAPIS tools no longer let models plot global data or claim trends from a handful of sequences, with optional `filters`, `mutations`, `lineages` and `group_by` typed as a plain object or array defaulting to empty instead of `anyOf [..., null]` that DeepSeek dropped, so a chart meant for Switzerland showed all countries, the peak of the over time summary taken among periods with at least 30 sequences and the smaller periods flagged as low n, e.g. "S:S31- peak 57.0% in 2024-07 (n=300)" instead of "85.7% in 2024-08 (n=7)", a caveat in the results of CoV-Spectrum that it holds the open INSDC sequences only and not GISAID, and guidance to pick the mutations whose proportion changes most between the start and end of the span instead of those fixed near 100% ([7b7cbe4](https://github.com/vemonet/light-chat/commit/7b7cbe4dc0fc952ad34cd50063b67be6d85f75df))
- **pdn-agent:** Link to GEO in the header of the GEO series explorer aligned at the top with the full screen button when the title wraps, instead of centered on the title, and NCBI logo shown 21px high instead of 15px so it is readable ([1a1da98](https://github.com/vemonet/light-chat/commit/1a1da984febec4f19dd1b1bf5b03e09063fc4669))
- **server:** Accept the public hostname on /mcp behind a reverse proxy, default to OpenRouter ([5561e71](https://github.com/vemonet/light-chat/commit/5561e71baadf998bbd1c2d854a9587a2fd12ecd3))
- Resolve the chat endpoint relative to the page ([960d359](https://github.com/vemonet/light-chat/commit/960d3590c9e250d2ba7cc88de363d8490e7c169d))

### Refactor

- **pdn-agent:** MCP Apps widgets rewritten with SolidJS and TypeScript, markup in JSX, state in signals and memos, instead of vanilla JS building HTML strings and wiring handlers by hand ([6a3f2b9](https://github.com/vemonet/light-chat/commit/6a3f2b9ff091ea670d4337d5e331385b7ca83d8d))
- **pdn-agent:** One Pathogen Data Network MCP server served on `/mcp`, the tools of each resource registered on it from their own module, instead of one server per resource under `/<resource>/mcp` ([1646020](https://github.com/vemonet/light-chat/commit/164602064caccec1e75ab52259e118da09101610))
- **pdn-agent:** Widgets use the official MCP Apps SDK `App` instead of a custom postMessage bridge ([8a1dcbc](https://github.com/vemonet/light-chat/commit/8a1dcbc1dc7402e895b44b67817c54d0166f2d77))
- Use the UniProt tools of the ExPASy MCP server in the demo server and PDN agent ([d6f9df0](https://github.com/vemonet/light-chat/commit/d6f9df0877228bd4b4edf942c97cdaad0ff48e23))
- Pydantic settings for the server and PDN agent configuration ([1b72e50](https://github.com/vemonet/light-chat/commit/1b72e505fbc78d5f89bbc69fc72d7dc8dedf5424))

### Performance

- **pdn-agent:** Sessions of the remote MCP servers opened once at startup and kept open for the app lifetime, instead of reconnecting and listing their tools on every chat run, about 1.6s less before the first call to the model ([619e953](https://github.com/vemonet/light-chat/commit/619e953a2f1a17b5fa6a823c28d625d062808d4e))

### Testing

- **pdn-agent:** Red teaming of the AG-UI `/chat` endpoint with NVIDIA garak, through its `function` generator calling `redteam/agui_target.py` that posts each probe prompt as a new AG-UI thread and returns the streamed answer without the provenance, with prompt injection, jailbreak, markdown exfiltration and XSS probes in `redteam/garak.yaml`, and the reports written to the git ignored `data/garak.*` ([f9f37d2](https://github.com/vemonet/light-chat/commit/f9f37d2322107aeafc26ac60f48945f75ddeade9))
- **e2e:** Dark theme picked with the theme switch in the chat sidebar, instead of the removed `#theme` select of the demo header that made the test time out after 30s ([b07f5ba](https://github.com/vemonet/light-chat/commit/b07f5ba11f2ac9d67fda0d715b7fef7fcc75b0db))

### Miscellaneous

- Npm packages renamed `@vemonet/light-chat` and `@vemonet/light-chat-solid`, npm rejecting the unscoped `light-chat` as too similar to the existing `light_chat`, with `repository`, `homepage` and `bugs` added, required by the provenance of trusted publishing that checks `repository.url` against the GitHub repo. Imports, jsdelivr URLs and install commands in the READMEs updated, the PyPI package keeps the name `light-chat` ([7933a47](https://github.com/vemonet/light-chat/commit/7933a473e9ebc88ff829f9bb08d8b7aef6402375))
- **pdn-agent:** Widgets bundled by Vite with their npm dependencies in one HTML file each, in the git ignored `mcp_servers/widgets/dist/`, instead of loading the MCP Apps SDK, d3, topojson, Cytoscape.js and the world map from jsDelivr ([28e0e34](https://github.com/vemonet/light-chat/commit/28e0e348e6fe91e9b8b0420ca6c54561d67e7ef2))
- Run the demo server with 4 uvicorn workers ([a2780b5](https://github.com/vemonet/light-chat/commit/a2780b543efae67874c591fc4325430a1a6c492e))
- Release workflow with release-it, git-cliff and trusted publishing ([1140474](https://github.com/vemonet/light-chat/commit/1140474f08bd01520b0f22b5f1d3847860b12c74))
- Upgrade to vite-plus 1.1.0 and pnpm 12.10.1 ([58119d4](https://github.com/vemonet/light-chat/commit/58119d4216aa93e6d6cd8a447b545c4d6fbad5c9))

