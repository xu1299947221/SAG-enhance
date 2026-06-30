# SAG 通用强关系图谱增强检索一次性升级方案

## 1. 目标

将 SAG 从“事件-实体增强检索系统”一次性升级为“通用强关系图谱增强检索系统”，完整支持：

- 通用基础关系本体
- 应标领域关系扩展
- LLM 自动强关系抽取
- 强关系图谱存储
- 关系质量治理
- 关系路径检索
- 检索解释链路
- 图谱关系审查
- 项目级关系配置
- 智能应标要求图谱与素材图谱对齐
- Neo4j 适配预留

所有改动只允许发生在 `/home/data/sag`，不得修改 `/home/data/rag/ragyuyan`，不得写入真实密钥、数据库密码或外部敏感配置。

## 2. 总体架构

保留现有 SAG 能力：

- 文档上传
- Milvus markdown 同步
- 文档切片
- 事件抽取
- 实体抽取
- 向量检索
- BM25 检索
- rerank
- MCP
- AI 设置页面

在现有能力上增加强关系层：

```text
文档入库
  -> 切片
  -> 事件抽取
  -> 实体抽取
  -> 关系本体约束
  -> LLM 强关系抽取
  -> 关系质量治理
  -> knowledge_edges 写入
  -> 搜索时关系召回
  -> 路径扩展
  -> rerank
  -> 解释为什么召回
```

内部关系类型统一使用英文枚举，页面和 trace 显示中文 label。

默认使用 Postgres 存储图谱数据，同时预留 Neo4j 适配层。

## 3. 通用关系本体

完善 `src/domain/relation-ontology.ts`，作为唯一关系定义入口。

### 3.1 通用基础关系

系统默认内置以下基础关系：

```text
CONTAINS        包含
PART_OF         属于/组成部分
IS_A            是一种
INSTANCE_OF     实例属于
EQUIVALENT_TO   等价/同义
SIMILAR_TO      相似
REFERS_TO       引用/指向
BASED_ON        基于/来源于
DERIVED_FROM    派生自
USES            使用
PRODUCES        产生/输出
DEPENDS_ON      依赖/前置
PRECEDES        先于
REQUIRES        要求/需要
SATISFIES       满足/符合
PROVES          证明/支撑
LIMITS          限制/约束
CAUSES          导致
AFFECTS         影响
RELATED_TO      相关
```

### 3.2 应标领域扩展关系

智能应标场景默认启用：

```text
HOLDS            持有/具备
HAS_EXPERIENCE   具备业绩
MATCHES_TYPE     匹配项目类型
SCORES_FOR       对应评分项
CAUSES_RISK      导致风险/废标
SUBMITS          提交/响应材料
```

### 3.3 关系定义字段

每个关系定义必须包含：

```text
type
label
description
aliases
strength
scope
inverseType
transitive
reasoning
defaultMinConfidence
```

### 3.4 本体方法

必须提供：

```text
normalizeRelation()
getRelationDefinition()
relationPromptCatalog()
isReasoningRelation()
relationMinConfidence()
```

要求：

- 中文“证明材料、佐证、支撑”归一到 `PROVES`。
- 中文“要求、须、必须、应提供”归一到 `REQUIRES`。
- `RELATED_TO` 只能作为低权重弱关系，不参与核心强推理路径。

## 4. 数据库升级

完善 `knowledge_edges` 表。

字段至少包含：

```text
id
source_id
document_id
chunk_id
event_id
subject_entity_id
object_entity_id
subject_name
object_name
relation_type
relation_label
evidence
evidence_start
evidence_end
confidence
quality_score
extraction_method
extraction_model
prompt_version
status
metadata
created_at
updated_at
```

`status` 支持：

```text
AUTO
CONFIRMED
REJECTED
DISABLED
```

新增或完善：

```text
entity_aliases
relation_configs
edge_feedback
```

要求：

- 删除文档时清理相关 edge。
- `replaceExisting=true` 重新导入时替换旧图谱数据。
- 人工确认过的关系不能被自动低质量结果覆盖。
- `REJECTED`、`DISABLED` 的边不参与检索。

