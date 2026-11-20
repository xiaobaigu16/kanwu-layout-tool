/* 导出 PDF（纯前端 / 离线 / 不弹打印对话框）
 *
 * 思路：预览里的每一页 DOM 由浏览器原生渲染成一张高清 JPEG，
 *       再把图片按页组装成一个真正的 PDF 文件直接下载。
 *   - 中文、双栏、竖排标签、二维码、绿色标签等版式无需嵌入字体，所见即所得
 *   - 「预览」与「导出 PDF」共用同一批页面图片，看到什么就导出什么
 *   - 依赖本地 vendor/html-to-image.js，不联网、不需要服务器
 */
const ExportPdf = (() => {
  // v3.4 P10：PDF 太糊 / 放大失真的根因是栅格化密度太低（v3.3 固定 144 DPI + JPEG 0.92）。
  // 改为可选档位，默认印刷级 300 DPI + JPEG 0.96；页面物理尺寸（216×303mm）始终不变，
  // DPI 只影响每页位图的像素数（放大清晰度）。仍为位图 PDF，极限倍率会见到像素边界。
  const DPI_LEVELS = [144, 216, 300];
  let DPI = 300;
  const JPEG_Q = 0.96;
  const MM_PT = 72 / 25.4;               // mm -> PDF point
  const MM_PX96 = 96 / 25.4;             // mm -> 96dpi px（预览显示尺寸）

  let cache = null;                      // { key, images:[{dataUrl,w,h}] }
  let zoom = 1;

  function setDpi(v) {
    const n = parseInt(v, 10);
    const val = DPI_LEVELS.indexOf(n) >= 0 ? n : 300;
    if (val !== DPI) { DPI = val; cache = null; }   // 换档强制重新栅格化
  }
  function getDpi() { return DPI; }

  // v3.5 V1：真矢量 PDF —— 走浏览器打印引擎。
  // 关键：预览按 SCALE(0.72) 缩放，JS 把几何/字号/装饰都乘了 SCALE 写成 inline 变量。
  // 若直接打印，.page 仍是 587px(≈155mm)，而纸张 216mm，内容会缩在左上、大片留白。
  // 因此打印前按 1/SCALE 等比例放大所有变量（分页已由 JS 按 SCALE 排定，等比例放大
  // 不改变换行/分页），打印后由 afterprint 还原。字号 --fs→1、装饰 --zs→1/BASE。
  function computePrintGeom() {
    const cs = getComputedStyle(document.documentElement);
    const fs = parseFloat(cs.getPropertyValue('--fs')) || 0.72;   // 当前 SCALE
    const k = fs > 0 ? 1 / fs : 1;
    const vars = ['--pw', '--ph', '--mt', '--mb', '--ml', '--mr', '--col-gap',
      '--tab-w', '--tab-h', '--tab-x', '--qr', '--qr-x', '--qr-y', '--full-inset'];
    let decl = '';
    vars.forEach(v => {
      const n = parseFloat(cs.getPropertyValue(v));
      if (!isNaN(n)) decl += v + ':' + (n * k).toFixed(3) + 'px!important;';
    });
    const zsNow = parseFloat(cs.getPropertyValue('--zs')) || 1;
    decl += '--fs:1!important;--zs:' + (zsNow / fs).toFixed(5) + '!important;';
    const pg = (window.App && App.state && App.state.page) || null;
    const pageRule = pg ? '@page{size:' + pg.w + 'mm ' + pg.h + 'mm;margin:0}' : '';
    return { decl, pageRule, scale: fs, k };
  }
  function printVector() {
    if (!pageEls().length) throw new Error('还没有可导出的页面，请先上传稿件');
    const g = computePrintGeom();
    const st = document.createElement('style');
    st.id = '__printGeom';
    st.textContent = g.pageRule + '@media print{:root{' + g.decl + '}}';
    document.head.appendChild(st);
    const cleanup = () => { if (st.parentNode) st.parentNode.removeChild(st); };
    window.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(cleanup, 120000);   // 兜底：某些浏览器不派发 afterprint
    try { window.print(); } catch (e) { cleanup(); throw e; }
  }

  function $(id) { return document.getElementById(id); }
  function pageEls() { return Array.from(document.querySelectorAll('#preview .page')); }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  // 内容指纹：文字改动 / 页面几何改动都会让它变化，避免导出到旧缓存
  function pageKey() {
    const p = App.state.page;
    const els = pageEls();
    return els.length + '|' + els.map(e => hashStr(e.innerHTML)).join(',') + '|' +
      [p.w, p.h, p.mt, p.mb, p.ml, p.mr, p.cols, p.lineH].join(',') + '|' +
      'dpi' + DPI + '|' + hashStr(document.documentElement.style.cssText);
  }

  // 生成一份「可截图」的页面副本：去掉编辑属性、把图注输入框换成普通文字、去掉纸张阴影
  function makeSnapshotHost() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;z-index:-1;opacity:1;pointer-events:none;';
    document.body.appendChild(host);
    return host;
  }
  function cleanClone(el) {
    const c = el.cloneNode(true);
    c.style.boxShadow = 'none';
    // v3.2：辅助线、溢出红框只属于编辑器画布，不能进导出的 PDF
    c.classList.remove('show-guides', 'page-overflow');
    c.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
    // v3.3：质检定位高亮不能进导出 PDF
    c.querySelectorAll('.qa-flash').forEach(n => n.classList.remove('qa-flash'));
    c.querySelectorAll('[data-cap]').forEach(inp => {
      const span = document.createElement('span');
      span.textContent = inp.textContent || '';
      // 成品标注：小字加粗黑字居中（与模板 .blk.caption / .cap-text 一致）
      span.style.cssText = 'display:block;font-size:calc(9pt * var(--fs));color:#222;' +
        'font-weight:700;text-align:center;margin:4px auto 0;max-width:80%';
      inp.replaceWith(span);
    });
    return c;
  }

  async function renderPages(force) {
    const key = pageKey();
    if (!force && cache && cache.key === key) return cache.images;
    const h2i = window.htmlToImage;
    if (!h2i || typeof h2i.toJpeg !== 'function') {
      throw new Error('缺少本地组件 vendor/html-to-image.js');
    }
    const p = App.state.page;
    const targetW = Math.max(1, Math.round(p.w * DPI / 25.4));
    const targetH = Math.max(1, Math.round(p.h * DPI / 25.4));
    const els = pageEls();
    if (!els.length) throw new Error('没有可导出的页面');

    const host = makeSnapshotHost();
    const images = [];
    try {
      for (const el of els) {
        const clone = cleanClone(el);
        host.appendChild(clone);
        const w = clone.offsetWidth || el.offsetWidth;
        const h = clone.offsetHeight || el.offsetHeight;
        const dataUrl = await h2i.toJpeg(clone, {
          quality: JPEG_Q,
          backgroundColor: '#ffffff',
          width: w,
          height: h,
          pixelRatio: targetW / w,
          skipFonts: true,
          skipAutoScale: true
        });
        images.push({ dataUrl, w: targetW, h: targetH });
        host.removeChild(clone);
      }
    } finally {
      host.remove();
    }
    cache = { key, images };
    return images;
  }

  // ---------- 组装 PDF（每页一张 JPEG，DCTDecode 直接嵌入，无需额外库） ----------
  function dataUrlBytes(u) {
    const b64 = u.slice(u.indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function buildPdf(images, wPt, hPt) {
    const enc = new TextEncoder();
    const chunks = [];
    let length = 0;
    const push = v => {
      const b = typeof v === 'string' ? enc.encode(v) : v;
      chunks.push(b); length += b.length;
    };
    const offsets = {};
    const N = images.length;
    const total = 2 + N * 3;

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // 二进制标记

    offsets[1] = length;
    push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    const kids = images.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
    offsets[2] = length;
    push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${N} >>\nendobj\n`);

    images.forEach((im, i) => {
      const pageNum = 3 + i * 3, contentNum = pageNum + 1, imageNum = pageNum + 2;
      const W = wPt.toFixed(2), H = hPt.toFixed(2);
      const jpeg = dataUrlBytes(im.dataUrl);

      offsets[pageNum] = length;
      push(`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${W} ${H}] ` +
        `/Resources << /XObject << /Im0 ${imageNum} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
        `/Contents ${contentNum} 0 R >>\nendobj\n`);

      const stream = `q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`;
      offsets[contentNum] = length;
      push(`${contentNum} 0 obj\n<< /Length ${enc.encode(stream).length} >>\nstream\n`);
      push(stream);
      push('endstream\nendobj\n');

      offsets[imageNum] = length;
      push(`${imageNum} 0 obj\n<< /Type /XObject /Subtype /Image ` +
        `/Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      push(jpeg);
      push('\nendstream\nendobj\n');
    });

    const xrefStart = length;
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= total; n++) {
      xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  // ---------- 预览弹窗 ----------
  function applyZoom() {
    const box = $('pmPages');
    if (box) box.style.transform = `scale(${zoom})`;
    const info = $('pmInfo');
    if (info && cache && cache.images.length) {
      info.textContent = `共 ${cache.images.length} 页 · ${App.state.page.w}×${App.state.page.h}mm · ${DPI} DPI · 缩放 ${Math.round(zoom * 100)}% · 与导出的 PDF 一致`;
    }
  }
  function fitZoom() {
    const scroll = $('pmScroll');
    const w = App.state.page.w * MM_PX96;
    const avail = (scroll ? scroll.clientWidth : 900) - 64;
    zoom = Math.max(0.3, Math.min(1, avail / Math.max(1, w)));
    applyZoom();
  }
  function closePreview() {
    const m = $('previewModal');
    if (m) m.hidden = true;
  }

  async function preview() {
    const modal = $('previewModal');
    const pages = $('pmPages');
    modal.hidden = false;
    pages.innerHTML = '<div class="pm-loading">正在逐页生成 PDF 效果预览…</div>';
    $('pmInfo').textContent = '正在生成…';
    try {
      const images = await renderPages(false);
      pages.innerHTML = '';
      const cssW = App.state.page.w * MM_PX96;
      images.forEach(im => {
        const img = document.createElement('img');
        img.className = 'pm-page';
        img.src = im.dataUrl;
        img.style.width = cssW + 'px';
        pages.appendChild(img);
      });
      fitZoom();
    } catch (e) {
      console.error(e);
      pages.innerHTML = '<div class="pm-loading">预览生成失败：' + U.escapeHtml(e.message || e) + '</div>';
      $('pmInfo').textContent = '生成失败';
    }
  }

  async function run() {
    U.toast('正在生成 PDF 文件，请稍候…');
    try {
      const images = await renderPages(false);
      const p = App.state.page;
      const blob = buildPdf(images, p.w * MM_PT, p.h * MM_PT);
      U.download(blob, '刊物内页_' + Date.now() + '.pdf');
      U.toast(`PDF 已导出（${images.length} 页 · ${DPI} DPI 高清）`);
    } catch (e) {
      console.error(e);
      U.toast('PDF 生成失败：' + (e.message || '未知错误'));
    }
  }

  function bindPreviewUI() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('pmClose', closePreview);
    on('pmZoomIn', () => { zoom = Math.min(2, zoom + 0.1); applyZoom(); });
    on('pmZoomOut', () => { zoom = Math.max(0.3, zoom - 0.1); applyZoom(); });
    on('pmZoomFit', fitZoom);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('previewModal') && !$('previewModal').hidden) closePreview();
    });
  }

  // 脚本置于 body 末尾，元素已就绪；兼容异步加载场景
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindPreviewUI);
  } else {
    bindPreviewUI();
  }

  return { run, preview, buildPdf, renderPages, closePreview, setDpi, getDpi, printVector, computePrintGeom };
})();
// 顶层 const 不自动成为 window 属性；显式挂载供 Share 只读预览等跨模块调用
window.ExportPdf = ExportPdf;
