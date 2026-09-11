/**
 * Fortune module (今日人品 / 运势 / 抽签 / 塔罗): deterministic, dependency-free
 * pseudo-fortune generation for QQ chats.
 *
 * Everything is derived from sha256(userId + '|' + local YYYY-MM-DD + '|' + salt),
 * so the same (userId, day) always yields the exact same answer and a new day
 * yields a new one. Math.random() is never used here, which also makes the whole
 * module trivially unit-testable.
 *
 * Score tiers (分档阈值):
 *   >= 90 大吉 | >= 75 中吉 | >= 55 小吉 | >= 30 末吉 | < 30 凶
 */
import { createHash } from 'node:crypto'

function pad(n) { return String(n).padStart(2, '0') }

/** 本地时区日期键，形如 '2024-05-01'。 */
export function todayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(d.getTime())) return todayKey(new Date())
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 确定性哈希：同样的 (userId, day, salt) 永远得到同样的 32 位无符号整数。 */
function hash32(userId, day, salt) {
  const src = `${String(userId ?? '')}|${String(day)}|${String(salt)}`
  return createHash('sha256').update(src, 'utf8').digest().readUInt32BE(0)
}

/** 从数组里按哈希位置确定性取值。 */
function pickWith(list, n) {
  return list[((n % list.length) + list.length) % list.length]
}

const LUCKY_COLORS = [
  '珊瑚橙', '鲸蓝', '月光白', '海盐绿', '晚霞粉', '墨玉黑', '柠檬黄', '雾紫',
  '沙滩金', '深海靛', '薄荷青', '枫叶红', '珍珠灰', '浪花银', '极光绿'
]

/** 今日人品分档标签。 */
const LABELS = [
  { min: 90, label: '大吉' },
  { min: 75, label: '中吉' },
  { min: 55, label: '小吉' },
  { min: 30, label: '末吉' },
  { min: 0, label: '凶' }
]

const BIG_LUCK_COMMENTS = [
  '今天尾巴拍水花的力气特别足，想做啥就去做吧。',
  '海面全是金色的光，你说的话今天格外有人听。',
  '喷起的水柱能到三层楼高，运气好到藏不住。',
  '今天你就是这片海里最靓的那条鱼，放手去浪。',
  '顺风又顺水，连小鱼干都会自己游到你嘴边。',
  '今天的你自带音效，走到哪儿都是背景音乐。',
  '运气像涨潮一样涌过来，记得接住别客气。',
  '今天的你人见人爱，连海鸥都想跟你合影。',
  '在水里转三圈也晕不了，今天做什么都稳。',
  '今天的鲸歌特别好听，别人听了都想给你点赞。',
  '万事皆宜，唯一不宜的就是谦虚。'
]

const MID_LUCK_COMMENTS = [
  '浪不大不小，正好够你舒舒服服地漂一天。',
  '今天的运气够用，但建议别一次花完。',
  '水温刚好，鱼群刚好，今天适合慢一点。',
  '有一点点小顺，攒着做正事最合适。',
  '今天的风稍稍帮你推了一把，剩下的靠自己划。',
  '海面平静，适合把欠下的活儿都清一清。',
  '运气平平但心态很贵，今天先笑再说。',
  '今天遇到的鱼都挺友善，可以多聊两句。',
  '不算大旺，但小惊喜大概有两三个。',
  '今天的洋流很温柔，顺着走不会累。',
  '该来的都会来，只是会慢半拍。'
]

const LOW_LUCK_COMMENTS = [
  '今天的浪有点拧巴，出门记得多带一份耐心。',
  '海况一般，先把简单的事做完，难的明天再说。',
  '今天水有点浑，看不清的时候就别急着跳。',
  '运气在打盹，别去招惹珊瑚礁。',
  '今天适合待在礁石后面观察，出去浪容易撞墙。',
  '小心脚下，今天的海胆好像特别多。',
  '今天不太顺，但喝口水再试一次往往就好了。',
  '海流逆着走，硬游会很累，绕个弯吧。',
  '今天风大，旗子别举太高。',
  '运气欠费了，记得省着点用。',
  '今天适合当观众，主角让给别人。'
]

function labelFor(score) {
  return (LABELS.find((t) => score >= t.min) ?? LABELS[LABELS.length - 1]).label
}

/**
 * 今日人品：确定性的分数 + 幸运色 + 幸运数字 + 俏皮点评。
 * score 0-100，label 见文件头分档表。
 */
