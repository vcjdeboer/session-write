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
import { parse as parseYaml } from "jsr:@std/yaml@1.1.1";

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

const ValidationSchema = z.object({
  valid: z.boolean(),
  /** True if the config is frozen AND every declared frozen file matches its hash. */
  frozen: z.boolean(),
  template: z.string(),
  slots: z.array(SlotResultSchema),
  /** SHA256 checks for files in `swamp.frozen` (the targets pipeline's _targets.R, R/*). */
  frozenFiles: z.array(FrozenFileResultSchema).default([]),
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

/** Directory of a path (for resolving frozen files relative to the fill file). */
function dirOf(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : ".";
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
  const throughOrigin = /(^|[^\w])-\s*1(\b|$)/.test(formula) ||
    /\+\s*0(\b|$)/.test(formula);
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
  version: "2026.06.22.3",
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
  },
  methods: {
    "init": {
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
    "validate": {
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
        const tmpl = splitQmd(tmplText);
        const fill = splitQmd(fillText);

        const tmplYaml = (parseYaml(tmpl.yaml) ?? {}) as Record<
          string,
          unknown
        >;
        const fillYaml = (parseYaml(fill.yaml) ?? {}) as Record<
          string,
          unknown
        >;

        // (a) structure frozen: body identical + all non-`params` YAML identical.
        const stripParams = (y: Record<string, unknown>) => {
          const c = { ...y };
          delete c.params;
          return JSON.stringify(c);
        };
        const frozen = tmpl.body === fill.body &&
          stripParams(tmplYaml) === stripParams(fillYaml);

        const swamp = (tmplYaml.swamp ?? {}) as {
          template?: string;
          slots?: Record<string, Slot>;
          frozen?: Record<string, string>;
        };
        const slots = swamp.slots ?? {};
        const params = (fillYaml.params ?? {}) as Record<string, string>;
        const columns = args.columns.split(",").map((s) => s.trim()).filter(
          Boolean,
        );

        const results = [];
        for (const [name, slot] of Object.entries(slots)) {
          const value = String(params[name] ?? "").trim();
          let ok = true;
          let reason = "";

          if (!value) {
            ok = false;
            reason = "slot not filled";
          } else if (slot.type === "dataset") {
            // (deterministic deep check — that columns exist — is a session-execute concern)
            ok = true;
          } else if (slot.type === "column") {
            ok = columns.length === 0 || columns.includes(value);
            if (!ok) {
              reason = `column "${value}" is not in [${columns.join(", ")}]`;
            }
          } else if (slot.type === "formula") {
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
                reason = `formula variables not in data: [${
                  unknown.join(", ")
                }]`;
              } else if (slot.contract === "quadratic_through_origin") {
                const c = quadraticThroughOrigin(value, String(params.x ?? ""));
                ok = c.ok;
                reason = c.reason;
              }
            }
          }
          results.push({ name, type: slot.type, value, ok, reason });
        }

        // (c) frozen FILES: the targets template's pipeline lives in separate files
        // (_targets.R, R/functions.R) the AI must not touch. Recompute their SHA256
        // and compare to the (frozen) swamp.frozen manifest — the analogue of the
        // .qmd body byte-compare. Empty when the template declares no frozen files.
        const frozenMap = (swamp.frozen ?? {}) as Record<string, string>;
        const baseDir = dirOf(args.filledPath);
        const frozenFiles = [];
        for (const [rel, expected] of Object.entries(frozenMap)) {
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
        const allFrozen = frozen && frozenFiles.every((f) => f.ok);

        const valid = allFrozen && results.every((r) => r.ok);
        const handle = await context.writeResource("validation", "result", {
          valid,
          frozen: allFrozen,
          template: swamp.template ?? "",
          slots: results,
          frozenFiles,
          timestamp: new Date().toISOString(),
        });

        context.logger.info(
          "validate: {valid} (frozen={frozen}) — {nbad}/{n} slot(s) failed",
          {
            valid,
            frozen: allFrozen,
            nbad: results.filter((r) => !r.ok).length,
            n: results.length,
          },
        );

        // Fail-closed gate (resource already written above, so the reason is
        // inspectable). A swamp workflow passes strict:true so `execute` can
        // `dependsOn: validate succeeded` and a bad fill never runs headless.
        if (args.strict && !valid) {
          const reasons = [
            ...(allFrozen ? [] : ["structure / frozen-file check failed"]),
            ...frozenFiles.filter((f) => !f.ok).map((f) => f.reason),
            ...results.filter((r) => !r.ok).map((r) =>
              `${r.name}: ${r.reason}`
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
  },
};
