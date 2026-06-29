import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertContractsDiscriminate,
  type AuthorInput,
  authorRoundTrip,
  canonConst,
  type Cell,
  checkDataset,
  type Contract,
  CONTRACTS,
  csvSchema,
  datasetFingerprint,
  diffDatasetPin,
  enumerateConstants,
  model,
  parseDoc,
  resolveRepoDir,
  serializeDoc,
  validateFill,
} from "./session_write.ts";

// --- resolveRepoDir (existing) ---
Deno.test("repoDir prefers explicit arg", () => {
  assertEquals(resolveRepoDir("/explicit", "/env", "/cwd"), "/explicit");
});
Deno.test("repoDir falls back to SWAMP_REPO_DIR env", () => {
  assertEquals(resolveRepoDir("", "/env", "/cwd"), "/env");
});
Deno.test("repoDir falls back to cwd when nothing else", () => {
  assertEquals(resolveRepoDir("", "", "/cwd"), "/cwd");
});
Deno.test("trailing slashes stripped", () => {
  assertEquals(resolveRepoDir("", "/env/", "/cwd"), "/env");
});

// --- validateFill fixtures ---------------------------------------------------
// A minimal .qmd built from a params block + a slots block, sharing one frozen
// body. Template and fill differ ONLY in the params values (the fill surface).
function doc(
  paramsYaml: string,
  slotsYaml: string,
  body = "mod <- lm(1)",
): string {
  return [
    "---",
    'title: "t"',
    "params:",
    paramsYaml,
    "swamp:",
    "  template: t@1",
    "  slots:",
    slotsYaml,
    "---",
    "",
    "```{r}",
    body,
    "```",
    "",
  ].join("\n");
}

const SLOTS = [
  "    data: { type: dataset }",
  "    formula: { type: formula, of: data, contract: quadratic_through_origin }",
  "    x: { type: column, of: data }",
  "    y: { type: column, of: data }",
].join("\n");
const PARAMS_EMPTY = ['  data: ""', '  formula: ""', '  x: ""', '  y: ""'].join(
  "\n",
);
const PARAMS_OK = [
  '  data: "mtcars"',
  '  formula: "mpg ~ I(hp^2) - 1"',
  '  x: "hp"',
  '  y: "mpg"',
].join("\n");

const TMPL = doc(PARAMS_EMPTY, SLOTS);
const FILL_OK = doc(PARAMS_OK, SLOTS);
const COLS = ["mpg", "hp"];

function slot(r: ReturnType<typeof validateFill>, name: string) {
  return r.slots.find((s) => s.name === name)!;
}

Deno.test("validateFill: a correct fill is frozen and every slot passes", () => {
  const r = validateFill(TMPL, FILL_OK, COLS);
  assertEquals(r.frozenBody, true);
  assertEquals(r.template, "t@1");
  assertEquals(r.slots.every((s) => s.ok), true);
});

Deno.test("validateFill: frozenBody is false when the body is edited", () => {
  const tampered = FILL_OK.replace("mod <- lm(1)", "mod <- lm(2)  # sneaky");
  assertEquals(validateFill(TMPL, tampered, COLS).frozenBody, false);
});

Deno.test("validateFill: an unfilled slot fails with 'slot not filled'", () => {
  // fill == template → all params still empty
  const r = validateFill(TMPL, TMPL, COLS);
  assertEquals(slot(r, "data").ok, false);
  assertEquals(slot(r, "data").reason, "slot not filled");
});

Deno.test("validateFill: a column value not in the dataset fails", () => {
  const fill = doc(
    [
      '  data: "mtcars"',
      '  formula: "mpg ~ I(hp^2) - 1"',
      '  x: "nope"',
      '  y: "mpg"',
    ].join("\n"),
    SLOTS,
  );
  assertEquals(slot(validateFill(TMPL, fill, COLS), "x").ok, false);
});

Deno.test("validateFill: a non-formula value in a formula slot fails", () => {
  const fill = doc(
    [
      '  data: "mtcars"',
      '  formula: "not a formula"',
      '  x: "hp"',
      '  y: "mpg"',
    ]
      .join("\n"),
    SLOTS,
  );
  const s = slot(validateFill(TMPL, fill, COLS), "formula");
  assertEquals(s.ok, false);
  assertEquals(s.reason, "not a formula (no `~`)");
});

Deno.test("validateFill: enforces quadratic_through_origin (rejects a plain linear formula)", () => {
  const fill = doc(
    ['  data: "mtcars"', '  formula: "mpg ~ hp"', '  x: "hp"', '  y: "mpg"']
      .join(
        "\n",
      ),
    SLOTS,
  );
  assertEquals(slot(validateFill(TMPL, fill, COLS), "formula").ok, false);
});

// --- the bug fix: unknown / inapplicable contracts no longer pass silently ---
Deno.test("validateFill: an UNKNOWN contract fails loudly (was the silent-pass bug)", () => {
  const slots = [
    "    data: { type: dataset }",
    "    formula: { type: formula, of: data, contract: bogus_contract }",
    "    x: { type: column, of: data }",
    "    y: { type: column, of: data }",
  ].join("\n");
  const r = validateFill(doc(PARAMS_EMPTY, slots), doc(PARAMS_OK, slots), COLS);
  const s = slot(r, "formula");
  assertEquals(s.ok, false);
  assertEquals(s.reason.includes("unknown contract"), true);
});

Deno.test("validateFill: a contract on the wrong slot type fails", () => {
  const slots = [
    "    data: { type: dataset }",
    "    x: { type: column, of: data, contract: quadratic_through_origin }",
  ].join("\n");
  const params = ['  data: "mtcars"', '  x: "hp"'].join("\n");
  const r = validateFill(doc(params, slots), doc(params, slots), COLS);
  const s = slot(r, "x");
  assertEquals(s.ok, false);
  assertEquals(s.reason.includes("does not apply"), true);
});

// --- the bug fix is fill-INDEPENDENT: an unknown contract is diagnosed even when
//     the slot is also unfilled / structurally invalid (closes the H1 gap) ---
Deno.test("validateFill: an UNKNOWN contract is diagnosed even on an UNFILLED slot", () => {
  const slots = [
    "    data: { type: dataset }",
    "    formula: { type: formula, of: data, contract: bogus_contract }",
    "    x: { type: column, of: data }",
    "    y: { type: column, of: data }",
  ].join("\n");
  // fill == template → the formula slot is EMPTY *and* names a bogus contract.
  const tmpl = doc(PARAMS_EMPTY, slots);
  const s = slot(validateFill(tmpl, tmpl, COLS), "formula");
  assertEquals(s.ok, false);
  assertEquals(s.reason.includes("unknown contract"), true);
});

// --- registry meta-gate: a contract that does not discriminate cannot ship -----
Deno.test("registry meta-gate: every shipped contract ACCEPTS its pass fixture and REJECTS its fail fixture", () => {
  for (const [name, c] of Object.entries(CONTRACTS)) {
    const pass = c.check(c.fixtures.pass.value, {
      columns: c.fixtures.pass.columns ?? [],
      params: c.fixtures.pass.params ?? {},
    });
    assertEquals(pass.ok, true, `${name}: pass fixture must PASS`);
    const fail = c.check(c.fixtures.fail.value, {
      columns: c.fixtures.fail.columns ?? [],
      params: c.fixtures.fail.params ?? {},
    });
    assertEquals(fail.ok, false, `${name}: fail fixture must FAIL`);
  }
});

Deno.test("registry meta-gate: assertContractsDiscriminate passes for the shipped registry", () => {
  assertContractsDiscriminate(); // would throw if any shipped contract were toothless
});

Deno.test("registry meta-gate: a non-discriminating contract throws (the load-time fail-closed guard)", () => {
  const toothless: Record<string, Contract> = {
    accepts_everything: {
      appliesTo: ["formula"],
      check: () => ({ ok: true, reason: "" }),
      fixtures: {
        pass: { value: "anything" },
        fail: { value: "also anything" },
      },
    },
  };
  assertThrows(
    () => assertContractsDiscriminate(toothless),
    Error,
    "does not discriminate",
  );
});

// --- author round-trip --------------------------------------------------------
const AUTHOR_BODY = [
  "```{r}",
  "mod <- lm(as.formula(params$formula), data = get(params$data))",
  "d <- get(params$data)",
  "d[[params$x]]; d[[params$y]]",
  "```",
].join("\n");

