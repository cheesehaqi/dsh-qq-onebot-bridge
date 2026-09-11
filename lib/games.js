/**
 * In-group text mini-games (文字小游戏): idiom chain (成语接龙) and guess-the-number.
 * Pure state machines — no timers, no I/O, no dependencies — so the host can drive
 * them from a single message handler and unit-test them with an injected clock.
 *
 * Design notes:
 *   - All user-visible strings are Chinese, because they are sent to QQ verbatim.
 *   - Timeouts are evaluated lazily on the next tryAnswer() call against the injected
 *     `now()` clock, so tests can jump time without waiting.
 */

/** Built-in idiom dictionary (四字成语). Deliberately broad in first/last characters so a chain can run. */
export const DEFAULT_IDIOMS = [
  // 一
  '一鸣惊人', '一心一意', '一帆风顺', '一举两得', '一路平安', '一目了然', '一丝不苟',
  '一表人才', '一见如故', '一见钟情', '一望无际', '一落千丈', '一败涂地', '一鼓作气',
  '一网打尽', '一诺千金', '一日千里', '一飞冲天', '一石二鸟', '一箭双雕', '一本正经',
  '一臂之力',
  // 不
  '不耻下问', '不劳而获', '不约而同', '不甘示弱', '不屈不挠', '不假思索', '不速之客',
  '不辞辛劳', '不言而喻', '不翼而飞', '不三不四', '不欢而散', '不同凡响', '不知所措',
  '不胫而走', '不谋而合', '不遗余力', '不足为奇',
  // 天
  '天长地久', '天下无双', '天衣无缝', '天翻地覆', '天罗地网', '天真烂漫', '天涯海角',
  '天经地义', '天马行空', '天壤之别',
  // 心
  '心花怒放', '心旷神怡', '心平气和', '心照不宣', '心安理得', '心领神会', '心心相印',
  '心口如一', '心明眼亮', '心甘情愿',
  // 大
  '大器晚成', '大同小异', '大惊小怪', '大显身手', '大快人心', '大公无私', '大名鼎鼎',
  '大功告成', '大起大落', '大展宏图',
  // 人
  '人山人海', '人才辈出', '人声鼎沸', '人杰地灵', '人定胜天', '人云亦云', '人尽皆知',
  '人来人往', '人财两空',
  // 山
  '山清水秀', '山穷水尽', '山盟海誓', '山高水长', '山明水秀',
  // 水
  '水到渠成', '水落石出', '水深火热', '水泄不通', '水乳交融', '水滴石穿',
  // 风
  '风和日丽', '风花雪月', '风雨同舟', '风声鹤唳', '风起云涌', '风驰电掣', '风调雨顺',
  '风平浪静', '风生水起', '风华正茂',
  // 花
  '花好月圆', '花团锦簇', '花言巧语', '花枝招展', '花红柳绿', '花花世界',
  // 日 / 月
  '日新月异', '日积月累', '日理万机', '日上三竿', '日暮途穷', '月下老人', '月明星稀',
  // 生 / 无 / 有 / 自 / 中
  '生龙活虎', '生机勃勃', '生死存亡', '无微不至', '无与伦比', '无中生有', '无独有偶',
  '无所不能', '无能为力', '无穷无尽', '无忧无虑', '有条不紊', '有始有终', '有备无患',
  '有口皆碑', '有目共睹', '有气无力', '自由自在', '自食其力', '自强不息', '自言自语',
  '中流砥柱', '中西合璧',
  // 上 / 下 / 来 / 去
  '上善若水', '上下其手', '上行下效', '上下一心', '上蹿下跳', '下不为例', '下笔成章',
  '来日方长', '来去自如', '去伪存真', '去粗取精',
  // 千 / 万
  '千军万马', '千锤百炼', '千方百计', '千变万化', '千钧一发', '千言万语', '千载难逢',
  '千辛万苦', '万紫千红', '万无一失', '万众一心', '万古长青', '万苦千辛',
  // 马 / 龙 / 鱼
  '马到成功', '马不停蹄', '马首是瞻', '快马加鞭', '龙飞凤舞', '龙马精神', '龙凤呈祥',
  '龙争虎斗', '龙腾虎跃', '鱼目混珠', '鱼贯而入', '鱼龙混杂',
  // 长链支撑
  '语重心长', '龙潭虎穴', '虎头蛇尾', '尾大不掉', '掉以轻心', '怡然自得', '得不偿失',
  '失之交臂', '肘腋之患', '患得患失', '失道寡助',
  // 其他常见四字成语
  '胸有成竹', '竹报平安', '安居乐业', '业精于勤', '勤能补拙', '拙口笨腮', '首屈一指',
  '指鹿为马', '口若悬河', '河东狮吼', '吼天喊地', '地大物博', '博古通今', '今非昔比',
  '比翼双飞', '飞黄腾达', '达官贵人', '事倍功半', '半途而废', '废寝忘食', '食古不化',
  '化险为夷', '夷然自若', '若即若离', '离乡背井', '井井有条', '条分缕析', '西风残照',
  '照本宣科', '科班出身', '身临其境', '境由心造', '造化弄人', '志同道合', '合情合理',
  '理直气壮', '壮志凌云', '云淡风轻', '轻而易举', '举一反三', '三心二意', '意气风发',
  '发扬光大', '大显神通', '神通广大', '地久天长', '长驱直入', '入木三分', '分道扬镳',
  '及时行乐', '乐不思蜀', '蜀犬吠日', '日进斗金', '金玉良言', '言而有信', '信以为真',
  '真相大白', '白手起家', '家喻户晓', '晓以大义', '义不容辞', '辞旧迎新', '新陈代谢',
  '谢天谢地', '精益求精', '安然无恙', '明日黄花', '河清海晏', '晏然自若', '气吞山河',
  '河山带砺', '川流不息', '息事宁人', '名副其实', '实事求是', '是非曲直', '直言不讳',
  '讳莫如深', '深入浅出', '出人意料', '料事如神', '守株待兔', '兔死狐悲', '悲欢离合',
  '亲密无间', '间不容发', '珠联璧合', '两全其美', '美不胜收', '收放自如', '如鱼得水',
  '开门见山', '顾此失彼', '彼竭我盈', '盈科后进', '进退两难', '难能可贵', '贵人多忘',
  '忘乎所以', '以身作则', '则天顺民', '光天化日', '光阴似箭', '箭在弦上', '万众瞩目',
  '目不转睛', '睛如点漆', '东张西望', '望眼欲穿', '穿针引线', '开花结果', '果不其然',
  '风卷残云', '画蛇添足', '足智多谋', '谋事在人', '雪中送炭', '雨过天晴', '晴空万里',
  '里应外合', '脱口而出', '情投意合', '调兵遣将', '将心比心', '强词夺理', '广开言路',
  '高瞻远瞩', '远走高飞', '作茧自缚', '甘拜下风', '妙手回春', '春风得意', '意气相投',
  '投桃报李', '李代桃僵', '首当其冲', '冲锋陷阵', '肝胆相照', '照猫画虎', '名不虚传',
  '方兴未艾', '爱不释手', '手忙脚乱', '乱七八糟', '助人为乐', '恋恋不舍', '色厉内荏',
  '忍无可忍', '变本加厉', '非同小可', '可歌可泣', '泣不成声', '声东击西', '苦尽甘来',
  '急转直下', '朝气蓬勃', '勃然大怒', '怒发冲冠', '冠冕堂皇', '皇天后土', '土生土长',
  '长年累月', '知难而进', '声名远扬', '扬长避短', '短兵相接', '接踵而至', '至理名言',
  '自由散漫', '漫不经心', '迫不及待', '待人接物', '物极必反', '反败为胜', '胜利在望',
  '望梅止渴', '渴骥奔泉',
  // 接龙常用连接词
  '海阔天空', '海纳百川', '海底捞针', '空前绝后', '后来居上', '仁至义尽', '空穴来风',
  '空口无凭', '上下交困', '对答如流', '返老还童', '童心未泯', '药到病除',
]

