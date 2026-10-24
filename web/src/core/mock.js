/**
 * 离线体验通道（mock）
 * ------------------------------------------------------------------
 * ⚠️ 仅用于在没有 API Key 时预览界面与完整流程，**不是游戏的正式内容来源**。
 *    正式游戏必须走真实大模型通道（provider=openai）。
 *
 * 识别规则（与 prompt.js 的标记严格对应）：
 *   - 开局提示词含「【阶段】开局」
 *   - 兜底结局提示词含「【触发原因】」
 *   - 其余为回合提示词
 */

let turnCount = 0

const NARRATIONS = [
  `急诊大厅的广播还在循环播放「请患者有序就诊」，但已经没有人再排队了。三分钟前，那个被抬进来的男人突然从担架床上坐起，咬住了离他最近的护士。你站在走廊尽头，手里还攥着刚打印出来的化验单——病因一栏写着「待查」。尖叫声从四面八方涌来，而你身后，是唯一一扇还亮着绿灯的安全通道门。`,
  `你在居民楼七层的阳台上屏住呼吸。楼下的尸群像退潮一样缓慢向东移动，领头的那具穿着环卫工制服，胸口别着一张已经模糊的工牌。对面楼顶，有人用镜子朝你闪了三下——那是幸存者之间的老信号。`,
  `发动机在高架匝道上彻底熄火。仪表盘黑下去的一瞬间，你听见了远处传来的钟声。不对，这个区域已经断电很久了。那钟声来自哪里？`,
  `你拆开绷带，伤口边缘已经泛起不正常的青灰色。军用手册上写过这种情况——尸化的早期征兆。你还有大概十二个小时，去找那家据说还囤着抗生素的社区医院。`,
]

function endingPayload() {
  return {
    narration: '（离线体验）你终于停下了脚步。身后的嘶吼越来越远，前方是一片望不到头的灰白。',
    stateDelta: { hp: -100, hunger: 10, thirst: 10, sanity: -20, stamina: -40 },
    memory: '离线体验流程走到终点。',
    eventSummary: '离线体验结局触发',
    choices: [],
    isEnding: true,
    endingTitle: '离线结局 · 灰白尽头',
    endingText:
      '（离线体验模式生成，非正式内容）这是离线通道输出的示例结局，用于验证结局页面与"再活一次"流程。请在「AI 通道设置」中填入真实 API Key，以获得由大模型现场推演的、完全随机的结局。',
  }
}

/**
 * 离线体验：使用物品分支。
 * **对象优先于分类**：同一个物品给不同对象用，结果完全不同（这是本次机制的核心）。
 * 离线通道用「本体名字是否出现在提示词的对象段落里」来判断对象，从而让自检可以覆盖
 * 「自己用 → 掉血」「给同行者用 → 见效」「就地使用 → 物理性质」三条路径。
 */
