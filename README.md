# jev-status

A Claude Code plugin that asks [TypeSafe Jev](https://typesafe.ai) after every turn whether
your task is **done**, **needs action** from you, or **failed**, and shows the answer above
the prompt (terminal, the desktop Code tab, VS Code), plus a short toast. When Jev is unsure,
it asks Claude for a second opinion and shows that instead.

```
JEV: ● needs action 96%
JEV: ✘ failed · Claude (Jev 55%)
JEV: ✔ done · Claude, full session (Jev 40%)
```

Who decides, in order: Jev; below its confidence threshold, a quick Claude review of the same
summary; and if that review can't tell, the session's own model re-reading the whole session.

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

Without a key nothing goes to TypeSafe; Claude judges each turn instead (unless you turn that off).

## Options

| Option | Default | |
|---|---|---|
| TypeSafe API key | empty | see above |
| Toast each verdict | on | also show each verdict as a toast |
| Ask Claude below (% Jev confidence) | 70 | below this, Claude gives a second opinion and its answer is shown; 0 never asks |
| Claude's view | summary-then-conversation | `summary`: the review model reads what Jev read. `summary-then-conversation`: the same, and when that is not enough to tell, the session's own model re-reads the whole session from cache. `conversation`: always the whole session |
| Claude review model | haiku | model for the summary review: an alias (`haiku`, `sonnet`, `opus`) or a full model id. The whole-session review always uses the session's own model, so the conversation comes from cache |
| Ask Claude when Jev can't answer | on | with no TypeSafe key or a Jev error, Claude answers instead of an error showing |

Claude's reviews use your own Claude Code account and count toward its usage. They only run on
turns where Jev is unsure or can't answer.

## What is sent

After each turn that ends with an answer (not after an interrupt or an error), one request
goes to `https://api.typesafe.ai/v1/systemone` containing:

- your message for that turn (first 2,000 characters),
- Claude's final message (last 4,000 characters),
- up to three tool error messages from that turn (300 characters each),
- the fixed question asking for `done`, `needaction` or `failed`.

Nothing else: no files, no other tool output, no earlier turns. Subagent turns are not sent.
Claude's second opinion goes to Anthropic through Claude Code, like the session itself.

## Requirements

Claude Code 2.1.288 or newer. It is built on Claude Code's early-access plugin hooks API,
which may change between releases.