## 5. LLM 强关系抽取

新增：

```text
src/services/relation-extraction-service.ts
```

入库时在文档画像、事件抽取之后，对每个 chunk/event 执行强关系抽取。

### 5.1 输入

```json
{
  "documentTitle": "string",
  "documentType": "string",
  "chunkHeading": "string",
  "chunkContent": "string",
  "extractedEntities": [],
  "relationCatalog": [],
  "projectRelationConfig": {}
}
```

### 5.2 输出

```json
{
  "relations": [
    {
      "subject": "项目负责人",
      "predicate": "REQUIRES",
      "object": "信息系统项目管理师证书",
      "displayLabel": "要求具备",
      "evidence": "拟派项目负责人须具备信息系统项目管理师证书。",
      "confidence": 0.91,
      "reason": "原文明确说明项目负责人须具备该证书"
    }
  ]
}
```

要求：

- `predicate` 必须从 relation catalog 中选择。
- 每条强关系必须有 evidence。
- subject/object 必须映射到实体；不存在时允许创建新实体，但必须经过清洗和去噪。
- 不允许只因为同段出现就连边。
- LLM 失败时允许 fallback，但 fallback 只能产生少量保守关系，不能大量生成 `RELATED_TO`。

## 6. 关系质量治理

新增 `quality_score`：

```text
quality_score =
  confidence
  + relation_strength_weight
  + evidence_quality_weight
  + confirmed_bonus
  - weak_relation_penalty
  - missing_evidence_penalty
```

过滤规则：

- 强关系没有 evidence，不入库。
- `RELATED_TO` 默认阈值更高，且不参与强推理。
- `PROVES`、`SATISFIES`、`REQUIRES` 等强关系按 relation ontology 阈值入库。
- evidence 应尽量包含 subject/object 或其别名。
- 泛词实体、标题噪声、OCR 噪声要降权或过滤。

页面和 trace 必须展示：

```text
confidence
quality_score
status
evidence
```

## 7. 搜索链路升级

保留现有 `vector`、`multi`、`fast` 搜索。

在 `multi` 搜索中增加强关系召回：

```text
query
  -> query entities
  -> relation intent
  -> entity recall
  -> edge recall
  -> graph path expansion
  -> event/chunk recall
  -> rerank
  -> explanation
```

新增 repository 能力：

```text
searchKnowledgeEdges()
getEdgesByEntityIds()
getEdgesByEventIds()
expandGraphPaths()
getSectionsForKnowledgeEdges()
getEdgesForSections()
```

搜索 trace 新增：

```json
{
  "relationIntent": [],
  "recalledEdges": [],
  "graphPaths": [],
  "explanation": {}
}
```

如果强关系路径命中，优先使用关系路径解释；没有命中时再降级向量召回。

搜索参数支持：

```json
{
  "useGraphPaths": true,
  "relationTypes": ["REQUIRES", "PROVES"],
  "minEdgeConfidence": 0.65,
  "returnTrace": true
}
```

## 8. 路径推理

支持 1-3 跳路径。

典型路径：

```text
项目负责人 -> REQUIRES -> 信息系统项目管理师证书
张三 -> HOLDS -> 信息系统项目管理师证书
证书扫描件 -> PROVES -> 信息系统项目管理师证书
```

```text
资格要求 <- PROVES <- 承诺函
```

```text
评分项 <- SCORES_FOR <- 类似业绩 -> MATCHES_TYPE -> 政务服务项目
```

```text
废标风险 <- CAUSES_RISK <- 无效响应条款
```

路径排序考虑：

- 关系强度
- 置信度
- evidence 质量
- 是否人工确认
- 与问题的语义相似度

路径必须保留 evidence 链路。

## 9. 搜索解释

`SearchResult` 每条 section 增加 `why` 字段。

```json
{
  "section": {},
  "why": {
    "matchedEntities": [],
    "matchedEdges": [],
    "graphPaths": [],
    "evidence": [],
    "recallType": "graph_path",
    "fallback": false
  }
}
```

页面展示：