function useItemPayload(userPrompt) {
  const text = String(userPrompt)
  const m = text.match(/使用物品）主角停下来，取用背包中的一件物品：\*\*(.+?)\*\*（分类：(.+?)[，)）]/)
  const name = m ? m[1] : '某件物品'
  const category = m ? m[2] : '杂物'

  // 对象：从「对象：**...**」段落里解析
  const isHere = /对象：\*\*就地使用\*\*/.test(text)
  const isSelf = /对象：\*\*主角自己\*\*/.test(text)
  const allyMatch = text.match(/对象：\*\*同行者「(.+?)」\*\*/)
  const allyName = allyMatch ? allyMatch[1] : null
  // 物品自己标注的适用对象
  const fitsMatch = text.match(/这件物品自己标注的\*\*适用对象\*\*是：「(.+?)」/)
  const fits = fitsMatch ? fitsMatch[1] : ''

  // 药品 + 自己用：适用对象不符 → 明确的负面后果
  if (category === '药品' && isSelf && fits && !/所有人/.test(fits) && !/自己/.test(fits)) {
    return {
      narrative: `（离线体验）你撕开${name}的包装，就着唾沫把药片咽了下去。你根本不知道这药是开给谁的——咽下去十几秒后，你的耳朵先开始嗡响，接着天旋地转，眼前的东西像被水泡过一样发白。你扶着柜台往下滑，膝盖磕在地上，胃里一阵翻江倒海。这药本来是要救${fits}的，可它对你来说就是毒。`,
      stateDelta: { hp: -16, sanity: -5, stamina: -8 },
      conditionsAdd: ['药物反应 · 眩晕', '血压骤降'],
      conditionsRemove: [],
      inventoryAdd: [],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [],
      alliesRemove: [],
      flagsAdd: [],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：把本该给${fits}的药${name}自己吃了，出现严重药物反应。`,
      eventSummary: '误服了不适用于自己的药物',
      choices: [
        { id: 'A', text: '靠着墙，等眩晕过去', basis: '药已经咽下去了，眼前发白，膝盖还撑在地上' },
        { id: 'B', text: '喝口水催吐', basis: '胃里翻江倒海，包里应该还有能喝的水' },
        { id: 'C', text: '强撑着站起来继续赶路', basis: '天旋地转还没停，但你还没倒下去' },
      ],
      isEnding: false,
      _mock: true,
    }
  }

  // 药品 + 给了适配的同行者：真实地救回他
  if (category === '药品' && allyName) {
    return {
      narrative: `（离线体验）你把${name}递到${allyName}手里。他愣了半秒，看清包装上的字之后，手明显抖了一下——他没说话，只是用力点了点头，掰开一粒就着水吞下去。过了几分钟，他额头上那层冷汗退了下去，呼吸也慢慢匀了。他抬头看你的时候，眼神跟刚才不一样了。末日里，这叫一条命。`,
      stateDelta: { sanity: 4 },
      conditionsAdd: [],
      conditionsRemove: [],
      inventoryAdd: [],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [{ name: allyName, status: '状态好转', note: `服用${name}后症状缓解，欠你一条命` }],
      alliesRemove: [],
      flagsAdd: [`救命之恩·${allyName}`],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：把${name}给了${allyName}，救了对方一命。`,
      eventSummary: `${allyName}被他救了过来`,
      choices: [
        { id: 'A', text: '让他先歇一会儿再走', basis: '他额头的冷汗刚退，呼吸才匀下来' },
        { id: 'B', text: '立刻继续赶路', basis: '药起效了，可你们还停在原地' },
      ],
      isEnding: false,
      _mock: true,
    }
  }

  // 就地使用：按物理性质裁决
  if (isHere) {
    return {
      narrative: `（离线体验）你没把${name}交给任何人，而是把它用在了面前这个地方。它在这里能做的事很有限——但它确实做完了：一阵短促的声响、一点被撬动的痕迹、一丝若有若无的气味。你退开两步，看着自己刚留下的动静，忽然不确定这究竟是帮忙还是惹祸。`,
      stateDelta: { stamina: -3, sanity: -1 },
      conditionsAdd: [],
      conditionsRemove: [],
      inventoryAdd: [],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [],
      alliesRemove: [],
      flagsAdd: [],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：把${name}就地用掉了。`,
      eventSummary: '把一件物品就地消耗掉',
      choices: [
        { id: 'A', text: '确认效果，继续行动', basis: '你刚在这里留下了声响和撬动的痕迹' },
        { id: 'B', text: '退开一些，观察周围反应', basis: '你不确定刚才那一下是帮忙还是惹祸' },
      ],
      isEnding: false,
      _mock: true,
    }
  }

  // 武器 / 工具：升级为随机事件（给出全新选项）
  if (category === '武器' || category === '工具') {
    return {
      narrative: `（离线体验）你握紧${name}，用它撬开了走廊尽头那扇锁死的防火门。金属摩擦的声音在空荡的楼道里被放大了十倍——你立刻意识到自己犯了错。门后是一条堆满杂物的过道，而在过道另一头，有什么东西停住了动作，慢慢地把头转向声音的来源。它没有眼睛，但它在"看"你。`,
      stateDelta: { sanity: -3, stamina: -2 },
      conditionsAdd: ['手掌磨破'],
      conditionsRemove: [],
      inventoryAdd: [],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [],
      alliesRemove: [],
      flagsAdd: ['防火门后的过道'],
      mutationsAdd: [],
      mainQuestUpdate: { stage: '在住院部发现一条被封死的过道', note: '过道尽头有异常' },
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：用${name}撬开防火门，声响引来了什么东西。`,
      eventSummary: '撬门引来未知威胁',
      choices: [
        { id: 'A', text: '立刻退回原路，压低脚步', basis: '门后那东西已经把头转向声音的来源' },
        { id: 'B', text: '举着工具迎上去', basis: '手里还握着刚撬开门的那件工具' },
        { id: 'C', text: '屏住呼吸，贴着墙不动', basis: '它没有眼睛，但正对着你这边' },
      ],
      isEnding: false,
      _mock: true,
    }
  }

  // 药品：常规使用
  if (category === '药品') {
    return {
      narrative: `（离线体验）你撕开${name}的包装，把药片干咽下去。苦味顺着喉咙一路烧下去，你靠在墙上等了大约十分钟，才感觉那些细小的血管不再一跳一跳地疼。伤口边缘的青灰色没有退，但暂时也没有再往前爬。你知道这只是把账往后推了推。`,
      stateDelta: { infection: -22, hp: 6, sanity: 3 },
      conditionsAdd: [],
      conditionsRemove: ['轻微擦伤'],
      inventoryAdd: [],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [],
      alliesRemove: [],
      flagsAdd: [],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：服用了${name}，感染被暂时压住。`,
      eventSummary: '服药延缓了尸化',
      choices: [],
      isEnding: false,
      _mock: true,
    }
  }

  // 食物 / 饮水：常规使用
  if (category === '食物' || category === '饮水') {
    return {
      narrative: `（离线体验）你就着袋口喝完了${name}。温吞的液体滑过干裂的喉咙，胃里泛起一阵久违的踏实。你才发现自己的手一直在抖——不是因为害怕，是因为低血糖。远处传来一声闷响，像是某栋楼又塌了一角。你抹了抹嘴，把空包装塞进口袋。`,
      stateDelta: category === '饮水' ? { thirst: -34, hp: 3 } : { hunger: -36, hp: 3 },
      conditionsAdd: [],
      conditionsRemove: [],
      inventoryAdd: [{ name: '空包装袋', category: '杂物', qty: 1, note: '可以装东西' }],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [],
      alliesRemove: [],
      flagsAdd: [],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：用掉了${name}，饥渴有所缓解。`,
      eventSummary: '补充了给养',
      choices: [],
      isEnding: false,
      _mock: true,
    }
  }

  // 弹药：单独一颗子弹派不上用场，但可以拆开取药——演示"有得有失"
  if (category === '弹药') {
    return {
      narrative: `（离线体验）你端详着${name}，弹壳上已经起了薄薄一层绿锈。没有枪，这东西就是一块金属。你犹豫了几秒，还是用刀尖把它撬开，倒出里面那点受潮的火药——它能让你下次生火时少费些力气。金属壳被你捏扁，扔进包里。`,
      stateDelta: { stamina: -2 },
      conditionsAdd: [],
      conditionsRemove: [],
      inventoryAdd: [{ name: '受潮的火药', category: '工具', qty: 1, note: '生火用，只有一次机会' }],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [],
      alliesRemove: [],
      flagsAdd: [],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：拆开${name}取出了火药。`,
      eventSummary: '拆弹药取火药',
      choices: [
        { id: 'A', text: '找个背风的角落生火', basis: '刚倒出来的火药还在手里，风还没停' },
        { id: 'B', text: '把火药收好，继续赶路', basis: '火药只有一次机会，弹壳已经被你捏扁' },
        { id: 'C', text: '检查还有多少可用的弹药', basis: '这颗子弹是拆开的，包里未必还有能用的' },
      ],
      isEnding: false,
      _mock: true,
    }
  }

  // 衣物：小幅恢复（保暖 / 包扎）
  if (category === '衣物') {
    return {
      narrative: `（离线体验）你把${name}裹在身上。布料粗糙，带着前任主人留下的、洗不掉的旧气味，但风确实被挡在了外面。骨头缝里那种持续了一整夜的冷，稍微退了一点。你把手往袖子里缩了缩，继续往前走。`,
      stateDelta: { hp: 4, sanity: 2 },
      conditionsAdd: [],
      conditionsRemove: [],
      inventoryAdd: [],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [],
      alliesRemove: [],
      flagsAdd: [],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：用${name}抵御了寒冷。`,
      eventSummary: '添了件御寒的衣物',
      choices: [],
      isEnding: false,
      _mock: true,
    }
  }

  // 物品描述在背包里找不到对应分类时（旧存档遗留等）：按杂物处理
  // 弹药 / 武器单独用掉一颗/一件是可以的，但离线通道统一给"无效使用"以示代价真实
  return {
    narrative: `（离线体验）你把${name}翻来覆去看了一遍，试了几个用法，最后确认它在这里派不上任何用场。你把它扔回包里，觉得自己刚才那两分钟像是被谁偷走了。风从破掉的窗户灌进来，天光又暗了一分。`,
    stateDelta: { sanity: -1 },
    conditionsAdd: [],
    conditionsRemove: [],
    inventoryAdd: [],
    inventoryRemove: [],
    alliesAdd: [],
    alliesUpdate: [],
    alliesRemove: [],
    flagsAdd: [],
    mutationsAdd: [],
    sideQuestsAdd: [],
    sideQuestsUpdate: [],
    memory: `离线体验：${name}没能派上用场，时间被浪费掉了。`,
    eventSummary: '无用地翻弄了一件杂物',
    choices: [],
    isEnding: false,
    _mock: true,
  }
}

