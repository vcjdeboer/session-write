/**
 * @vcjdeboer/session-write — governed parameter-fill of analysis templates.
 *
 * The Score/Compose member of the `session-*` suite. It does NOT write code: a
 * template fixes the analysis PATTERN (frozen structure) and declares typed
 * parameter SLOTS; an AI fills ONLY the `params:` values; this model's `validate`
 * method is the deterministic gate — it asserts the structure was untouched and
 * every filled parameter satisfies its slot's type + contract. A stray fill is
 * rejected with the specific reason, so the agent re-fills. Bounded, validated,
 * reproducible — the swamp idea applied to AI authoring.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "jsr:@std/yaml@1.1.1";

/** Resolve the control-plane repo dir to bake into start_swamp(repo=).
 *  Order: explicit arg (--input repoDir) → SWAMP_REPO_DIR env → cwd.
 *  NOTE: `--repo-dir` is consumed by the CLI to locate the model and is NOT visible
 *  in-method; set the baked repo via the `SWAMP_REPO_DIR=...` env prefix or `--input repoDir=`. */
export function resolveRepoDir(
  arg: string,
  envVal: string,
  cwd: string,
): string {
  return (arg.trim() || envVal.trim() || cwd).replace(/\/+$/, "");
}

const ValidateArgsSchema = z.object({
  /** Path to the ORIGINAL template .qmd (defines the frozen body + swamp.slots). */
  templatePath: z.string().min(1),
  /** Path to the AI-FILLED .qmd (only its `params:` values should differ). */
  filledPath: z.string().min(1),
  /** Comma-separated columns of the dataset, for formula/column contracts. */
  columns: z.string().default(""),
  /**
   * Fail-closed gate: when true, the method THROWS (non-zero step) if the fill
   * is invalid, so a swamp workflow's `dependsOn: succeeded` becomes a real
   * validity gate. Defaults false (soft) — the validation resource is still
   * written either way, so the failure reason stays inspectable.
   */
  strict: z.preprocess((v) => v === true || v === "true", z.boolean()).default(
    false,
  ),
});

const SlotResultSchema = z.object({
  name: z.string(),
  type: z.string(),
  value: z.string(),
  ok: z.boolean(),
  reason: z.string(),
});

const FrozenFileResultSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
  reason: z.string().default(""),
});

/** #35 — per dataset-slot data-identity check: the current fingerprint, whether
 *  a pin was recorded in the fill, and any drift from it. */
const DataPinResultSchema = z.object({
  slot: z.string(),
  sha256: z.string(),
  rows: z.number(),
  pinned: z.boolean(),
  ok: z.boolean(),
  drift: z.array(z.string()).default([]),
});

const ValidationSchema = z.object({
  valid: z.boolean(),
  /** True if the config is frozen AND every declared frozen file matches its hash. */
  frozen: z.boolean(),
  template: z.string(),
  slots: z.array(SlotResultSchema),
  /** SHA256 checks for files in `swamp.frozen` (the targets pipeline's _targets.R, R/*). */
  frozenFiles: z.array(FrozenFileResultSchema).default([]),
  /** #35 — dataset-identity fingerprints + drift vs. the recorded `swamp.datapins`. */
  dataPins: z.array(DataPinResultSchema).default([]),
  timestamp: z.string(),
});

/** Hex SHA-256 of a file's bytes. */
async function sha256HexFile(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * A dataset's IDENTITY fingerprint — a content hash plus a cheap structural
 * schema (first-line tokens + row count). This is IDENTITY, not validation: it
 * answers "is this the SAME data?" not "is this data good?" (the latter is the
 * decades-long field we deliberately do not enter). The sha256 catches any byte
 * change; `columns`/`rows` exist only to make drift HUMAN-READABLE (a column
 * moved vs. an opaque hash flip). The CSV read is naive (split on comma, strip a
 * wrapping quote) — a STABLE fingerprint, not a semantic schema; a field with an
 * embedded comma is a noted limit, harmless because the sha256 is authoritative.
 */
export interface DatasetPin {
  sha256: string;
  columns: string[];
  rows: number;
}

/** First-line tokens + data-row count of a CSV. A fingerprint, not a parser. */
export function csvSchema(text: string): { columns: string[]; rows: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = lines[0] ?? "";
  const columns = header === ""
    ? []
    : header.split(",").map((c) => c.trim().replace(/^"([\s\S]*)"$/, "$1"));
  return { columns, rows: Math.max(0, lines.length - 1) };
}

/** Identity fingerprint of a dataset's bytes: sha256 + the structural schema. */
export async function datasetFingerprint(
  bytes: Uint8Array,
): Promise<DatasetPin> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const sha256 = Array.from(new Uint8Array(d)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return { sha256, ...csvSchema(new TextDecoder().decode(bytes)) };
}

/** Human-readable drift between a RECORDED pin and the CURRENT file; empty array
 *  ⇒ the data is byte-identical to what was sealed. sha256 is authoritative; the
 *  column/row lines just explain a mismatch the seal would otherwise report opaquely. */
export function diffDatasetPin(
  recorded: DatasetPin,
  current: DatasetPin,
): string[] {
  const out: string[] = [];
  const removed = recorded.columns.filter((c) => !current.columns.includes(c));
  const added = current.columns.filter((c) => !recorded.columns.includes(c));
  if (removed.length) out.push(`columns removed: ${removed.join(", ")}`);
  if (added.length) out.push(`columns added: ${added.join(", ")}`);
  if (recorded.rows !== current.rows) {
    out.push(`row count ${recorded.rows} → ${current.rows}`);
  }
  if (recorded.sha256 !== current.sha256) {
    out.push(
      out.length
        ? `content changed`
        : `content changed (same shape; sha256 ${
          recorded.sha256.slice(0, 8)
        }… → ${current.sha256.slice(0, 8)}…)`,
    );
  }
  return out;
}

/** Directory of a path (for resolving frozen files relative to the fill file). */
function dirOf(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : ".";
}

/**
 * Disk-bound resolvability check for a filled `dataset` slot value. An INSTANCE
 * must pin its data with a path that resolves from ANY working directory —
 * otherwise the `.qmd` silently breaks the moment it is opened from a different
 * cwd than the one it was filled in (RStudio's project dir, `quarto render`'s
 * doc dir, a headless run): "working-directory hell". So the value must be
 * cwd-INDEPENDENT — an absolute POSIX path (`/…`) or a home-anchored `~/…` path
 * (home is fixed, so `~` resolves the same everywhere) — AND must exist on disk
 * (a typo is caught at the gate, not at R runtime).
 *
 * This is disk-bound, so — exactly like the frozen-FILES sha256 check — it lives
 * OUTSIDE the pure `validateFill` core that `author`'s in-memory round-trip
 * shares (that round-trip renders placeholder dataset values like `mtcars` which
 * do not exist on disk; an FS check there would wrongly fail every authoring).
 *
 * `stat`/`home` are injectable so the path-shape branch is unit-testable without
 * touching the filesystem or the environment; the defaults are the real ones.
 */
export async function checkDataset(
  value: string,
  deps: { stat?: (p: string) => Promise<unknown>; home?: string } = {},
): Promise<{ ok: boolean; reason: string }> {
  const stat = deps.stat ?? ((p: string) => Deno.stat(p));
  // A scheme URL (http(s)://, s3://, file://, …) is cwd-INDEPENDENT and is a
  // valid read.csv/readr/arrow source — but it is not a local path to stat.
  // Accept it as-is (the documented invariant is "cwd-independent", not
  // "/-absolute and on local disk").
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(value)) {
    return { ok: true, reason: "" };
  }
  // Reading HOME throws PermissionError (uncatchable as a file error) when the
  // method runs without --allow-env; guard it so a `~` fill fails GRACEFULLY
  // (clear reason) instead of crashing validate. An absolute `/` path never
  // reaches here, so the common case needs no env permission at all.
  const envHome = (): string => {
    try {
      return Deno.env.get("HOME") ?? "";
    } catch {
      return "";
    }
  };
  let p = value;
  if (p === "~" || p.startsWith("~/")) {
    const home = (deps.home ?? envHome()).replace(/\/+$/, "");
    if (!home) {
      return {
        ok: false,
        reason: `dataset path "${value}" uses "~" but HOME is not set`,
      };
    }
    p = home + p.slice(1);
  }
  if (!p.startsWith("/")) {
    return {
      ok: false,
      reason:
        `dataset path must be absolute so it resolves from any working directory ` +
        `(got relative "${value}") — an instance pins its data with a /full/path or ~/path`,
    };
  }
  try {
    const info = await stat(p) as { isDirectory?: boolean };
    // A dataset value is a single readable file (read.csv(params$x)); a path
    // that resolves to a DIRECTORY is a bad pin (e.g. a stale path that lost its
    // filename) that would only blow up at R runtime — catch it at the gate.
    if (info?.isDirectory) {
      return {
        ok: false,
        reason: `dataset path is a directory, not a file: ${value}`,
      };
    }
    return { ok: true, reason: "" };
  } catch {
    return { ok: false, reason: `dataset path does not exist: ${value}` };
  }
}

/**
 * Split a fill file into its YAML config and (frozen) body. A `.qmd` has `---`
 * frontmatter + a body; a plain config `.yaml` (e.g. the targets-lm params file,
 * whose frozen "body" is the separate _targets.R / R/functions.R) has no
 * frontmatter — it is ALL config, with an empty body.
 */