function authorInput(over: Partial<AuthorInput> = {}): AuthorInput {
  return {
    title: "lm",
    templateId: "lm@1",
    body: AUTHOR_BODY,
    columns: ["mpg", "hp"],
    slots: [
      { name: "data", type: "dataset", desc: "the data", sample: "mtcars" },
      {
        name: "formula",
        type: "formula",
        of: "data",
        contract: "quadratic_through_origin",
        desc: "model",
        sample: "mpg ~ I(hp^2) - 1",
        antisample: "mpg ~ hp",
      },
      {
        name: "x",
        type: "column",
        of: "data",
        sample: "hp",
        antisample: "nope",
      },
      {
        name: "y",
        type: "column",
        of: "data",
        sample: "mpg",
        antisample: "nope",
      },
    ],
    ...over,
  };
}

Deno.test("authorRoundTrip: a well-formed intent passes and yields a template", () => {
  const v = authorRoundTrip(authorInput());
  assertEquals(v.valid, true, v.reasons.join("; "));
  assertEquals(v.templateText.includes("template: lm@1"), true);
  assertEquals(v.templateText.includes("mod <- lm("), true);
  // the authoring-only fields never leak into the emitted .qmd
  assertEquals(v.templateText.includes("antisample"), false);
  assertEquals(v.templateText.includes("sample"), false);
});

Deno.test("authorRoundTrip: a CONTRACT slot without an antisample is rejected", () => {
  const inp = authorInput();
  inp.slots = inp.slots.map((s) =>
    s.name === "formula" ? { ...s, antisample: undefined } : s
  );
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, false);
  assertEquals(
    v.reasons.some((r) => r.includes("must declare an antisample")),
    true,
  );
});

Deno.test("authorRoundTrip: an antisample that is NOT rejected fails (no teeth)", () => {
  const inp = authorInput();
  // a quadratic-through-origin formula PASSES the contract → not a real antisample
  inp.slots = inp.slots.map((s) =>
    s.name === "formula" ? { ...s, antisample: "mpg ~ I(hp^2) - 1" } : s
  );
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, false);
  assertEquals(v.reasons.some((r) => r.includes("no teeth")), true);
});

Deno.test("authorRoundTrip: a body referencing an undeclared param is rejected", () => {
  const v = authorRoundTrip(
    authorInput({ body: `${AUTHOR_BODY}\nz <- params$zzz` }),
  );
  assertEquals(v.valid, false);
  assertEquals(v.reasons.some((r) => r.includes("undeclared param")), true);
});

Deno.test("authorRoundTrip: a declared slot never used in the body is rejected", () => {
  const inp = authorInput();
  inp.slots = [...inp.slots, {
    name: "extra",
    type: "column",
    of: "data",
    sample: "hp",
  }];
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, false);
  assertEquals(
    v.reasons.some((r) => r.includes("never used in the body")),
    true,
  );
});

Deno.test("authorRoundTrip: a sample that does not satisfy its own slot is rejected", () => {
  const inp = authorInput();
  inp.slots = inp.slots.map((s) =>
    s.name === "x" ? { ...s, sample: "nope" } : s
  );
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, false);
  assertEquals(
    v.reasons.some((r) => r.includes("does not satisfy")),
    true,
  );
});

Deno.test("authorRoundTrip: B1 — a contract antisample the CONTRACT accepts (but a structural check would reject) is NOT teeth", () => {
  const inp = authorInput();
  // A quadratic-through-origin formula in an UNDECLARED column: the column-var check
  // would reject it, but quadratic_through_origin ACCEPTS it → it is NOT a real
  // antisample for the contract, and must be flagged.
  inp.slots = inp.slots.map((s) =>
    s.name === "formula" ? { ...s, antisample: "zzz ~ I(zzz^2) - 1" } : s
  );
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, false);
  assertEquals(
    v.reasons.some((r) => r.includes("rejected by contract")),
    true,
  );
});

Deno.test("authorRoundTrip: H1 — duplicate slot names are rejected", () => {
  const inp = authorInput();
  inp.slots = [...inp.slots, {
    name: "x",
    type: "column",
    of: "data",
    sample: "mpg",
  }];
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, false);
  assertEquals(v.reasons.some((r) => r.includes("duplicate slot name")), true);
});

Deno.test("authorRoundTrip: H2 — bracket-style params[['x']] refs count and comment mentions do not", () => {
  const body = [
    "```{r}",
    "mod <- lm(as.formula(params[['formula']]), data = get(params[['data']]))",
    'd <- get(params[["data"]]); d[[params[["x"]]]]; d[[params[["y"]]]]',
    "# a comment mentioning params$ghost must NOT count as a reference",
    "```",
  ].join("\n");
  const v = authorRoundTrip(authorInput({ body }));
  assertEquals(v.valid, true, v.reasons.join("; "));
});

Deno.test("authorRoundTrip: M2 — an antisample equal to the sample is rejected", () => {
  const inp = authorInput();
  inp.slots = inp.slots.map((s) =>
    s.name === "x" ? { ...s, antisample: s.sample } : s
  );
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, false);
  assertEquals(
    v.reasons.some((r) => r.includes("antisample must differ from sample")),
    true,
  );
});

// --- M1: a parameterized contract reads the NAMED param, not a hardcoded `x` ---
Deno.test("validateFill: M1 — quadratic_through_origin(dose) reads the 'dose' param", () => {
  const slots = [
    "    data: { type: dataset }",
    "    fit: { type: formula, of: data, contract: 'quadratic_through_origin(dose)' }",
    "    dose: { type: column, of: data }",
  ].join("\n");
  const params = [
    '  data: "df"',
    '  fit: "resp ~ I(dose^2) - 1"',
    '  dose: "dose"',
  ].join("\n");
  const r = validateFill(doc(params, slots), doc(params, slots), [
    "resp",
    "dose",
  ]);
  // the contract reads params.dose and confirms I(dose^2) specifically → passes
  assertEquals(slot(r, "fit").ok, true);
});

// --- L3: a `+ 0.5` / `- 1.5` coefficient is NOT mistaken for intercept removal ---
Deno.test("quadratic_through_origin: a `+ 0.5` coefficient is not 'through origin'", () => {
  const c = CONTRACTS.quadratic_through_origin;
  const ctx = { columns: [], params: { x: "x" } };
  assertEquals(c.check("y ~ I(x^2) + 0.5", ctx).ok, false);
  assertEquals(c.check("y ~ I(x^2) - 1.5", ctx).ok, false);
  // a genuine through-origin term still passes
  assertEquals(c.check("y ~ I(x^2) - 1", ctx).ok, true);
  assertEquals(c.check("y ~ I(x^2) + 0", ctx).ok, true);
});

// --- dataset resolvability gate: a filled INSTANCE must pin its data with a path
//     that resolves from ANY working directory (else the .qmd silently breaks when
//     opened from a different cwd — "working-directory hell"). The check is
//     disk-bound, so it lives in the `validate` METHOD, NOT in the pure
//     `validateFill` core (which `author`'s in-memory round-trip shares). ---------
const okDataset = async (
  p: string,
  deps?: Parameters<typeof checkDataset>[1],
) => (await checkDataset(p, deps)).ok;
// a stat stub that "finds" any path, to isolate the absolute/relative branch
const STAT_FOUND = { stat: () => Promise.resolve({}) };
const STAT_MISSING = { stat: () => Promise.reject(new Error("ENOENT")) };

Deno.test("checkDataset: a RELATIVE path is rejected (must be absolute)", async () => {
  const r = await checkDataset("examples/bca/abs.csv", STAT_FOUND);
  assertEquals(r.ok, false);
  assertEquals(r.reason.includes("absolute"), true);
});

Deno.test("checkDataset: ./ and ../ cwd-relative paths are rejected", async () => {
  assertEquals(await okDataset("./x.csv", STAT_FOUND), false);
  assertEquals(await okDataset("../data/x.csv", STAT_FOUND), false);
});

Deno.test("checkDataset: an ABSOLUTE, EXISTING path passes", async () => {
  assertEquals(await okDataset("/data/x.csv", STAT_FOUND), true);
});

Deno.test("checkDataset: an ABSOLUTE, MISSING path is rejected with a clear reason", async () => {
  const r = await checkDataset("/data/nope.csv", STAT_MISSING);
  assertEquals(r.ok, false);
  assertEquals(r.reason.includes("does not exist"), true);
});

