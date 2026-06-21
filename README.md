# @vcjdeboer/session-write

**Governed parameter-fill of analysis templates** — the *compose* member of the
swamp `session-*` suite. It does **not** write code: a template fixes the
analysis *pattern* (a frozen structure) and declares typed parameter **slots**;
an AI fills **only** the `params:` values; this model's `validate` method is the
deterministic gate that asserts the structure was untouched and every filled
parameter satisfies its slot's type and contract. A stray fill is rejected with
the specific reason, so the agent re-fills. Bounded, validated, reproducible —
the swamp idea applied to AI authoring.

## Installation

```sh
swamp extension pull @vcjdeboer/session-write
```

## Usage

```sh
swamp model create @vcjdeboer/session-write writer
swamp model method run writer validate \
    --input templatePath=lm-report.qmd \
    --input filledPath=cars-good.qmd \
    --input columns=speed,dist \
    --input strict=true
```

`validate` writes a `validation` resource — `{ valid, frozen, slots[], frozenFiles[] }`.
With `strict=true` it **fails (non-zero)** when the fill is invalid, so a swamp
workflow can gate downstream steps on a valid fill.

## How it works

A template is a `.qmd` (frontmatter + frozen body) or a plain config `.yaml`.
The `swamp.slots` block declares each fillable parameter's `type` (`dataset`,
`column`, `formula`) and optional `contract` (e.g. `quadratic_through_origin`).
`validate` checks that the body/structure is byte-identical to the template,
checks every slot value against its type + contract, and — for multi-file
templates like a `targets` pipeline — recomputes a `swamp.frozen` SHA-256
manifest so the analysis code itself cannot be altered undetected. Pure and
offline; no credentials or network.

## Part of the session-* suite

- [`@vcjdeboer/session-record`](https://github.com/vcjdeboer/session-record) — the provenance ledger
- `@vcjdeboer/session-execute` — run a filled template headless
- `@vcjdeboer/session-witness` — seal a recorded session

## License

MIT — see LICENSE.md for details.
