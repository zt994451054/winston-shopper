# 布局协作的离线示例

[示例JSON](data/layout-assistance-offline.json)包含`evidence`、模型形状的`proposal`以及`checked_result`。它来自合成测试页面：保留固定摘要与正文分开的拓扑，给正文和规格内部换成未支持的类名。标题、颜色、图片和价格均是测试数据，不是新读取的真实商品，也不新增平台覆盖样本。

在Skill目录执行以下代码即可离线重现候选校验，不创建正式任务、不访问浏览器、不改历史状态：

```sh
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { checkLayoutProposal } from './lib/layout-proposal.mjs';
const example = JSON.parse(await readFile('examples/data/layout-assistance-offline.json', 'utf8'));
const result = checkLayoutProposal(example.proposal, example.evidence, { url: example.evidence.url });
console.log(JSON.stringify(result, null, 2));
NODE
```

结果返回5项候选：标题、规格组文字、规格选项文字、该选项内的图片、展示价原文。它验证的是保存证据中的对应关系，`field_interpretation_verified`仍为false；没有得到SKU ID、确定实付或完整商品数据。

实际使用应从原任务的`layout-diagnosis`获取节点和证据哈希，再提交模型提案给`layout-check`。旧任务没有新版证据时保持缺项，不能导入此示例冒充实页。具体字段和边界见[调用说明](../references/layout-assistance.md)。