export function dailyFortune(userId, name = '', now = new Date()) {
  const day = todayKey(now)
  const h = hash32(userId, day, 'fortune')
  const score = 12 + (h % 89) // 12..100
  const luckyColor = pickWith(LUCKY_COLORS, hash32(userId, day, 'color'))
  const luckyNumber = 1 + (hash32(userId, day, 'number') % 99)
  const pool = score >= 75 ? BIG_LUCK_COMMENTS : score >= 55 ? MID_LUCK_COMMENTS : LOW_LUCK_COMMENTS
  const comment = pickWith(pool, hash32(userId, day, 'comment'))
  return {
    score,
    label: labelFor(score),
    luckyColor,
    luckyNumber,
    comment: name ? `${name}：${comment}` : comment
  }
}

/** 仿寺庙签库（12 支）。 */
const LOTS = [
  {
    level: '上上签',
    title: '鲸吞万里',
    poem: '海阔凭鱼跃，天高任鸟飞；\n一朝风浪起，直上九万里。',
    advice: '所求皆遂，放开手去做，别自己给自己上锁。'
  },
  {
    level: '上上签',
    title: '潮生明月',
    poem: '潮生沧海月，光照满船归；\n旧愿今朝了，新程次第开。',
    advice: '旧事将了、新事将成，把握这两天的机会。'
  },
  {
    level: '上签',
    title: '顺风张帆',
    poem: '风来帆自满，水阔路偏长；\n莫问几时到，行舟即是乡。',
    advice: '方向对了就别急着算距离，继续划就是。'
  },
  {
    level: '上签',
    title: '明珠出水',
    poem: '明珠藏海底，一朝出水来；\n识者争相看，光价自难裁。',
    advice: '你身上有还没被看见的东西，主动拿出来给人看。'
  },
  {
    level: '上签',
    title: '群鱼绕舟',
    poem: '群鱼绕舟戏，浪静不生尘；\n贵人近在侧，何须问远津。',
    advice: '帮你的多半是身边熟人，开口求助并不丢人。'
  },
  {
    level: '中签',
    title: '潮平岸阔',
    poem: '潮平两岸阔，风正一帆悬；\n但行平稳路，何必问神仙。',
    advice: '没有大风大浪，按部就班就是最好的策略。'
  },
  {
    level: '中签',
    title: '守礁待潮',
    poem: '潮来还复去，静坐看云生；\n待到春雷动，方知有日明。',
    advice: '时机未到，先把自己养好，别硬挤这扇门。'
  },
  {
    level: '中签',
    title: '半篓小鱼',
    poem: '半篓小鱼归，虽少亦可炊；\n莫嫌滋味淡，细品有甘回。',
    advice: '收获不算多，但都是你的，收着就好。'
  },
  {
    level: '中签',
    title: '雾里行舟',
    poem: '雾重舟难辨，声来知有人；\n徐徐随桨转，终见一溪春。',
    advice: '看不清就先慢下来，多问一句不亏。'
  },
  {
    level: '下签',
    title: '逆流而上',
    poem: '逆流舟自苦，力尽浪犹高；\n不如且收桨，泊岸待明朝。',
    advice: '现在硬顶会受伤，停一停，明天再游。'
  },
  {
    level: '下签',
    title: '网破鱼惊',
    poem: '网破鱼惊散，空手立斜阳；\n悔从贪处起，及早补疏防。',
    advice: '别贪最后一口，漏洞先补上再说别的。'
  },
  {
    level: '下下签',
    title: '浅滩搁舟',
    poem: '浅滩舟自搁，进退两为难；\n弃得船中物，方能入深湾。',
    advice: '该舍的舍掉，轻装才出得来。'
  }
]

/** 抽签：确定性抽一支庙签。 */
export function drawLot(userId, now = new Date()) {
  const day = todayKey(now)
  const h = hash32(userId, day, 'lot')
  const lot = pickWith(LOTS, h >>> 3)
  const seed = hash32(userId, day, 'lot-pick')
  return {
    level: lot.level,
    title: lot.title,
    poem: lot.poem,
    advice: lot.advice,
    ...(seed % 7 === 0 ? { note: '此签宜截图留存，据说截图的人三天内都有好事。' } : {})
  }
}