function splitQmd(text: string): { yaml: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { yaml: m[1], body: m[2] } : { yaml: text, body: "" };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FORMULA_FNS = new Set([
  "I",
  "log",
  "log2",
  "log10",
  "sqrt",
  "exp",
  "poly",
  "factor",
  "as.factor",
  "scale",
  "ns",
  "bs",
  "sin",
  "cos",
  "as.formula",
]);

/** Identifier tokens in a formula that aren't known function names. */
function formulaVars(formula: string): string[] {
  const toks = formula.match(/[A-Za-z.][A-Za-z0-9._]*/g) ?? [];
  return [...new Set(toks.filter((t) => !FORMULA_FNS.has(t)))];
}

/** Contract: a quadratic term in x AND through the origin. */
function quadraticThroughOrigin(formula: string, xcol: string) {
  const sq = xcol
    ? new RegExp(`I\\(\\s*${escapeRe(xcol)}\\s*\\^\\s*2\\s*\\)`).test(formula)
    : false;
  const sqAny = /I\(\s*[A-Za-z.][\w.]*\s*\^\s*2\s*\)/.test(formula) ||
    /poly\([^)]*,\s*2/.test(formula);
  const hasSquare = sq || sqAny;
  // `- 1` or `+ 0` removes the intercept (through the origin). The negative
  // lookahead `(?![.\d])` requires a STANDALONE 0/1 term, so a coefficient like
  // `+ 0.5` / `- 1.5` is not mistaken for intercept removal (review L3).
  const throughOrigin = /(^|[^\w])-\s*1(?![.\d])/.test(formula) ||
    /\+\s*0(?![.\d])/.test(formula);
  if (!hasSquare) {
    return {
      ok: false,
      reason:
        "contract quadratic_through_origin: missing a quadratic term — need I(x^2) or poly(x, 2)",
    };
  }
  if (!throughOrigin) {
    return {
      ok: false,
      reason:
        "contract quadratic_through_origin: not through the origin — need `- 1` or `+ 0`",
    };
  }
  return { ok: true, reason: "" };
}

interface Slot {
  type: string;
  of?: string;
  contract?: string;
  /** Optional UNIT annotation (e.g. "pg/mL", "RLU", "1" for dimensionless). Pure
   *  metadata/provenance — recorded in the swamp block, NOT used by any gate or
   *  coercion; a hook for future unit-aware checks. */
  unit?: string;
  /** Optional fallback for a slot (typically a `scalar` constant): an empty fill
   *  resolves to this default instead of failing "slot not filled". A non-default
   *  fill is therefore explicit, and the default itself is visible in the frozen
   *  template — swamp's native "explicit non-default" (Zod `.default()`). */
  default?: string;
  /** For a `dataset` slot: how the value is consumed. `"path"` = a file path
   *  (`read.csv(params$x)`) → it must be a cwd-independent, existing path
   *  (gated by `checkDataset` in the `validate` method). Anything else / unset =
   *  an in-memory R OBJECT name (`get(params$data)` → `"mtcars"`); NOT a path,
   *  so the path gate is skipped. Defaulting to object keeps the suite's
   *  `get()`-style templates (lm-report, cars, targets-lm) valid. */
  source?: string;
}

/**
 * Parse a slot's `contract` reference into a registry NAME + an optional ARG.
 * `"quadratic_through_origin(dose)"` → { name, arg: "dose" }; a bare
 * `"quadratic_through_origin"` → { name, arg: undefined }. The arg lets a contract
 * read a named param/column instead of a hardcoded one (fixes the magic-`x` trap).
 */
export function parseContractRef(ref: string): { name: string; arg?: string } {
  const m = ref.match(/^\s*([^()]+?)\s*(?:\(\s*([^()]*?)\s*\))?\s*$/);
  if (!m) return { name: ref.trim() };
  return { name: m[1].trim(), arg: m[2]?.trim() || undefined };
}

/**
 * A contract is a NAMED, code-backed predicate a slot's filled value must
 * satisfy. The registry is the single source of truth shared by `validate`
 * (production fills) and `author` (the authoring round-trip), so the two can
 * never drift. A slot that names a contract NOT in this registry FAILS LOUDLY —
 * closing the historical silent-pass hole where any unknown `contract:` string
 * was ignored. Every contract ships a discriminating pass/fail fixture (asserted
 * by the registry meta-gate test) so a contract that accepts everything cannot
 * ship.
 */
export interface ContractCtx {
  /** Columns of the bound dataset, for column/formula contracts. */
  columns: string[];
  /** All filled params, so a contract can read sibling slots (e.g. the x column). */
  params: Record<string, string>;
}

export interface Contract {
  /** Slot types this contract may be attached to. */
  appliesTo: string[];
  /**
   * The predicate. `arg` is the optional reference from a PARAMETERIZED contract
   * ref like `quadratic_through_origin(dose)` — it names the param/column the
   * contract should read, so a contract is never coupled to a magic param name.
   * Returns ok=false + a specific reason on violation.
   */
  check: (
    value: string,
    ctx: ContractCtx,
    arg?: string,
  ) => { ok: boolean; reason: string };
  /** A value that MUST pass and a value that MUST fail — proves the contract discriminates. */
  fixtures: {
    pass: {
      value: string;
      params?: Record<string, string>;
      columns?: string[];
    };
    fail: {
      value: string;
      params?: Record<string, string>;
      columns?: string[];
    };
  };
}

/**
 * The contract registry. Add a domain contract here (with discriminating
 * fixtures) to make it enforceable. Referenced from a template's `slot.contract`
 * by NAME; an unknown name fails the slot rather than passing silently.
 */
export const CONTRACTS: Record<string, Contract> = {
  quadratic_through_origin: {
    appliesTo: ["formula"],
    // `arg` names the param holding the predictor column; defaults to "x" when a
    // template uses the bare `quadratic_through_origin` (back-compat). A template
    // with a differently-named predictor writes `quadratic_through_origin(dose)`.
    check: (value, ctx, arg) =>
      quadraticThroughOrigin(value, String(ctx.params[arg ?? "x"] ?? "")),
    fixtures: {
      pass: { value: "y ~ I(x^2) - 1", params: { x: "x" } },
      fail: { value: "y ~ x", params: { x: "x" } },
    },
  },
};

/**
 * Load-time invariant: every registered contract MUST discriminate — accept its
 * `pass` fixture and reject its `fail` fixture. A toothless contract (one that
 * accepts everything) fails the EXTENSION TO LOAD rather than silently passing
 * bad fills in production. Fail-closed by design; pure + deterministic. Reused by
 * the test suite so the same invariant is asserted in CI and at runtime.
 */
export function assertContractsDiscriminate(
  registry: Record<string, Contract> = CONTRACTS,
): void {
  for (const [name, c] of Object.entries(registry)) {
    const pass = c.check(c.fixtures.pass.value, {
      columns: c.fixtures.pass.columns ?? [],
      params: c.fixtures.pass.params ?? {},
    });
    const fail = c.check(c.fixtures.fail.value, {
      columns: c.fixtures.fail.columns ?? [],
      params: c.fixtures.fail.params ?? {},
    });
    if (!pass.ok || fail.ok) {
      throw new Error(
        `session-write contract "${name}" does not discriminate ` +
          `(pass.ok=${pass.ok}, fail.ok=${fail.ok}) — fix its fixtures or check()`,
      );
    }
  }
}

// Enforce the invariant at module load. A non-discriminating contract is a
// defect that must block, not ship.
assertContractsDiscriminate();

/** Result of checking one slot's filled value. */
export interface SlotResult {
  name: string;
  type: string;
  value: string;
  ok: boolean;
  reason: string;
  /** The slot's declared `source` (e.g. `"path"` for a file-path dataset),
   *  passed through so the disk-bound `validate` method knows whether to run the
   *  `checkDataset` path gate. Undefined for non-dataset slots / object datasets. */
  source?: string;
}

/** What the pure validation core returns (no disk I/O). */
export interface FillResult {
  /** True if the body + all non-`params` YAML are byte-identical to the template. */
  frozenBody: boolean;
  /** The `swamp.template` id declared by the template. */
  template: string;
  /** Per-slot verdicts. */
  slots: SlotResult[];
  /** The declared `swamp.frozen` file→sha256 map (the caller does the disk check). */
  frozenManifest: Record<string, string>;
  /** Non-null when the template and fill carry different `swamp.writer` builds — an
   *  informational signal (author content is checked independently of the serializer
   *  now), surfaced so a reader knows the layout was generated by another build. */
  writerSkew: { template: string; fill: string } | null;
  /** Integrity of the writer-generated param-setup cell, which is EXCLUDED from
   *  `frozenBody` (it is codegen, not authored) and re-derived from the slots here:
   *  `"ok"` = matches the current build's codegen; `"drift"` = differs but the fill
   *  was written by ANOTHER build (a benign codegen refresh — author content still
   *  verified); `"tampered"` = differs under THIS build (hand-edited / injected →
   *  fail closed). */
  setupIntegrity: "ok" | "drift" | "tampered";
}

/**
 * The pure, string-only CORE of validation — no disk I/O, deterministic. Shared
 * by `validate` (production fills) and the `author` round-trip so authoring-time
 * and production-time checks are byte-identical and can never drift. The
 * frozen-FILES (sha256) check stays in `validate` because it is inherently
 * disk-bound; this returns the declared manifest so the caller can run it.
 */
/** A declared constant in `swamp.constants` — the provenance-envelope shape
 *  (`{ value, why, source? }`) borrowed from @stateless/sourced-kb / @mellens/rave.
 *  `value` must equal a decision literal present in the frozen body; `why` is the
 *  mandatory rationale that makes the magic number explicit. */
export interface Constant {
  value: string;
  why: string;
  source?: string;
}

/** Canonical key for a literal so equivalent spellings reconcile — for matching
 *  (declared vs body) and the trivial `0`/`1` exclusion. Numbers: `2`/`2.0`/`2.`/
 *  `2e0`/`2L` → `"2"`, `.5` → `"0.5"`, `-0.5` → `"-0.5"`. Booleans (language-neutral):
 *  any of `TRUE`/`true`/`True`/`T` → `"TRUE"`, `FALSE`/`false`/`False`/`F` →
 *  `"FALSE"`. Falls back to the trimmed lexeme otherwise. */
export function canonConst(s: string): string {
  const t = String(s).trim();
  const lower = t.toLowerCase();
  if (lower === "true" || t === "T") return "TRUE";
  if (lower === "false" || t === "F") return "FALSE";
  const n = Number(t.replace(/[Li]$/i, ""));
  return Number.isFinite(n) ? String(n) : t;
}

/** Valid boolean FILL values (incl. R's `T`/`F` shorthand). */
const BOOL_VALUES = new Set(
  ["TRUE", "FALSE", "T", "F", "True", "False", "true", "false"],
);
/** A decimal literal in the R/Python grammar — `2`, `2.5`, `.5`, `1e-3`, `2L`,
 *  optional sign. Deliberately NOT JS's grammar: `0x..`/`0b..`/`0o..` are rejected
 *  (R/Python coerce those to a silent NA from a fill string), so a fill that PASSES
 *  the gate also coerces cleanly at runtime. */
const NUM_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[Li]?$/;
/** Integer-valued literal (whole number; accepts 2/2.0/2L, rejects 2.5/0b101). */
function isIntLiteral(v: string): boolean {
  const t = String(v).trim();
  return NUM_LITERAL.test(t) && Number.isInteger(Number(t.replace(/L$/i, "")));
}
/** A real (double/numeric) literal in the R/Python decimal grammar. */
function isRealLiteral(v: string): boolean {
  return NUM_LITERAL.test(String(v).trim());
}
/** Boolean literal WORDS detected as magic constants — full words only (`T`/`F`
 *  alone are too ambiguous with variables to flag, though they validate as fills). */
const BOOL_LITERAL = /^(?:TRUE|FALSE|True|False)/;

/**
 * Enumerate the DECISION literals in a frozen body — magic NUMBERS and BOOLEANS
 * that encode an authorship choice and must be made explicit (slotted or
 * declared). Each result carries an inferred language-neutral `type`
 * (`int`/`double`/`bool`). Pure + heuristic (no language parser): strips `#`
 * comments + string literals, then collects standalone numeric/boolean tokens,
 * EXCLUDING the structural set: `0`/`1`, `^N` exponents, `[...]` subscript
 * indices, identifier-glued digits.
 *
 * STRINGS are deliberately NOT detected as labels — a magic `"pearson"` is
 * indistinguishable from a column name without semantics. The exception is a
 * number that is COERCED back to a number (`as.numeric("0.05")`), or string-FOLDED
 * from all-literal fragments (`as.numeric(paste0("0.","05"))`): the coercion is the
 * static tell that it is a smuggled constant, not a label. Both are surfaced.
 *
 * STATIC LIMIT (by Rice's theorem, not a bug): this gate is sound against honest
 * authoring and casual obfuscation; it is NOT an adversarial defense. A determined
 * writer can always launder a constant past any static check — assign-then-coerce
 * (`k <- "0.05"; as.numeric(k)`), nested builders, ASCII/raw construction, runtime
 * reads. Recovering those values requires EVALUATION, which this gate does not do.
 * The adversarial case is covered by defense-in-depth (the witness seal makes the
 * author accountable; obfuscated code is conspicuous to human approval), not here.
 *
 * `language` is the seam for per-language literal grammar; only `"r"` is fully
 * implemented. `"python"` additionally collapses `_` digit separators (`1_000`);
 * its booleans (`True`/`False`) are already in the shared vocabulary. A real
 * Python parser is deferred until a Python template path exists.
 * Honest limit: a `poly(x, N)` degree is not auto-handled.
 */
/** Fold a flat list of concatenation fragments into the string they build by PURE
 *  string concatenation — NO evaluation. Returns the folded value iff every
 *  fragment is a string/number LITERAL AND the result is itself a numeric literal;
 *  null otherwise (a bare variable ⇒ the value is runtime, not a constant; a
 *  non-numeric join ⇒ it builds a label). This is the sound core of the
 *  shape-rejection rule: only an all-literal builder can be folded, so it can
 *  never misfire on runtime code. */
function foldLiteralConcat(parts: string[], sep: string): string | null {
  const vals: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (p === "") continue;
    const sm = /^(["'])([\s\S]*)\1$/.exec(p);
    if (sm) {
      vals.push(sm[2]);
      continue;
    }
    if (NUM_LITERAL.test(p)) {
      vals.push(p);
      continue;
    }
    return null; // a variable / call / non-literal ⇒ runtime, not a constant
  }
  if (!vals.length) return null;
  const joined = vals.join(sep).trim();
  return NUM_LITERAL.test(joined) ? joined : null;
}

export function enumerateConstants(
  body: string,
  language: "r" | "python" = "r",
): { value: string; context: string; type: "int" | "double" | "bool" }[] {
  let s = body;
  // Python triple-quoted strings (docstrings) are stripped FIRST — they may
  // legally contain `#`, `'` and `"` that would otherwise mis-pair the
  // comment/single-string strippers and leak a digit out of the docstring.
  if (language === "python") {
    s = s.replace(/"""[\s\S]*?"""/g, '""').replace(/'''[\s\S]*?'''/g, "''");
  }
  s = s.replace(/#[^\n]*/g, "");
  // A number written as a STRING is a label UNTIL it is coerced back to a number
  // (`as.numeric("0.05")`, `float("0.05")`, `eval/parse(text="0.05")`) — the
  // coercion call is the static tell that separates a SMUGGLED constant from a
  // categorical label, so this runs only inside a coercion/eval wrapper and
  // leaves `c("1","2","3")` factor levels alone. Heuristic allowlist of coercers;
  // an obscure alias (or split-and-`paste` fragments) is an honest limit, like a
  // `poly()` degree. Expose the inner literal so the scanner below flags it.
  const numSrc = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?[Li]?";
  const coercers = language === "python"
    ? ["float", "int", "complex", "Decimal", "eval", "literal_eval"]
    : ["as\\.numeric", "as\\.integer", "as\\.double", "as\\.single", "strtoi"];
  // `\1\s*\)` requires the numeric string to be the SOLE argument, so a
  // concatenation like `float("0." + "05")` is left for the folding pass below.
  s = s.replace(
    new RegExp(
      `\\b(?:${
        coercers.join("|")
      })\\s*\\(\\s*(["'])\\s*(${numSrc})\\s*\\1\\s*\\)`,
      "g",
    ),
    (_m, _q, num) => ` ${num} `,
  );
  if (language !== "python") {
    // R idiom: eval/parse(text="0.05") — the literal hides in the keyword arg.
    s = s.replace(
      new RegExp(
        `\\bparse\\s*\\(\\s*text\\s*=\\s*(["'])\\s*(${numSrc})\\s*\\1`,
        "g",
      ),
      (_m, _q, num) => ` ${num} `,
    );
  }
  // Shape-rejection: an all-LITERAL string-builder fed to a coercer
  // (`as.numeric(paste0("0.","05"))`, `float("0."+"05")`) launders a constant the
  // single-literal rule above can't see. We do NOT evaluate — `foldLiteralConcat`
  // string-folds the literal fragments and exposes the recovered number for the
  // scanner. SOUND by construction: a variable in the args ⇒ fold returns null ⇒
  // left untouched (so `paste0(scale,"00")` / `gsub(",","",x)` stay runtime). The
  // `[^()]` confine keeps it to a FLAT builder, so a nested runtime call
  // (`paste0(Sys.getenv("X"),"5")`) simply doesn't match. Nested builders and
  // assign-then-coerce laundering still escape — the documented static limit.
  if (language === "python") {
    s = s.replace(
      new RegExp(
        `\\b(?:${coercers.join("|")})\\s*\\(\\s*([^()]*\\+[^()]*)\\)`,
        "g",
      ),
      (m, arg) => {
        const folded = foldLiteralConcat(String(arg).split("+"), "");
        return folded !== null ? ` ${folded} ` : m;
      },
    );
  } else {
    s = s.replace(
      new RegExp(
        `\\b(?:${
          coercers.join("|")
        })\\s*\\(\\s*(paste0|str_c|paste)\\s*\\(([^()]*)\\)\\s*\\)`,
        "g",
      ),
      (m, builder, argsRaw) => {
        let sep = builder === "paste" ? " " : "";
        const positional: string[] = [];
        for (const part of String(argsRaw).split(",")) {
          const kw = /^\s*sep\s*=\s*(["'])([\s\S]*)\1\s*$/.exec(part);
          if (kw) {
            sep = kw[2];
            continue;
          }
          if (/^\s*(?:collapse|sep)\s*=/.test(part)) continue;
          positional.push(part);
        }
        const folded = foldLiteralConcat(positional, sep);
        return folded !== null ? ` ${folded} ` : m;
      },
    );
  }
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
  if (language === "python") s = s.replace(/(\d)_(?=\d)/g, "$1"); // 1_000 → 1000
  const out: {
    value: string;
    context: string;
    type: "int" | "double" | "bool";
  }[] = [];
  let depth = 0; // `[...]` subscript nesting
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "]") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    // boolean literal (standalone full word) — a real magic constant
    if (c === "T" || c === "F") {
      const bm = BOOL_LITERAL.exec(s.slice(i));
      if (bm) {
        const word = bm[0];
        // `$` excludes member access (`x$TRUE`); `.`/word-char exclude identifiers.
        const gluedBefore = /[\w.$]/.test(s[i - 1] ?? "");
        const after = s[i + word.length] ?? "";
        if (!gluedBefore && !/[\w.]/.test(after) && depth === 0) {
          const ctx = s.slice(Math.max(0, i - 24), i + word.length).trim();
          out.push({ value: word, context: ctx, type: "bool" });
          i += word.length;
          continue;
        }
      }
    }
    // Python radix literals (0x.. / 0o.. / 0b..) ARE magic constants — handled
    // before the decimal path so the leading `0` isn't matched then dropped as
    // the structural `0`. (R has no 0o/0b and its hex stays a pre-existing limit.)
    if (language === "python" && c === "0" && /[xXoObB]/.test(s[i + 1] ?? "")) {
      const rm = /^0[xX][0-9a-fA-F]+|^0[oO][0-7]+|^0[bB][01]+/.exec(s.slice(i));
      if (rm) {
        const prevTrim = s.slice(0, i).replace(/[ \t]+$/, "").slice(-1);
        if (!/[\w.]/.test(prevTrim) && depth === 0) {
          const ctx = s.slice(Math.max(0, i - 24), i + rm[0].length).trim();
          out.push({ value: rm[0], context: ctx, type: "int" });
        }
        i += rm[0].length;
        continue;
      }
    }
    // a numeric literal starts at a digit, or a `.` immediately before a digit
    const startsNum = (c >= "0" && c <= "9") ||
      (c === "." && s[i + 1] >= "0" && s[i + 1] <= "9");
    if (startsNum) {
      // digits/.digits, optional sci exponent (1e-5), optional integer/complex
      // suffix (2L / 3i) — all ONE literal.
      const tok =
        /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?[Li]?/.exec(s.slice(i))![0];
      const prevTrim = s.slice(0, i).replace(/[ \t]+$/, "").slice(-1);
      const gluedToIdent = /[\w.]/.test(prevTrim); // col2, paste0, x.5, 2.foo
      // a unary sign: a `-` IMMEDIATELY before the number (no space), that is NOT
      // the `<-` assignment arrow and NOT after a value (`)`/`]`/identifier — which
      // would be subtraction). So `< -0.5` keeps its sign, while `x <- 1`, `a - 2`,
      // and `a -2` stay positive.
      let lexeme = tok;
      if (s[i - 1] === "-" && s[i - 2] !== "<") {
        const beforeMinus = s.slice(0, i - 1).replace(/\s+$/, "").slice(-1);
        if (!/[\w.)\]]/.test(beforeMinus)) lexeme = "-" + tok;
      }
      const can = canonConst(lexeme);
      // Python power operator `**` is the structural analogue of R's `^`: the
      // EXPONENT is a degree, not a magic threshold (the base still flags).
      const afterPow = language === "python" &&
        s.slice(0, i).replace(/[ \t]+$/, "").endsWith("**");
      if (
        !gluedToIdent && prevTrim !== "^" && !afterPow && depth === 0 &&
        can !== "0" && can !== "1"
      ) {
        const ctx = s.slice(Math.max(0, i - 24), i + tok.length).trim();
        // type hint: a decimal point or exponent → real/double, else integer.
        const type = /[.eE]/.test(tok) ? "double" : "int";
        out.push({ value: lexeme, context: ctx, type });
      }
      i += tok.length;
      continue;
    }
    i++;
  }
  return out;
}

export function validateFill(
  templateText: string,
  fillText: string,
  columns: string[],
  registry: Record<string, Contract> = CONTRACTS,
  currentWriter = "",
): FillResult {
  // Parse both documents (qmd OR ipynb) to the format-agnostic shape. (a) the
  // structure is frozen when `frozenRepr` — the AUTHOR content (swamp contract +
  // author cells, EXCLUDING params, the serializer version, and the generated setup
  // cell) — matches. Excluding the serializer-dependent pieces is what makes the
  // frozen check independent of which build serialized either document.
  const tmpl = parseDoc(templateText);
  const fill = parseDoc(fillText);
  const frozenBody = tmpl.frozenRepr === fill.frozenRepr;

  // `swamp.writer` is informational now (the frozen check no longer depends on it).
  const tw = (tmpl.swamp.writer ?? "").trim();
  const fw = (fill.swamp.writer ?? "").trim();
  const writerSkew = tw !== fw ? { template: tw, fill: fw } : null;

  // Setup-cell integrity. The generated param-setup is excluded from `frozenBody`, so
  // verify it RE-DERIVES from the fill's own slots under the CURRENT build. A mismatch
  // when the fill was written by THIS build is tampering (hand-edited / injected code)
  // → fail closed; a mismatch when it was written by ANOTHER build is a benign codegen
  // refresh (the author content is already verified) → "drift", not a failure.
  const expectSetup = expectedSetupSource(
    fill.swamp as Record<string, unknown>,
    fill.language,
  );
  // Only a PRESENT setup is checked. A legacy / body-path / hand-written document has
  // no setup cell (its code uses `params$x` directly) — there is nothing to re-derive,
  // and a missing setup can't inject code, so it is not flagged. An injected or edited
  // setup IS present, so it is caught.
  let setupIntegrity: "ok" | "drift" | "tampered" = "ok";
  if (fill.setupSource && fill.setupSource !== expectSetup) {
    setupIntegrity = currentWriter && fw && fw !== currentWriter
      ? "drift"
      : "tampered";
  }

  const swamp = tmpl.swamp;
  const slots = swamp.slots ?? {};
  const params = fill.params;

  const results: SlotResult[] = [];
  for (const [name, slot] of Object.entries(slots)) {
    const slotType = String(slot.type ?? "").trim();
    // an empty fill resolves to the slot's `default` (if any) — so an OPTIONAL slot
    // with a default passes, and a non-default fill is the explicit value.
    const value = String(params[name] ?? "").trim() ||
      String(slot.default ?? "").trim();
    let ok = true;
    let reason = "";

    if (!value) {
      ok = false;
      reason = "slot not filled";
    } else if (slotType === "dataset") {
      // (deterministic deep check — that columns exist — is a session-execute concern)
      ok = true;
    } else if (slotType === "scalar" || slotType === "string") {
      // an untyped literal / free string — any non-empty value or default.
      ok = true;
    } else if (slotType === "int") {
      // a whole-number constant (a row count / seed / n, consumed via as.integer);
      // rejects 2.5 so a non-integer fill is caught at the gate, not at runtime.
      ok = isIntLiteral(value);
      if (!ok) reason = `"${value}" is not an integer`;
    } else if (slotType === "double" || slotType === "number") {
      // a real constant (threshold / coefficient). R/Python don't split float32/64
      // at the literal level, so one double type covers "float" and "double".
      ok = isRealLiteral(value);
      if (!ok) reason = `"${value}" is not a number (double)`;
    } else if (slotType === "bool") {
      ok = BOOL_VALUES.has(value);
      if (!ok) reason = `"${value}" is not a boolean (TRUE/FALSE)`;
    } else if (slotType === "column") {
      ok = columns.length === 0 || columns.includes(value);
      if (!ok) reason = `column "${value}" is not in [${columns.join(", ")}]`;
    } else if (slotType === "formula") {
      if (!value.includes("~")) {
        ok = false;
        reason = "not a formula (no `~`)";
      } else {
        const vars = formulaVars(value);
        const unknown = columns.length
          ? vars.filter((v) => !columns.includes(v))
          : [];
        if (unknown.length) {
          ok = false;
          reason = `formula variables not in data: [${unknown.join(", ")}]`;
        }
      }
    } else {
      // FAIL-CLOSED on an unrecognized slot type — a typo'd or phantom `type`
      // (e.g. `enum` before it is implemented) must never silently accept any value.
      ok = false;
      reason = `unknown slot type "${slotType}"`;
    }

    // (b) NAMED CONTRACT enforcement. The contract REFERENCE (does it exist? does
    // it apply to this slot type?) is validated UNCONDITIONALLY — a template that
    // names a nonexistent or misplaced contract is a template defect independent
    // of any particular fill, and `author` relies on this being fill-independent,
    // so a typo'd contract can never hide behind an also-invalid value. The value
    // PREDICATE runs only on an otherwise-valid value, so a structural reason
    // still wins for a genuinely bad value.
    if (slot.contract) {
      const { name: cname, arg } = parseContractRef(slot.contract);
      const contract = registry[cname];
      if (!contract) {
        ok = false;
        reason = `unknown contract "${cname}" — not in the contract registry`;
      } else if (!contract.appliesTo.includes(slotType)) {
        ok = false;
        reason = `contract "${cname}" does not apply to a ${slotType} slot`;
      } else if (ok) {
        const r = contract.check(value, { columns, params }, arg);
        ok = r.ok;
        reason = r.reason;
      }
    }

    const source = String(slot.source ?? "").trim() || undefined;
    results.push({ name, type: slotType, value, ok, reason, source });
  }

  return {
    frozenBody,
    template: swamp.template ?? "",
    slots: results,
    frozenManifest: (swamp.frozen ?? {}) as Record<string, string>,
    writerSkew,
    setupIntegrity,
  };
}

// ============================================================================
// document model — session-write OWNS the document LAYOUT (the "template for the
// template"). A template's FROZEN content is (swamp block + code cells); `params`
// are the fill surface; the FORMAT (qmd | ipynb) is only a serialization. The
// author supplies STRUCTURED cells and the writer assembles a correct document,
// so a fence-less or mis-laid-out body can never be emitted — exactly the bug a
// freeform `body` string allowed.
// ============================================================================

export type DocLanguage = "r" | "python";
export type DocFormat = "qmd" | "ipynb";

/** One cell of an analysis document. `code` cells carry a language (default = the
 *  document language) and optional Quarto chunk `label`/`options`; `markdown`
 *  cells are prose. */
export interface Cell {
  type: "code" | "markdown";
  language?: DocLanguage;
  source: string;
  label?: string;
  options?: Record<string, string>;
}

/** Per-language serialization knobs: the Quarto fence tag, the Jupyter kernelspec
 *  + language_info, and how a string param is assigned in a parameters cell. */
const LANGS: Record<DocLanguage, {
  fence: string;
  kernel: Record<string, string>;
  langInfo: Record<string, unknown>;
  assign: (name: string, value: string) => string;
}> = {
  r: {
    fence: "r",
    kernel: { name: "ir", display_name: "R", language: "R" },
    langInfo: { name: "R", file_extension: ".r" },
    assign: (n, v) => `${n} <- ${JSON.stringify(v)}`,
  },
  python: {
    fence: "python",
    kernel: { name: "python3", display_name: "Python 3", language: "python" },
    langInfo: { name: "python", file_extension: ".py" },
    assign: (n, v) => `${n} = ${JSON.stringify(v)}`,
  },
};

/** nbformat `source` is an array of lines, each terminated by `\n` except the
 *  last — produce that shape from a plain string. */
function toSourceLines(s: string): string[] {
  const lines = s.replace(/\n+$/, "").split("\n");
  return lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l));
}

