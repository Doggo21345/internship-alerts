import test from "node:test";
import assert from "node:assert/strict";
import { isInternship, roleTypes, termsIn, companyKey, companyTags, describe } from "../lib/classify.js";

test("isInternship matches whole words only", () => {
  assert.ok(isInternship("Software Engineer Intern"));
  assert.ok(isInternship("Co-op, Data Science"));
  assert.ok(isInternship("Summer Analyst 2027"));
  assert.ok(!isInternship("International Sales Manager"));
  assert.ok(!isInternship("Internal Audit Lead"));
});

test("roleTypes labels common titles and leaves vague ones unlabelled", () => {
  assert.deepEqual(roleTypes("Software Engineer Intern"), ["Software"]);
  assert.deepEqual(roleTypes("Machine Learning Intern"), ["Data/AI"]);
  assert.deepEqual(roleTypes("UX Researcher Intern"), ["Design"]);
  assert.deepEqual(roleTypes("Data Scientist Intern"), ["Data/AI"]);
  assert.deepEqual(roleTypes("Quantitative Trader Intern"), ["Quant"]);
  assert.deepEqual(roleTypes("Mechanical Engineering Intern"), ["Hardware"]);
  assert.deepEqual(roleTypes("Product Manager Intern"), ["Product"]);
  assert.deepEqual(roleTypes("UX Designer Intern"), ["Design"]);
  assert.deepEqual(roleTypes("Engineering Intern"), []);
  assert.ok(!roleTypes("Maintenance Intern").includes("Data/AI"), "ai inside a word");
});

test("termsIn pairs seasons with years", () => {
  assert.deepEqual(termsIn("SWE Intern (Summer 2027)"), ["Summer 2027"]);
  assert.deepEqual(termsIn("Intern, Fall/Autumn 2026"), ["Fall 2026"]);
  assert.deepEqual(termsIn("2027 Intern"), ["2027"]);
  assert.deepEqual(termsIn("Intern"), []);
});

test("companyKey and tags", () => {
  assert.equal(companyKey("Jane Street Capital, LLC"), "jane street capital");
  assert.equal(companyKey("AT&T"), "at and t");
  assert.deepEqual(companyTags("Google"), ["Big Tech"]);
  assert.deepEqual(companyTags("Jane Street"), ["Quant"]);
  assert.deepEqual(companyTags("Ramp", { yc: new Set(["ramp"]) }), ["YC Startup"]);
  assert.deepEqual(companyTags("Acme"), []);
});

test("describe adds what sheets filter on, keeping a source's own labels", () => {
  const d = describe({ title: "Intern", location: "Toronto, ON", terms: ["Summer 2027"], roleTypes: ["Software"] });
  assert.deepEqual(d.countries, ["CA"]);
  assert.deepEqual(d.terms, ["Summer 2027"]);
  assert.deepEqual(d.roleTypes, ["Software"]);
});
