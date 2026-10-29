export function formatTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${md} ${formatTime(iso)}`;
}

export function statusText(status?: string): string {
  switch (status) {
    case 'signed':
      return '已签到';
    case 'makeup':
      return '已补签';
    case 'unsigned':
      return '未签到';
    case 'absent':
      return '缺勤';
    case 'active':
      return '进行中';
    default:
      return status || '未知';
  }
}