/** Inverse of `toSourceLines`: nbformat `source` may be a string or string[]. */
function joinSource(src: unknown): string {
  return Array.isArray(src) ? src.join("") : String(src ?? "");
}

function serializeCellQmd(c: Cell, docLang: DocLanguage): string {
  if (c.type === "markdown") return c.source.replace(/\n+$/, "");
  const lang = c.language ?? docLang;
  const opts: string[] = [];
  if (c.label) opts.push(`#| label: ${c.label}`);
  for (const [k, v] of Object.entries(c.options ?? {})) {
    opts.push(`#| ${k}: ${v}`);
  }
  const head = opts.length ? opts.join("\n") + "\n" : "";
  return "```{" + lang + "}\n" + head + c.source.replace(/\n+$/, "") + "\n```";
}

function cellTags(c: Cell): string[] {
  return c.label ? [c.label] : [];
}

/** The binding the writer emits for one slot, per language. knitr/papermill deliver
 *  every param as a STRING (and knitr LOCKS `params`, so it can't be coerced in
 *  place) — so the writer binds a fresh variable at the slot's declared type and
 *  the cell code uses that BARE name. R binds EVERY slot (typed → coerced, else a
 *  plain alias) for a uniform bare idiom; Python's params cell already injects bare
 *  names, so it only needs to coerce the typed ones in place (its vars aren't
 *  locked). Returns null when nothing need be emitted (a Python string-ish slot). */
