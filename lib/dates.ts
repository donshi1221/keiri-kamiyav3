import { getDaysInMonth } from 'date-fns'
import { formatInTimeZone } from 'date-fns-tz'

export const TZ = 'Asia/Tokyo'

export function nowJST(): Date {
  const jstStr = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd')
  const [y, m, d] = jstStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function getLastDayOfMonth(year: number, month: number): number {
  return getDaysInMonth(new Date(year, month - 1))
}

export function isInReminderWindow(today: number, deadlineDay: number): boolean {
  return today >= deadlineDay - 3
}

export type DueState = 'upcoming' | 'inWindow' | 'overdue' | 'done'

export function getDueState(
  day: number,
  dueDay: number,
  doneAt: string | Date | null | undefined,
  windowDays = 3
): DueState {
  if (doneAt) return 'done'
  if (day > dueDay) return 'overdue'
  if (day >= dueDay - windowDays) return 'inWindow'
  return 'upcoming'
}

export function getDueDates(year: number, month: number) {
  const lastDay = getLastDayOfMonth(year, month)
  return {
    day10: new Date(year, month - 1, 10),
    day15: new Date(year, month - 1, 15),
    day20: new Date(year, month - 1, 20),
    day25: new Date(year, month - 1, 25),
    lastDay: new Date(year, month - 1, lastDay),
  }
}
