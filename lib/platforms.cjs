'use strict';
// 平台注册表：把「一个平台叫什么、开关存在哪、关键词存在哪、归哪个 Agent 管」集中到这一张表。
//
// 加一个平台的最小改动路径（清单见 docs/ARCHITECTURE.md）：
// 1) 在这里加一条描述；
// 2) 在 collector/ 下实现 openLogin / probe / collect / closeBrowser；
// 3) 在 server.cjs 的 runCollection 里接上采集分支；
// 4) 前端加开关与关键词输入；
// 5) tests/api-smoke.cjs 补接口基线。

const PLATFORMS = [
  {
    id: 'xhs',
    label: '小红书',
    agentId: 'xhs-collector',
    enabledKey: 'xhsEnabled',
    keywordsKey: 'xhsKeywords',
    delayKey: 'xhsDelayMs',
    collector: './collector/xiaohongshu.cjs',
    creatorCenter: './collector/xhs-creator-center.cjs',
    performanceSupported: true
  },
  {
    id: 'douyin',
    label: '抖音',
    agentId: 'douyin-collector',
    enabledKey: 'douyinEnabled',
    keywordsKey: 'douyinKeywords',
    delayKey: 'douyinDelayMs',
    collector: './collector/douyin.cjs',
    creatorCenter: '',
    performanceSupported: false
  }
];

const byId = new Map(PLATFORMS.map((item) => [item.id, item]));
const byLabel = new Map(PLATFORMS.map((item) => [item.label, item]));

const labels = () => PLATFORMS.map((item) => item.label);
const ids = () => PLATFORMS.map((item) => item.id);
const byLabelOrId = (value) => byLabel.get(value) || byId.get(value) || null;
const isSupported = (value) => Boolean(byLabelOrId(value));
const describe = (value) => byLabelOrId(value);

module.exports = { PLATFORMS, labels, ids, byLabelOrId, isSupported, describe };
