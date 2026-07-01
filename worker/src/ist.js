// IST = UTC + 5:30
export function getIST(timestamp) {
  const utc = new Date(timestamp || Date.now());
  const ist = new Date(utc.getTime() + 5.5 * 60 * 60 * 1000);
  const hh = ist.getUTCHours();
  const mm = ist.getUTCMinutes();
  return {
    date: ist.toISOString().split('T')[0],
    time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    totalMinutes: hh * 60 + mm,
    dayOfWeek: ist.getUTCDay(), // 0=Sun 6=Sat
    ist
  };
}

export function isWeekday(ist) { return ist.dayOfWeek >= 1 && ist.dayOfWeek <= 5; }
export function isMarketOpen(ist) { return isWeekday(ist) && ist.totalMinutes >= 9 * 60 && ist.totalMinutes <= 15 * 60 + 35; }
