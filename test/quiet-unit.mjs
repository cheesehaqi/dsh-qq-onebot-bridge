/** Unit-test quiet-hours parsing and weekday/peak detection. */
import { parseQuietRanges, isQuietTime } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// Fix the clock: Date passed in as "now" so the checks are deterministic.
// 2026-09-02 is a Wednesday.
function at(iso) { return new Date(iso) }

const ranges = parseQuietRanges(['9:00-12:00', '14:00-18:00'])
check('parse two ranges', ranges.length === 2, JSON.stringify(ranges))
check('range1 start 540', ranges[0]?.start === 540)
check('range1 end 720', ranges[0]?.end === 720)
check('range2 start 840', ranges[1]?.start === 840)
check('range2 end 1080', ranges[1]?.end === 1080)

const on = { quietHoursEnabled: true, quietWeekendExempt: true }
const off = { quietHoursEnabled: false, quietWeekendExempt: true }

check('disabled never quiet', !isQuietTime(off, ranges, at('2026-09-02T10:00:00+08:00')))
check('weekday 10:00 quiet', isQuietTime(on, ranges, at('2026-09-02T10:00:00+08:00')))
check('weekday 9:00 boundary quiet', isQuietTime(on, ranges, at('2026-09-02T09:00:00+08:00')))
check('weekday 11:59 quiet', isQuietTime(on, ranges, at('2026-09-02T11:59:00+08:00')))
check('weekday 12:00 end exclusive', !isQuietTime(on, ranges, at('2026-09-02T12:00:00+08:00')))
check('weekday 13:00 gap not quiet', !isQuietTime(on, ranges, at('2026-09-02T13:00:00+08:00')))
check('weekday 15:30 quiet', isQuietTime(on, ranges, at('2026-09-02T15:30:00+08:00')))
check('weekday 17:59 quiet', isQuietTime(on, ranges, at('2026-09-02T17:59:00+08:00')))
check('weekday 18:00 end exclusive', !isQuietTime(on, ranges, at('2026-09-02T18:00:00+08:00')))
check('weekday 8:59 not quiet', !isQuietTime(on, ranges, at('2026-09-02T08:59:00+08:00')))
check('weekday 20:00 not quiet', !isQuietTime(on, ranges, at('2026-09-02T20:00:00+08:00')))

// 2026-09-05 is a Saturday, 2026-09-06 a Sunday.
check('saturday exempt', !isQuietTime(on, ranges, at('2026-09-05T10:00:00+08:00')))
check('sunday exempt', !isQuietTime(on, ranges, at('2026-09-06T15:00:00+08:00')))
const noExempt = { quietHoursEnabled: true, quietWeekendExempt: false }
check('saturday quiet when exempt off', isQuietTime(noExempt, ranges, at('2026-09-05T10:00:00+08:00')))

// Full-width characters from QQ input get normalized.
const fullWidth = parseQuietRanges(['９：００－１２：００'])
check('full-width parsed', fullWidth.length === 1 && fullWidth[0].start === 540 && fullWidth[0].end === 720, JSON.stringify(fullWidth))

// Malformed ranges are skipped, valid ones survive.
const mixed = parseQuietRanges(['9:00-12:00', 'not-a-range', '9:75-10:00', '12:00-12:00', ''])
check('malformed skipped', mixed.length === 1 && mixed[0].start === 540, JSON.stringify(mixed))

// Overnight window wraps midnight.
const overnight = parseQuietRanges(['22:00-2:00'])
check('overnight 23:00 quiet', isQuietTime(on, overnight, at('2026-09-02T23:00:00+08:00')))
check('overnight 1:00 quiet', isQuietTime(on, overnight, at('2026-09-02T01:00:00+08:00')))
check('overnight 12:00 not quiet', !isQuietTime(on, overnight, at('2026-09-02T12:00:00+08:00')))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