/** 离线体验：搜刮分支（按同一地点第 N 次递减，并服从提示词里的产出配额） */
function scavengePayload(userPrompt) {
  const text = String(userPrompt)
  const m = text.match(/同一地点第\s*(\d+)\s*次搜刮/)
  const depth = m ? Number(m[1]) : 1
  // 产出配额（0 表示本次注定空手；缺省按无限处理，兼容旧调用）
  const q = text.match(/本次最多产出\s*(\d+)\s*件/)
  const zeroQuota = /本次允许产出 0 件/.test(text)
  const quota = zeroQuota ? 0 : q ? Number(q[1]) : 99

  // 插曲判定：解析引擎写进提示词的触发与倾向，生成对应的离线插曲（危险 / 机遇各一支）
  const spTriggered = /本次触发插曲/.test(text)
  const spDanger = /danger（危险）/.test(text)
  let scavengeSpecial = { triggered: false, kind: 'chance', title: '', text: '' }
  let spDelta = {}
  let spConditions = []
  let spFlags = []
  if (spTriggered) {
    if (spDanger) {
      scavengeSpecial = {
        triggered: true,
        kind: 'danger',
        title: '货架后的那双眼睛',
        text: '（离线体验·插曲）你正把最底层的东西往外拖，头顶传来一声极轻的响动。抬头——货架背后蹲着一个人影，手里攥着一根撬棍，正一动不动地盯着你。你的手先于脑子做出了反应，整个人往旁边一滚，撬棍砸在你刚才跪着的位置，碎木屑溅了一脸。对方喘得比你还重，退了半步，像随时会再扑上来。',
      }
      spDelta = { hp: -6, sanity: -6, stamina: -3 }
      spConditions = ['左臂擦伤']
      spFlags = ['撞见盘踞此地的幸存者']
    } else {
      scavengeSpecial = {
        triggered: true,
        kind: 'chance',
        title: '夹层里的铁盒',
        text: '（离线体验·插曲）你伸手去够架子深处，指尖碰到一层松动的木板——不是原来的结构。你抠开它，后面是个巴掌大的空腔，塞着一只锈迹斑斑的铁盒。盒盖咬得很紧，你用匕首撬开，里面的东西让你屏住了呼吸：一把还带着机油味的车钥匙，和一张折了三折的手绘地图，几个位置被红笔圈过。',
      }
      spDelta = { sanity: 3 }
      spConditions = []
      spFlags = ['手绘地图上的红圈']
    }
  }

  // 把插曲并入 payload（所有分支共用；未触发时维持空结构）
  const withSpecial = (p) => ({
    ...p,
    stateDelta: { ...(p.stateDelta || {}), ...spDelta },
    conditionsAdd: [...(p.conditionsAdd || []), ...spConditions],
    flagsAdd: [...(p.flagsAdd || []), ...spFlags],
    scavengeSpecial,
  })

  // 配额为 0：必定空手（把"徒劳"写得有内容）
  if (quota === 0) {
    return withSpecial({
      narrative:
        '（离线体验）你在这地方翻了好一阵。柜门一扇扇拉开，抽屉一个个拽到底，连沙发坐垫底下都伸手摸过——除了一层黏手的灰，什么都没有。你捡起一只裂口的水杯看了看，又放回去；翻出一张泡烂的报纸，字迹早就化开了。你直起身，膝盖响了一声。这一趟，什么也没能带走。',
      stateDelta: { sanity: -2, stamina: -2 },
      conditionsAdd: [],
      conditionsRemove: [],
      inventoryAdd: [],
      inventoryRemove: [],
      flagsAdd: [],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: '离线体验：这次搜刮一无所获，主角继续赶路。',
      eventSummary: '一次徒劳的翻找',
      choices: [
        { id: 'A', text: '离开这里，继续赶路', basis: '抽屉和柜子都翻过了，这里已经没什么可拿的' },
        { id: 'B', text: '换个方向再找找', basis: '这一趟除了灰和泡烂的报纸，什么都没带走' },
        { id: 'C', text: '先歇一会儿，喘口气', basis: '直起身时膝盖响了一声，体力已经下去了' },
      ],
      isEnding: false,
      _mock: true,
    })
  }

  // 深度 >= 3，或配额只剩 1 件：基本翻空
  if (depth >= 3 || quota <= 1) {
    const found = quota >= 1 && depth < 3
    return withSpecial({
      narrative: found
        ? '（离线体验）你把同一个抽屉又拉开了一遍。上一次留下的灰印还在，说明确实是你自己翻的。这一趟只摸出一颗受潮的子弹，铜壳上已经起了绿锈。你把它攥在手里掂了掂，觉得它更像是个提醒，而不是收获。'
        : '（离线体验）你把同一个抽屉又拉开了一遍。上一次留下的灰印还在，说明确实是你自己翻的。里面只剩半截发霉的皮带和一枚生锈的图钉。你直起身，膝盖响了一声。这里已经被翻空了——继续待下去只是把后背暴露给黑暗。',
      stateDelta: { sanity: -1 },
      conditionsAdd: [],
      conditionsRemove: [],
      inventoryAdd: found ? [{ name: '受潮的子弹', category: '弹药', qty: 1, note: '底火可能已失效' }] : [],
      inventoryRemove: [],
      flagsAdd: [],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: found ? '离线体验：再次搜刮只翻到一颗受潮子弹。' : '离线体验：同一地点已翻空，主角继续赶路。',
      eventSummary: found ? '翻到一颗受潮的子弹' : '某处已被翻空',
      choices: [
        { id: 'A', text: '离开这里，继续赶路', basis: '抽屉和柜子都翻过了，这里已经没什么可拿的' },
        { id: 'B', text: '检查四周有没有被跟踪', basis: '同一处翻第二次，后背一直对着空处' },
        { id: 'C', text: '就地吃点东西补充体力', basis: '翻找耗了体力，包里未必还有能入口的东西' },
      ],
      isEnding: false,
      _mock: true,
    })
  }

  if (depth === 2) {
    return withSpecial({
      narrative:
        '（离线体验）第二次翻找的收获明显寒酸。柜台下面的纸箱里只有三颗受潮的子弹和一张撕掉一半的收据，收货人那一栏被人用笔狠狠划掉了。你把它反过来，背面潦草写着一串数字，像是门牌号，又像是某种编号。窗外，有什么东西踩碎了一块玻璃。',
      stateDelta: { hp: -3, stamina: -4, sanity: -2 },
      conditionsAdd: ['手掌擦伤'],
      conditionsRemove: [],
      inventoryAdd: quota >= 1 ? [{ name: '受潮的子弹', category: '弹药', qty: 3, note: '底火可能已经失效' }] : [],
      inventoryRemove: [],
      flagsAdd: ['纸条上的门牌号'],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: '离线体验：二次搜刮收获有限，捡到一张写着门牌号的残收据。',
      eventSummary: '二次搜刮翻出一张残收据',
      choices: [
        { id: 'A', text: '按门牌号找过去看看', basis: '收据背面有一串像门牌号的数字' },
        { id: 'B', text: '先躲开窗外的动静', basis: '窗外刚有东西踩碎了一块玻璃' },
        { id: 'C', text: '把子弹收好，立刻离开', basis: '三颗受潮子弹还攥在手里，底火未必好' },
      ],
      isEnding: false,
      _mock: true,
    })
  }

  // 首次搜刮：可能翻到有用物资（数量受配额约束）
  const full = [
    { name: '广谱抗生素', category: '药品', qty: 4, fits: '伤员', tradable: true, note: '铝箔完整，可延缓感染' },
    { name: '饮用水', category: '饮水', qty: 1, note: '保温杯里剩的半瓶' },
  ]
  const items = quota >= 2 ? full : full.slice(0, Math.max(0, quota))
  return withSpecial({
    narrative:
      '（离线体验）你蹲下来，把货架最底层的东西一样样拖出来。灰尘呛得你咳嗽，声音在空荡的店里回响。指尖碰到一个冰凉的东西——半盒没拆封的抗生素，铝箔还完整；旁边是一只裂了口的保温杯，里面竟然还剩小半瓶水，晃一晃，没有异味。你把它们塞进包里，心跳因为这点微小的收获而快了一拍。',
    stateDelta: { stamina: -6, sanity: 2 },
    conditionsAdd: [],
    conditionsRemove: [],
    inventoryAdd: items,
    inventoryRemove: [],
    flagsAdd: [],
    mutationsAdd: [],
    sideQuestsAdd: [],
    sideQuestsUpdate: [],
    memory: '离线体验：首次搜刮翻到抗生素与半瓶水。',
    eventSummary: '首次搜刮有所收获',
    choices: [
      { id: 'A', text: '趁天色还亮继续赶路', basis: '抗生素和半瓶水已经塞进包里，天还没黑透' },
      { id: 'B', text: '把水分给同行的伤员', basis: '保温杯里还剩小半瓶没有异味的水' },
      { id: 'C', text: '先找个地方处理手上的伤口', basis: '翻货架时手被灰和碎物蹭过' },
    ],
    isEnding: false,
    _mock: true,
  })
}

