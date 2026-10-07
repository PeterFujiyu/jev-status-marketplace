# jev-status

A Claude Code plugin that asks [TypeSafe Jev](https://typesafe.ai) two independent questions after
every turn and shows both answers above the prompt (terminal, the desktop Code tab, VS Code), plus a
short toast:

```
JEV task:   ✔ done 96%
JEV deploy: ▲ production 91%
```

```
JEV task:   ✔ done 95%
JEV deploy: ? needs review · Jev suggested production 35%
```

## The two questions

**task**: where your request stands. It says nothing about deployment.

| task | means |
|---|---|
| ✔ done | the agent finished what you asked (answering a question counts) |
| ● needs action | the agent is waiting on you: a question, a decision, an approval, credentials, a manual step, or just your next request (as after "Hi") |
| ✘ failed | the agent could not complete it: unresolved errors, gave up, or the result doesn't work |

**deploy**: how ready the turn's deployable work is. It says nothing about whether you are needed, so
work can be production-ready while the agent waits for your go-ahead, and a greeting is
`needs action` with `nothing to deploy`.

| deploy | means |
|---|---|
| ▲ production | deployable work was produced, the relevant verification was reported or observed passing, and there are no known blockers or unresolved risks |
| ◆ development only | deployable work that looks usable but wasn't fully verified; fine for development or staging, not production |
| ■ not deployable | deployable work with a known blocker or failure, unfinished, risky (migrations, destructive or irreversible steps, security- or credential-sensitive changes), or an explicit warning not to ship |
| – nothing to deploy | no environment-deployable work: research, an explanation, planning, a code review, conversation |
| ? needs review | the plugin's own state, never one of Jev's choices: no one could settle the deploy answer with enough confidence, or the plugin saw a check fail that contradicts `production` |

**`production` means technical readiness only.** It does not replace CI, code review, branch
protection, approvals or your release policy, and the plugin never deploys anything.

## Who decides

For each question separately:

1. **Jev** answers both questions in one request. Answers are validated strictly: a known choice and
   a confidence between 0 and 1, or the answer counts as a Jev error.
2. If Jev's confidence is under the question's threshold (or Jev failed and the fallback is on), a
   **quick Claude review** reads the same summary Jev read.
3. If that review answers `unclear`, the **session's own model** reviews the **session context**:
   the conversation as Claude Code holds it at that moment. Claude Code may have already compacted
   it, so this review sees the summary and the turns kept since, not necessarily every earlier
   detail. It is a second look with more context, not a lossless record. It may also answer
   `unclear`.

When no one can settle a question (with Claude's review turned on; a threshold of 0 opts out of
reviews, and Jev's answer then shows as given, even a low-confidence `production`):

- **task** keeps Jev's low-confidence answer, shown with its percentage.
- **deploy** fails closed: it shows `? needs review` with what Jev suggested, never a
  low-confidence green `production`. The same happens when the review fails or times out.

A Jev error (HTTP failure, invalid JSON, malformed answer) with no Claude answer shows as
`Jev error (…)`.

## Observed checks

The plugin watches the Bash commands the agent runs during the turn and records four checks as
`passed`, `failed` or `unknown`: **tests**, **build**, **typecheck** and **lint** (e.g. `npm test`,
`pytest`, `cargo build`, `tsc`, `eslint`). These are observations, kept apart from what the agent
claims in its final message, and are sent to Jev and the summary review as such. If the plugin saw
a check fail (its latest run in the turn) and the answer is `production`, the deploy row shows
`? needs review · …, but observed tests failed` instead.

Limits, chosen so that an observation errs towards `unknown` rather than `passed`:

- It relies on Claude Code reporting a non-zero exit as a tool error. That is how Claude Code
  behaves, but the plugin API's types don't promise it. A non-zero exit that Claude Code reads as
  no error (for example `grep` finding nothing) counts as `unknown`, never `passed`.
- It only knows a command's exit status, not its output. A command counts only when that status
  speaks for it: plain commands and `&&` chains. Anything piped (`npm test | tail`), joined with `;`
  or `||`, or run in the background stays `unknown`, since the exit status there may belong to
  another command.
- A failed `&&` chain counts only when exactly one check is in it (with `cd`/`export` alone around
  it); otherwise the failing step can't be told.
- Commands are recognized by name from a fixed list of common tools and package scripts; custom
  scripts (`./scripts/ci.sh`) stay `unknown`.
- Only Bash is watched (subagents' Bash calls in the turn included); checks run through other tools
  (MCP servers, IDE tasks) are not seen.
- Checks reset with each new prompt, a background task's notification included; they describe
  that turn only.

## Install

```bash
claude plugin marketplace add PeterFujiyu/jev-status-marketplace
```

```bash
claude plugin install jev-status@peter-plugins
```

Then give it a TypeSafe API key (from https://console.typesafe.ai/keys), in the first place
that is set:

1. the plugin's **TypeSafe API key** option (stored in your system's secure storage),
2. the `TYPESAFE_API_KEY` environment variable,
3. the file `~/.config/typesafe/api_key` (skipped when `HOME` is not set).

Without a key nothing goes to TypeSafe; Claude judges each turn instead (unless you turn that off).

## Options

| Option | Default | |
|---|---|---|
| TypeSafe API key | empty | see above |
| Toast each verdict | on | also show each verdict as a toast |
| Deploy check | on | also ask the deploy question; off shows only the task row |
| Ask Claude below (% Jev confidence) | 70 | below this, Claude gives a second opinion on that answer; used for both questions unless overridden below; 0 never asks |
| Task threshold (%) | empty | overrides the above for the task question |
| Deploy threshold (%) | empty | overrides the above for the deploy question |
| Production threshold (%) | empty | a stricter threshold for a `production` answer from Jev; applies only when higher than the deploy threshold |
| Claude's view | summary-then-conversation | `summary`: only the quick review of what Jev read. `summary-then-conversation`: the same, then the session-context review when the summary isn't enough. `conversation`: always the session-context review |
| Claude review model | haiku | model for the summary review: an alias (`haiku`, `sonnet`, `opus`) or a full model id. The session-context review always uses the session's own model, which lets it reuse the prompt cache |
| Ask Claude when Jev can't answer | on | with no TypeSafe key or a Jev error, Claude answers instead of an error showing |

Claude's reviews use your own Claude Code account and count toward its usage. They only run on
answers Jev is unsure of or can't give, and one review covers every question that needs it.

## What is sent, and privacy

After each turn that ends with an answer (not after an interrupt or an error), one request goes to
TypeSafe at `https://api.typesafe.ai/v1/systemone` containing:

- an excerpt of your message for that turn (up to 2,000 characters: the start and the end, with
  the middle cut when longer),
- an excerpt of Claude's final message the same way (up to 4,000 characters),
- the last three tool error messages from the turn, subagents' tools included (up to 300
  characters each), and how many errors there were in all,
- the four observed check states (`passed` / `failed` / `unknown`; no command lines, no output),
- the fixed questions and their choices.

Nothing else: no files, no other tool output, no earlier turns; subagents' own final answers are not
judged or sent. Note that the
excerpts are your words and Claude's, and tool errors can quote file paths, code or values from
your project. Anything in them reaches a third party, so don't use the plugin with a TypeSafe key
on work whose content may not leave your machine (or turn the key off and let Claude judge).
Claude's second opinions go to Anthropic through Claude Code, like the session itself.

## Requirements

Claude Code 2.1.288 or newer. It is built on Claude Code's early-access plugin hooks API,
which may change between releases.
