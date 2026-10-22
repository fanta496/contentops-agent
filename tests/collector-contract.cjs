#!/usr/bin/env node
'use strict';
/**
 * 采集器契约检查：只做静态检查，不启动浏览器。
 * 目的：新加一个平台时，先确认采集器该有的方法都在，不要等真跑采集才发现漏了。
 *
 * - 必须实现：openLogin / collect / closeBrowser
 * - 建议实现：probe（登录状态探测）。缺失只记 warning，不判失败——
 *   抖音采集器目前就没有 probe（README 里已注明抖音闭环未完成）。
 */

const path = require('node:path');
const { PLATFORMS } = require(path.resolve(__dirname, '..', 'lib', 'platforms.cjs'));

const REQUIRED = ['openLogin', 'collect', 'closeBrowser'];
const SUGGESTED = ['probe'];
const problems = [];
const warnings = [];

function collectorPrototype(platform) {
  const mod = require(path.resolve(__dirname, '..', platform.collector));
  const exported = Object.values(mod).filter((value) => typeof value === 'function');
  return exported.length ? exported[0].prototype || {} : null;
}

for (const platform of PLATFORMS) {
  if (!platform.collector) { problems.push(`${platform.label}: 没有配置 collector 路径`); continue; }
  let proto;
  try {
    proto = collectorPrototype(platform);
  } catch (error) {
    problems.push(`${platform.label}: 采集器加载失败（${error.message}）`);
    continue;
  }
  if (!proto) { problems.push(`${platform.label}: 采集器没有导出类`); continue; }
  for (const method of REQUIRED) {
    if (typeof proto[method] !== 'function') problems.push(`${platform.label}: 采集器缺少 ${method}()`);
  }
  for (const method of SUGGESTED) {
    if (typeof proto[method] !== 'function') warnings.push(`${platform.label}: 采集器缺少 ${method}()（建议补上，用于登录状态探测）`);
  }
  if (platform.creatorCenter) {
    try {
      const creator = require(path.resolve(__dirname, '..', platform.creatorCenter));
      const creatorProto = Object.values(creator).find((value) => typeof value === 'function')?.prototype || {};
      if (typeof creatorProto.probe !== 'function') problems.push(`${platform.label}: 创作后台采集器缺少 probe()`);
    } catch (error) {
      problems.push(`${platform.label}: 创作后台采集器加载失败（${error.message}）`);
    }
  }
}

console.log(JSON.stringify({ ok: problems.length === 0, platforms: PLATFORMS.length, problems, warnings }, null, 2));
if (problems.length) process.exitCode = 1;