Deno.test("checkDataset: a ~ home-anchored path is accepted (home-relative is cwd-INDEPENDENT) when it exists", async () => {
  assertEquals(
    await okDataset("~/lab/x.csv", {
      home: "/Users/v",
      stat: () => Promise.resolve({}),
    }),
    true,
  );
});

Deno.test("checkDataset: a ~ path is rejected when HOME cannot be resolved", async () => {
  const r = await checkDataset("~/lab/x.csv", {
    home: "",
    stat: () => Promise.resolve({}),
  });
  assertEquals(r.ok, false);
  assertEquals(r.reason.includes("HOME"), true);
});

// companion integration test: defends the DEFAULT wiring (real Deno.stat + the
// real absolute-path rule), since the stub tests above bypass the filesystem.
Deno.test("checkDataset: real filesystem — a temp file passes, a missing sibling and a relative path fail", async () => {
  const f = await Deno.makeTempFile(); // an absolute path to a real file
  try {
    assertEquals((await checkDataset(f)).ok, true);
    assertEquals((await checkDataset(`${f}.nope`)).ok, false);
    assertEquals((await checkDataset("relative.csv")).ok, false);
  } finally {
    await Deno.remove(f);
  }
});

// --- the SEAM invariant: the FS check did NOT leak into the pure core. A relative
//     dataset path still passes validateFill structurally (so author's in-memory
//     round-trip, which uses placeholder paths, is unaffected). ------------------
Deno.test("validateFill stays PURE: a relative/bare dataset value passes the structural core (FS gate is method-only)", () => {
  const r = validateFill(TMPL, FILL_OK, COLS); // data: "mtcars" — a bare, non-absolute name
  assertEquals(slot(r, "data").ok, true);
});

// --- a scheme URL is cwd-INDEPENDENT and not a local path: accepted, no stat ---
Deno.test("checkDataset: an http(s)/s3 URL is accepted (cwd-independent; not stat-able)", async () => {
  assertEquals(
    (await checkDataset("https://host/d.csv", STAT_MISSING)).ok,
    true,
  );
  assertEquals(
    (await checkDataset("s3://bucket/key.csv", STAT_MISSING)).ok,
    true,
  );
  assertEquals(
    (await checkDataset("file:///abs/d.csv", STAT_MISSING)).ok,
    true,
  );
});

// --- a dataset is a single readable file: an existing DIRECTORY is rejected ------
Deno.test("checkDataset: an absolute existing DIRECTORY is rejected (a dataset is a file, not a dir)", async () => {
  const d = await Deno.makeTempDir();
  try {
    const r = await checkDataset(d);
    assertEquals(r.ok, false);
    assertEquals(r.reason.includes("directory"), true);
  } finally {
    await Deno.remove(d, { recursive: true });
  }
});

// --- the `~` expansion JOIN is asserted (the stub captures the resolved path) ----
Deno.test("checkDataset: the ~ expansion joins home + remainder (and strips a trailing home slash)", async () => {
  let seen = "";
  const stat = (p: string) => {
    seen = p;
    return Promise.resolve({});
  };
  await checkDataset("~/lab/x.csv", { home: "/Users/v/", stat });
  assertEquals(seen, "/Users/v/lab/x.csv");
});

// --- the validate METHOD wiring (the actual change), driven end-to-end. This is the
//     guard that would have caught the dataset-overload BLOCKER: an object-name
//     dataset (get(params$data) → "cars") must NOT be path-checked. -------------
async function runValidate(
  templateText: string,
  fillText: string,
  columns = "",
) {
  const dir = await Deno.makeTempDir();
  const tp = `${dir}/t.qmd`, fp = `${dir}/f.qmd`;
  await Deno.writeTextFile(tp, templateText);
  await Deno.writeTextFile(fp, fillText);
  let verdict:
    | {
      valid: boolean;
      frozen: boolean;
      slots: Array<
        {
          name: string;
          type: string;
          ok: boolean;
          reason: string;
          source?: string;
        }
      >;
    }
    | undefined;
  const context = {
    writeResource: (_s: string, _i: string, data: unknown) => {
      verdict = data as typeof verdict;
      return Promise.resolve({ version: 1 });
    },
    logger: { info: () => {} },
  };
  try {
    await model.methods.validate.execute(
      { templatePath: tp, filledPath: fp, columns, strict: false },
      context,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  return verdict!;
}
const dslot = (v: Awaited<ReturnType<typeof runValidate>>) =>
  v.slots.find((s) => s.name === "data")!;

Deno.test("validate METHOD: an OBJECT-name dataset fill (no source:path) stays VALID — the FS gate must not touch get() datasets", async () => {
  const ps = "    data: { type: dataset }"; // default source = object
  const v = await runValidate(doc('  data: ""', ps), doc('  data: "cars"', ps));
  assertEquals(v.valid, true);
  assertEquals(dslot(v).ok, true);
});

Deno.test("validate METHOD: a source:path dataset with a RELATIVE path is INVALID at the gate", async () => {
  const ps = "    data: { type: dataset, source: path }";
  const v = await runValidate(
    doc('  data: ""', ps),
    doc('  data: "rel/x.csv"', ps),
  );
  assertEquals(v.valid, false);
  assertEquals(dslot(v).ok, false);
  assertEquals(dslot(v).reason.includes("absolute"), true);
});

Deno.test("validate METHOD: a source:path dataset with an ABSOLUTE EXISTING path is VALID", async () => {
  const ps = "    data: { type: dataset, source: path }";
  const f = await Deno.makeTempFile();
  try {
    const v = await runValidate(
      doc('  data: ""', ps),
      doc(`  data: "${f}"`, ps),
    );
    assertEquals(v.valid, true);
    assertEquals(dslot(v).ok, true);
  } finally {
    await Deno.remove(f);
  }
});

Deno.test("validate METHOD: an EMPTY source:path dataset keeps 'slot not filled' (the && s.ok guard is not clobbered by the path reason)", async () => {
  const ps = "    data: { type: dataset, source: path }";
  const v = await runValidate(doc('  data: ""', ps), doc('  data: ""', ps));
  assertEquals(dslot(v).ok, false);
  assertEquals(dslot(v).reason, "slot not filled");
});

// --- author EMITS `source: path` so the factory can produce path-gated templates
//     (the seam that lets a factory-authored file-input template carry the gate) ---
Deno.test("authorRoundTrip: a dataset slot with source:path emits `source: path` into the template", () => {
  const inp = authorInput();
  inp.slots = inp.slots.map((s) =>
    s.name === "data"
      ? { ...s, source: "path" as const, sample: "/abs/data.csv" }
      : s
  );
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, true, v.reasons.join("; "));
  assertEquals(v.templateText.includes("source: path"), true);
});

Deno.test("authorRoundTrip: `source` on a NON-dataset slot is rejected (it describes how a dataset is consumed)", () => {
  const inp = authorInput();
  inp.slots = inp.slots.map((s) =>
    s.name === "x" ? { ...s, source: "path" as const } : s
  );
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, false);
  assertEquals(v.reasons.some((r) => r.includes("source")), true);
});

// a dataset WITHOUT source must NOT emit a source line (default stays object) ------
Deno.test("authorRoundTrip: a dataset slot without source emits no `source:` line (default object)", () => {
  const v = authorRoundTrip(authorInput());
  assertEquals(v.valid, true, v.reasons.join("; "));
  assertEquals(v.templateText.includes("source:"), false);
});

// === the constants-accounting gate ===========================================
// --- the enumerator: find decision literals in a frozen body, exclude structural ones
Deno.test("enumerateConstants: finds `skip = 2`, excludes [] indices, ^ exponents, string/comment digits, 0/1, identifier-glued", () => {
  const body = [
    "g <- read.csv(path, skip = 2)",
    'x <- sub("^\\\\s*([0-9.]+).*$", "\\\\1", label)   # 0 and 9 in a string + a 3 in a comment',
    "slope <- co[2]; intercept <- co[1]",
    "y <- I(x^2)",
    "n0 <- 0; n1 <- 1; p <- paste0(a, b)",
  ].join("\n");
  assertEquals(enumerateConstants(body).map((l) => l.value), ["2"]);
});

Deno.test("enumerateConstants: a bare threshold in a comparison IS flagged", () => {
  assertEquals(
    enumerateConstants("if (p < 0.05) reject()").map((l) => l.value),
    ["0.05"],
  );
});

Deno.test("enumerateConstants: a poly() degree is NOT auto-excluded (honest heuristic limit — declare or slot it)", () => {
  assertEquals(
    enumerateConstants("m <- lm(y ~ poly(x, 3))").map((l) => l.value),
    ["3"],
  );
});

