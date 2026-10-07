# jev-status

A Claude Code plugin that asks [TypeSafe Jev](https://typesafe.ai) after every turn whether
your task is **done**, **needs action** from you, or **failed**, and shows the answer above
the prompt (terminal and the desktop Code tab), plus a short toast.

```
JEV: ● needs action 100%
```

## Install

```bash
claude plugin marketplace add PeterFujiyu/jev-status-marketplace
claude plugin install jev-status@peter-plugins
```

Then give it a TypeSafe API key (from https://console.typesafe.ai/keys), in the first place
that is set:

1. the plugin's **TypeSafe API key** option (stored in your system's secure storage),
2. the `TYPESAFE_API_KEY` environment variable,
3. the file `~/.config/typesafe/api_key`.

Without a key the band says so and nothing is sent.

## Options

| Option | Default | |
|---|---|---|
| TypeSafe API key | empty | see above |
| Toast each verdict | on | also show each verdict as a toast |

## What is sent

After each turn that ends with an answer (not after an interrupt or an error), one request
goes to `https://api.typesafe.ai/v1/systemone` containing:

- your message for that turn (first 2,000 characters),
- Claude's final message (last 4,000 characters),
- up to three tool error messages from that turn (300 characters each),
- the fixed question asking for `done`, `needaction` or `failed`.

Nothing else: no files, no other tool output, no earlier turns. Subagent turns are not sent.

## Requirements

Claude Code 2.1.288 or newer. It is built on Claude Code's early-access plugin hooks API,
which may change between releases.
