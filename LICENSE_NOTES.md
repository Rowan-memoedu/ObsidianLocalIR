# License Notes

This plugin is an Obsidian-native implementation inspired by:

- `ebAobS/roaming-mode-incremental-reading`
- Repository: https://github.com/ebAobS/roaming-mode-incremental-reading

The source project advertises MIT in `package.json` and `plugin.json`, while several
source files include older GPL-style headers. To avoid license ambiguity, this
Obsidian plugin does not directly copy the SiYuan UI or API integration code.
It reimplements the compatible ideas in a small Obsidian-specific codebase:

- multi-metric priority model
- absolute-priority probability
- roulette-weighted document selection
- visit records
- later/archive queue states
- local annotation records
- legacy Obsidian highlight compatibility
- local rewrite records
- future TF-IDF recommendation placeholder

If future work copies larger source sections directly, preserve upstream copyright
headers and re-check the effective license before distribution.
