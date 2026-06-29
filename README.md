# @vcjdeboer/session-write

**Governed parameter-fill of analysis templates.** It does *not* write code: a
template fixes the analysis **pattern** (a frozen Quarto/R body) and declares
typed parameter **slots**; an AI fills **only** the `params:` values; the
`validate` method is the deterministic gate that asserts the structure was never
touched and every fill satisfies its slot's type + contract. Same template +
same params → same output. Bounded, validated, reproducible AI authoring — the
Score/Compose member of the `session-*` suite.

A template can also be **authored** from a typed intent (`author`), and a
fresh R project can be **wired** to record its work (`init`).

## Installation

```sh
swamp extension pull @vcjdeboer/session-write
```

## Methods

| Method | Purpose | Key arguments |
|---|---|---|
| **`validate`** | The deterministic gate. Asserts the filled `.qmd` left the structure frozen (body + non-`params` YAML byte-identical to the template) and every filled parameter satisfies its slot's type + contract. Writes a `validation` resource `{valid, frozen, slots[], frozenFiles[]}`. | `templatePath`, `filledPath`, `columns` (CSV, for column/formula contracts), `strict` (throw on invalid) |
| **`author`** | Assemble a governed template from a typed authoring-intent and **round-trip** it: the all-samples fill must validate and every contract slot's antisample must be rejected; the `.qmd` is written to `outPath` **only** on a passing round-trip. | `templateId`, `outPath`, `body`, `slots` (JSON), `returns` (JSON), `columns`, `strict` |
| **`init`** | R-project on-ramp: wire a project to record its work — writes `swamp.qmd` + the recorder wiring. `repoDir` resolves from `--input repoDir`, else `SWAMP_REPO_DIR`, else cwd. | `projectPath`, `repoDir`, `fileName`, `force` |

## Slots

A slot is declared in the template's `swamp.slots` block with a `type` and
optional `of`/`contract`/`source`:

| Slot `type` | Meaning | Validation |
|---|---|---|
| `dataset` | the data. `source: path` → a **file path** (`read.csv(params$x)`): the fill must be a cwd-independent, existing path. Otherwise an in-memory **object name** (`get(params$data)`). | path gate (`source: path` only) |
| `column` | a column of the bound dataset (`of: <dataset>`) | must be one of `columns` |
| `formula` | an R formula (`of: <dataset>`) | parses; its variables ⊆ `columns`; optional named `contract` |

A `contract` is a named, code-backed predicate with discriminating fixtures
(e.g. `quadratic_through_origin`), enforced at validate time.

## Usage

Validate a filled instance against its template:

```sh
swamp model method run writer validate \
  --input templatePath=templates/my-analysis.qmd \
  --input filledPath=runs/experiment-1.qmd \
  --input columns="speed,dist" \
  --input strict=true
```

A `dataset` slot marked `source: path` must be pinned with an **absolute** (or
`~/`, or `scheme://`) path that **exists** — so the instance resolves from any
working directory, not just the one it was filled in. A relative path is
rejected at the gate, before the analysis ever runs.

Author a governed template from a typed intent (round-tripped before it is
written):

```sh
swamp model method run writer author \
  --input templateId=my-analysis@1 \
  --input outPath=templates/my-analysis.qmd \
  --input body='```{r}
d <- read.csv(params$data); nrow(d)
```' \
  --input 'slots:json=[{"name":"data","type":"dataset","source":"path","desc":"a CSV","sample":"/abs/data.csv"}]'
```

## The `session-*` suite

- **session-write** *(this package)* — author + fill + gate governed analysis templates.
- **`@vcjdeboer/session-record`** — the append-only provenance ledger a run writes to.
- **`@vcjdeboer/session-witness`** — seals a recorded session into a tamper-evident digest.

## License

MIT © Vincent de Boer