/** 离线体验：睡觉分支（恢复量按地点质量给；就地或危险局势会出事） */
function sleepPayload(userPrompt) {
  const text = String(userPrompt)
  const quality = /质量：稳固/.test(text) ? 3 : /质量：尚可/.test(text) ? 2 : /质量：勉强/.test(text) ? 1 : 0
  const placeMatch = text.match(/【睡觉地点】(.+?) · 质量/)
  const place = placeMatch ? placeMatch[1].trim() : '就地'
  const risky = quality <= 0 // 就地过夜 = 最危险的一档

  const base =
    quality >= 3
      ? { stamina: 68, sanity: 30, hp: 8 }
      : quality === 2
        ? { stamina: 52, sanity: 21, hp: 4 }
        : quality === 1
          ? { stamina: 40, sanity: 15, hp: 1 }
          : { stamina: 26, sanity: 9, hp: 0 }
  const delta = risky
    ? { stamina: Math.round(base.stamina * 0.6), sanity: -6, hp: -8 }
    : { ...base }

  const narration = risky
    ? '你把背抵在墙上，抱着膝盖合上眼。起初只是打盹，后来真的睡沉了——直到一声响把你从黑里拽出来。\n\n' +
      '是个罐头从货架上滚下来，也可能不是。你屏住呼吸听了很久，听见了呼吸声，而且不止你一个。' +
      '等你终于敢动，天已经灰蒙蒙亮了，指尖冻得发僵，而这一觉几乎没能把你从疲惫里拉出来。'
    : '你把门反锁，用一件外套垫住门缝，然后才允许自己坐下去、躺下。\n\n' +
      '睡意来得比预想中快。中途醒过一次——是风，或者别的什么——但四周安静得像一口井。' +
      '再睁眼时，天光已经沿着缝隙爬了进来，远处有人在说话，声音不慌不忙。\n\n' +
      '你活动了一下脖子，觉得力气回来了一些。'

  return {
    narration,
    stateDelta: delta,
    conditionsAdd: risky ? ['睡眠不足'] : [],
    conditionsRemove: [],
    inventoryAdd: [],
    inventoryRemove: [],
    alliesAdd: [],
    alliesUpdate: [],
    flagsAdd: [],
    mutationsAdd: [],
    sideQuestsAdd: [],
    mainQuestUpdate: {},
    // 在像样的落脚点安稳过了一夜，就把它记成已知的安全点
    sheltersAdd: quality >= 2 ? [{ name: place, quality, note: '门能从里面反锁，暂时没被人发现' }] : [],
    sheltersRemove: [],
    memory: `在${place}过了一夜（${risky ? '夜里出过事' : '相对安稳'}），天亮后继续行动。`,
    eventSummary: '过了一夜',
    choices: [
      { id: 'A', text: '先清点背包，确认还剩多少水和吃的', basis: '刚睡醒，还不知道这一夜有没有少东西', quest: 'new' },
      { id: 'B', text: '出门看看这条街现在的样子', basis: '天光已经沿着缝隙进来了', quest: 'new' },
      { id: 'C', text: '去城北，妹妹最后的位置就在那边', basis: '妹妹最后的定位仍指向城北', quest: 'main' },
      { id: 'D', text: '天亮后再搜一遍附近，总该安全些', basis: '天刚亮，夜里的动静暂时停了', quest: 'new' },
    ],
    isEnding: false,
    _mock: true,
  }
}

