/**
 * 不连模型、不启数据库，只核对配方表和材料匹配规则。
 * 运行：node scripts/check-features.mjs
 */
import { RECIPES, UPGRADE_SLOTS, SKILL_DEFS } from '../web/src/core/prompt.js'

let failed = 0
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!pass) failed++
}

function itemFits(item, need) {
  if (need.category && item.category !== need.category) return false
  const keys = need.keys || []
  if (!keys.length) return true
  return keys.some((k) => `${item.name}${item.note || ''}`.includes(k))
}

const cloth = RECIPES.find((r) => r.id === 'bandage').need[0]
ok('旧衬衫能当布料', itemFits({ name: '一件旧衬衫', category: '衣物', note: '' }, cloth))
ok('罐头不能当布料', !itemFits({ name: '罐头', category: '食物', note: '' }, cloth))
ok('分类对了但名字不含关键词也不算', !itemFits({ name: '皮靴', category: '衣物', note: '' }, cloth))
ok('配方 6 条且 id 不重复', RECIPES.length === 6 && new Set(RECIPES.map((r) => r.id)).size === 6)
ok('加固 4 件且 id 不重复', UPGRADE_SLOTS.length === 4 && new Set(UPGRADE_SLOTS.map((s) => s.id)).size === 4)
ok('技能 4 项', SKILL_DEFS.map((d) => d.id).join(',') === 'scavenge,combat,craft,social')
ok('每条材料都有分类和关键词', [...RECIPES, ...UPGRADE_SLOTS.map((s) => ({ need: s.need }))].every((r) => r.need.every((n) => n.category && n.keys?.length)))

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