function bindExpr(
  name: string,
  type: string,
  language: DocLanguage,
): string | null {
  const t = type.trim();
  if (language === "r") {
    if (t === "int") return `${name} <- as.integer(params$${name})`;
    if (t === "double" || t === "number") {
      return `${name} <- as.numeric(params$${name})`;
    }
    if (t === "bool") return `${name} <- as.logical(params$${name})`;
    return `${name} <- params$${name}`;
  }
  if (t === "int") return `${name} = int(${name})`;
  if (t === "double" || t === "number") return `${name} = float(${name})`;
  if (t === "bool") return `${name} = str(${name}).strip().lower() == "true"`;
  return null;
}

/** A writer-generated setup cell that binds every slot to a BARE, correctly-typed
 *  variable so the analysis code references params by bare name without
 *  hand-coercion. FROZEN content derived from swamp.slots (identical across the
 *  template + every fill), carries no magic literals, and in qmd is hidden from the
 *  rendered output (`include: false`). Null when no binding is needed. */
function paramSetupCell(
  swamp: Record<string, unknown>,
  language: DocLanguage,
): Cell | null {
  const slots = (swamp.slots ?? {}) as Record<string, { type?: string }>;
  const lines: string[] = [];
  for (const [name, s] of Object.entries(slots)) {
    const expr = bindExpr(name, String(s.type ?? ""), language);
    if (expr) lines.push(expr);
  }
  if (!lines.length) return null;
  return {
    type: "code",
    language,
    label: SETUP_LABEL,
    source:
      "# writer-generated: bind params to bare, typed variables (params arrive as strings)\n" +
      lines.join("\n"),
    options: language === "r" ? { include: "false" } : undefined,
  };
}

/** Stable marker (chunk label / cell tag) on the writer-generated param-setup cell,
 *  so `parseDoc` can EXCLUDE it from the frozen comparison (it is codegen, not
 *  authored) and re-derive it for integrity instead. */
const SETUP_LABEL = "swamp-param-setup";

/** The source of the param-setup the CURRENT build would generate for these slots —
 *  used by `validate` to re-derive and verify the setup instead of freezing its
 *  bytes (which would couple the frozen check to the serializer version). */
function expectedSetupSource(
  swamp: Record<string, unknown>,
  language: DocLanguage,
): string {
  return (paramSetupCell(swamp, language)?.source ?? "").trim();
}

/**
 * Assemble a governed analysis document from structured cells. The frozen content
 * (swamp block + cells) is identical across formats; only the SERIALIZATION
 * differs. `qmd` → YAML frontmatter (title/format/params/swamp) + ```{lang}```
 * fenced chunks. `ipynb` → nbformat-4 JSON: a papermill `parameters`-tagged cell
 * (the fill surface) + the author cells, with the swamp block + kernelspec in
 * notebook metadata.
 */