/** 离线体验：交出物品分支（对方反应由物品是否"适合交换"与接收方决定） */
function giveItemPayload(userPrompt) {
  const text = String(userPrompt)
  const m = text.match(/（交出物品）主角主动把背包里的 \*\*(.+?)\*\*（分类：(.+?)[，)）]/)
  const name = m ? m[1] : '某件物品'
  const category = m ? m[2] : '杂物'
  const tradable = /本身适合交换/.test(text)
  const allyMatch = text.match(/接收方是 「(.+?)」/)
  const receiver = allyMatch ? allyMatch[1] : '对方'

  // 有价值的物品：换来等价回报
  if (tradable || category === '药品' || category === '弹药') {
    return {
      narrative: `（离线体验）你把${name}放到${receiver}面前，没有先开口。${receiver}的视线在东西上停了两秒——这两秒里他飞快地把你从头到脚看了一遍，确认你手上没有武器，才伸手接过去。他转身从身后的包里摸出一样东西塞给你，动作快得像怕自己反悔。交易就是这么回事：双方都不说破自己有多需要对方手里的东西。`,
      stateDelta: { sanity: 2 },
      conditionsAdd: [],
      conditionsRemove: [],
      inventoryAdd: [{ name: '半盒受潮的压缩饼干', category: '食物', qty: 1, note: '对方用它换的', fits: '所有人', tradable: true }],
      inventoryRemove: [name],
      alliesAdd: [],
      alliesUpdate: [{ name: receiver, status: '交易对象', note: `用压缩饼干换走了你的${name}` }],
      alliesRemove: [],
      flagsAdd: [`人情·与${receiver}的一次交易`],
      mutationsAdd: [],
      sideQuestsAdd: [],
      sideQuestsUpdate: [],
      memory: `离线体验：把${name}交给${receiver}，换回一份压缩饼干。`,
      eventSummary: `与${receiver}做成一笔交易`,
      choices: [
        { id: 'A', text: '收好东西，立刻离开', basis: '对方塞过来的东西还没看清' },
        { id: 'B', text: '趁机打听城北的消息', basis: '交易刚做成，对方还没转身走' },
        { id: 'C', text: '问他还需要什么', basis: '他接东西前先看了你手上有没有武器' },
      ],
      isEnding: false,
      _mock: true,
    }
  }

  // 无甚价值的杂物：对方敷衍 / 甚至反手抢夺
  return {
    narrative: `（离线体验）你把${name}递过去，${receiver}接在手里翻来覆去看了两眼，脸上什么表情都没有。他把它随手塞进兜里，既没说谢谢，也没说不要。空气僵了几秒，远处传来一声闷响，他借机转过身去。你忽然明白，在这条路上，有些东西交出去就再也换不回来了——但你已经交出去了。`,
    stateDelta: { sanity: -3 },
    conditionsAdd: [],
    conditionsRemove: [],
    inventoryAdd: [],
    inventoryRemove: [name],
    alliesAdd: [],
    alliesUpdate: [],
    alliesRemove: [],
    flagsAdd: [`一笔没换来任何东西的付出·${receiver}`],
    mutationsAdd: [],
    sideQuestsAdd: [],
    sideQuestsUpdate: [],
    memory: `离线体验：把${name}交给${receiver}，什么也没换回来。`,
    eventSummary: `交给${receiver}的东西打了水漂`,
    choices: [
      { id: 'A', text: '算了，继续赶路', basis: '东西已经交出去了，对方什么都没给' },
      { id: 'B', text: '开口把话挑明', basis: '他把东西塞进兜里，既没道谢也没拒绝' },
      { id: 'C', text: '记下这张脸，以后再说', basis: '这笔付出什么都没换回来，你记住了他的脸' },
    ],
    isEnding: false,
    _mock: true,
  }
}

