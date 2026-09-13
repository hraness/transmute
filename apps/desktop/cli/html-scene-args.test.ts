import { expect, test } from "bun:test";
import { parseCliArgs } from "./args";
import { commandHelp } from "./help";
import { runPortableSurface } from "./portable-surface";

test("HTML render routes through the local host with explicit dry run and JSON", async () => {
  const argv = ["html", "render", "--input", "scene.json", "--dry-run", "--json"];
  expect(await runPortableSurface(argv)).toBeUndefined();
  expect(parseCliArgs(argv)).toEqual({ kind: "html-render", input: "scene.json", dryRun: true, json: true });
  expect(parseCliArgs(["html", "render", "--input=scene.json"])).toEqual({ kind: "html-render", input: "scene.json", dryRun: false, json: false });
  expect(commandHelp(["html"])).toContain("html render --input");
});

test("HTML render rejects duplicate, missing, positional, and unsupported options", () => {
  for (const args of [[], ["--input"], ["--input", "a", "--input", "b"], ["--input", "a", "extra"],
    ["--input", "a", "--output", "b"], ["--input", "a", "--dry-run=true"]]) {
    expect(() => parseCliArgs(["html", "render", ...args])).toThrow();
  }
});

test("HTML help reaches the ordinary help parser without writing a scaffold", async () => {
  expect(await runPortableSurface(["html", "render", "--help"])).toBeUndefined();
  expect(parseCliArgs(["html", "render", "--help"]).kind).toBe("help");
});
