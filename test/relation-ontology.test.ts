import { describe, expect, it } from "vitest";
import { BASE_RELATIONS, normalizeRelation, relationPromptCatalog } from "../src/domain/relation-ontology.js";

describe("relation ontology", () => {
  it("provides a reusable base relation catalog", () => {
    expect(BASE_RELATIONS.map((relation) => relation.type)).toEqual(expect.arrayContaining([
      "CONTAINS",
      "PART_OF",
      "REQUIRES",
      "SATISFIES",
      "PROVES",
      "LIMITS",
      "CAUSES",
      "RELATED_TO"
    ]));
    expect(relationPromptCatalog().find((relation) => relation.type === "REQUIRES")).toMatchObject({
      label: "要求/需要",
      strength: "strong",
      scope: "base"
    });
  });

  it("normalizes Chinese labels and enum names to stable relation types", () => {
    expect(normalizeRelation("要求具备")).toMatchObject({ type: "REQUIRES" });
    expect(normalizeRelation("证明材料")).toMatchObject({ type: "PROVES" });
    expect(normalizeRelation("SATISFIES")).toMatchObject({ type: "SATISFIES" });
    expect(normalizeRelation("无法判断的关系")).toMatchObject({ type: "RELATED_TO" });
  });
});