Deno.test("enumerateConstants: scientific notation is a single literal", () => {
  assertEquals(
    enumerateConstants("tol <- 1e-5; big <- 2.5e10").map((l) => l.value),
    [
      "1e-5",
      "2.5e10",
    ],
  );
});

// --- slot defaults + the scalar type (in the pure validateFill core) ----------
Deno.test("validateFill: an OPTIONAL scalar slot (has a default) passes when the fill leaves it empty", () => {
  const slots = "    n: { type: scalar, default: '2' }";
  const r = validateFill(doc('  n: ""', slots), doc('  n: ""', slots), []);
  assertEquals(slot(r, "n").ok, true);
  assertEquals(slot(r, "n").value, "2"); // effective value = the default
});

Deno.test("validateFill: a scalar slot with NO default still requires a value", () => {
  const slots = "    n: { type: scalar }";
  const r = validateFill(doc('  n: ""', slots), doc('  n: ""', slots), []);
  assertEquals(slot(r, "n").ok, false);
  assertEquals(slot(r, "n").reason, "slot not filled");
});

Deno.test("validateFill: a filled scalar value overrides the default", () => {
  const slots = "    n: { type: scalar, default: '2' }";
  const r = validateFill(doc('  n: ""', slots), doc('  n: "5"', slots), []);
  assertEquals(slot(r, "n").ok, true);
  assertEquals(slot(r, "n").value, "5");
});

// --- the author gate: every body literal must be slotted, declared, or excluded
function bodyConst(extra: string): string {
  return [
    "```{r}",
    "d <- get(params$data); f <- as.formula(params$formula)",
    "a <- d[[params$x]]; b <- d[[params$y]]",
    extra,
    "```",
  ].join("\n");
}

Deno.test("authorRoundTrip: an unaccounted constant in the body fails the round-trip", () => {
  const v = authorRoundTrip(
    authorInput({ body: bodyConst("g <- head(d, 2)") }),
  );
  assertEquals(v.valid, false);
  assertEquals(
    v.reasons.some((r) => r.includes("unaccounted int constant")),
    true,
  );
});

Deno.test("authorRoundTrip: declaring the constant with a rationale accounts for it and emits swamp.constants", () => {
  const v = authorRoundTrip(authorInput({
    body: bodyConst("g <- head(d, 2)"),
    constants: { preview_rows: { value: "2", why: "show the first two rows" } },
  }));
  assertEquals(v.valid, true, v.reasons.join("; "));
  assertEquals(v.templateText.includes("constants:"), true);
  assertEquals(v.templateText.includes("first two rows"), true);
});

Deno.test("authorRoundTrip: slotting the constant (scalar slot + params$ in body) accounts for it and emits a default", () => {
  const inp = authorInput({
    body: bodyConst("g <- head(d, as.integer(params$nrows))"),
  });
  inp.slots = [...inp.slots, {
    name: "nrows",
    type: "scalar",
    default: "2",
    sample: "2",
    desc: "rows to preview",
  }];
  const v = authorRoundTrip(inp);
  assertEquals(v.valid, true, v.reasons.join("; "));
  assertEquals(
    v.templateText.includes("default: 2") ||
      v.templateText.includes("default: '2'"),
    true,
  );
});

Deno.test("authorRoundTrip: a declared constant whose value is absent from the body is flagged (dangling)", () => {
  const v = authorRoundTrip(authorInput({
    body: bodyConst("g <- head(d, 2)"),
    constants: { ghost: { value: "7", why: "nope" } },
  }));
  assertEquals(v.valid, false);
  assertEquals(v.reasons.some((r) => r.includes("appears nowhere")), true);
});

Deno.test("authorRoundTrip: a declared constant without a rationale is rejected", () => {
  const v = authorRoundTrip(authorInput({
    body: bodyConst("g <- head(d, 2)"),
    constants: { r: { value: "2", why: "" } },
  }));
  assertEquals(v.valid, false);
  assertEquals(
    v.reasons.some((r) => r.toLowerCase().includes("rationale")),
    true,
  );
});

// regression: a body with NO numeric literals (the standard fixtures) is unaffected
Deno.test("authorRoundTrip: a literal-free body needs no constants block and stays valid", () => {
  const v = authorRoundTrip(authorInput());
  assertEquals(v.valid, true, v.reasons.join("; "));
  assertEquals(v.templateText.includes("constants:"), false);
});

// --- review fixes: numeric (not lexical) matching, signs, R integer literals ---
Deno.test("enumerateConstants: an R integer literal `2L` is caught, not silently dropped", () => {
  assertEquals(enumerateConstants("head(d, 2L)").map((l) => l.value), ["2L"]);
});

Deno.test("authorRoundTrip: declaring `2` accounts for a body literal written `2.0` (numeric match, not lexical)", () => {
  const v = authorRoundTrip(authorInput({
    body: bodyConst("g <- head(d, 2.0)"),
    constants: { rows: { value: "2", why: "two rows" } },
  }));
  assertEquals(v.valid, true, v.reasons.join("; "));
});

Deno.test("authorRoundTrip: a negative threshold is reported WITH its sign and declarable as such", () => {
  const bad = authorRoundTrip(
    authorInput({ body: bodyConst("ok <- score > -0.5") }),
  );
  assertEquals(bad.reasons.some((r) => r.includes("-0.5")), true);
  const good = authorRoundTrip(authorInput({
    body: bodyConst("ok <- score > -0.5"),
    constants: { thr: { value: "-0.5", why: "minimum score" } },
  }));
  assertEquals(good.valid, true, good.reasons.join("; "));
});

Deno.test("authorRoundTrip: a repeated unaccounted constant yields exactly ONE reason (dedupe)", () => {
  const v = authorRoundTrip(authorInput({
    body: bodyConst("g <- head(d, 2); h <- tail(d, 2)"),
  }));
  assertEquals(
    v.reasons.filter((r) => r.includes("constant 2")).length,
    1,
  );
});

Deno.test("authorRoundTrip: a dangling declaration on a LITERAL-FREE body fails for exactly that reason", () => {
  const v = authorRoundTrip(authorInput({
    body: bodyConst("g <- nrow(d)"),
    constants: { ghost: { value: "7", why: "nope" } },
  }));
  assertEquals(v.valid, false);
  assertEquals(v.reasons.some((r) => r.includes("appears nowhere")), true);
  assertEquals(v.reasons.some((r) => r.includes("unaccounted")), false); // isolated
});

// --- first-class typed scalar slots: int / double / bool (language-neutral) ----
const tv = (type: string, v: string) =>
  slot(
    validateFill(
      doc('  n: ""', `    n: { type: ${type} }`),
      doc(`  n: "${v}"`, `    n: { type: ${type} }`),
      [],
    ),
    "n",
  ).ok;

Deno.test("validateFill: `int` accepts whole numbers, rejects a real", () => {
  assertEquals(tv("int", "2"), true);
  assertEquals(tv("int", "2.0"), true);
  assertEquals(tv("int", "2L"), true);
  assertEquals(tv("int", "-3"), true);
  assertEquals(tv("int", "2.5"), false); // the as.integer-truncation trap, caught
  assertEquals(tv("int", "two"), false);
});

Deno.test("validateFill: `double` accepts reals, rejects non-numbers", () => {
  assertEquals(tv("double", "2.5"), true);
  assertEquals(tv("double", "0.05"), true);
  assertEquals(tv("double", "1e-3"), true);
  assertEquals(tv("double", "-0.5"), true);
  assertEquals(tv("double", "2"), true);
  assertEquals(tv("double", "two"), false);
  assertEquals(tv("double", "TRUE"), false);
});

Deno.test("validateFill: `bool` accepts the boolean vocabulary, rejects a number/word", () => {
  for (
    const b of ["TRUE", "FALSE", "T", "F", "True", "False", "true", "false"]
  ) {
    assertEquals(tv("bool", b), true, b);
  }
  assertEquals(tv("bool", "2"), false);
  assertEquals(tv("bool", "yes"), false);
});

// --- the enumerator now detects booleans + infers a language-neutral type -------
Deno.test("enumerateConstants: detects boolean literals with type bool; numbers get int/double", () => {
  const r = enumerateConstants(
    "x <- foo(na.rm = TRUE); y <- bar(verbose = False); n <- 3; p <- 0.05",
  );
  assertEquals(r.map((l) => [l.value, l.type]), [
    ["TRUE", "bool"],
    ["False", "bool"],
    ["3", "int"],
    ["0.05", "double"],
  ]);
});