/** 离线体验：制作。成品已由引擎入包，这里只回一段动手的描写。 */
function craftPayload(userPrompt) {
  const m = String(userPrompt).match(/动手做一件东西：\*\*(.+?)\*\*/)
  const name = m ? m[1] : '一件东西'
  return {
    narrative: `（离线体验）你把材料摊在膝盖上，一件一件对上。做${name}不需要多少手艺，需要的是别让声音传出去。你停下来听了两次，楼道里只有自己的呼吸。做完的时候手指上留着一道新的口子，而那件东西躺在包口，能用。`,
    stateDelta: { stamina: -2 },
    conditionsAdd: [],
    inventoryAdd: [],
    inventoryRemove: [],
    flagsAdd: [],
    choices: [],
    memory: `离线体验：做成了${name}。`,
    eventSummary: `做成了${name}`,
    isEnding: false,
    _mock: true,
  }
}

/** 离线体验：交易成交。换手已由引擎完成。 */
function tradePayload(userPrompt) {
  const m = String(userPrompt).match(/把 \*\*(.+?)\*\* 交给了 \*\*(.+?)\*\*，换回 \*\*(.+?)\*\*/)
  const give = m ? m[1] : '一件东西'
  const who = m ? m[2] : '对方'
  const got = m ? m[3] : '另一件东西'
  return {
    narrative: `（离线体验）${who}接过${give}的时候没有看你的眼睛。他把${got}推过来，推到一半又停了一下，像是在算这笔账以后还值不值得再找你。最后他还是松了手。你们谁都没有说谢谢。`,
    stateDelta: { sanity: 1 },
    inventoryAdd: [],
    inventoryRemove: [],
    flagsAdd: [`人情·与${who}换过一次`],
    choices: [
      { id: 'A', text: '把换来的东西塞进背包最底下', basis: '东西已经到手，对方还没转身', quest: 'new' },
      { id: 'B', text: '问他城北现在还能不能过', basis: '他松手之前犹豫过一下', quest: 'main' },
      { id: 'C', text: '先离开这条街', basis: '这笔交易谁都没说谢谢', quest: 'new' },
    ],
    memory: `离线体验：用${give}向${who}换了${got}。`,
    eventSummary: `和${who}做成一笔交易`,
    isEnding: false,
    _mock: true,
  }
}

/** 离线体验：据点加固。加固件已由引擎记上。 */
function upgradePayload(userPrompt) {
  const m = String(userPrompt).match(/在 \*\*(.+?)\*\* 装上了 \*\*(.+?)\*\*/)
  const place = m ? m[1] : '落脚点'
  const what = m ? m[2] : '一件加固'
  return {
    narrative: `（离线体验）你在${place}忙了一个钟头，手上的${what}终于固定住了。做完之后你在门口站了一会儿，听外面有没有人被这阵动静引过来。没有。至少现在没有。`,
    stateDelta: { stamina: -4 },
    inventoryAdd: [],
    inventoryRemove: [],
    sheltersRemove: [],
    flagsAdd: [],
    choices: [],
    memory: `离线体验：在${place}装上了${what}。`,
    eventSummary: `${place}多了${what}`,
    isEnding: false,
    _mock: true,
  }
}