```text
为什么召回：
1. 命中实体：项目负责人、证书
2. 命中关系：项目负责人 REQUIRES 信息系统项目管理师证书
3. 关系路径：张三 HOLDS 信息系统项目管理师证书
4. 证据原文：……
```

trace 中明确区分：

```text
向量召回
实体召回
强关系召回
路径推理召回
降级召回
```

## 10. 图谱页面升级

图谱页面增加：

```text
实体视图
事件视图
强关系边视图
路径视图
待审核关系
```

强关系边表格展示：

```text
主体
关系
客体
证据
置信度
质量分
状态
来源文档
操作
```

支持操作：

```text
确认
拒绝
禁用
修改关系类型
修改主体/客体
查看原文
```

要求：

- `REJECTED`、`DISABLED` 的边不参与检索。
- `CONFIRMED` 的边提高排序权重。
- 点击 evidence 能定位原文切片。

## 11. 项目级配置

新增项目级 relation config。

支持：

```json
{
  "disabledRelations": ["SIMILAR_TO"],
  "relationAliases": {
    "PROVES": ["佐证材料", "支撑文件"]
  },
  "entityAliases": {
    "项目经理": "项目负责人"
  },
  "minConfidence": {
    "RELATED_TO": 0.8,
    "PROVES": 0.65
  },
  "customRelations": []
}
```

原则：

- 默认启用通用基础关系。
- 智能应标项目启用应标领域关系。
- 项目级配置只允许补充和覆盖，不允许破坏基础关系本体。
- 别名类配置搜索时立即生效。
- 阈值和自定义关系对新导入生效。

## 12. 智能应标双图谱

自动识别文档类型：

```text
REQUIREMENT_DOC
MATERIAL_DOC
GENERAL_DOC
```

### 12.1 要求图谱

招标文件构建要求图谱：

```text
资格要求
人员要求
证书要求
评分项
无效响应
付款
验收
服务期限
技术要求
安全要求
```

典型关系：

```text
人员要求 -> REQUIRES -> 证书
评分项 -> SCORES_FOR -> 类似业绩
无效响应条款 -> CAUSES_RISK -> 废标风险
资格要求 -> REQUIRES -> 证明材料
```

### 12.2 素材图谱

素材文件构建材料图谱：

```text
公司资质
人员
证书
业绩
合同
中标通知
验收证明
承诺函
方案素材
```

典型关系：

```text
人员 -> HOLDS -> 证书
公司 -> HAS_EXPERIENCE -> 项目业绩
材料 -> PROVES -> 资质
业绩 -> MATCHES_TYPE -> 项目类型
```

### 12.3 要求和素材对齐

建立匹配关系：

```text
素材 -> SATISFIES -> 要求
材料 -> PROVES -> 要求对象
人员 -> HOLDS -> 证书
业绩 -> MATCHES_TYPE -> 项目类型
```

验收问题：

```text
项目负责人证书怎么响应
类似业绩评分怎么准备
哪些材料能证明资格要求
哪些条款会导致废标风险
```

必须返回材料、关系链路、证据原文。

## 13. Neo4j 适配预留

新增 GraphStore 抽象：

```text
upsertNode()
upsertEdge()
searchEdges()
expandPaths()
getPathEvidence()
deleteDocumentGraph()
```

实现：

```text
PostgresGraphStore
Neo4jGraphStore
```

当前默认 Postgres，Neo4j 不作为必需运行依赖。

`knowledge_edges` 作为未来同步 Neo4j 的事实源。

上层搜索服务不能直接依赖 Postgres SQL 细节。

## 14. API 升级

新增接口：

```text
GET   /api/relation-ontology
GET   /api/projects/:projectId/relations
GET   /api/projects/:projectId/relations/stats
GET   /api/documents/:documentId/relations
PATCH /api/relations/:edgeId
POST  /api/relations/:edgeId/confirm
POST  /api/relations/:edgeId/reject
POST  /api/relations/:edgeId/disable
POST  /api/relations/rebuild
GET   /api/projects/:projectId/relation-config
PATCH /api/projects/:projectId/relation-config
```

增强：

```text
POST /api/search
```

新增参数：