Deno.test("enumerateConstants: a boolean glued into an identifier (isTRUE) is NOT flagged", () => {
  assertEquals(enumerateConstants("if (isTRUE(x) && TRUEFLAG) y").length, 0);
});

// review fix: lowercase true/false are NOT R/Python booleans — must not flag prose
Deno.test("enumerateConstants: lowercase true/false (English prose / undefined vars) are NOT flagged", () => {
  assertEquals(
    enumerateConstants("Beware a false positive when the fit holds true."),
    [],
  );
  assertEquals(enumerateConstants("foo(flag = true)"), []);
  // and member access x$TRUE is not flagged
  assertEquals(enumerateConstants("y <- x$TRUE"), []);
});

// --- Python branch: lexical grammar differs from R --------------------------
Deno.test("enumerateConstants(python): a triple-quoted docstring is a string — digits inside are NOT flagged", () => {
  const body = [
    '"""Compute significance at 0.05 over 3 replicates."""',
    "threshold = 0.01",
  ].join("\n");
  assertEquals(
    enumerateConstants(body, "python").map((l) => l.value),
    ["0.01"],
  );
});

Deno.test("enumerateConstants(python): a `#` inside a triple-quoted string does not start a comment that corrupts stripping", () => {
  const body = "'''note: skip 0.5 # not a comment'''\nx = 7";
  assertEquals(
    enumerateConstants(body, "python").map((l) => l.value),
    ["7"],
  );
});

Deno.test("enumerateConstants(python): an apostrophe inside a triple-quoted docstring does not break quote-pairing and leak a digit", () => {
  // Without real triple-quote stripping, the `'` in `it's` mis-pairs and exposes
  // `(0.05)` as code → a false positive on ordinary docstring prose.
  assertEquals(
    enumerateConstants("'''it's (0.05) significant'''", "python").map((l) =>
      l.value
    ),
    [],
  );
});

Deno.test("enumerateConstants(python): a hex literal is a magic constant, not silently dropped (soundness)", () => {
  assertEquals(
    enumerateConstants("mask = 0xFF", "python").map((l) => [l.value, l.type]),
    [["0xFF", "int"]],
  );
});

Deno.test("enumerateConstants(python): octal and binary literals are flagged", () => {
  assertEquals(
    enumerateConstants("a = 0o17; b = 0b1010", "python").map((l) => l.value),
    ["0o17", "0b1010"],
  );
});

Deno.test("enumerateConstants(python): the `**` exponent is excluded but the base is flagged (parity with R `^`)", () => {
  assertEquals(
    enumerateConstants("y = x ** 2", "python").map((l) => l.value),
    [],
  );
  assertEquals(
    enumerateConstants("y = 2 ** x", "python").map((l) => l.value),
    ["2"],
  );
});

Deno.test("enumerateConstants(python): a bare threshold and True/False are still flagged", () => {
  const r = enumerateConstants("if p < 0.05 and flag is True: n = 3", "python");
  assertEquals(r.map((l) => [l.value, l.type]), [
    ["0.05", "double"],
    ["True", "bool"],
    ["3", "int"],
  ]);
});

Deno.test("enumerateConstants(R): missing/absence sentinels (NA, NULL, NaN, Inf) are NOT decisions — only the bool is flagged", () => {
  const body =
    "x <- NA; y <- NULL; z <- NaN; hi <- Inf; lo <- -Inf; w <- NA_real_; m <- mean(d, na.rm = TRUE)";
  assertEquals(enumerateConstants(body).map((l) => l.value), ["TRUE"]);
});

Deno.test("enumerateConstants(python): None/nan/inf are NOT decisions — only the bool is flagged", () => {
  const body = "x = None\ny = float('nan')\nhi = float('inf')\nflag = True";
  assertEquals(
    enumerateConstants(body, "python").map((l) => l.value),
    ["True"],
  );
});

// --- string-smuggled constants: a number coerced back to a number is a constant,
//     but a numeric-looking LABEL (not coerced) stays a label -------------------
Deno.test('enumerateConstants(R): a constant smuggled through as.numeric("…") is caught', () => {
  assertEquals(
    enumerateConstants('p < as.numeric("0.05")').map((l) => l.value),
    ["0.05"],
  );
  assertEquals(
    enumerateConstants('n <- as.integer("2")').map((l) => l.value),
    ["2"],
  );
});

Deno.test('enumerateConstants(R): a constant smuggled through eval(parse(text="…")) is caught', () => {
  assertEquals(
    enumerateConstants('reject(eval(parse(text="0.05")))').map((l) => l.value),
    ["0.05"],
  );
});

Deno.test("enumerateConstants(python): a constant smuggled through float/int/eval of a string is caught", () => {
  assertEquals(
    enumerateConstants('p < float("0.05")', "python").map((l) => l.value),
    ["0.05"],
  );
  assertEquals(
    enumerateConstants('n = int("2")', "python").map((l) => l.value),
    ["2"],
  );
  assertEquals(
    enumerateConstants('x = eval("3.5")', "python").map((l) => l.value),
    ["3.5"],
  );
});

Deno.test("enumerateConstants: a numeric-looking LABEL that is NOT coerced stays a label (no over-flooding)", () => {
  // factor levels / categorical labels / filenames — must NOT be flagged
  assertEquals(
    enumerateConstants('lv <- c("1", "2", "3")').map((l) => l.value),
    [],
  );
  assertEquals(
    enumerateConstants('m <- "pearson"; f <- read.csv("plate1.csv")').map((l) =>
      l.value
    ),
    [],
  );
  assertEquals(
    enumerateConstants('name = "v2"', "python").map((l) => l.value),
    [],
  );
});

// --- dataset identity fingerprint (#35: seal the data) ----------------------
Deno.test("csvSchema: header tokens + data-row count, quote-stripped, trailing newline ignored", () => {
  assertEquals(csvSchema('well,"A562",conc\nA1,0.1,2\nA2,0.2,4\n'), {
    columns: ["well", "A562", "conc"],
    rows: 2,
  });
  assertEquals(csvSchema(""), { columns: [], rows: 0 });
});

Deno.test("datasetFingerprint: stable sha for same bytes, different for changed bytes", async () => {
  const a = new TextEncoder().encode("well,conc\nA1,2\n");
  const b = new TextEncoder().encode("well,conc\nA1,2\n");
  const c = new TextEncoder().encode("well,conc\nA1,9\n"); // one value changed
  const fa = await datasetFingerprint(a);
  const fb = await datasetFingerprint(b);
  const fc = await datasetFingerprint(c);
  assertEquals(fa.sha256.length, 64);
  assertEquals(fa.sha256, fb.sha256); // deterministic
  assertEquals(fa.sha256 === fc.sha256, false); // a flipped value is caught
  assertEquals(fa.columns, ["well", "conc"]);
  assertEquals(fa.rows, 1);
});

Deno.test("diffDatasetPin: empty when identical; human-readable when drifted", () => {
  const base = { sha256: "a".repeat(64), columns: ["well", "conc"], rows: 8 };
  // identical → no drift
  assertEquals(diffDatasetPin(base, { ...base }), []);
  // same shape, different bytes
  assertEquals(
    diffDatasetPin(base, { ...base, sha256: "b".repeat(64) }),
    ["content changed (same shape; sha256 aaaaaaaa… → bbbbbbbb…)"],
  );
  // a column added + a row-count change
  assertEquals(
    diffDatasetPin(base, {
      sha256: "b".repeat(64),
      columns: ["well", "conc", "flag"],
      rows: 12,
    }),
    ["columns added: flag", "row count 8 → 12", "content changed"],
  );
});

Deno.test("parseDoc: swamp.datapins is instance-level — it does NOT change the frozen repr", () => {
  const base = [
    "---",
    'title: "t"',
    "params:",
    '  d: ""',
    "swamp:",
    "  template: t@1",
    "  slots:",
    "    d: { type: dataset, source: path }",
    "---",
    "",
    "```{r}",
    "x <- read.csv(params$d)",
    "```",
    "",
  ].join("\n");
  const withPins = base.replace(
    "  slots:",
    "  datapins:\n    d: { sha256: abc, columns: [a, b], rows: 8 }\n  slots:",
  );
  // pins ride along but are excluded from the frozen comparison
  assertEquals(parseDoc(base).frozenRepr, parseDoc(withPins).frozenRepr);
  assertEquals(parseDoc(withPins).swamp.datapins?.d.rows, 8);
});

