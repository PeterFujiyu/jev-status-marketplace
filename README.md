# jev-status

A Claude Code plugin that asks [TypeSafe Jev](https://typesafe.ai) two independent questions after
every turn and shows both answers above the prompt (terminal, the desktop Code tab, VS Code), plus a
short toast:

```
JEV task: ✔ done 97%
JEV ship: ▲ production 91%
```

```
JEV task: ✔ done 95%
JEV ship: ◆ development 92% · production gated: verification incomplete
```

```
JEV task: ✔ done 95%
JEV ship: ? needs review · Jev suggested production 35%
```

On the right of the band, **r: ↻ retry** judges the last turn again: click it, or press `r` with
the band focused (never from the prompt). It reuses the same summary and runs a fresh
session-context review where one is needed. It is there for working on the plugin and for a
verdict that went wrong (a timeout, a Jev error), and it appears once a turn has been judged.

## The two questions

**task**: where your request stands. It says nothing about delivery.

| task | means |
|---|---|
| ✔ done | the agent finished what you asked (answering a question counts) |
| ● needs action | the agent is waiting on you: a question, a decision, an approval, credentials, a manual step, or just your next request (as after "Hi") |
| ✘ failed | the agent could not complete it: unresolved errors, gave up, or the result doesn't work |

**ship**: the highest safe delivery level for the **current active work** in the session, which may
come from earlier turns. A turn with no edits of its own (like "yes, push it" after the work was
written and tested earlier) is still about that work, not `n/a`. It says nothing about whether you
are needed, so work can be production-ready while the agent waits for your go-ahead.

| ship | means |
|---|---|
| ▲ production | the active work's relevant verification was reported or observed passing, with no known blockers or unresolved risks; ready to push or merge and release |
| ◆ development | usable but not verified enough for production; safe to push or merge for development or staging |
| ■ blocked | shouldn't be pushed, merged or deployed yet: a known failure, unfinished work, an unresolved risk (migrations, destructive or irreversible steps, security- or credential-sensitive changes), or a required fix or review |
| – n/a | genuinely no active deliverable work in the session: questions, research, explanation, planning, conversation |
| ? needs review | the plugin's own state, never one of Jev's choices: no one could settle the ship answer with enough confidence, or the plugin saw a check fail that contradicts `production` |

### The verification gate

Behind the ship row there is a third, internal question, never drawn as a row of its own:
**verification**, whether all the verification the active work needs is done: `complete`,
`incomplete` (a relevant test, manual, runtime, integration, environment or compatibility check is
still pending, unchecked, not run or left manual), or `unknown`. Implementation complete does not
mean production ready. The rubric tells Jev and Claude that wording like *still manual*,
*unchecked*, *not tested*, *not run*, *pending verification*, *needs validation*, *requires manual
testing* or *open checks* means `incomplete`; the plugin itself matches no keywords.

After all reviews, the plugin applies the gate to the ship answer:

| ship | verification | shown |
|---|---|---|
| production | complete | ▲ production |
| production | incomplete | ◆ development · production gated: verification incomplete |
| production | unknown, or not settled by a review | ? needs review · … but verification unknown / not settled |
| production | (a check the plugin saw fail this turn) | ◆ development · production gated: observed tests failed |
| development / blocked / n/a | any | unchanged |

So the session-context review can recover context from earlier turns, but it can't lift work to
`production` on its own: verification has to be `complete` as well.

**`production` means technical readiness only.** It does not replace CI, code review, branch
protection, approvals or your release policy, and the plugin never pushes or deploys anything.

## Who decides

1. **Jev** answers both questions in one request. It sees only the latest turn (see *What is sent*).
   Answers are validated strictly: a known choice and a confidence between 0 and 1, or the answer
   counts as a Jev error.
2. **task**, when Jev's confidence is under the task threshold (or Jev failed and the fallback is
   on): a **quick Claude review** reads the same summary Jev read; if it answers `unclear`, the
   session-context review below takes over (as set by *Claude's view*).
3. **ship** goes straight to the **session-context review** when:
   - Jev's confidence is under the ship threshold, which includes a low-confidence `n/a`;
   - Jev says `production` under the production threshold;
   - the turn ran a delivery command (`git push`/`merge`, also with git options like
     `git -C /repo push`, `gh pr merge`, `npm publish`, `terraform apply`, `… deploy`, …), even if
     Jev is sure. Jev can't see the earlier turns where that work was written and verified;
   - Jev says `n/a`, even confidently, right after a turn whose ship answer had active work
     (anything but `n/a`): the turn may only be approving or continuing that work. Only that
     last answer is remembered, no history;
   - or Jev failed and the fallback is on.

   The current-turn summary can't show work from earlier turns, so it is skipped for ship.
4. **verification** goes to the session-context review with ship whenever ship does, and on its own
   when Jev's ship answer is `production` and Jev is unsure of verification (or the turn delivered
   work). When ship isn't `production`, verification can't change what is shown, so it isn't
   reviewed.

The **session-context review** is the session's own model, asked to judge the latest active work
across the session as Claude Code holds it at that moment. Claude Code may have already compacted
the conversation, so this review sees the summary and the turns kept since, not necessarily every
earlier detail. It is a second look with more context, not a lossless record. When several
questions need it, one review answers them all. It may answer `unclear`. It is also the same model
that did the work, reviewing itself; its prompt asks it to judge verification as strictly as an
outside reviewer would, and the verification gate above holds whatever it answers.