export function serializeDoc(input: {
  format: DocFormat;
  language: DocLanguage;
  title: string;
  params: Record<string, string>;
  swamp: Record<string, unknown>;
  cells: Cell[];
}): string {
  const { format, language, title, params, swamp, cells } = input;
  // Prepend the writer-generated param-binding cell so the author's code can use
  // bare, correctly-typed variable names (knitr locks `params` + delivers strings).
  const setup = paramSetupCell(swamp, language);
  const allCells = setup ? [setup, ...cells] : cells;
  if (format === "qmd") {
    const front = stringifyYaml({
      title: title || "untitled",
      format: "html",
      params,
      swamp,
    });
    const blocks = allCells.map((c) => serializeCellQmd(c, language));
    return `---\n${front}---\n\n${blocks.join("\n\n")}\n`;
  }
  const ks = LANGS[language];
  const paramLines = Object.entries(params).map(([n, v]) => ks.assign(n, v));
  const paramCell = {
    cell_type: "code",
    metadata: { tags: ["parameters"] },
    execution_count: null,
    outputs: [] as unknown[],
    source: toSourceLines(paramLines.join("\n")),
  };
  const bodyCells = allCells.map((c) => ({
    cell_type: c.type,
    metadata: cellTags(c).length ? { tags: cellTags(c) } : {},
    ...(c.type === "code"
      ? { execution_count: null, outputs: [] as unknown[] }
      : {}),
    source: toSourceLines(c.source),
  }));
  const nb = {
    cells: [paramCell, ...bodyCells],
    metadata: {
      kernelspec: ks.kernel,
      language_info: ks.langInfo,
      title: title || "untitled",
      swamp,
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(nb, null, 1) + "\n";
}

/** Strict params-cell parse: one `name <- "value"` / `name = "value"` per line. */
function parseParamCell(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_.][\w.]*)\s*(?:<-|=)\s*(.+?)\s*$/);
    if (!m) continue;
    out[m[1]] = unquoteScalar(m[2].trim());
  }
  return out;
}

/** Undo the quoting `serializeDoc` applied to a param value. A double-quoted RHS
 *  is JSON — so `JSON.stringify`'s escapes (`\"`, `\\`, `\n`) decode correctly; a
 *  single-quoted RHS is literal with the two R/Python escapes undone; anything
 *  else (a bare number/bool token) is verbatim. */
