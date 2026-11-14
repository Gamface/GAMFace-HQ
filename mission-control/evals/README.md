# Eval suite

Fixed prompts sent through the harness (same queue, system prompts, voice
style and Ollama settings as Mission Control), scored with automatic checks.
Run it after changing a model, a system prompt or an Ollama setting.

```sh
cd ~/sandcastle/ts-harness
npm run eval                                        # 3 default models, all cases
npm run eval -- --models qwen3:14b                  # one model
npm run eval -- --only code-slugify,voice-math      # some cases
npm run eval -- --repeat 3                          # answers vary; repeat to compare models fairly
```

Needs the harness running (`docker compose up -d`, port 3010). Eval tasks show
up in Mission Control with source `eval`; Jarvis does not read them aloud.

## Cases (`cases.ts`)

| Group | What is checked |
|---|---|
| `code-*` | The answer's code block runs against assertions in a container with no network, read-only filesystem, 256 MB, 1 CPU, 10 s. |
| `plan-*` | Numbered steps; asks for details when the request is vague. |
| `security-*` | Names the right fixes for a misconfigured server. |
| `browser-*`, `file-*` | Admits it has no live web or file access instead of inventing an answer. |
| `voice-*` | Uses the voice style: answer first, short, no markdown. |
| `format-*` | Exact output: raw JSON, a single word. |

Add a case by appending to `CASES` with checks from `checks.ts`.

## Results

- `results/<timestamp>.json`: every answer, check result and timing.
- `results/history.csv`: one row per case per run, for comparing over time.

`ttft` is time to first token, measured from dispatch, so it includes queue wait.