// --- structural shape-rejection: an all-literal string-builder fed to a coercer
//     is laundering; we string-FOLD the fragments (no eval) and surface the value.
//     A variable anywhere in the args means runtime → left alone. -------------
Deno.test("enumerateConstants(R): a constant laundered through paste0 of literals is folded and flagged", () => {
  assertEquals(
    enumerateConstants('x <- as.numeric(paste0("0.", "05"))').map((l) =>
      l.value
    ),
    ["0.05"],
  );
  assertEquals(
    enumerateConstants('x <- as.numeric(str_c("1", "00"))').map((l) => l.value),
    ["100"],
  );
  assertEquals(
    enumerateConstants('x <- as.numeric(paste("0", ".", "05", sep = ""))').map((
      l,
    ) => l.value),
    ["0.05"],
  );
});

Deno.test("enumerateConstants(python): a constant laundered through string `+` of literals is folded and flagged", () => {
  assertEquals(
    enumerateConstants('x = float("0." + "05")', "python").map((l) => l.value),
    ["0.05"],
  );
  assertEquals(
    enumerateConstants('n = int("2" + "5")', "python").map((l) => l.value),
    ["25"],
  );
});

Deno.test("enumerateConstants: a string-builder with a VARIABLE is runtime, not a constant — left alone", () => {
  assertEquals(
    enumerateConstants('x <- as.numeric(paste0(scale, "00"))').map((l) =>
      l.value
    ),
    [],
  );
  assertEquals(
    enumerateConstants('y <- as.numeric(gsub(",", "", user_input))').map((l) =>
      l.value
    ),
    [],
  );
  assertEquals(
    enumerateConstants('z = float(prefix + "05")', "python").map((l) =>
      l.value
    ),
    [],
  );
});

Deno.test("enumerateConstants(R, default): a hex literal stays dropped — radix handling is python-scoped (no R regression)", () => {
  assertEquals(enumerateConstants("mask <- 0xFF").map((l) => l.value), []);
  // and `**` is not R syntax, so the R path is untouched by the exponent rule
  assertEquals(enumerateConstants("y <- x ^ 2").map((l) => l.value), []);
});

// review fix: int/double obey the R/Python decimal grammar, not JS Number()
Deno.test("validateFill: int/double reject JS-only hex/binary/octal that R coerces to NA", () => {
  assertEquals(tv("int", "0b101"), false);
  assertEquals(tv("int", "0o17"), false);
  assertEquals(tv("double", "0x1F"), false);
  assertEquals(tv("double", "0b101"), false);
  // the genuine decimal forms still pass
  assertEquals(tv("int", "2"), true);
  assertEquals(tv("double", "1e-3"), true);
});

// review fix: an unknown slot type FAILS CLOSED (no silent accept-anything)
Deno.test("validateFill: an unrecognized slot type fails closed", () => {
  const r = slot(
    validateFill(
      doc('  n: ""', "    n: { type: bogus }"),
      doc('  n: "whatever"', "    n: { type: bogus }"),
      [],
    ),
    "n",
  );
  assertEquals(r.ok, false);
  assertEquals(r.reason.includes("unknown slot type"), true);
});

Deno.test("canonConst: boolean spellings reconcile (true/True/T → TRUE; F → FALSE)", () => {
  for (const t of ["TRUE", "true", "True", "T"]) {
    assertEquals(canonConst(t), "TRUE", t);
  }
  for (const f of ["FALSE", "false", "False", "F"]) {
    assertEquals(canonConst(f), "FALSE", f);
  }
});

Deno.test("authorRoundTrip: an unaccounted boolean is now caught; slotting/declaring accounts for it", () => {
  const bad = authorRoundTrip(
    authorInput({ body: bodyConst("g <- mean(d, na.rm = TRUE)") }),
  );
  assertEquals(bad.valid, false);
  assertEquals(bad.reasons.some((r) => r.includes("bool constant TRUE")), true);
  const good = authorRoundTrip(authorInput({
    body: bodyConst("g <- mean(d, na.rm = TRUE)"),
    constants: { drop_na: { value: "true", why: "drop NA before the mean" } },
  }));
  assertEquals(good.valid, true, good.reasons.join("; "));
});

// --- the author METHOD path (the actual wiring), driven end-to-end -------------
async function runAuthor(args: Record<string, unknown>) {
  const dir = await Deno.makeTempDir();
  let resource:
    | { written?: boolean; valid?: boolean; reasons?: string[] }
    | undefined;
  const context = {
    writeResource: (_s: string, _i: string, data: unknown) => {
      resource = data as typeof resource;
      return Promise.resolve({ version: 1 });
    },
    logger: { info: () => {}, warning: () => {} },
  };
  let threw = false;
  type AuthorExec = typeof model.methods.author.execute;
  try {
    await model.methods.author.execute(
      {
        title: "",
        domain: "",
        returns: {},
        columns: "",
        constants: {},
        strict: false,
        outPath: `${dir}/out.qmd`,
        ...args,
      } as Parameters<AuthorExec>[0],
      context as Parameters<AuthorExec>[1],
    );
  } catch {
    threw = true;
  }
  let onDisk = "";
  try {
    onDisk = await Deno.readTextFile(`${dir}/out.qmd`);
  } catch { /* not written */ }
  await Deno.remove(dir, { recursive: true });
  return { resource, onDisk, threw };
}

const METHOD_BODY = [
  "```{r}",
  "d <- get(params$data); a <- d[[params$x]]",
  "g <- head(d, 2)",
  "```",
].join("\n");
const METHOD_SLOTS = [
  { name: "data", type: "dataset", sample: "mtcars" },
  { name: "x", type: "column", of: "data", sample: "hp" },
];

Deno.test("author METHOD: an unaccounted constant under strict:true throws and writes NO file", async () => {
  const r = await runAuthor({
    templateId: "m-a@1",
    body: METHOD_BODY,
    slots: METHOD_SLOTS,
    columns: "hp,mpg",
    strict: true,
  });
  assertEquals(r.threw, true);
  assertEquals(r.onDisk, ""); // nothing written on a failed round-trip
});

Deno.test("author METHOD: declaring the constant writes the .qmd with the swamp.constants block", async () => {
  const r = await runAuthor({
    templateId: "m-b@1",
    body: METHOD_BODY,
    slots: METHOD_SLOTS,
    columns: "hp,mpg",
    constants: { preview: { value: "2", why: "preview two rows" } },
  });
  assertEquals(r.resource?.written, true);
  assertEquals(r.onDisk.includes("constants:"), true);
  assertEquals(r.onDisk.includes("preview two rows"), true);
});

Deno.test("author args schema: a constant with an empty `why` is rejected at the Zod boundary", () => {
  const parsed = model.methods.author.arguments.safeParse({
    templateId: "s@1",
    outPath: "/tmp/x.qmd",
    body: "x",
    slots: [{ name: "a", type: "scalar", sample: "1" }],
    constants: { c: { value: "2", why: "" } },
  });
  assertEquals(parsed.success, false);
});

// --- document model: serializeDoc / parseDoc (qmd + ipynb) -------------------
const DOC_CELLS: Cell[] = [
  { type: "code", source: "fit <- lm(net ~ x, data = d)", label: "analysis" },
];
const DOC_SWAMP = {
  template: "demo@1",
  slots: { d: { type: "dataset" } },
};

Deno.test("serializeDoc qmd: frontmatter + fenced labelled chunk", () => {
  const out = serializeDoc({
    format: "qmd",
    language: "r",
    title: "Demo",
    params: { d: "" },
    swamp: DOC_SWAMP,
    cells: DOC_CELLS,
  });
  // a real Quarto chunk, not inert text
  if (!out.includes("```{r}")) throw new Error("missing ```{r} fence");
  if (!out.includes("#| label: analysis")) throw new Error("missing label");
  if (!out.includes("fit <- lm(net ~ x, data = d)")) {
    throw new Error("missing code");
  }
  // frontmatter carries params + swamp
  if (!out.startsWith("---\n")) throw new Error("missing frontmatter");
  if (!out.includes("template: demo@1")) throw new Error("missing swamp block");
});