/** 大阿卡纳 22 张（中文牌名 + 正位/逆位解读）。 */
const TAROT = [
  { name: '愚者', upright: '新的开始与自由，大胆迈出第一步就好。', reversed: '想法太多却没落地，先挑一件做完。' },
  { name: '魔术师', upright: '你手里的资源已经够了，动手就能成事。', reversed: '别只会说漂亮话，缺的是执行那一下。' },
  { name: '女祭司', upright: '答案在你心里，安静下来就能听见。', reversed: '你在骗自己，把真正担心的说出来。' },
  { name: '皇后', upright: '被照顾也被喜欢，适合享受和滋养。', reversed: '照顾别人太多，自己先枯了。' },
  { name: '皇帝', upright: '立规矩、担责任，今天适合当主心骨。', reversed: '太想控制，反而把合作对象推远。' },
  { name: '教皇', upright: '按老办法来比较稳，请教经验者。', reversed: '老规矩解决不了新问题，该换个思路。' },
  { name: '恋人', upright: '关系升温，做选择时听从真心。', reversed: '摇摆不定最伤人，想清楚再表态。' },
  { name: '战车', upright: '目标明确就冲，行动力今天拉满。', reversed: '方向没对齐就猛冲，只会原地打滑。' },
  { name: '力量', upright: '用耐心而不是力气，温柔也能赢。', reversed: '情绪先绷不住了，先深呼吸再开口。' },
  { name: '隐者', upright: '适合独处复盘，别急着对外输出。', reversed: '闭门太久会钻牛角尖，找人聊聊。' },
  { name: '命运之轮', upright: '局势自己转起来了，顺势接住即可。', reversed: '时机差半步，硬上也只会白费力气。' },
  { name: '正义', upright: '讲道理就能赢，公平会被看见。', reversed: '别找借口，先承认自己那部分责任。' },
  { name: '倒吊人', upright: '换个角度看，坏事其实是暂停键。', reversed: '无意义的牺牲，该放手就放手。' },
  { name: '死神', upright: '旧的结束了，结束了才有新的位置。', reversed: '舍不得的那点东西正在拖住你。' },
  { name: '节制', upright: '分寸感是关键，不多不少刚刚好。', reversed: '冷热不均，作息和情绪都需要调一调。' },
  { name: '恶魔', upright: '诱惑很甜，看清代价再决定。', reversed: '你正在挣脱一个旧习惯，继续。' },
  { name: '高塔', upright: '突发变动会拆掉些东西，但露出真实地基。', reversed: '小震一下作为提醒，别等它塌。' },
  { name: '星星', upright: '希望回来了，许愿并做一点小事。', reversed: '信心有点低，先从最小的目标开始。' },
  { name: '月亮', upright: '信息不全，别把猜测当事实。', reversed: '误会快散了，真相这两天会浮上来。' },
  { name: '太阳', upright: '顺利又明亮，适合摊开来说清楚。', reversed: '开心打了折，别因为一点小瑕疵扫兴。' },
  { name: '审判', upright: '该做的决定别再拖，是时候回应召唤。', reversed: '你在躲避一个已知的答案。' },
  { name: '世界', upright: '一件事圆满收尾，可以准备下一段旅程。', reversed: '差最后一步，别在终点前松手。' }
]

/** 塔罗：确定性抽一张大阿卡纳，正逆位由哈希决定。 */
export function drawTarot(userId, question = '', now = new Date()) {
  const day = todayKey(now)
  const card = pickWith(TAROT, hash32(userId, day, 'tarot') % TAROT.length)
  const reversed = hash32(userId, day, 'tarot-rev') % 2 === 1
  return {
    name: card.name,
    reversed,
    meaning: reversed ? card.reversed : card.upright,
    question: String(question ?? '').trim()
  }
}

/** 今日人品文案（多行，可直接发 QQ）。 */
export function formatFortune(r) {
  return [
    '🐋 今日人品',
    `分数：${r.score}/100　评级：${r.label}`,
    `幸运色：${r.luckyColor}　幸运数字：${r.luckyNumber}`,
    `点评：${r.comment}`
  ].join('\n')
}

/** 抽签文案（多行，可直接发 QQ）。 */
export function formatLot(r) {
  const lines = [
    `🎋 求签结果：${r.level} · ${r.title}`,
    r.poem,
    `解签：${r.advice}`
  ]
  if (r.note) lines.push(`✨ ${r.note}`)
  return lines.join('\n')
}

/** 塔罗文案（多行，可直接发 QQ）。 */
export function formatTarot(r) {
  const pos = r.reversed ? '逆位' : '正位'
  const lines = [`🔮 塔罗牌：${r.name}（${pos}）`]
  if (r.question) lines.push(`问题：${r.question}`)
  lines.push(`解读：${r.meaning}`)
  return lines.join('\n')
}

/** 识别运势类意图：'fortune' | 'lot' | 'tarot' | null。 */
export function parseFortuneIntent(text) {
  const t = String(text ?? '').trim().replace(/^[\/／]/, '').replace(/[!！。.~～]+$/, '').trim()
  if (t === '') return null
  if (/^(今日)?人品(值|分|指数)?$/.test(t) || t === '运势' || t === '今日运势' || t === '今日运气' || t === '运气') return 'fortune'
  if (/^(抽签|求签|签诗|庙签|灵签)$/.test(t)) return 'lot'
  if (/^(塔罗|塔罗牌|抽塔罗|塔罗占卜|占卜)$/.test(t)) return 'tarot'
  return null
}
