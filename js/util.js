/* 通用工具函数 */
const U = (() => {
  const MM_TO_TWIPS = 1440 / 25.4;   // 1mm = 56.6929 twips
  const MM_TO_PX = 96 / 25.4;        // 96dpi 下 1mm 的像素
  const MM_TO_EMU = 36000;           // 1mm = 36000 EMU

  function uid(prefix = 'id') {
    return prefix + '_' + Math.random().toString(36).slice(2, 9);
  }
  function mmToTwips(mm) { return Math.round(mm * MM_TO_TWIPS); }
  function mmToPx(mm, scale = 1) { return Math.round(mm * MM_TO_PX * scale); }
  function mmToEmu(mm) { return Math.round(mm * MM_TO_EMU); }

  function escapeXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 从文件名提取排序序号（取前导数字，无则用整串比较）
  function sortKey(name) {
    const base = name.replace(/\.[^.]+$/, '');
    const m = base.match(/(\d+)/);
    if (m) return [parseInt(m[1], 10), base];
    return [Infinity, base];
  }
  function compareSort(a, b) {
    const ka = U.sortKey(a), kb = U.sortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
  }
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  return { uid, mmToTwips, mmToPx, mmToEmu, escapeXml, escapeHtml,
           sortKey, compareSort, toast, download };
})();