Deno.test("serializeDoc ipynb: valid nbformat-4 with params cell + swamp metadata", () => {
  const out = serializeDoc({
    format: "ipynb",
    language: "python",
    title: "Demo",
    params: { d: "mtcars", n: "500" },
    swamp: DOC_SWAMP,
    cells: [{ type: "code", language: "python", source: "import pandas" }],
  });
  const nb = JSON.parse(out);
  assertEquals(nb.nbformat, 4);
  assertEquals(nb.metadata.kernelspec.language, "python");
  assertEquals(nb.metadata.swamp.template, "demo@1");
  // first cell is the papermill parameters cell
  assertEquals(nb.cells[0].metadata.tags, ["parameters"]);
  const psrc = nb.cells[0].source.join("");
  if (!psrc.includes('d = "mtcars"')) {
    throw new Error("param d not assigned: " + psrc);
  }
  if (!psrc.includes('n = "500"')) throw new Error("param n not assigned");
});

Deno.test("parseDoc qmd: recovers params, swamp, code", () => {
  const out = serializeDoc({
    format: "qmd",
    language: "r",
    title: "T",
    params: { d: "mtcars" },
    swamp: DOC_SWAMP,
    cells: DOC_CELLS,
  });
  const p = parseDoc(out);
  assertEquals(p.format, "qmd");
  assertEquals(p.params.d, "mtcars");
  assertEquals(p.swamp.template, "demo@1");
  if (!p.code.includes("fit <- lm(net ~ x, data = d)")) {
    throw new Error("code not extracted: " + p.code);
  }
});

Deno.test("parseDoc ipynb: recovers params from parameters cell, swamp, code", () => {
  const out = serializeDoc({
    format: "ipynb",
    language: "python",
    title: "T",
    params: { d: "mtcars", n: "500" },
    swamp: DOC_SWAMP,
    cells: [{ type: "code", language: "python", source: "x = d" }],
  });
  const p = parseDoc(out);
  assertEquals(p.format, "ipynb");
  assertEquals(p.params.d, "mtcars");
  assertEquals(p.params.n, "500");
  assertEquals(p.swamp.template, "demo@1");
  if (!p.code.includes("x = d")) {
    throw new Error("code not extracted: " + p.code);
  }
});

Deno.test("frozenRepr is params-independent but code-sensitive (both formats)", () => {
  for (const format of ["qmd", "ipynb"] as const) {
    const lang = format === "ipynb" ? "python" : "r";
    const mk = (params: Record<string, string>, code: string) =>
      parseDoc(
        serializeDoc({
          format,
          language: lang,
          title: "T",
          params,
          swamp: DOC_SWAMP,
          cells: [{ type: "code", language: lang, source: code }],
        }),
      ).frozenRepr;
    const base = mk({ d: "" }, "x = d");
    // different PARAMS -> same frozen repr (the frozen invariant)
    assertEquals(mk({ d: "mtcars" }, "x = d"), base);
    // different CODE -> different frozen repr
    if (mk({ d: "" }, "x = d + 1") === base) {
      throw new Error(`${format}: code change not reflected in frozenRepr`);
    }
  }
});

// --- author via STRUCTURED cells (writer owns the layout) ---------------------
Deno.test("authorRoundTrip cells->qmd: emits a real ```{r} chunk and validates", () => {
  const v = authorRoundTrip({
    title: "Demo",
    templateId: "cells-r@1",
    cells: [{
      type: "code",
      source: "d <- read.csv(params$data)\nhead(d)",
      label: "load",
    }],
    slots: [{
      name: "data",
      type: "dataset",
      source: "path",
      sample: "examples/x.csv",
    }],
    columns: [],
  });
  assertEquals(v.valid, true);
  if (!v.templateText.includes("```{r}")) throw new Error("no ```{r} fence");
  if (!v.templateText.includes("#| label: load")) throw new Error("no label");
  if (!v.templateText.includes("template: cells-r@1")) {
    throw new Error("no swamp block");
  }
});

Deno.test("authorRoundTrip cells->ipynb (python): emits nbformat-4 and validates", () => {
  const v = authorRoundTrip({
    title: "Demo",
    templateId: "cells-py@1",
    format: "ipynb",
    language: "python",
    cells: [{
      type: "code",
      language: "python",
      source: "import pandas as pd\nd = pd.read_csv(data)\nd.head()",
    }],
    slots: [{
      name: "data",
      type: "dataset",
      source: "path",
      sample: "examples/x.csv",
    }],
    columns: [],
  });
  assertEquals(v.valid, true);
  const nb = JSON.parse(v.templateText);
  assertEquals(nb.nbformat, 4);
  assertEquals(nb.metadata.kernelspec.language, "python");
});

Deno.test("authorRoundTrip cells (python): the constants gate runs on python code", () => {
  const intent = (
    constants: Record<string, { value: string; why: string }>,
  ) => ({
    title: "T",
    templateId: "py-const@1",
    format: "ipynb" as const,
    language: "python" as const,
    cells: [{
      type: "code" as const,
      language: "python" as const,
      source: "x = threshold * 2",
    }],
    slots: [{
      name: "threshold",
      type: "double",
      sample: "0.5",
      antisample: "abc",
    }],
    columns: [],
    constants,
  });
  const bad = authorRoundTrip(intent({}));
  assertEquals(bad.valid, false);
  if (!bad.reasons.some((r) => r.includes("unaccounted") && r.includes("2"))) {
    throw new Error(
      "magic 2 not caught in python: " + JSON.stringify(bad.reasons),
    );
  }
  const good = authorRoundTrip(
    intent({ two: { value: "2", why: "doubling factor" } }),
  );
  assertEquals(good.valid, true);
});

Deno.test("authorRoundTrip cells: a declared slot never used in the body is caught (python bare-name)", () => {
  const v = authorRoundTrip({
    title: "T",
    templateId: "py-unused@1",
    format: "ipynb",
    language: "python",
    cells: [{ type: "code", language: "python", source: "d = read(data)" }],
    slots: [
      { name: "data", type: "dataset", source: "path", sample: "x.csv" },
      { name: "unused", type: "dataset", source: "path", sample: "y.csv" },
    ],
    columns: [],
  });
  assertEquals(v.valid, false);
  if (
    !v.reasons.some((r) => r.includes("never used") && r.includes("unused"))
  ) {
    throw new Error("unused slot not caught: " + JSON.stringify(v.reasons));
  }
});

// --- robustness: malformed ipynb + direct validateFill on ipynb --------------
Deno.test("parseDoc: a malformed .ipynb throws a descriptive error (not a raw crash)", () => {
  assertThrows(
    () => parseDoc('{ "cells": [ bad json '),
    Error,
    "malformed .ipynb",
  );
});

Deno.test("validateFill ipynb: correct fill frozen + slot ok; tampered code breaks frozen", () => {
  const swamp = { template: "nb@1", slots: { data: { type: "dataset" } } };
  const cells: Cell[] = [{
    type: "code",
    language: "python",
    source: "d = read(data)",
  }];
  const mk = (params: Record<string, string>, src = "d = read(data)") =>
    serializeDoc({
      format: "ipynb",
      language: "python",
      title: "T",
      params,
      swamp,
      cells: [{ type: "code", language: "python", source: src }],
    });
  const tmpl = mk({ data: "" });
  const r = validateFill(tmpl, mk({ data: "mtcars" }), []);
  assertEquals(r.frozenBody, true);
  assertEquals(r.template, "nb@1");
  assertEquals(r.slots.find((s) => s.name === "data")!.ok, true);
  assertEquals(
    validateFill(tmpl, mk({ data: "mtcars" }, "d = read(data) + 1"), [])
      .frozenBody,
    false,
  );
});

// --- F1/F2 hardening ---------------------------------------------------------
Deno.test("F1: an ipynb param value with an embedded quote round-trips exactly", () => {
  const swamp = { template: "q@1", slots: { label: { type: "string" } } };
  const v = 'a "quoted" b\twith escapes';
  const doc = serializeDoc({
    format: "ipynb",
    language: "python",
    title: "T",
    params: { label: v },
    swamp,
    cells: [{ type: "code", language: "python", source: "x = label" }],
  });
  assertEquals(parseDoc(doc).params.label, v);
});

Deno.test("F2: a python slot used ONLY inside a string literal is flagged unused", () => {
  const v = authorRoundTrip({
    title: "T",
    templateId: "pystr@1",
    format: "ipynb",
    language: "python",
    cells: [{
      type: "code",
      language: "python",
      source: 'print("data is here")\nx = other',
    }],
    slots: [
      { name: "data", type: "dataset", source: "path", sample: "x.csv" },
      { name: "other", type: "dataset", source: "path", sample: "y.csv" },
    ],
    columns: [],
  });
  assertEquals(v.valid, false);
  if (!v.reasons.some((r) => r.includes("never used") && r.includes("data"))) {
    throw new Error(
      "string-only slot not flagged: " + JSON.stringify(v.reasons),
    );
  }
  if (v.reasons.some((r) => r.includes("never used") && r.includes("other"))) {
    throw new Error("bare-name 'other' wrongly flagged unused");
  }
});