/** Strip surrounding quotes/punctuation and whitespace from a candidate answer. */
function normalizeIdiom(text) {
  return String(text ?? '').replace(/^[\s"'「『（(]+/, '').replace(/[\s"'」』）)。，！？!?、；;：:~～]+$/, '').trim()
}

/** A candidate is only accepted when it is exactly four Chinese characters. */
function isFourCharIdiom(text) {
  return /^[\u4e00-\u9fa5]{4}$/.test(text)
}

/** 成语接龙状态机：单群一个实例，由宿主消息处理器喂养。 */
export class IdiomChain {
  #words
  #timeoutMs
  #now
  #active = false
  #current = ''
  #used = new Set()
  #lastAt = 0

  /** words 可换成自定义词库；timeoutMs 为两次成功之间的宽容时间；now 可注入时钟便于测试。 */
  constructor({ words = DEFAULT_IDIOMS, timeoutMs = 120000, now = () => Date.now() } = {}) {
    const list = (Array.isArray(words) ? words : []).map((w) => String(w).trim()).filter((w) => w !== '')
    this.#words = [...new Set(list)]
    this.#timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000
    this.#now = typeof now === 'function' ? now : () => Date.now()
  }

  get active() {
    return this.#active
  }

  /** 玩家现在该接的那一句；未开局时为空串。 */
  get current() {
    return this.#active ? this.#current : ''
  }

  /** 已用过的成语数量（含开局那一条）。 */
  get usedCount() {
    return this.#used.size
  }

  /** 开局：随机挑一个成语作为首个，并标记为已用；返回该成语。 */
  start(rng = Math.random) {
    if (this.#words.length === 0) return ''
    const pick = typeof rng === 'function' ? rng : Math.random
    const index = Math.min(this.#words.length - 1, Math.max(0, Math.floor(pick() * this.#words.length)))
    const first = this.#words[index]
    this.#active = true
    this.#current = first
    this.#used = new Set([first])
    this.#lastAt = this.#now()
    return first
  }

  /** 结束本局。 */
  stop() {
    this.#active = false
    this.#current = ''
    this.#used = new Set()
    this.#lastAt = 0
  }

  /**
   * 接一句。返回 { ok, reason, next }：
   * ok=false 时 next 为空串；ok=true 且词库接不下去时 next 也为空串（reason 会说明）。
   *
   * 规则就是标准成语接龙：`#current` 是「桌面上最后一句成语」，玩家必须接
   * `#current[3]` 开头的四字成语；接对后机器人从词库挑一个以玩家末字开头的成语
   * 作为 `next`（同时计入已用），并把 `#current` 换成它。
   */
  tryAnswer(text) {
    if (!this.#active) return { ok: false, reason: '现在没有在玩接龙哦，发「接龙」开始一局吧', next: '' }
    if (this.#now() - this.#lastAt > this.#timeoutMs) {
      this.stop()
      return { ok: false, reason: '接龙超时啦', next: '' }
    }

    const answer = normalizeIdiom(text)
    if (!isFourCharIdiom(answer)) return { ok: false, reason: '这不是四字成语哦', next: '' }
    if (!this.#words.includes(answer)) return { ok: false, reason: '词库里没有这个成语', next: '' }

    const tail = this.#current[3]
    if (answer[0] !== tail) return { ok: false, reason: `首字要接「${tail}」哦`, next: '' }
    if (this.#used.has(answer)) return { ok: false, reason: '这个已经用过啦', next: '' }

    this.#used.add(answer)
    this.#lastAt = this.#now()

    const candidates = this.#words.filter((w) => w[0] === answer[3] && !this.#used.has(w))
    const next = candidates.length === 0
      ? ''
      : candidates[Math.min(candidates.length - 1, Math.floor(Math.random() * candidates.length))]
    if (next === '') {
      this.#current = answer
      return { ok: true, reason: '接得漂亮，不过我想不出下一个啦', next: '' }
    }
    // 机器人接的这句同样计入已用，否则玩家可以拿它再顶一次。
    this.#used.add(next)
    this.#current = next
    return { ok: true, reason: '接上啦', next }
  }
}

/** 猜数字状态机：答案在构造时确定。 */
export class GuessNumber {
  #min
  #max
  #maxTries
  #answer
  #tries = 0
  #active = true

  constructor({ min = 1, max = 100, maxTries = 10, rng = Math.random } = {}) {
    const lo = Number.isFinite(min) ? Math.trunc(min) : 1
    const hi = Number.isFinite(max) ? Math.trunc(max) : 100
    this.#min = Math.min(lo, hi)
    this.#max = Math.max(lo, hi)
    this.#maxTries = Number.isFinite(maxTries) && maxTries > 0 ? Math.trunc(maxTries) : 10
    const pick = typeof rng === 'function' ? rng : Math.random
    const span = this.#max - this.#min + 1
    this.#answer = this.#min + Math.min(span - 1, Math.max(0, Math.floor(pick() * span)))
  }

  get active() {
    return this.#active
  }

  get tries() {
    return this.#tries
  }

  get range() {
    return { min: this.#min, max: this.#max }
  }

  /** 猜一次；非纯数字输入返回 ok:false、hint:''，且不计次数。 */
  guess(text) {
    if (!this.#active) return { ok: false, hint: '', tries: this.#tries, exhausted: true }
    const raw = String(text ?? '').trim().replace(/^[\/／]\s*/, '').replace(/^猜\s*/, '').trim()
    if (!/^\d+$/.test(raw)) return { ok: false, hint: '', tries: this.#tries }
    const n = Number(raw)
    this.#tries += 1
    if (n < this.#min || n > this.#max) {
      const outOfRange = this.#tries >= this.#maxTries
      if (outOfRange) this.#active = false
      return { ok: false, hint: '', tries: this.#tries, ...(outOfRange ? { answer: this.#answer, exhausted: true } : { exhausted: false }) }
    }
    if (n === this.#answer) {
      this.#active = false
      return { ok: true, hint: 'correct', tries: this.#tries, answer: this.#answer }
    }
    if (this.#tries >= this.#maxTries) {
      this.#active = false
      return { ok: false, hint: '', tries: this.#tries, answer: this.#answer, exhausted: true }
    }
    return { ok: false, hint: n < this.#answer ? 'bigger' : 'smaller', tries: this.#tries, exhausted: false }
  }

  /** 公布答案（放弃或次数用尽）。 */
  reveal() {
    this.#active = false
    return this.#answer
  }
}

/** 识别开局意图；返回 'idiom' | 'guess' | null。 */
export function parseGameStartIntent(text) {
  const t = String(text ?? '').trim().replace(/^[\/／]\s*/, '')
  if (t === '') return null
  if (/^猜数字[!！。~～]*$/.test(t)) return 'guess'
  if (/^成语接龙[!！。~～]*$/.test(t)) return 'idiom'
  if (/^(?:来|想|要|开始|继续|玩|再来|一起)?\s*(?:玩|来|开始|继续)?\s*接龙[!！。~～]*$/.test(t)) return 'idiom'
  if (/^(?:来|想|要|开始|继续|一起)?\s*(?:玩|来|开始|继续)?\s*猜数字[!！。~～]*$/.test(t)) return 'guess'
  if (/^[^，,。？?]{0,3}猜数字[!！。~～]*$/.test(t)) return 'guess'
  if (/^[^，,。？?]{0,3}(?:成语|词语)?接龙[!！。~～]*$/.test(t)) return 'idiom'
  return null
}

/** 识别结束意图；返回 boolean。 */
export function parseGameStopIntent(text) {
  const t = String(text ?? '').trim()
  if (t === '') return false
  if (/^[\/／]\s*(?:结束|停止|结束游戏|停止游戏|不玩了|退出游戏)[!！。~～\s]*$/.test(t)) return true
  return /^(?:不玩了|不玩啦|结束游戏|结束啦|结束|停止游戏|停止|退出游戏|游戏结束|收工)[!！。~～\s]*$/.test(t)
}
