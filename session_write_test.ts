import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { resolveRepoDir } from "./session_write.ts";

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