// --- unit annotation + typed-param coercion preamble (30b) -------------------
Deno.test("slot `unit` annotation flows into swamp.slots", () => {
  const v = authorRoundTrip({
    title: "T",
    templateId: "unit@1",
    cells: [{ type: "code", source: "result <- params$conc" }],
    slots: [{
      name: "conc",
      type: "double",
      unit: "pg/mL",
      sample: "1.5",
      antisample: "abc",
    }],
    columns: [],
  });
  assertEquals(v.valid, true);
  const p = parseDoc(v.templateText);
  assertEquals(
    (p.swamp.slots as Record<string, { unit?: string }>).conc.unit,
    "pg/mL",
  );
});

Deno.test("coercion: qmd binds a hidden bare as.integer var (params is locked in knitr)", () => {
  const out = serializeDoc({
    format: "qmd",
    language: "r",
    title: "T",
    params: { n: "" },
    swamp: { template: "t@1", slots: { n: { type: "int" } } },
    cells: [{ type: "code", source: "head(d, n)" }],
  });
  // bare var bound from params (NOT an in-place params$n <- ..., which knitr locks)
  if (!out.includes("n <- as.integer(params$n)")) {
    throw new Error("no bare coercion binding: " + out);
  }
  if (out.includes("params$n <- ")) {
    throw new Error("must not reassign locked params");
  }
  if (!out.includes("#| include: false")) throw new Error("setup not hidden");
});

Deno.test("coercion: ipynb python emits int() coercion after the parameters cell", () => {
  const out = serializeDoc({
    format: "ipynb",
    language: "python",
    title: "T",
    params: { n: "" },
    swamp: { template: "t@1", slots: { n: { type: "int" } } },
    cells: [{ type: "code", language: "python", source: "df.head(n)" }],
  });
  const nb = JSON.parse(out);
  assertEquals(nb.cells[0].metadata.tags, ["parameters"]);
  if (!nb.cells[1].source.join("").includes("n = int(n)")) {
    throw new Error("no python coercion: " + nb.cells[1].source.join(""));
  }
});

Deno.test("coercion: setup is frozen (template==fill) and leaves non-typed slots alone", () => {
  const swamp = {
    template: "t@1",
    slots: { n: { type: "int" }, d: { type: "dataset" } },
  };
  const cells: Cell[] = [{
    type: "code",
    source: "read.csv(params$d); params$n",
  }];
  const mk = (params: Record<string, string>) =>
    serializeDoc({
      format: "qmd",
      language: "r",
      title: "T",
      params,
      swamp,
      cells,
    });
  assertEquals(
    validateFill(mk({ n: "", d: "" }), mk({ n: "6", d: "/x.csv" }), [])
      .frozenBody,
    true,
  );
  const out = mk({ n: "", d: "" });
  // dataset slot d is ALIASED (d <- params$d) but NOT coerced
  if (!out.includes("d <- params$d")) {
    throw new Error("dataset slot not aliased");
  }
  if (out.includes("d <- as.")) throw new Error("dataset slot wrongly coerced");
});

Deno.test("coercion does NOT mask an unused slot (ref-check stays on author cells)", () => {
  const v = authorRoundTrip({
    title: "T",
    templateId: "unused-int@1",
    cells: [{ type: "code", source: "y <- nrow(d)" }],
    slots: [
      { name: "d", type: "dataset", source: "path", sample: "x.csv" },
      { name: "n", type: "int", sample: "6", antisample: "6.5" },
    ],
    columns: [],
  });
  assertEquals(v.valid, false);
  if (!v.reasons.some((r) => r.includes("never used") && r.includes("n"))) {
    throw new Error(
      "unused int slot masked by coercion: " + JSON.stringify(v.reasons),
    );
  }
});

// --- serializer drift: writer stamp + canonicalization (trust boundary) -------
Deno.test("author stamps swamp.writer (the serializer version) into the artifact", () => {
  const v = authorRoundTrip({
    title: "T",
    templateId: "stamp@1",
    writerVersion: "@vcjdeboer/session-write@2026.06.27.3",
    cells: [{ type: "code", source: "x <- nrow(d)" }],
    slots: [{ name: "d", type: "dataset", source: "path", sample: "x.csv" }],
    columns: [],
  });
  assertEquals(v.valid, true);
  assertEquals(
    parseDoc(v.templateText).swamp.writer,
    "@vcjdeboer/session-write@2026.06.27.3",
  );
});

Deno.test("author content verifies ACROSS builds; writerSkew is informational", () => {
  const mk = (writer: string, conc: string) =>
    serializeDoc({
      format: "qmd",
      language: "r",
      title: "T",
      params: { d: conc },
      swamp: { template: "t@1", slots: { d: { type: "dataset" } }, writer },
      cells: [{ type: "code", source: "read.csv(d)" }],
    });
  // Different builds (A vs B), identical authored content → frozen is TRUE now (the
  // serializer version is excluded from the frozen comparison), and the skew is just
  // reported.
  const r = validateFill(
    mk("session-write@A", ""),
    mk("session-write@B", "mtcars"),
    [],
  );
  assertEquals(r.frozenBody, true);
  assertEquals(r.writerSkew, {
    template: "session-write@A",
    fill: "session-write@B",
  });
  // same writer → no skew
  const r2 = validateFill(
    mk("session-write@A", ""),
    mk("session-write@A", "mtcars"),
    [],
  );
  assertEquals(r2.frozenBody, true);
  assertEquals(r2.writerSkew, null);
});

Deno.test("frozenRepr is robust to YAML key ORDER (canonicalized, not incidental)", () => {
  const tmpl = [
    "---",
    "title: T",
    "params:",
    '  d: ""',
    "swamp:",
    "  template: t@1",
    "  slots: { d: { type: dataset } }",
    "---",
    "",
    "```{r}",
    "read.csv(d)",
    "```",
    "",
  ].join("\n");
  // identical content, only PARAMS filled + swamp keys in a different order
  const fill = [
    "---",
    "title: T",
    "params:",
    '  d: "mtcars"',
    "swamp:",
    "  slots: { d: { type: dataset } }",
    "  template: t@1",
    "---",
    "",
    "```{r}",
    "read.csv(d)",
    "```",
    "",
  ].join("\n");
  assertEquals(validateFill(tmpl, fill, []).frozenBody, true);
});

// --- deeper fix: setup excluded from frozen + re-derived for integrity ----------
const _W = "@vcjdeboer/session-write@2026.06.27.3";
const _mkTyped = (n: string, writer = _W) =>
  serializeDoc({
    format: "qmd",
    language: "r",
    title: "T",
    params: { n },
    swamp: { template: "t@1", slots: { n: { type: "int" } }, writer },
    cells: [{ type: "code", source: "x <- n" }],
  });

Deno.test("setup is EXCLUDED from frozen; an INJECTED setup passes frozen but is caught (tampered)", () => {
  const tmpl = _mkTyped("");
  const clean = validateFill(tmpl, _mkTyped("6"), [], undefined, _W);
  assertEquals(clean.frozenBody, true);
  assertEquals(clean.setupIntegrity, "ok");
  // inject code into the (excluded-from-frozen) setup binding
  const evil = _mkTyped("6").replace(
    "n <- as.integer(params$n)",
    "n <- as.integer(params$n)\nsystem('rm -rf /')",
  );
  const r = validateFill(tmpl, evil, [], undefined, _W);
  assertEquals(r.frozenBody, true); // author cells untouched
  assertEquals(r.setupIntegrity, "tampered"); // but setup != what the slots derive
});

Deno.test("a setup written by ANOTHER build is DRIFT, not tampering (author content still verifies)", () => {
  const tmpl = _mkTyped("", "old-build@1");
  const fill = _mkTyped("6", "old-build@1").replace(
    "n <- as.integer(params$n)",
    "n <- as.integer(params[['n']])", // a different codegen spelling
  );
  const r = validateFill(tmpl, fill, [], undefined, _W); // current build != old-build
  assertEquals(r.frozenBody, true);
  assertEquals(r.setupIntegrity, "drift");
});