When no one can settle a question (with Claude's review turned on; a threshold of 0 opts out of
reviews, delivery turns included, and Jev's answer then shows as given, even a low-confidence
`production`):

- **task** keeps Jev's low-confidence answer, shown with its percentage.
- **ship** and **verification** fail closed: ship shows `? needs review` with what Jev suggested,
  never a low-confidence green `production`; an unsettled verification counts as not complete. The same happens when the review fails or times out, and on the two kinds
  of turn above (delivery, n/a after active work), whatever Jev's confidence was.

A Jev error (HTTP failure, invalid JSON, malformed answer) with no Claude answer shows as
`Jev error (…)`.

## Observed checks

The plugin watches the Bash commands the agent runs during the turn and records four checks as
`passed`, `failed` or `unknown`: **tests**, **build**, **typecheck** and **lint** (e.g. `npm test`,
`pytest`, `cargo build`, `tsc`, `eslint`). These are observations, kept apart from what the agent
claims in its final message, and are sent to Jev and the summary review as such. If the plugin saw
a check fail (its latest run in the turn) and the answer is `production`, the ship row shows
`◆ development · production gated: observed tests failed` instead. A passing check alone never
makes verification `complete`.

Limits, chosen so that an observation errs towards `unknown` rather than `passed`:

- It relies on Claude Code reporting a non-zero exit as a tool error. That is how Claude Code
  behaves, but the plugin API's types don't promise it. A non-zero exit that Claude Code reads as
  no error (for example `grep` finding nothing) counts as `unknown`, never `passed`.
- It only knows a command's exit status, not its output. A check passes only when that status
  speaks for a real run of it: a plain command, or an `&&` chain that exited 0.
- Version, help, listing and dry-run forms (`pytest --version`, `tsc -v`, `npm test -- --help`,
  `jest --listTests`, `pytest --collect-only`, `cargo test --no-run`, `--dry-run`, …) are not runs.
- A failure is blamed on a check only when the command was that check alone. In a failed chain
  (`cd /missing && npm test`, `source env.sh && pytest`) any step may have failed, so the check
  becomes `unknown`.
- A check that ran but whose outcome can't be told becomes `unknown`, replacing any earlier
  `passed` or `failed` from the same turn: piped (`npm test | tail`), joined with `;` or `||`, run
  in the background, interrupted, timed out, a failed chain, or a not-a-run form as above.
  Commands that touch no check change nothing.
- Commands are recognized by name from a fixed list of common tools and package scripts; custom
  scripts (`./scripts/ci.sh`) stay `unknown`.
- Only Bash is watched (subagents' Bash calls in the turn included); checks run through other tools
  (MCP servers, IDE tasks) are not seen.
- Checks reset with each new prompt, a background task's notification included; they describe
  that turn only. A tool call that started in an earlier turn and finishes later is not counted,
  and neither are the tools of a subagent first seen in an earlier turn (a background agent still
  running). A background agent whose first tool call comes after the next prompt can't be told
  apart and is counted.

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
| Retry button | on | show **↻ retry** on the right of the band |
| Ship check | on | also ask the ship and verification questions; off shows only the task row. Left unset, 0.6's *Deploy check* applies |
| Ask Claude below (% Jev confidence) | 70 | below this, Claude gives a second opinion on that answer; used for both questions unless overridden below; 0 never asks (delivery turns included) |
| Task threshold (%) | empty | overrides the above for the task question |
| Ship threshold (%) | empty | overrides the above for the ship and verification questions. Left unset, 0.6's *Deploy threshold* applies |
| Production threshold (%) | empty | a stricter threshold for a `production` answer from Jev; applies only when higher than the ship threshold |
| Claude's view | summary-then-conversation | for the **task** question: `summary`: only the quick review of what Jev read. `summary-then-conversation`: the same, then the session-context review when the summary isn't enough. `conversation`: always the session-context review. The ship question always uses the session-context review |
| Claude review model | haiku | model for the summary review: an alias (`haiku`, `sonnet`, `opus`) or a full model id. The session-context review always uses the session's own model, which lets it reuse the prompt cache |
| Ask Claude when Jev can't answer | on | with no TypeSafe key or a Jev error, Claude answers instead of an error showing |

Claude's reviews use your own Claude Code account and count toward its usage. They run on answers
Jev is unsure of or can't give, and on ship for turns that push, merge or deploy; one review covers
every question that needs it.

Upgrading from 0.6: *Deploy check* and *Deploy threshold* are now *Ship check* and *Ship
threshold*. The old two stay in the settings menu, marked as replaced, so values you set in 0.6
keep applying until you set the new ones.

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

Jev sees only that latest turn, never earlier ones; that is why ship answers lean on the
session-context review.

Nothing else: no files, no other tool output, no earlier turns; subagents' own final answers are not
judged or sent. Note that the
excerpts are your words and Claude's, and tool errors can quote file paths, code or values from
your project. Anything in them reaches a third party, so don't use the plugin with a TypeSafe key
on work whose content may not leave your machine (or turn the key off and let Claude judge).
Claude's second opinions go to Anthropic through Claude Code, like the session itself.

## Requirements

Claude Code 2.1.288 or newer. It is built on Claude Code's early-access plugin hooks API,
which may change between releases.
