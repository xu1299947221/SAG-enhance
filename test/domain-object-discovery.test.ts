import { describe, expect, it } from "vitest";
import { discoverDomainObjects } from "../src/domain/domain-object-discovery.js";

describe("discoverDomainObjects", () => {
  it("discovers domain objects from unknown product manuals without a fixed bidding lexicon", () => {
    const objects = discoverDomainObjects([
      "用户在模型选择页面选择对话模型。",
      "系统支持文件上传、材料解析、预审任务创建和报告生成。",
      "管理员可以维护权限配置并查看历史记录。"
    ].join("\n"));
    const names = objects.map((object) => object.name);

    expect(names).toEqual(expect.arrayContaining([
      "模型选择页面",
      "对话模型",
      "文件上传",
      "预审任务",
      "报告生成",
      "权限配置",
      "历史记录"
    ]));
  });

  it("discovers requirements and materials from bidding-like content", () => {
    const objects = discoverDomainObjects("供应商须提供类似业绩证明材料，响应文件应满足服务期限要求和技术评分标准。");
    const names = objects.map((object) => object.name);

    expect(names).toEqual(expect.arrayContaining([
      "类似业绩证明材料",
      "响应文件",
      "服务期限要求",
      "技术评分标准"
    ]));
  });
});