```json
{
  "useGraphPaths": true,
  "relationTypes": ["REQUIRES", "PROVES"],
  "minEdgeConfidence": 0.65,
  "returnTrace": true
}
```

所有 API 需要有类型定义和前端 api 封装。

## 15. 前端升级

要求：

- 文档详情展示当前文档抽到的强关系。
- 图谱页展示强关系边和路径。
- 搜索结果展示 `why` explanation。
- 调试页展示入库后的实体数、事件数、强关系数、低置信度关系数。
- AI 设置页保留现有 rerank、embedding、LLM 配置。
- 项目配置页增加关系配置入口。

## 16. 测试和验证

新增测试：

```text
relation-ontology.test.ts
relation-extraction-service.test.ts
ingestion-knowledge-edges.test.ts
repository-knowledge-edges.test.ts
search-graph-path.test.ts
relation-config.test.ts
graph-store.test.ts
```

更新测试：

```text
search-service-multi.test.ts
repository-delete.test.ts
Milvus markdown import tests
document ingestion tests
web api type tests
```

测试样例：

```text
操作手册：用户上传文件后，系统生成预审报告。
期望：文件上传 -> PRODUCES -> 预审报告
```

```text
招标文件：项目负责人须具备信息系统项目管理师证书。
期望：项目负责人 -> REQUIRES -> 信息系统项目管理师证书
```

```text
素材：张三持有信息系统项目管理师证书。
期望：张三 -> HOLDS -> 信息系统项目管理师证书
```

```text
证明材料：证书扫描件可证明人员证书要求。
期望：证书扫描件 -> PROVES -> 人员证书要求
```

完成后执行：

```bash
npm run typecheck
npx vitest run
npm run build:api
npm run build:web
```

如有数据库迁移，必须明确提示对当前运行环境执行：

```bash
DATABASE_URL='对应当前 SAG 数据库连接' npm run db:migrate
```

## 17. 最终验收标准

一次性完成后必须满足：

1. 导入文档后，页面能看到强关系边。
2. 搜索结果能解释为什么召回。
3. trace 能看到：问题 -> 实体 -> 关系边 -> 路径 -> 原文证据。
4. 低质量 `RELATED_TO` 不污染主要结果。
5. 可以确认、拒绝、禁用关系边。
6. 项目级可以配置关系别名和阈值。
7. 智能应标能区分招标要求和素材能力，并通过关系链对齐。
8. 现有上传、Milvus markdown 同步、搜索、MCP、AI 设置不被破坏。
9. API、前端类型、数据库迁移、测试完整。
10. `npm run typecheck`、`npx vitest run`、`npm run build:api`、`npm run build:web` 全部通过。

## 18. 一次性 Goal 文案

```text
目标：根据 docs/strong-relation-graph-upgrade-plan.md，将 /home/data/sag 一次性升级为通用强关系图谱增强检索系统。

必须完整实现文档中的所有能力：通用关系本体、应标关系扩展、LLM 自动强关系抽取、knowledge_edges 完整存储、关系质量治理、关系路径检索、搜索 why/explanation、图谱页面强关系边视图、关系确认/拒绝/禁用、项目级关系配置、智能应标要求图谱与素材图谱对齐、GraphStore 抽象和 Neo4j 预留、API 与前端类型、数据库迁移、测试和构建验证。

约束：
1. 只修改 /home/data/sag。
2. 不修改 /home/data/rag/ragyuyan。
3. 不写入真实密钥、数据库密码或外部敏感配置。
4. 保留现有上传、Milvus markdown 同步、搜索、MCP、AI 设置能力。
5. 内部关系类型使用英文稳定 type，页面和 trace 显示中文 label。
6. 强关系必须带 evidence 和 confidence。
7. RELATED_TO 只能作为低权重弱关系，不能污染主要推理路径。
8. 完成后执行 npm run typecheck、npx vitest run、npm run build:api、npm run build:web。
9. 如新增迁移，说明当前运行环境需要执行的 db:migrate 命令。

最终验收：导入文档后能在页面看到强关系边；搜索结果能展示为什么召回；trace 能展示实体、关系边、路径和证据；智能应标问题能通过要求图谱和素材图谱关系链召回材料。
```