function unquoteScalar(rhs: string): string {
  if (rhs.length >= 2 && rhs.startsWith('"') && rhs.endsWith('"')) {
    try {
      return JSON.parse(rhs) as string;
    } catch {
      return rhs.slice(1, -1);
    }
  }
  if (rhs.length >= 2 && rhs.startsWith("'") && rhs.endsWith("'")) {
    return rhs.slice(1, -1).replace(/\\(['\\])/g, "$1");
  }
  return rhs;
}

/** Concatenated source of every code chunk in a qmd body (fences stripped). */
/** Parse a qmd body into cells: each ```{lang} chunk → a code cell (option lines
 *  stripped, `label` + `language` captured); text between chunks → markdown. Cell
 *  sources are BOUNDARY-trimmed (inter-cell whitespace is not content) but internal
 *  whitespace — code indentation — is byte-exact, so the analysis is still frozen. */
function parseQmdCells(
  body: string,
): Array<{ type: string; source: string; label?: string; language?: string }> {
  const cells: Array<
    { type: string; source: string; label?: string; language?: string }
  > = [];
  const re = /```\{([^}]*)\}\r?\n([\s\S]*?)\r?\n```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const md = body.slice(last, m.index).trim();
    if (md) cells.push({ type: "markdown", source: md });
    const lines = m[2].split("\n");
    let i = 0;
    let label: string | undefined;
    while (i < lines.length && /^[ \t]*#\|/.test(lines[i])) {
      const lm = lines[i].match(/#\|[ \t]*label:[ \t]*(.+?)[ \t]*$/);
      if (lm) label = lm[1].trim();
      i++;
    }
    cells.push({
      type: "code",
      source: lines.slice(i).join("\n").trim(),
      label,
      language: m[1].trim(),
    });
    last = m.index + m[0].length;
  }
  const tail = body.slice(last).trim();
  if (tail) cells.push({ type: "markdown", source: tail });
  return cells;
}

/** The canonical FROZEN representation: the swamp CONTRACT (minus `writer`, the
 *  serializer-version metadata) + the AUTHOR cells. The caller has already excluded
 *  the params cell and the writer-generated setup cell. Excluding the serializer
 *  version AND the generated setup is what lets identical authored content compare
 *  equal ACROSS serializer builds — the frozen check no longer assumes serializer
 *  parity, it no longer depends on it. */
function frozenReprOf(
  swamp: Record<string, unknown>,
  authorCells: Array<{ type: string; source: string }>,
): string {
  const swampFrozen = { ...swamp };
  delete swampFrozen.writer;
  // `datapins` are INSTANCE-level data fingerprints (like `params`) — they differ
  // per fill, so they must NOT be part of the frozen-identical comparison.
  delete swampFrozen.datapins;
  return JSON.stringify(canonicalize({
    swamp: swampFrozen,
    cells: authorCells.map((c) => ({ type: c.type, source: c.source })),
  }));
}

/** A parsed document, format-agnostic. `frozenRepr` is the canonical string the
 *  frozen-check compares (EVERYTHING except params); `code` is the concatenated
 *  code-cell source (for the constants gate + body-ref check). */
/** Recursively key-SORT a value so a structural string comparison is robust to
 *  incidental key ordering (the load-bearing primitive is string equality, so its
 *  canonicalization must be stable, not whatever order a parser happened to emit).
 *  Arrays keep their order — cell/element order IS content; strings/scalars are
 *  left byte-exact, so frozen CODE is still compared verbatim. */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return v;
}

export interface ParsedDoc {
  format: DocFormat;
  language: DocLanguage;
  title: string;
  params: Record<string, string>;
  swamp: {
    template?: string;
    slots?: Record<string, Slot>;
    frozen?: Record<string, string>;
    /** INSTANCE-level data identity pins (`#35`): slot name → the dataset
     *  fingerprint recorded when the fill was sealed. Excluded from the frozen
     *  repr (it is per-fill, like `params`); `validate` re-checks it for drift. */
    datapins?: Record<string, DatasetPin>;
    /** The session-write build that SERIALIZED this document (`<type>@<version>`).
     *  Recorded so a later reader / `validate` can detect serializer drift instead
     *  of a confusing frozen mismatch — the artifact, not just the doc header,
     *  binds the writer version (and the sha256 seal hashes it with the rest). */
    writer?: string;
  };
  code: string;
  /** Source of the writer-generated param-setup cell (codegen, NOT frozen content).
   *  `validate` re-derives + verifies this against the slots instead of freezing its
   *  bytes — so a `bindExpr` change in a later build can't break the frozen check. */
  setupSource: string;
  /** Canonical string of the AUTHOR content only — the swamp contract (minus
   *  `writer`) + author cells, EXCLUDING params, the serializer version, and the
   *  generated setup cell. Identical authored content ⇒ equal across builds. */
  frozenRepr: string;
}

/** Parse a document by auto-detected format (leading `{` → ipynb JSON, else qmd
 *  frontmatter). The inverse of `serializeDoc` for the fields the gates need. */
export function parseDoc(text: string): ParsedDoc {
  if (text.trimStart().startsWith("{")) {
    let nb: {
      cells?: Array<
        { cell_type?: string; metadata?: { tags?: string[] }; source?: unknown }
      >;
      metadata?: {
        title?: string;
        swamp?: ParsedDoc["swamp"];
        kernelspec?: { language?: string };
      };
    };
    try {
      nb = JSON.parse(text);
    } catch (e) {
      // A user-supplied fill reaches `validate`; a corrupt notebook must fail with
      // a clear reason, not a raw "Unexpected token" crash.
      throw new Error(
        `malformed .ipynb (not valid JSON): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    const raw = Array.isArray(nb.cells) ? nb.cells : [];
    const has = (c: { metadata?: { tags?: string[] } }, tag: string) =>
      Array.isArray(c?.metadata?.tags) && c.metadata!.tags!.includes(tag);
    const params = (() => {
      const pc = raw.find((c) => has(c, "parameters"));
      return pc ? parseParamCell(joinSource(pc.source)) : {};
    })();
    const setupSource = (raw.find((c) =>
        has(c, SETUP_LABEL)
      )?.source
      ? joinSource(raw.find((c) => has(c, SETUP_LABEL))!.source)
      : "").trim();
    const swamp = nb.metadata?.swamp ?? {};
    const authorCells = raw
      .filter((c) => !has(c, "parameters") && !has(c, SETUP_LABEL))
      .map((c) => ({
        type: String(c.cell_type ?? ""),
        source: joinSource(c.source),
      }));
    return {
      format: "ipynb",
      language: nb.metadata?.kernelspec?.language === "R" ? "r" : "python",
      title: nb.metadata?.title ?? "",
      params,
      swamp,
      code: authorCells.filter((c) => c.type === "code").map((c) => c.source)
        .join("\n"),
      setupSource,
      frozenRepr: frozenReprOf(swamp, authorCells),
    };
  }
  const { yaml, body } = splitQmd(text);
  const y = (parseYaml(yaml) ?? {}) as Record<string, unknown>;
  const swamp = (y.swamp ?? {}) as ParsedDoc["swamp"];
  const params = (y.params ?? {}) as Record<string, string>;
  const cells = parseQmdCells(body);
  const setupSource = (cells.find((c) => c.label === SETUP_LABEL)?.source ?? "")
    .trim();
  const authorCells = cells.filter((c) => c.label !== SETUP_LABEL);
  return {
    format: "qmd",
    language: cells.find((c) => c.type === "code")?.language === "python"
      ? "python"
      : "r",
    title: String(y.title ?? ""),
    params,
    swamp,
    code: authorCells.filter((c) => c.type === "code").map((c) => c.source)
      .join("\n"),
    setupSource,
    frozenRepr: frozenReprOf(swamp, authorCells),
  };
}

// ============================================================================
// author — assemble a governed template from a typed intent and round-trip it
// ============================================================================

/**
 * One typed slot in an authoring intent: the slot grammar (`type`/`of`/
 * `contract`/`desc`) plus a must-pass `sample` and an optional must-fail
 * `antisample`. The antisample is what makes the round-trip non-vacuous; it is
 * REQUIRED for a slot guarded by a `contract` (where a hand-picked passing
 * sample would otherwise be a tautology) and optional otherwise.
 */
const AuthorSlotSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  of: z.string().optional(),
  contract: z.string().optional(),
  desc: z.string().optional(),
  /** For a `dataset` slot only: `"path"` emits `source: path` so the filled
   *  instance is path-gated by `checkDataset` (a file input read via
   *  `read.csv(params$x)`); `"object"` (or omitted) is an in-memory object name
   *  (`get(params$data)`). */
  source: z.enum(["path", "object"]).optional(),
  /** Optional fallback (typically for a `scalar` constant): emitted as the slot's
   *  `default` so an empty fill resolves to it. */
  default: z.string().optional(),
  /** Optional UNIT annotation (e.g. "pg/mL", "RLU", "1"). Metadata/provenance only. */
  unit: z.string().optional(),
  /** A value that MUST satisfy this slot. */
  sample: z.string().min(1),
  /** A value that MUST be rejected by this slot (required for contract slots). */
  antisample: z.string().optional(),
});

/** A declared constant in the authoring intent — `{ value, why }` (+ optional
 *  `source`); `why` must be non-empty (the rationale is the whole point). */
const AuthorConstantSchema = z.object({
  value: z.string().min(1),
  why: z.string().min(1),
  source: z.string().optional(),
});

/** One structured cell of the document the writer assembles (the "template for the
 *  template" surface): a code chunk or a markdown block. */
const CellSchema = z.object({
  type: z.enum(["code", "markdown"]),
  language: z.enum(["r", "python"]).optional(),
  source: z.string(),
  label: z.string().optional(),
  options: z.record(z.string(), z.string()).optional(),
});

const AuthorArgsSchema = z.object({
  /** Template id baked into the swamp block, e.g. "seahtrue-ocr@1". */
  templateId: z.string().min(1),
  /** Where the governed template is written — ONLY on a passing round-trip. Its
   *  extension must match `format` (.qmd / .ipynb). */
  outPath: z.string().min(1),
  /** STRUCTURED cells — the writer OWNS the layout (preferred). Pass as JSON:
   *  `--input 'cells:json=[{"type":"code","source":"..."}]'`. */
  cells: z.array(CellSchema).optional(),
  /** Target serialization (default qmd). `ipynb` REQUIRES `cells`. */
  format: z.enum(["qmd", "ipynb"]).default("qmd"),
  /** Document language (default r): drives fences, kernelspec, the param idiom. */
  language: z.enum(["r", "python"]).default("r"),
  /** LEGACY freeform body (a raw .qmd body WITH its own ```{r} fences); used only
   *  when `cells` is absent. Prefer `cells`. */
  body: z.string().optional(),
  /** The typed slots (pass as JSON: `--input 'slots:json=[...]'`). */
  slots: z.array(AuthorSlotSchema).min(1),
  title: z.string().default(""),
  domain: z.string().default(""),
  /** Optional typed output contract → swamp.returns (pass as JSON). */
  returns: z.record(z.string(), z.unknown()).default({}),
  /** Comma-separated columns for column/formula contracts during the round-trip. */
  columns: z.string().default(""),
  /** Declared constants (kept literals justified): `{ <name>: {value, why, source?} }`.
   *  Pass as JSON: `--input 'constants:json={"alpha":{"value":"0.05","why":"…"}}'`.
   *  Tolerant of an empty/absent value (a literal-free template, or the factory's
   *  CEL binding when no constants were elicited) → {}. */
  constants: z.preprocess(
    (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
    z.record(z.string(), AuthorConstantSchema),
  ).default({}),
  /** Fail-closed: throw (and write NOTHING) when the round-trip fails. */
  strict: z.preprocess((v) => v === true || v === "true", z.boolean()).default(
    true,
  ),
});

const AuthoringResultSchema = z.object({
  valid: z.boolean(),
  templateId: z.string(),
  outPath: z.string(),
  /** True only when the round-trip passed AND the file was written. */
  written: z.boolean(),
  /** SHA-256 of the emitted template bytes (empty when not written). */
  sha256: z.string(),
  /** Why the round-trip failed (empty on success). */
  reasons: z.array(z.string()).default([]),
  /** Declared slot names. */
  slots: z.array(z.string()).default([]),
  timestamp: z.string(),
});

type AuthorSlot = z.infer<typeof AuthorSlotSchema>;

/** The pure inputs the round-trip needs (no outPath/strict — those are I/O policy). */
export interface AuthorInput {
  title: string;
  templateId: string;
  domain?: string;
  /** STRUCTURED cells — the writer owns the document layout (preferred). */
  cells?: Cell[];
  /** Target serialization (default qmd). ipynb REQUIRES `cells`. */
  format?: DocFormat;
  /** Document language (default r) — drives fences, kernelspec, the param idiom. */
  language?: DocLanguage;
  /** LEGACY freeform body (a raw .qmd body WITH its own ```{r} fences). Used only
   *  when `cells` is absent; kept for back-compat with pre-cells callers. */
  body?: string;
  slots: AuthorSlot[];
  returns?: Record<string, unknown>;
  columns: string[];
  /** Declared constants keyed by name — the kept-literal justifications. */
  constants?: Record<string, Constant>;
  /** The serializing build (`<type>@<version>`), stamped into `swamp.writer` so the
   *  artifact self-describes its serializer and drift is detectable. */
  writerVersion?: string;
}

export interface AuthorVerdict {
  valid: boolean;
  reasons: string[];
  /** The rendered template text — written to outPath ONLY when valid. */
  templateText: string;
  slotNames: string[];
}

/**
 * Assemble a .qmd from a frontmatter object + a frozen body. YAML is rendered via
 * @std/yaml `stringify` so the template and every fill serialize identically
 * (only `params` differ) — which is exactly why the frozen-body check is
 * true-by-construction and the ANTISAMPLES (not the freeze) carry the real signal.
 */
function renderQmd(front: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(front);
  const b = body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${yaml}---\n${b}`;
}

/**
 * The deterministic authoring round-trip (no disk I/O, no LLM). Given a typed
 * intent it: (0) requires an antisample on every contract slot; (1) checks the
 * body references EXACTLY the declared slots; (2) renders the template + an
 * all-samples fill + per-slot antisample fills via the SAME renderer; (3) asserts
 * the all-samples fill VALIDATES; and (4) asserts each provided antisample is
 * REJECTED by its slot — the non-vacuous gate proving every guarded slot's check
 * has teeth. The template is returned for the caller to write ONLY when `valid`.
 */
export function authorRoundTrip(
  input: AuthorInput,
  registry: Record<string, Contract> = CONTRACTS,
): AuthorVerdict {
  const reasons: string[] = [];
  const slotNames = input.slots.map((s) => s.name);
  const language: DocLanguage = input.language ?? "r";
  const format: DocFormat = input.format ?? "qmd";
  const cells = input.cells;
  // The analysis CODE the gates read: concatenated code-cell source (cells path)
  // or the legacy freeform body. Fences/markdown carry no slots or magic literals.
  const codeText = cells
    ? cells.filter((c) => c.type === "code").map((c) => c.source).join("\n")
    : (input.body ?? "");
  if (!cells && !(input.body ?? "").trim()) {
    return {
      valid: false,
      reasons: ["no cells and no body — nothing to author"],
      templateText: "",
      slotNames: [],
    };
  }

  // (0a) at least one slot (the method schema enforces this too, but the exported
  // pure function must stand on its own).
  if (input.slots.length === 0) {
    return {
      valid: false,
      reasons: ["no slots declared"],
      templateText: "",
      slotNames: [],
    };
  }

  // (0b) slot names must be UNIQUE — Object.fromEntries would silently collapse
  // duplicates, dropping one slot (and its contract) from the emitted template.
  const dupes = [
    ...new Set(slotNames.filter((n, i) => slotNames.indexOf(n) !== i)),
  ];
  if (dupes.length) {
    reasons.push(`duplicate slot name(s): [${dupes.join(", ")}]`);
  }

  for (const s of input.slots) {
    const hasAnti = !!(s.antisample && s.antisample.trim());
    // (0c) a CONTRACT slot must ship an antisample (else the gate is a tautology).
    if (s.contract && !hasAnti) {
      reasons.push(
        `contract slot "${s.name}" must declare an antisample (a value the contract REJECTS)`,
      );
    }
    // (0d) an antisample equal to the sample proves nothing.
    if (hasAnti && s.antisample!.trim() === s.sample.trim()) {
      reasons.push(`slot "${s.name}": antisample must differ from sample`);
    }
    // (0f) `source` describes how a DATASET value is consumed (path vs object);
    // it is meaningless on a column/formula slot — a template defect.
    if (s.source && s.type !== "dataset") {
      reasons.push(
        `slot "${s.name}": source applies only to a dataset slot (got type ${s.type})`,
      );
    }
  }

  // (0e) the returns block is spliced verbatim into the template — reject garbage.
  for (const [k, v] of Object.entries(input.returns ?? {})) {
    if (!k.trim()) reasons.push("returns has an empty key");
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      reasons.push(
        `return "${k}" must be an object (e.g. { bind: ..., inherits: ... })`,
      );
    }
  }

  // (1) the body must reference the declared slots. Line comments (`#…` in both R
  // and Python) are stripped first so a commented mention is not a false reference.
  const code = codeText.replace(/#[^\n]*/g, "");
  const referenced = new Set<string>();
  if (!cells) {
    // LEGACY body path (R only): the author wrote `params$name` /
    // `params[["name"]]` directly. We KNOW the full reference surface, so an
    // UNDECLARED `params$x` is also a defect.
    for (const m of code.matchAll(/params\$([A-Za-z.][A-Za-z0-9._]*)/g)) {
      referenced.add(m[1]);
    }
    for (const m of code.matchAll(/params\[\[\s*['"]([^'"\]]+)['"]\s*\]\]/g)) {
      referenced.add(m[1]);
    }
    const undeclared = [...referenced].filter((n) => !slotNames.includes(n));
    if (undeclared.length) {
      reasons.push(
        `body references undeclared param(s): [${undeclared.join(", ")}]`,
      );
    }
  } else {
    // CELLS path (R and Python): the writer binds each slot to a BARE variable, so
    // a slot is "used" when its name appears as a bare identifier (this also
    // matches `params$name` / `params["name"]`, since the sigil is a non-word
    // char). STRING LITERALS are blanked first so a name appearing ONLY inside a
    // string is not a false "use". Bare-name matching can't distinguish an
    // undeclared param from any local, so only the unreferenced direction is
    // checked (documented heuristic limit).
    const noStrings = code
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
    for (const name of slotNames) {
      if (
        new RegExp(`(^|[^\\w.])${escapeRe(name)}([^\\w]|$)`).test(noStrings)
      ) {
        referenced.add(name);
      }
    }
  }
  const unreferenced = slotNames.filter((n) => !referenced.has(n));
  if (unreferenced.length) {
    reasons.push(
      `declared slot(s) never used in the body: [${unreferenced.join(", ")}]`,
    );
  }

  // (1b) NO UNACCOUNTED CONSTANTS. Every DECISION literal in the frozen body must be
  // either slotted away (so it is `params$name`, not a bare literal) or declared in
  // `swamp.constants` with a rationale. A magic number is an authorship choice as
  // real as a slot value — fail-closed until it is made explicit.
  const consts = input.constants ?? {};
  // match on canonical numeric VALUE, not spelling — `2` declared accounts for a
  // body `2.0`/`2e0`/`2L`, and `-0.5` reconciles its sign.
  const declaredVals = new Set(
    Object.values(consts).map((c) => canonConst(String(c.value))),
  );
  const bodyLits = enumerateConstants(codeText, language);
  const bodyVals = new Set(bodyLits.map((l) => canonConst(l.value)));
  const reported = new Set<string>();
  for (const lit of bodyLits) {
    const key = canonConst(lit.value);
    if (!declaredVals.has(key) && !reported.has(key)) {
      reported.add(key);
      reasons.push(
        `unaccounted ${lit.type} constant ${lit.value} (near \`${lit.context}\`) — bind it ` +
          `to a slot, declare it in swamp.constants with a rationale, or remove it`,
      );
    }
  }
  for (const [k, c] of Object.entries(consts)) {
    if (!String(c.why ?? "").trim()) {
      reasons.push(`declared constant "${k}" must include a rationale (why)`);
    }
    if (!bodyVals.has(canonConst(String(c.value)))) {
      reasons.push(
        `declared constant "${k}" (value ${c.value}) appears nowhere in the body`,
      );
    }
  }

  // (2) render the template + fills from ONE structure (only `params` differ). The
  // swamp block is format-independent; `render` serializes it via the writer-owned
  // document model (cells → serializeDoc, which OWNS the layout) or the legacy
  // freeform-body path (renderQmd). Same structure → frozen-by-construction.
  const swampBlock: Record<string, unknown> = {
    template: input.templateId,
    slots: Object.fromEntries(input.slots.map((s) => [s.name, {
      type: s.type,
      ...(s.of ? { of: s.of } : {}),
      ...(s.contract ? { contract: s.contract } : {}),
      ...(s.source ? { source: s.source } : {}),
      ...(s.default !== undefined ? { default: s.default } : {}),
      ...(s.unit ? { unit: s.unit } : {}),
      ...(s.desc ? { desc: s.desc } : {}),
    }])),
    ...(input.returns && Object.keys(input.returns).length
      ? { returns: input.returns }
      : {}),
    ...(input.constants && Object.keys(input.constants).length
      ? { constants: input.constants }
      : {}),
    ...(input.writerVersion ? { writer: input.writerVersion } : {}),
  };
  const title = input.title || input.templateId;
  const render = (params: Record<string, string>): string =>
    cells
      ? serializeDoc({
        format,
        language,
        title,
        params,
        swamp: swampBlock,
        cells,
      })
      : renderQmd(
        { title, format: "html", params, swamp: swampBlock },
        input.body ?? "",
      );
  const sampleParams = Object.fromEntries(
    input.slots.map((s) => [s.name, s.sample]),
  );
  const templateText = render(
    Object.fromEntries(input.slots.map((s) => [s.name, ""])),
  );

  // (3) the all-samples fill must VALIDATE (every slot accepts its own sample;
  // an unknown contract also fails here, via the shared validateFill).
  const sampleText = render(sampleParams);
  const sampleResult = validateFill(
    templateText,
    sampleText,
    input.columns,
    registry,
  );
  for (const r of sampleResult.slots) {
    if (!r.ok) {
      reasons.push(
        `sample for slot "${r.name}" does not satisfy it: ${r.reason}`,
      );
    }
  }

  // (4) the ANTISAMPLE gate (non-vacuous). For a CONTRACT slot the antisample must
  // be rejected BY THE CONTRACT SPECIFICALLY — a structural sub-check (no `~`,
  // column-not-in-data) rejecting it would NOT prove the contract has teeth. For a
  // non-contract slot, the slot's structural check must reject the antisample.
  for (const s of input.slots) {
    const anti = s.antisample?.trim();
    if (!anti) continue;
    if (s.contract) {
      const { name: cname, arg } = parseContractRef(s.contract);
      const contract = registry[cname]; // unknown contract already failed step 3
      if (contract) {
        const r = contract.check(anti, {
          columns: input.columns,
          params: sampleParams,
        }, arg);
        if (r.ok) {
          reasons.push(
            `antisample for contract slot "${s.name}" is NOT rejected by contract "${cname}" — it has no teeth (value: "${anti}")`,
          );
        }
      }
    } else {
      const antiText = render({ ...sampleParams, [s.name]: anti });
      const res = validateFill(templateText, antiText, input.columns, registry);
      const slotRes = res.slots.find((r) => r.name === s.name);
      if (slotRes && slotRes.ok) {
        reasons.push(
          `antisample for slot "${s.name}" was NOT rejected — its check has no teeth (value: "${anti}")`,
        );
      }
    }
  }

  return { valid: reasons.length === 0, reasons, templateText, slotNames };
}

/** Arguments for `init`: wire a (new) R project to the suite. */
const InitArgsSchema = z.object({
  /** Folder of the R project to wire — the `.qmd` is written here. */
  projectPath: z.string().min(1),
  /**
   * Control-plane repo dir baked into the recorder call (`start_swamp(repo=)`).
   * Defaults to the cwd the method runs in (the control plane). Pass explicitly
   * if running the method from elsewhere.
   */
  repoDir: z.string().default(""),
  /** Name of the quarto file written into the project. */
  fileName: z.string().default("swamp.qmd"),
  /**
   * Absolute path to the `swamp` CLI binary, baked into the recorder call
   * (`start_swamp(swamp=)`). RStudio launched from the GUI has a minimal PATH
   * that usually omits `~/.local/bin`, so the recorder's bare-name `swamp` child
   * can't be spawned and records ship-fail silently. Default ""  → resolve it at
   * init time (the method runs where swamp IS resolvable) and write the answer
   * down. Pass explicitly to override the resolved path.
   */
  swampBin: z.string().default(""),
  /** Overwrite an existing file (default: keep it, so user edits survive). */
  force: z.preprocess((v) => v === true || v === "true", z.boolean()).default(
    false,
  ),
});

const InitResultSchema = z.object({
  projectPath: z.string(),
  file: z.string(),
  repoDir: z.string(),
  /** False when the file already existed and `force` was not set (kept as-is). */
  written: z.boolean(),
  /** Absolute swamp binary baked into start_swamp(swamp=), or "swamp" if unresolved. */
  swampBin: z.string(),
  /** Path to the .claude/settings.local.json that records SWAMP_REPO_DIR for Claude. */
  settings: z.string(),
  timestamp: z.string(),
});

/**
 * Resolve the absolute path of the `swamp` CLI to bake into `start_swamp(swamp=)`.
 * RStudio's GUI PATH often omits `~/.local/bin`, so the bare name fails to spawn
 * there; `init` runs in the control-plane shell where swamp IS resolvable, so we
 * record the answer once. Order: explicit arg → the running swamp binary (the
 * extension executes inside the deno-compiled swamp binary, so `Deno.execPath()`
 * IS the CLI) → a PATH scan → bare "swamp" (preserves prior behavior if nothing
 * resolves). Every probe is guarded so a denied permission just falls through.
 */
async function resolveSwampBin(explicit: string): Promise<string> {
  const e = explicit.trim();
  if (e) return e;
  try {
    const p = Deno.execPath();
    if (p && /(^|\/)swamp$/.test(p)) return p;
  } catch { /* execPath not granted — fall through */ }
  try {
    const path = Deno.env.get("PATH") ?? "";
    for (const d of path.split(":")) {
      if (!d) continue;
      const cand = `${d.replace(/\/+$/, "")}/swamp`;
      try {
        const st = await Deno.stat(cand);
        if (st.isFile) return cand;
      } catch { /* not in this dir */ }
    }
  } catch { /* env not granted — fall through */ }
  return "swamp";
}

/**
 * The single quarto file that makes an R project record. Its setup chunk installs
 * swamprecord on first run (via pak/renv/remotes, whichever is present) and arms
 * the recorder against the control plane — no `.Rprofile`, no nix, no engine.
 * Runs in the user's own RStudio.
 */
function swampQmd(repoDir: string, swampBin: string): string {
  // Bake the resolved swamp binary into the recorder call only when we have an
  // absolute path; if resolution fell back to the bare name, omit the arg so the
  // call is identical to the historical template (relies on PATH).
  const startCall = swampBin && swampBin !== "swamp"
    ? `swamprecord::start_swamp(repo = ${JSON.stringify(repoDir)}, swamp = ${
      JSON.stringify(swampBin)
    })`
    : `swamprecord::start_swamp(repo = ${JSON.stringify(repoDir)})`;
  return [
    "---",
    'title: "Swamp session"',
    "format: html",
    "---",
    "",
    "```{r}",
    "#| label: swamp-recorder",
    "#| message: true",
    "# Arm the swamp session recorder for this project. On first run it installs",
    "# swamprecord, then records every top-level execution to the `rec` ledger in",
    "# the swamp control plane. Repo path baked in by `session-write init`.",
    'if (!requireNamespace("swamprecord", quietly = TRUE)) {',
    '  message("Installing swamprecord ...")',
    '  if (requireNamespace("pak", quietly = TRUE)) {',
    '    pak::pak("vcjdeboer/swamprecord")',
    '  } else if (requireNamespace("renv", quietly = TRUE)) {',
    '    renv::install("vcjdeboer/swamprecord")',
    "  } else {",
    '    if (!requireNamespace("remotes", quietly = TRUE)) install.packages("remotes")',
    '    remotes::install_github("vcjdeboer/swamprecord")',
    "  }",
    "}",
    startCall,
    "```",
    "",
    "```{r}",
    "# Your analysis here — every chunk is recorded to the ledger.",
    "```",
    "",
  ].join("\n");
}

/**
 * Persist `SWAMP_REPO_DIR` into the project's `.claude/settings.local.json` so any
 * later Claude session in this folder reaches the control plane without being told
 * the path again. Merges — existing keys (and other env vars) survive.
 */
async function writeSwampRepoDir(
  projectDir: string,
  repoDir: string,
): Promise<string> {
  const settingsPath = `${projectDir}/.claude/settings.local.json`;
  await Deno.mkdir(`${projectDir}/.claude`, { recursive: true });
  let data: Record<string, unknown> = {};
  try {
    const txt = await Deno.readTextFile(settingsPath);
    data = txt.trim() ? (JSON.parse(txt) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  const env = (data.env && typeof data.env === "object")
    ? data.env as Record<string, unknown>
    : {};
  env.SWAMP_REPO_DIR = repoDir;
  data.env = env;
  await Deno.writeTextFile(settingsPath, JSON.stringify(data, null, 2) + "\n");
  return settingsPath;
}

/** The session-write model definition. */
export const model = {
  type: "@vcjdeboer/session-write",
  version: "2026.06.29.1",
  globalArguments: z.object({}),
  resources: {
    "validation": {
      description:
        "Result of validating a filled template against its slot contracts",
      schema: ValidationSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "init": {
      description:
        "Record of wiring an R project to the suite (the swamp.qmd written into it)",
      schema: InitResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "authoring": {
      description:
        "Result of authoring a governed template — the round-trip verdict plus the emitted path + sha256",
      schema: AuthoringResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    init: {
      description:
        'R-project on-ramp. Run from the project: SWAMP_REPO_DIR=<swamp> swamp model method run writer init --input projectPath="$PWD". Writes swamp.qmd + .claude/settings.local.json; arms swamprecord against the rec ledger. repoDir resolves from --input repoDir, else SWAMP_REPO_DIR env, else cwd (--repo-dir does NOT set it in-method).',
      arguments: InitArgsSchema,
      execute: async (
        args: z.infer<typeof InitArgsSchema>,
        context: {
          writeResource: (
            specName: string,
            instanceName: string,
            data: unknown,
          ) => Promise<{ version: number }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        const repoDir = resolveRepoDir(
          args.repoDir,
          Deno.env.get("SWAMP_REPO_DIR") ?? "",
          Deno.cwd(),
        );
        const dir = args.projectPath.replace(/\/+$/, "");
        const target = `${dir}/${args.fileName}`;

        await Deno.mkdir(dir, { recursive: true });

        let exists = false;
        try {
          await Deno.stat(target);
          exists = true;
        } catch {
          exists = false;
        }

        const swampBin = await resolveSwampBin(args.swampBin);

        const written = !exists || args.force;
        if (written) {
          await Deno.writeTextFile(target, swampQmd(repoDir, swampBin));
        }

        // Always refreshed: the pointer that lets later Claude sessions here reach
        // the control plane without being told the path again.
        const settings = await writeSwampRepoDir(dir, repoDir);

        const handle = await context.writeResource("init", "result", {
          projectPath: dir,
          file: target,
          repoDir,
          written,
          swampBin,
          settings,
          timestamp: new Date().toISOString(),
        });

        context.logger.info(
          "init: {status} {file} (repo={repo}, swamp={swamp})",
          {
            status: written ? "wrote" : "kept existing",
            file: target,
            repo: repoDir,
            swamp: swampBin,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    validate: {
      description:
        "Assert the filled .qmd left the structure frozen and every parameter satisfies its slot contract",
      arguments: ValidateArgsSchema,
      execute: async (
        args: z.infer<typeof ValidateArgsSchema>,
        context: {
          writeResource: (
            specName: string,
            instanceName: string,
            data: unknown,
          ) => Promise<{ version: number }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        const tmplText = await Deno.readTextFile(args.templatePath);
        const fillText = await Deno.readTextFile(args.filledPath);
        const columns = args.columns.split(",").map((s) => s.trim()).filter(
          Boolean,
        );

        // Pure, deterministic core (frozen body + slot/contract checks). Shared
        // verbatim with the `author` round-trip so the two can never drift.
        const core = validateFill(
          tmplText,
          fillText,
          columns,
          CONTRACTS,
          `${model.type}@${model.version}`,
        );

        // frozen FILES: the targets template's pipeline lives in separate files
        // (_targets.R, R/functions.R) the AI must not touch. Recompute their
        // SHA256 and compare to the (frozen) swamp.frozen manifest — the disk-bound
        // analogue of the .qmd body byte-compare. Empty when none are declared.
        const baseDir = dirOf(args.filledPath);
        const frozenFiles = [];
        for (const [rel, expected] of Object.entries(core.frozenManifest)) {
          let ok = false;
          let reason = "";
          try {
            const actual = await sha256HexFile(`${baseDir}/${rel}`);
            ok = actual === expected;
            if (!ok) {
              reason = `frozen file "${rel}" was altered (sha256 mismatch)`;
            }
          } catch {
            reason = `frozen file "${rel}" is missing`;
          }
          frozenFiles.push({ path: rel, ok, reason });
        }
        const allFrozen = core.frozenBody && frozenFiles.every((f) => f.ok);

        // dataset slots with `source: path`: a filled INSTANCE must pin its data
        // with an absolute, existing path (a relative path silently breaks when
        // the .qmd is opened from another working directory — "working-directory
        // hell"). Disk-bound, like the frozen-FILES check, so it runs HERE in the
        // method and NOT in the pure core (author's in-memory round-trip uses
        // placeholder paths). The `source === "path"` guard is essential: a
        // `dataset` slot without it is an in-memory OBJECT name (`get(params$x)`
        // → "mtcars"), NOT a path, and must not be path-checked. Only
        // structurally-valid (filled) slots are probed, so a "slot not filled"
        // reason still wins for an empty value.
        const slots: SlotResult[] = [];
        for (const s of core.slots) {
          if (s.type === "dataset" && s.source === "path" && s.ok) {
            const d = await checkDataset(s.value);
            slots.push(d.ok ? s : { ...s, ok: false, reason: d.reason });
          } else {
            slots.push(s);
          }
        }

        // #35 SEAL THE DATA: fingerprint each filled dataset-path slot and, if the
        // fill carries a recorded pin (swamp.datapins[slot]), verify the data has
        // not drifted under the sealed analysis. A pin is OPT-IN — with no recorded
        // pin there is nothing to compare, so the slot is reported (sha256/rows) but
        // never fails; a MISMATCH fails (the CSV changed since it was sealed).
        // Remote (scheme://) sources are reported-only, not hashed. This is IDENTITY,
        // not quality: it answers "same data?", never "good data?".
        const recordedPins = parseDoc(fillText).swamp.datapins ?? {};
        const dataPins: z.infer<typeof DataPinResultSchema>[] = [];
        for (const s of slots) {
          if (s.type !== "dataset" || s.source !== "path" || !s.ok) continue;
          if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(s.value)) continue; // remote
          let path = s.value;
          if (path === "~" || path.startsWith("~/")) {
            let home = "";
            try {
              home = Deno.env.get("HOME") ?? "";
            } catch {
              /* no --allow-env: leave unresolved, read will fail below */
            }
            if (home) {
              path = home.replace(/\/+$/, "") + path.slice(1);
            }
          }
          try {
            const cur = await datasetFingerprint(await Deno.readFile(path));
            const rec = recordedPins[s.name];
            const drift = rec ? diffDatasetPin(rec, cur) : [];
            dataPins.push({
              slot: s.name,
              sha256: cur.sha256,
              rows: cur.rows,
              pinned: !!rec,
              ok: drift.length === 0,
              drift,
            });
          } catch {
            /* unreadable is already a checkDataset failure on the slot */
          }
        }
        const allPinsOk = dataPins.every((p) => p.ok);

        // A TAMPERED setup (injected/hand-edited under THIS build) fails; "drift"
        // (the setup was generated by another build, author content already frozen)
        // does NOT fail — it is a benign codegen refresh.
        const valid = allFrozen && slots.every((r) => r.ok) && allPinsOk &&
          core.setupIntegrity !== "tampered";
        const handle = await context.writeResource("validation", "result", {
          valid,
          frozen: allFrozen,
          template: core.template,
          slots,
          frozenFiles,
          dataPins,
          timestamp: new Date().toISOString(),
        });

        if (core.setupIntegrity === "drift" || core.writerSkew) {
          context.logger.info(
            "validate: serializer drift (template={t} fill={f}) — author content checked independently of the serializer; re-render to refresh the generated layout",
            {
              t: core.writerSkew?.template ?? "",
              f: core.writerSkew?.fill ?? "",
            },
          );
        }

        context.logger.info(
          "validate: {valid} (frozen={frozen}) — {nbad}/{n} slot(s) failed",
          {
            valid,
            frozen: allFrozen,
            nbad: slots.filter((r) => !r.ok).length,
            n: slots.length,
          },
        );

        // Fail-closed gate (resource already written above, so the reason is
        // inspectable). A swamp workflow passes strict:true so `execute` can
        // `dependsOn: validate succeeded` and a bad fill never runs headless.
        if (args.strict && !valid) {
          const reasons = [
            ...(core.setupIntegrity === "tampered"
              ? [
                "the writer-generated param-setup cell does not match the declared slots — it was hand-edited or replaced with injected code; re-render the fill with the current session-write build",
              ]
              : []),
            ...(allFrozen ? [] : [
              "structure check failed: the frozen analysis (swamp contract + author cells) differs from the template",
            ]),
            ...frozenFiles.filter((f) => !f.ok).map((f) => f.reason),
            ...slots.filter((r) => !r.ok).map((r) => `${r.name}: ${r.reason}`),
            ...dataPins.filter((p) => !p.ok).map((p) =>
              `data drift in "${p.slot}": ${p.drift.join("; ")}`
            ),
          ].filter(Boolean);
          throw new Error(
            `validate (strict): fill is INVALID — ${
              reasons.join("; ") || "see the validation resource"
            }`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
    author: {
      description:
        "Assemble a governed template from a typed authoring-intent and round-trip it: the all-samples fill must VALIDATE and every contract slot's antisample must be REJECTED; the .qmd is written to outPath ONLY on pass. Returns the verdict the factory's round-trip gate reads.",
      arguments: AuthorArgsSchema,
      execute: async (
        args: z.infer<typeof AuthorArgsSchema>,
        context: {
          writeResource: (
            specName: string,
            instanceName: string,
            data: unknown,
          ) => Promise<{ version: number }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        const columns = args.columns.split(",").map((s) => s.trim()).filter(
          Boolean,
        );
        // outPath safety: this method writes a file at a CALLER-supplied path (an
        // agent supplies it in the factory flow). Refuse path traversal and require
        // an extension that MATCHES `format` so a stray path can't clobber an
        // arbitrary file and a qmd is never written to a .ipynb name (or vice versa).
        const ext = args.format === "ipynb" ? ".ipynb" : ".qmd";
        const pathReasons: string[] = [];
        if (!args.outPath.endsWith(ext)) {
          pathReasons.push(
            `outPath must end in ${ext} (format=${args.format})`,
          );
        }
        if (args.outPath.split("/").includes("..")) {
          pathReasons.push("outPath must not contain '..' segments");
        }
        // cross-field intent checks (kept out of the Zod object so swamp can still
        // introspect a plain schema): supply cells OR a legacy body; ipynb needs cells.
        if (!args.cells && !(args.body ?? "").trim()) {
          pathReasons.push(
            "provide either `cells` (preferred) or a legacy `body`",
          );
        }
        if (args.format === "ipynb" && !args.cells) {
          pathReasons.push(
            "format ipynb requires structured `cells` (no legacy body path)",
          );
        }

        const verdict = authorRoundTrip({
          title: args.title,
          templateId: args.templateId,
          domain: args.domain,
          cells: args.cells,
          format: args.format,
          language: args.language,
          body: args.body,
          slots: args.slots,
          returns: args.returns,
          columns,
          constants: args.constants,
          writerVersion: `${model.type}@${model.version}`,
        });
        const reasons = [...pathReasons, ...verdict.reasons];
        const valid = verdict.valid && pathReasons.length === 0;

        // Write ONLY on a passing round-trip, and ATOMICALLY (temp file + rename)
        // so a failed write can never leave a truncated .qmd at outPath. The sha256
        // is taken from the bytes ON DISK, so it is a real seal a later reader can
        // re-verify.
        let written = false;
        let sha256 = "";
        if (valid) {
          const tmp = `${args.outPath}.tmp`;
          await Deno.mkdir(dirOf(args.outPath), { recursive: true });
          await Deno.writeTextFile(tmp, verdict.templateText);
          await Deno.rename(tmp, args.outPath);
          sha256 = await sha256HexFile(args.outPath);
          written = true;
        }

        const handle = await context.writeResource("authoring", "result", {
          valid,
          templateId: args.templateId,
          outPath: args.outPath,
          written,
          sha256,
          reasons,
          slots: verdict.slotNames,
          timestamp: new Date().toISOString(),
        });

        context.logger.info(
          "author: {valid} (written={written}) {outPath} — {nbad} reason(s)",
          {
            valid,
            written,
            outPath: args.outPath,
            nbad: reasons.length,
          },
        );

        if (args.strict && !valid) {
          throw new Error(
            `author (strict): template REJECTED — ${
              reasons.join("; ") || "see the authoring resource"
            }`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