export function mockRespond(userPrompt = '') {
  const isOpening = /【阶段】开局/.test(userPrompt)
  const isEnding = /【触发原因】/.test(userPrompt)
  const isScavenge = /【搜刮次数】/.test(userPrompt)
  const isSleep = /【睡觉地点】/.test(userPrompt)
  const isGiveItem = /（交出物品）/.test(userPrompt)
  const isUseItem = /（使用物品）/.test(userPrompt)
  const isCraft = /动手做一件东西/.test(userPrompt)
  const isTrade = /交易成交/.test(userPrompt)
  const isUpgrade = /加固据点/.test(userPrompt)
  const isTravel = /【回合】[\s\S]{0,40}赶路/.test(userPrompt)
  const isKeep = /【回合】[\s\S]{0,40}赴约/.test(userPrompt)

  if (isEnding) return endingPayload()
  if (isTravel) {
    return {
      narration: '（离线体验）你顺着积水走完了这段路。到达的时候，裤脚是湿的，刚才那个地方的灯已经看不见了。',
      narrative: '（离线体验）你顺着积水走完了这段路。到达的时候，裤脚是湿的，刚才那个地方的灯已经看不见了。',
      stateDelta: {},
      choices: [
        { id: 'A', text: '先在门口听一听里面', basis: '门就在你面前', quest: 'main' },
        { id: 'B', text: '绕到这栋楼的后面', basis: '楼的侧面还有一条窄道', quest: 'new' },
        { id: 'C', text: '在台阶上把鞋里的水倒掉', basis: '鞋里灌进了积水', quest: 'new' },
      ],
      memory: '人：独自\n处：刚到的门口\n未了：门还没推\n账：无',
      eventSummary: '赶到了下一个地点，门还没推',
      isEnding: false,
    }
  }
  if (isKeep) {
    return {
      narration: '（离线体验）约定的地方只剩一张被坐过的塑料椅。椅面上有一点还没干的水印，人已经不在了。',
      narrative: '（离线体验）约定的地方只剩一张被坐过的塑料椅。椅面上有一点还没干的水印，人已经不在了。',
      stateDelta: { sanity: -4 },
      choices: [
        { id: 'A', text: '在椅子旁边再等一会儿', basis: '椅子上的水印还没干', quest: 'main' },
        { id: 'B', text: '把椅子翻过来看看', basis: '这张塑料椅是这里唯一被动过的东西', quest: 'new' },
        { id: 'C', text: '离开这个空着的地方', basis: '约定的人已经不在椅子上', quest: 'new' },
      ],
      memory: '人：独自\n处：约定地点的塑料椅\n未了：人没等到\n账：无',
      eventSummary: '赴约时人已经离开',
      isEnding: false,
    }
  }
  if (isScavenge) return scavengePayload(userPrompt)
  if (isSleep) return sleepPayload(userPrompt)
  if (isCraft) return craftPayload(userPrompt)
  if (isTrade) return tradePayload(userPrompt)
  if (isUpgrade) return upgradePayload(userPrompt)
  if (isGiveItem) return giveItemPayload(userPrompt)
  if (isUseItem) return useItemPayload(userPrompt)

  if (isOpening) {
    turnCount = 0
    return {
      protagonist: {
        name: '林默',
        background: '市政档案馆夜班文员，习惯和纸堆打交道，此刻正陪发烧的室友在医院挂水。',
        goal: '找到失联的妹妹，并弄清这到底是什么病。',
      },
      location: '城南 · 市立医院 · 急诊走廊',
      timeOfDay: '21:40',
      mainQuest: { title: '寻妹', stage: '刚在医院目睹第一起撕咬事件', note: '妹妹最后一条短信定位在城北' },
      stats: { hp: 92, hunger: 25, thirst: 30, sanity: 78, stamina: 88, infection: 0 },
      inventory: [
        { name: '手机', category: '工具', qty: 1, note: '信号只剩一格，电量 34%' },
        { name: '充电宝', category: '工具', qty: 1 },
        { name: '钥匙串', category: '工具', qty: 1, note: '上面挂着一把折叠小刀' },
        { name: '降压药', category: '药品', qty: 1, fits: '高血压患者', tradable: true, note: '处方药，只剩一粒' },
      ],
      conditions: [],
      allies: [],
      flags: ['目标：找到失联的妹妹'],
      memory: '爆发第 1 天夜里 21:40，林默在市立医院急诊走廊目睹第一起撕咬事件，妹妹失联。',
      eventSummary: '医院急诊出现第一起撕咬事件',
      // 开局：急诊走廊正发生撕咬、人群奔逃——显然没有余裕停下来翻找
      safeToScavenge: false,
      unsafeReason: '丧尸正在撕咬',
      // 初始落脚点：会成为玩家夜里睡觉的候选
      sheltersAdd: [
        { name: '医院值班室', quality: 1, note: '能反锁，但窗户朝着停车场，声音挡不住' },
        { name: '城南出租屋', quality: 2, note: '门锁还能用，离医院三站地' },
      ],
      narration: NARRATIONS[0],
      // 开局尚无支线：选项只能标 "main"（推进主线）或 "new"（先自保 / 探索）。
      // 选项刻意"势均力敌"——没有一眼可辨的正确项；B 还特意写了剧透副词「果断地」，
      // 用于验证引擎侧的去剧透兜底（polishChoiceText 会把它摘掉）。
      choices: [
        { id: 'A', text: '推开安全通道的门，先离开这一层', basis: '安全通道的门就在走廊这一头', quest: 'main' },
        { id: 'B', text: '果断地抓起墙上的灭火器迎上去', basis: '墙上挂着灭火器，眼前正有人在撕咬', quest: 'new' },
        { id: 'C', text: '退回诊室，把门反锁上', basis: '你是从诊室这边退出来的，门还在身后', quest: 'main' },
        { id: 'D', text: '拽上那个还在发愣的护士一起走', basis: '护士还站在原地发愣，没有跑', quest: 'new' },
      ],
      isEnding: false,
    }
  }

  // 回合推进
  turnCount += 1

  // 第 6 回合：感染值触顶。**不主动声明 isEnding**，用于验证"强制尸化结局"兜底链路
  if (turnCount >= 6) {
    return {
      narration: '（离线体验）伤口处的青灰色已经蔓延到整条手臂。你听见自己的心跳慢了下来，而某种别的东西正在接管它。',
      stateDelta: { infection: 100 },
      conditionsAdd: ['感染·临界尸化'],
      memory: '离线体验流程触发尸化。',
      eventSummary: '感染值触顶',
      choices: [{ id: 'A', text: '（继续）', basis: '眼前的状况还没结束' }],
      isEnding: false,
    }
  }

  return {
    location: turnCount % 2 === 0 ? '城南 · 临街便利店' : '城南 · 市立医院 · 住院部',
    timeCostHours: 1.5, // 每回合推进约 1.5 个游戏小时（24 小时制）
    // 局势危险度：离线流程刻意让第 2 回合"危险"，其余回合"安全"，
    // 以便自检同时覆盖"安全搜刮"与"危险时仍可搜刮（代价自负）"两条路径。
    safeToScavenge: turnCount !== 2,
    unsafeReason: turnCount === 2 ? '疾行者正在靠近' : '',
    stateDelta: { hp: -4, hunger: 5, thirst: 6, sanity: -3, stamina: -8, infection: turnCount >= 2 ? 9 : 0 },
    conditionsAdd: turnCount === 2 ? ['左臂划伤', '感染·潜伏期'] : turnCount % 3 === 0 ? ['轻微擦伤'] : [],
    conditionsRemove: [],
    inventoryAdd:
      turnCount % 2 === 0
        ? [{ name: '生锈的铁钉', category: '杂物', qty: 3, note: '也许能当简易陷阱的材料' }]
        : turnCount === 1
          ? [{ name: '医用纱布卷', category: '药品', qty: 2, note: '从消防柜里翻出来的' }]
          : [],
    inventoryRemove: [],
    alliesAdd: turnCount % 5 === 0 ? [{ name: '未知的幸存者', status: '保持距离', note: '在对楼顶向你打信号' }] : [],
    alliesUpdate: [],
    alliesRemove: [],
    flagsAdd: [],
    appointmentsAdd: turnCount === 3 ? [{ who: '老周', note: '天亮在后门等', inHours: 6 }] : [],
    mutationsAdd:
      turnCount === 3
        ? [
            {
              name: '疾行者 · 夜行亚种',
              traits: '对光极度敏感，黑暗中移动速度翻倍，会主动追踪光源',
              note: '城南市立医院',
            },
          ]
        : [],
    mainQuestUpdate:
      turnCount === 1
        ? { stage: '逃出急诊楼，正沿住院部向西门移动', note: '住院部护士提到城北安置点' }
        : turnCount === 4
          ? { stage: '已离开医院，向城北方向推进', note: '便利店的收音机提到城北在收容幸存者' }
          : turnCount === 5
            ? {
                stage: '抵达城北安置点外围——妹妹的定位就在这栋楼里',
                note: '安置点已被废弃，但楼里有人活动的痕迹',
                status: 'done',
              }
            : undefined,
    // 主线在离线流程的第 5 回合达成 → 同一次输出里必须给出新主线（任务链闭环）
    mainQuestNew:
      turnCount === 5
        ? {
            title: '楼里的人',
            stage: '安置点里还有活人，但门是从里面锁上的',
            note: '门缝里透出微弱的灯光',
          }
        : null,
    // 支线：夜晚偏"尸"与"恐惧"，白天偏"人"；且必须从主线派生
    sideQuestsAdd:
      turnCount === 1
        ? [
            {
              title: '药房里的敲击声',
              hook: '安全通道尽头的药房门后传来规律的敲击',
              giver: '被困的值班护士',
              note: '门后有人，但不确定是否已被咬',
            },
          ]
        : turnCount === 4
          ? [
              {
                title: '老人和他的妻子',
                hook: '便利店里一个老人求你带上他瘫痪的妻子',
                giver: '姓陈的老人',
                note: '他们占着一辆还能发动的面包车',
              },
            ]
          : turnCount === 5
            ? [
                {
                  title: '门后的灯',
                  hook: '安置点的大门从里面锁着，门缝里透出灯光',
                  giver: '不肯开门的陌生人',
                  note: '要先弄清里面是谁、为什么锁门',
                },
              ]
            : [],
    sideQuestsUpdate:
      turnCount === 4
        ? [{ title: '药房里的敲击声', status: 'done', note: '你打开了门——她还没被咬' }]
        : [],
    memory: '林默仍在城南活动，正逐步向城北推进，身后有不明势力跟随。',
    eventSummary: `第 ${turnCount} 段离线事件`,
    // ⚠ 离线通道第 4 回合演示「消耗需玩家点头」：提出请求而不直接扣除，
    //    引擎会把它渲染成一条带 ⚠ 的选项，玩家点了才真正扣减（供自检覆盖该链路）。
    consumeRequest:
      turnCount === 4 ? { name: '充电宝', reason: '给快没电的手电续上最后一格电' } : undefined,
    narration: NARRATIONS[turnCount % NARRATIONS.length],
    // 选项标注它服务于哪条任务线：第 2/3 回合可推进「药房里的敲击声」，第 5 回合起可推进「门后的灯」。
    // 选项刻意"势均力敌"：B 听起来最省事、最安全（钻进没锁的车），却正是一类典型陷阱。
    choices: (() => {
      const activeSide = turnCount === 2 || turnCount === 3 ? '药房里的敲击声' : turnCount >= 5 ? '门后的灯' : null
      const list = [
        { id: 'A', text: '沿主路继续往城北走', basis: '主线仍指向城北，主路就在眼前', quest: 'main' },
        { id: 'B', text: '钻进路边那辆没锁的面包车', basis: '路边停着一辆没锁的面包车', quest: 'new' },
      ]
      list.push(
        activeSide
          ? { id: 'C', text: '先去处理：' + activeSide, basis: '这条支线还没了结。上一步就是冲着它来的', quest: activeSide }
          : { id: 'C', text: '朝那名幸存者打个手势', basis: '对楼顶有人在向你打信号', quest: 'new' },
      )
      return list
    })(),
    isEnding: false,
    _mock: true,
  }
}
