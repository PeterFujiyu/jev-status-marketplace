# jev-status

A Claude Code plugin that shows, above the prompt, whether the last turn left the task
**done**, **needaction** or **failed**, as judged by [TypeSafe Jev](https://typesafe.ai).

## Install

```bash
claude plugin marketplace add <path or GitHub owner/repo of this marketplace>
claude plugin install jev-status@peter-plugins
```

## Requirements

This version only *displays* a verdict. It reads `~/.claude/jev-status/<session_id>.json`,
which a separate Stop hook (`jev-stop.py`) must write after each turn. That hook is not
part of this plugin yet.

## Privacy

The Stop hook sends each turn's request, Claude's final message and up to three tool error
messages to `https://api.typesafe.ai` using your own TypeSafe API key.

## Note

Built on Claude Code's early-access plugin hooks API, which may change between releases.
