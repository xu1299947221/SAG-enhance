import { describe, expect, it } from "vitest";
import { cleanExtractedEntities } from "../src/domain/entity-cleaning.js";

describe("cleanExtractedEntities", () => {
  it("filters noisy UI fragments and preserves useful domain objects", () => {
    const cleaned = cleanExtractedEntities([
      { type: "subject", name: "Introduction", description: "noise" },
      { type: "subject", name: "Ctrl Shift", description: "shortcut" },
      { type: "metric", name: "4.2关于征集智能体应用情况的函 (4月1日17点前).ofd", description: "file name" },
      { type: "risk_or_exception", name: "为了准确回答您的问题", description: "prompt fragment" },
      { type: "data_object", name: "一个总结股东会会议记录", description: "long fragment" },
      { type: "document_material", name: "帮我写一份工作报告", description: "prompt example" },
      { type: "document_material", name: "分析这份文件", description: "prompt example" },
      { type: "time_constraint", name: "他用三分之二以上的时间", description: "sentence fragment" },
      { type: "process", name: "内容由AI生成", description: "ui disclaimer" },
      { type: "process", name: "上传本地文件", description: "upload action" },
      { type: "document_material", name: "工作报告", description: "profiled object" },
      { type: "data_object", name: "知识库", description: "profiled object" }
    ], {
      inputIsChinese: true,
      preserveNames: ["工作报告", "知识库"],
      limit: 20
    });

    expect(cleaned.map((entity) => entity.name)).toEqual(expect.arrayContaining([
      "文件上传",
      "工作报告",
      "知识库"
    ]));
    expect(cleaned.map((entity) => entity.name)).not.toEqual(expect.arrayContaining([
      "Introduction",
      "Ctrl Shift",
      "为了准确回答您的问题",
      "一个总结股东会会议记录",
      "帮我写一份工作报告",
      "分析这份文件",
      "他用三分之二以上的时间",
      "内容由AI生成"
    ]));
  });
});
