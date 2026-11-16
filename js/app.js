/* 主程序：状态、渲染、交互编排（含刊物模板：竖排栏目标签/二维码/通栏+分栏混排/分组目录） */
const App = (() => {
  // 预览缩放：可变。页面几何、字号（--fs）、固定 px 装饰（--zs）全部随它同比变化，
  // 分页与导出仍按真实物理 mm 计算，所以换档不会影响排版结果与 PDF 尺寸。
  let SCALE = 0.72;
  const BASE_SCALE = 0.72;
  const MM_PX = 96 / 25.4;

  // 《2025年度雨露肝霖白皮书》实测版式常量（2026-11-09 用户确认）
  const COL_GAP_MM = 12.2;      // 双栏栏间距
  const TAB_W_MM = 8.9;         // 竖排栏目标签宽
  const TAB_H_MM = 38.1;        // 竖排栏目标签高
  const TAB_X_MM = 0;           // v3.4：栏目框完全贴页边（image4/6 标准样例），与标题拉开距离
  const QR_MM = 20;             // 二维码边长
  const QR_X_MM = 21;           // 二维码距页面右边
  // v3.2：二维码不再写死 y=24mm（旧值下半部压在编者按上）。改为与内容区顶 / 标题首行齐平，
  // 落在「标题水平带」内（标题两行约 16mm 高，二维码 20mm 到 y≈35mm，编者按约从 35.6mm 起）。
  const QR_Y_MM = 15;
  const FULL_INSET_MM = 10.9;   // 通栏区相对双栏左边界向左外扩（22.9 → 12mm）
  function fullInsetPx() { return FULL_INSET_MM * MM_PX * SCALE; }
  const PAGE_DEFAULT = { w: 216, h: 303, mt: 15, mb: 35, ml: 22.9, mr: 23.5,
                         cols: 1, lineH: 1.77, hdr: '', ftr: '', showNum: true };

  // 白皮书模板：文章标题 / 编者按导语 / 文献来源 / 文献截图 横跨整页宽，之后正文走双栏
  const FULL_TYPES = ['art-title', 'lead', 'cite-box'];
  const ALLOWED_TYPES = ['image', 'h1', 'h2', 'h3', 'body', 'caption', 'references',
                         'art-title', 'lead', 'cite-box', 'label-head', 'highlight'];

  const state = {
    page: Object.assign({}, PAGE_DEFAULT),
    docs: [],
    tocEnabled: true,
    tocEntries: [],
    blockMap: {},
    selectedDocId: null,
    showGuides: false,   // 03 章：分栏线 / 安全边距辅助线
    qaDoneIssues: [],    // v3.4：质检报告里用户勾选「已完成」的问题指纹
    // v3.3：三级栏目分类（可增删），一级决定竖排标签底色与目录分组
    categories: {
      l1: ['期刊导读', '数据阅独', '会议撷萃', '新药进展', '名家访谈', '项目进展'],
      l2: ['APASL', 'EASL', 'AASLD', '第十三届全国疑难及重症肝病大会'],
      l3: ['慢乙肝治疗相关', '慢乙肝合并脂肪肝相关', '慢乙肝疾病进展相关',
           '慢乙肝核苷停药相关', '慢乙肝治疗及疗效预测相关']
    },
  };

  let measureEl = null;
  let lastPageLabels = {}; // blockId -> 页码标签
  let lastLayout = null;   // v3.2：最近一次分页结果，供质检面板读取

  // 图片预加载：保证测量高度准确，且避免“每次渲染都触发 load→重新渲染”的死循环
  const imgReady = new Set();
  function ensureImages(srcs, cb) {
    const pending = [...new Set(srcs)].filter(s => s && !imgReady.has(s));
    if (pending.length === 0) { cb(); return; }
    let n = pending.length;
    pending.forEach(s => {
      const im = new Image();
      im.onload = im.onerror = () => { imgReady.add(s); if (--n === 0) cb(); };
      im.src = s;
    });
  }

  function $(id) { return document.getElementById(id); }

  // ============ v3.3：栏目配色 / 撤销还原 / 页面跳转 / 质检定位 ============
  const DEFAULT_CATEGORIES = {
    l1: ['期刊导读', '数据阅独', '会议撷萃', '新药进展', '名家访谈', '项目进展'],
    l2: ['APASL', 'EASL', 'AASLD', '第十三届全国疑难及重症肝病大会'],
    l3: ['慢乙肝治疗相关', '慢乙肝合并脂肪肝相关', '慢乙肝疾病进展相关',
         '慢乙肝核苷停药相关', '慢乙肝治疗及疗效预测相关']
  };
  // 一级栏目 → 竖排标签底色（前 3 个取自往期样例像素实测，后 3 个为可区分补色）
  const TAB_COLORS = {
    '期刊导读': '#5FAA31', '数据阅独': '#36A9CC', '会议撷萃': '#4174F2',
    '新药进展': '#E08A2E', '名家访谈': '#8B5CC7', '项目进展': '#C0506B'
  };
  function tabColorFor(doc) {
    const name = (doc && (doc.cat1 || doc.columnName)) || '';
    if (TAB_COLORS[name]) return TAB_COLORS[name];
    if (!name) return '#58A830';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h % 360) + ',52%,44%)';
  }

  // ---- 撤销 / 还原（快照式，15 步；内容无变化不记录） ----
  let undoStack = [], redoStack = [];
  let lastSig = null, lastSnapshot = null, historyRestoring = false;
  let pageNavTotal = 0;

  function stateSig() {
    let s = state.docs.length + '|' + state.tocEnabled + '|' +
            JSON.stringify(state.page) + '|' + JSON.stringify(state.categories) + '|';
    state.docs.forEach(d => {
      s += [d.id, d.name, d.columnName || '', d.cat1 || '', d.cat2 || '', d.cat3 || '',
            d.cols || '', d.qr ? 1 : 0, d.blocks.length].join(':') + ';';
      d.blocks.forEach(b => {
        s += [b.id, b.type, (b.html || '').length, b.caption || '', b.full ? 'F' : '',
              b.fontPt || '', b.align || ''].join(',') + '/';
      });
    });
    s += '|' + state.tocEntries.map(e =>
      [e.text, e.page, e.level, e.column, e.cat2, e.cat3].join('~')).join(';');
    return s;
  }
  function snapshot() {
    return JSON.parse(JSON.stringify({
      page: state.page, docs: state.docs, tocEnabled: state.tocEnabled,
      tocEntries: state.tocEntries, selectedDocId: state.selectedDocId,
      showGuides: state.showGuides, categories: state.categories,
      qaDoneIssues: state.qaDoneIssues
    }));
  }
  function updateHistoryButtons() {
    const u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }
  function applySnapshot(snap) {
    historyRestoring = true;
    state.page = Object.assign({}, PAGE_DEFAULT, snap.page || {});
    state.docs = snap.docs || [];
    state.tocEnabled = snap.tocEnabled !== false;
    state.tocEntries = snap.tocEntries || [];
    state.selectedDocId = snap.selectedDocId || null;
    state.showGuides = !!snap.showGuides;
    state.categories = Object.assign({}, DEFAULT_CATEGORIES, snap.categories || {});
    state.qaDoneIssues = Array.isArray(snap.qaDoneIssues) ? snap.qaDoneIssues.slice() : [];
    migrateImageCaptions();
    rebuildBlockMap();
    syncPageInputs();
    render();
    historyRestoring = false;
    lastSig = stateSig(); lastSnapshot = snapshot();
    updateHistoryButtons();
  }
  function undo() {
    if (!undoStack.length) { U.toast('没有可撤销的操作'); return; }
    redoStack.push(snapshot());
    applySnapshot(undoStack.pop());
    setStatus('已撤销上一步操作', 'busy');
  }
  function redo() {
    if (!redoStack.length) { U.toast('没有可还原的操作'); return; }
    undoStack.push(snapshot());
    applySnapshot(redoStack.pop());
    setStatus('已还原上一步操作', 'busy');
  }

  // ---- 文档 / 页面跳转 ----
  function scrollToDoc(docId) {
    const el = document.querySelector('#preview .page[data-doc-id="' + docId + '"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function scrollToPage(n) {
    const pages = document.querySelectorAll('#preview .page');
    if (!pages.length) return;
    const idx = Math.max(1, Math.min(pageNavTotal || pages.length, n || 1));
    const el = document.querySelector('#preview .page[data-page-no="' + idx + '"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const inp = $('navPage'); if (inp) inp.value = String(idx);
    if (el) updateNavDoc(el);
  }
  function updateNavDoc(pageEl) {
    const el = $('navDoc');
    if (el) el.textContent = pageEl ? (pageEl.getAttribute('data-doc-name') || '目录') : '—';
  }
  function syncNavFromScroll() {
    const scroller = $('previewScroll');
    if (!scroller) return;
    const pages = Array.from(document.querySelectorAll('#preview .page'));
    if (!pages.length) return;
    const base = scroller.getBoundingClientRect().top;
    let best = 0, bestD = Infinity;
    pages.forEach((p, i) => {
      const d = Math.abs(p.getBoundingClientRect().top - base - 24);
      if (d < bestD) { bestD = d; best = i; }
    });
    const inp = $('navPage');
    if (inp && document.activeElement !== inp) inp.value = String(best + 1);
    updateNavDoc(pages[best]);
  }
  function updatePageNav() {
    const pages = document.querySelectorAll('#preview .page');
    pageNavTotal = pages.length;
    const t = $('navTotal'); if (t) t.textContent = String(pages.length);
    const inp = $('navPage');
    if (inp) {
      inp.max = String(pages.length);
      if (+inp.value > pages.length) inp.value = String(pages.length || 1);
    }
    syncNavFromScroll();
  }

  // ---- 质检条目定位（报告 / 识别结果点击） ----
  function gotoQaTarget(g) {
    if (!g) return;
    const m = $('qaModal'); if (m) m.hidden = true;
    if (g.indexOf('block:') === 0) {
      const el = document.getElementById('blk-' + g.slice(6));
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('qa-flash');
        setTimeout(() => el.classList.remove('qa-flash'), 1900);
      } else U.toast('该段落未在预览中找到');
    } else if (g.indexOf('page:') === 0) {
      const n = parseInt(g.slice(5), 10);
      const toc = (lastLayout && lastLayout.tocPages) || 0;
      scrollToPage(toc + n);
    }
  }

  // 成品目录页码为三位补零（001 / 003 / 007）；手动填的非数字页码原样保留
  function fmtPage(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '—';
    return /^\d+$/.test(s) ? s.padStart(3, '0') : s;
  }

  function rebuildBlockMap() {
    state.blockMap = {};
    state.docs.forEach(d => d.blocks.forEach(b => { state.blockMap[b.id] = b; }));
  }

  // v3.4：图注统一为「紧随图片之后的独立 caption 块」。
  // 旧版把图注内嵌为图片块的 caption 字段，导致删图注=删整图、图注重复两行、IME 输入丢字。
  // 这里把残留的 caption 字段拆成独立块（幂等：迁移后删字段，重复调用不会叠加）。
  // 文字一律用 U.escapeHtml 包成纯文本，不改一字。
  function migrateImageCaptions() {
    state.docs.forEach(d => {
      const out = [];
      d.blocks.forEach(b => {
        out.push(b);
        if (b.type === 'image' && b.caption != null && String(b.caption).trim() !== '') {
          // 若其后已有 caption 块则不重复插入
          const nxt = d.blocks[d.blocks.indexOf(b) + 1];
          if (!nxt || nxt.type !== 'caption') {
            out.push({
              id: U.uid('blk'), type: 'caption',
              html: U.escapeHtml(String(b.caption)),
              align: 'center', pageBreakBefore: false, recog: 'ok'
            });
          }
          delete b.caption;
        } else if (b.type === 'image') {
          delete b.caption;
        }
      });
      d.blocks = out;
    });
  }

  function blockFull(b) {
    if (b.full === true || b.full === false) return b.full;
    return FULL_TYPES.includes(b.type);
  }
  function docCols(doc) {
    return (doc && doc.cols) ? doc.cols : (state.page.cols || 1);
  }
  function selectedDoc() {
    return state.docs.find(d => d.id === state.selectedDocId) || null;
  }

  // ---------- 渲染 ----------
  function setGeometryCss() {
    const p = state.page;
    const root = document.documentElement.style;
    const mm = v => (v * MM_PX * SCALE) + 'px';
    root.setProperty('--pw', mm(p.w));
    root.setProperty('--ph', mm(p.h));
    root.setProperty('--mt', mm(p.mt));
    root.setProperty('--mb', mm(p.mb));
    root.setProperty('--ml', mm(p.ml));
    root.setProperty('--mr', mm(p.mr));
    root.setProperty('--col-gap', mm(COL_GAP_MM));
    root.setProperty('--tab-w', mm(TAB_W_MM));
    root.setProperty('--tab-h', mm(TAB_H_MM));
    root.setProperty('--tab-x', mm(TAB_X_MM));
    root.setProperty('--qr', mm(QR_MM));
    root.setProperty('--qr-x', mm(QR_X_MM));
    root.setProperty('--qr-y', mm(QR_Y_MM));
    root.setProperty('--full-inset', fullInsetPx() + 'px');
    // 字号按页面缩放同比缩小；--zs 供模板里以 px 写的装饰元素同比缩放
    root.setProperty('--fs', String(SCALE));
    root.setProperty('--zs', String(SCALE / BASE_SCALE));
  }

  // 预览缩放换档：几何/字号全部重算，分页与导出不受影响
  function setPreviewScale(v) {
    const n = parseFloat(v);
    if (!n || n < 0.35 || n > 2) return;
    SCALE = n;
    render();
    setStatus(`预览缩放已设为 ${Math.round(n * 100)}%（排版与导出尺寸不变）`, 'busy');
  }

  function bodyWidthPx() {
    const p = state.page;
    return (p.w - p.ml - p.mr) * MM_PX * SCALE;
  }
  function contentHeightPx() {
    const p = state.page;
    return (p.h - p.mt - p.mb) * MM_PX * SCALE;
  }
  function columnWidthPx(cols) {
    const bw = bodyWidthPx();
    return cols === 1 ? bw : (bw - COL_GAP_MM * MM_PX * SCALE) / 2;
  }

  function makeBlockEl(block) {
    const el = document.createElement('div');
    el.className = 'blk ' + (block.type === 'image' ? 'imgblk' : block.type);
    el.setAttribute('data-block-id', block.id);
    el.setAttribute('data-type', block.type);
    el.setAttribute('contenteditable', 'true');
    if (block.type === 'image') {
      // v3.4：图片块只输出 <img>。图注改为紧随其后的独立 caption 块
      //（P7 可单独删 / P8 不重复 / P9 走普通块同步，输入法不再被打断）。
      el.innerHTML = `<img src="${block.src}" alt="">`;
    } else {
      el.innerHTML = block.html || '';
      if (block.lineHeight) el.style.lineHeight = block.lineHeight;
      if (block.align) el.style.textAlign = block.align;
      // 手动设过的字号 / 字体 / 颜色：用 calc(真实pt × --fs) 写入，预览缩放时自动跟随
      if (block.fontPt) {
        el.style.fontSize = `calc(${block.fontPt}pt * var(--fs))`;
        el.dataset.pt = String(block.fontPt);
      }
      if (block.fontFamily) el.style.fontFamily = block.fontFamily;
      if (block.color) el.style.color = block.color;
    }
    el.addEventListener('focusin', () => Editor.setCurrentBlock(el));
    el.addEventListener('input', () => syncBlock(el));
    el.addEventListener('blur', () => { syncBlock(el); scheduleRender(); });
    return el;
  }

  function syncBlock(el) {
    const id = el.getAttribute('data-block-id');
    const b = state.blockMap[id];
    if (!b) return;
    if (b.type === 'image') {
      // v3.4：图注已是独立块，图片块只同步 src
      b.src = el.querySelector('img') ? el.querySelector('img').src : b.src;
    } else {
      b.html = el.innerHTML;
      b.type = el.getAttribute('data-type') || 'body';
      b.align = el.style.textAlign || null;
      b.alignLocked = !!el.style.textAlign;
      b.lineHeight = el.style.lineHeight || null;
      b.fontPt = el.dataset.pt ? parseFloat(el.dataset.pt) : null;
      b.fontFamily = el.style.fontFamily || null;
      b.color = el.style.color || null;
    }
  }

  // v3.4 P9：中文输入法是「合成输入」，若在合成期间整体重建 DOM，
  // 未上屏文字与光标会被一起丢弃，表现为「字加上去后过一会就消失」。
  // 因此：合成中 / 焦点仍停在可编辑块内时，一律延后重绘，等失焦后再排。
  let composing = false;
  function scheduleRender() {
    clearTimeout(scheduleRender._t);
    const fire = () => {
      const ae = document.activeElement;
      const editing = ae && ae.isContentEditable &&
        ae.closest && ae.closest('#preview .blk');
      if (composing || editing) { scheduleRender._t = setTimeout(fire, 300); return; }
      render();
    };
    scheduleRender._t = setTimeout(fire, 350);
  }
  function bindCompositionGuard() {
    const pv = $('preview');
    if (!pv) return;
    pv.addEventListener('compositionstart', () => { composing = true; }, true);
    pv.addEventListener('compositionend', () => { composing = false; }, true);
  }

  // 成品正文统一两端对齐。旧逻辑按「拉丁字符占比 >42%」就改左对齐，
  // 导致同页里中文段两端对齐、含几个英文缩写的段左对齐，观感杂乱。
  // 现在只有「几乎全是拉丁/数字」的段落（纯英文参考文献等）才改左对齐，
  // 避免两端对齐把英文单词间的空格拉散；用户手动设过的一律不覆盖。
  function normalizeAlign() {
    state.docs.forEach(d => d.blocks.forEach(b => {
      if (b.type !== 'body' && b.type !== 'lead') return;
      if (b.alignLocked) return;   // v3.3：用户手动设过对齐，不再覆盖
      const t = (b.html || '').replace(/<[^>]+>/g, '');
      const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
      const latin = (t.match(/[A-Za-z0-9\s.,;:()%\-–—=+]/g) || []).length;
      const almostLatin = t.length > 0 && cjk <= 3 && latin / t.length > 0.85;
      b.align = almostLatin ? 'left' : 'justify';
    }));
  }

  function render() {
    // v3.3：内容真正变化才记一步历史；缩放 / 辅助线等显示切换不占位
    if (!historyRestoring && lastSig !== null) {
      const sig = stateSig();
      if (sig !== lastSig) {
        undoStack.push(lastSnapshot);
        if (undoStack.length > 15) undoStack.shift();
        redoStack.length = 0;
      }
    }
    migrateImageCaptions();
    normalizeAlign();
    setGeometryCss();
    renderDocList();
    renderDocProps();
    renderTocList();
    const srcs = [];
    state.docs.forEach(d => d.blocks.forEach(b => { if (b.type === 'image' && b.src) srcs.push(b.src); }));
    ensureImages(srcs, renderPreview);
    autoSave();
    lastSig = stateSig(); lastSnapshot = snapshot();
    updateHistoryButtons();
  }

  function renderDocList() {
    const ul = $('docList');
    ul.innerHTML = '';
    if (state.docs.length === 0) {
      ul.innerHTML = '<li class="doc-empty">（暂无文档，点「＋ 增加文档」或上传文件）</li>';
      return;
    }
    // v3.4 P1：固定「目录」定位项（不参与拖拽 / 删除 / 选中），点击直达目录页
    if (state.tocEnabled) {
      const tocLi = document.createElement('li');
      tocLi.className = 'doc-toc-entry';
      tocLi.innerHTML = `<span class="grip">📖</span><span class="doc-name">目录</span>` +
        `<span class="doc-toc-tag">定位</span>`;
      tocLi.addEventListener('click', () => {
        scrollToPage(1);
        setStatus('已跳到目录页（第 1 页）', 'busy');
      });
      ul.appendChild(tocLi);
    }
    state.docs.forEach((d, i) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.dataset.id = d.id;
      if (d.id === state.selectedDocId) li.classList.add('selected');
      li.innerHTML = `<span class="grip">⋮⋮</span>` +
        `<span class="doc-name">${U.escapeHtml(d.columnName ? '[' + d.columnName + '] ' : '')}${U.escapeHtml(d.name)}</span>` +
        `<button class="doc-del" title="删除该文档">✕</button>`;
      li.querySelector('.doc-del').addEventListener('click', ev => {
        ev.stopPropagation();
        deleteDoc(d.id);
      });
      li.addEventListener('click', () => {
        state.selectedDocId = d.id; render();
        scrollToDoc(d.id);
      });
      li.addEventListener('dragstart', () => li.classList.add('dragging'));
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', e => e.preventDefault());
      li.addEventListener('drop', e => {
        e.preventDefault();
        const fromId = document.querySelector('.doc-list li.dragging')?.dataset.id;
        if (!fromId || fromId === d.id) return;
        const fromIdx = state.docs.findIndex(x => x.id === fromId);
        const toIdx = state.docs.findIndex(x => x.id === d.id);
        const [m] = state.docs.splice(fromIdx, 1);
        state.docs.splice(toIdx, 0, m);
        render();
      });
      ul.appendChild(li);
    });
  }

  function renderDocProps() {
    const d = selectedDoc();
    const colName = $('docColName'), docCols = $('docCols');
    const qrPrev = $('qrPreview'), qrClear = $('btnQrClear');
    const sels = { l1: $('docCat1'), l2: $('docCat2'), l3: $('docCat3') };
    const keys = { l1: 'cat1', l2: 'cat2', l3: 'cat3' };
    const fill = (sel, list, val) => {
      if (!sel) return;
      const opts = [''].concat(list || []);
      if (val && opts.indexOf(val) < 0) opts.push(val);   // 自定义值不丢
      sel.innerHTML = opts.map(v =>
        `<option value="${U.escapeHtml(v)}">${U.escapeHtml(v || '（未分类）')}</option>`).join('');
      sel.value = val || '';
    };
    if (!d) {
      colName.value = ''; colName.disabled = true;
      docCols.value = '0'; docCols.disabled = true;
      Object.keys(sels).forEach(k => { if (sels[k]) { sels[k].innerHTML = ''; sels[k].disabled = true; } });
      qrPrev.hidden = true; qrClear.hidden = true;
      return;
    }
    colName.disabled = false; docCols.disabled = false;
    colName.value = d.columnName || '';
    docCols.value = d.cols ? String(d.cols) : '0';
    Object.keys(sels).forEach(k => {
      if (!sels[k]) return;
      sels[k].disabled = false;
      fill(sels[k], state.categories[k], d[keys[k]] || '');
    });
    if (d.qr) { qrPrev.src = d.qr; qrPrev.hidden = false; qrClear.hidden = false; }
    else { qrPrev.hidden = true; qrClear.hidden = true; }
  }

  function renderTocList() {
    const ul = $('tocList');
    ul.innerHTML = '';
    if (!state.tocEnabled) { ul.innerHTML = '<li class="toc-empty">（已关闭目录）</li>'; return; }
    if (state.tocEntries.length === 0) {
      ul.innerHTML = '<li class="toc-empty">（暂无标题可提取：正文中使用「文章标题」或一/二/三级标题样式后，点「重新提取」）</li>';
      return;
    }
    state.tocEntries.forEach((e, i) => {
      const li = document.createElement('li');
      li.className = 'toc-item';
      li.innerHTML =
        `<select class="toc-lvl" data-i="${i}" title="层级（决定缩进）">` +
          `<option value="h1"${e.level === 'h1' ? ' selected' : ''}>一级</option>` +
          `<option value="h2"${e.level === 'h2' ? ' selected' : ''}>二级</option>` +
          `<option value="h3"${e.level === 'h3' ? ' selected' : ''}>三级</option>` +
        `</select>` +
        `<input class="toc-text" data-i="${i}" value="${U.escapeHtml(e.text)}" placeholder="目录文字">` +
        `<input class="toc-page" data-i="${i}" value="${U.escapeHtml(e.page == null ? '' : e.page)}" size="3" title="页码（可手动改；清空则恢复自动）">` +
        `<span class="toc-acts">` +
          `<button data-act="up" data-i="${i}" title="上移">↑</button>` +
          `<button data-act="down" data-i="${i}" title="下移">↓</button>` +
          `<button data-act="jump" data-i="${i}" title="定位到正文">定位</button>` +
          (e.manualPage ? `<button data-act="reset" data-i="${i}" title="恢复自动页码">↺</button>` : '') +
          `<button data-act="del" data-i="${i}" title="删除该条目">✕</button>` +
        `</span>`;

      li.querySelector('.toc-lvl').addEventListener('change', ev => {
        state.tocEntries[i].level = ev.target.value; render();
      });
      li.querySelector('.toc-text').addEventListener('input', ev => {
        state.tocEntries[i].text = ev.target.value; scheduleRender();
      });
      const pg = li.querySelector('.toc-page');
      pg.addEventListener('input', ev => {
        const v = ev.target.value.trim();
        if (v === '') { state.tocEntries[i].manualPage = false; state.tocEntries[i].page = ''; }
        else { state.tocEntries[i].page = v; state.tocEntries[i].manualPage = true; }
        scheduleRender();
      });
      li.querySelector('[data-act="up"]').addEventListener('click', () => moveToc(i, -1));
      li.querySelector('[data-act="down"]').addEventListener('click', () => moveToc(i, 1));
      li.querySelector('[data-act="jump"]').addEventListener('click', () => { if (e.targetId) scrollToBlock(e.targetId); });
      li.querySelector('[data-act="del"]').addEventListener('click', () => { state.tocEntries.splice(i, 1); render(); });
      const rb = li.querySelector('[data-act="reset"]');
      if (rb) rb.addEventListener('click', () => { state.tocEntries[i].manualPage = false; state.tocEntries[i].page = ''; render(); });
      ul.appendChild(li);
    });
  }

  function moveToc(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= state.tocEntries.length) return;
    const a = state.tocEntries;
    [a[i], a[j]] = [a[j], a[i]];
    render();
  }

  function addTocEntry() {
    state.tocEntries.push({
      id: U.uid('toc'), text: '新条目', level: 'h2',
      targetId: null, column: '', page: '', custom: true, manualPage: false
    });
    render();
  }

  function scrollToBlock(blockId) {
    const el = document.getElementById('blk-' + blockId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- 分页 + 预览 ----------
  // 每次 render 都会清空重建预览 DOM；这里记住并恢复滚动位置，
  // 否则编辑正文触发重绘时视图会跳回顶部的目录页（用户反馈「正文调不了」）
  function renderPreview() {
    const scroller = $('previewScroll');
    const keepTop = scroller ? scroller.scrollTop : 0;
    const keepLeft = scroller ? scroller.scrollLeft : 0;
    renderPreviewInner();
    if (scroller) { scroller.scrollTop = keepTop; scroller.scrollLeft = keepLeft; }
  }

  // v3.2：把一组块切成若干栏（2 栏时按最接近半页的切点做栏平衡）。
  // 渲染层据此画成两个真实栏容器，不再用 CSS column-count 自动分栏，
  // 因此不会出现「大块被整块推到下一栏 / 第一栏底部大片留白」。
  function splitColumns(groups, colH, cols) {
    if (cols <= 1) return [groups];
    const parts = Paginate.balanceTwo(groups, colH).slice(0, cols);
    while (parts.length < cols) parts.push([]);
    return parts;
  }

  // v3.2：按「文档 → 首页通栏槽位 → 双栏逐栏装箱」生成页面描述。
  // 每页 { doc, fuls, fullH, columns:[[group]], used:[h], colH, overflow, unbalanced, isFirstOfDoc }
  function layoutPages(items, cap, refHByDoc) {
    const MIN_COL_H = 24;   // v3.3 降低阈值，尽量让双栏接在通栏区下方，减少半页留白
    const pages = [];
    let i = 0;
    while (i < items.length) {
      const doc = items[i].doc;
      const docItems = [];
      while (i < items.length && items[i].doc === doc) docItems.push(items[i++]);

      // 开头连续的通栏块 = 首页槽位（标题 → 编者按 → 文献截图 → 来源）
      let k = 0;
      while (k < docItems.length && docItems[k].full) k++;
      const front = docItems.slice(0, k);
      const body = docItems.slice(k);
      const cols = docCols(doc);

      // 通栏块按整页高切页。超高不裁切，换页并标记 overflow（文档 05 章「不得静默截断」）
      const frontPages = [];
      let fz = [], fzH = 0;
      const pushFront = () => {
        if (fz.length) { frontPages.push({ fuls: fz, fullH: fzH }); fz = []; fzH = 0; }
      };
      front.forEach(it => {
        if (fz.length && fzH + it.h > cap) pushFront();
        fz.push(it); fzH += it.h;
      });
      pushFront();
      if (!frontPages.length) frontPages.push({ fuls: [], fullH: 0 });

      frontPages.forEach((fp, fi) => {
        pages.push({
          doc, fuls: fp.fuls, fullH: fp.fullH, columns: [], used: [],
          colH: 0, overflow: fp.fullH > cap + 1, unbalanced: false,
          isFirstOfDoc: fi === 0
        });
      });

      // 双栏：第一页接在最后一个通栏页下方（剩余空间够时），后续页用整页高
      // v3.3：先绑标题/图注，再把超高组合拆成可跨栏的子组，
      // 避免「一个过大块整组推到下一页，当前页另一栏整片留白」
      const kept = Paginate.keepGroups(body);
      const groups = Paginate.fitGroups(kept, cap);
      const lastFront = frontPages[frontPages.length - 1];
      const firstColH = Math.max(0, cap - lastFront.fullH);
      const attachFirst = groups.length > 0 && frontPages.length === 1 && firstColH >= MIN_COL_H;
      const colHFor = pageIdx => (attachFirst && pageIdx === 0 ? firstColH : cap);

      let gi = 0, pageIdx = 0;
      while (gi < groups.length) {
        const colH = colHFor(pageIdx);
        const pageCap = colH * cols;
        const picked = [];
        let used = 0;
        while (gi < groups.length) {
          const g = groups[gi];
          if (picked.length && used + g.h > pageCap) break;
          if (picked.length && g.breakBefore) break;
          picked.push(g); used += g.h; gi++;
        }
        const parts = splitColumns(picked, colH, cols);
        const usedArr = parts.map(p => p.reduce((s, g2) => s + g2.h, 0));
        const overflow = usedArr.some(u => u > colH + 1);
        const mx = Math.max.apply(null, usedArr), mn = Math.min.apply(null, usedArr);
        const unbalanced = mx > 0 && (mx - mn) / mx > 0.4;
        const target = attachFirst && pageIdx === 0 ? pages[pages.length - 1] : null;
        if (target) {
          target.columns = parts; target.used = usedArr; target.colH = colH;
          target.overflow = target.overflow || overflow;
          target.unbalanced = unbalanced;
        } else {
          pages.push({
            doc, fuls: [], fullH: 0, columns: parts, used: usedArr,
            colH, overflow, unbalanced, isFirstOfDoc: false
          });
        }
        pageIdx++;
        if (!picked.length) gi++;   // 单个超大组也要能推进，避免死循环
      }
    }

    // v3.3：每篇文章最后一页为「页底参考文献带」预留高度。
    // 先标记各篇最后一页，再用缩小后的栏高把该页内容重新装箱（必要时多分一页），
    // 保证参考文献贴底时不会盖住正文。
    pages.forEach((pg, idx) => {
      const nx = pages[idx + 1];
      pg.isLastOfDoc = !nx || nx.doc !== pg.doc;
    });
    if (refHByDoc) {
      for (let idx = pages.length - 1; idx >= 0; idx--) {
        const pg = pages[idx];
        if (!pg.isLastOfDoc || !pg.doc) continue;
        const rh = refHByDoc[pg.doc.id] || 0;
        if (rh <= 0) continue;
        pg.refH = rh;
        const flat = [].concat.apply([], pg.columns || []);
        if (!flat.length) continue;
        const nCols = pg.columns && pg.columns.length ? pg.columns.length : 1;
        const newColH = Math.max(24, (pg.colH || cap) - rh);
        const newCap = newColH * nCols;
        const rebuilt = [];
        let cur = [], used = 0;
        flat.forEach(g => {
          if (cur.length && used + g.h > newCap) { rebuilt.push(cur); cur = []; used = 0; }
          cur.push(g); used += g.h;
        });
        if (cur.length) rebuilt.push(cur);
        if (!rebuilt.length) continue;
        const parts = splitColumns(rebuilt[0], newColH, nCols);
        pg.columns = parts; pg.colH = newColH;
        pg.used = parts.map(p => p.reduce((s, g2) => s + g2.h, 0));
        pg.overflow = pg.used.some(u => u > newColH + 1);
        const mx = Math.max.apply(null, pg.used), mn = Math.min.apply(null, pg.used);
        pg.unbalanced = mx > 0 && (mx - mn) / mx > 0.4;
        for (let r = 1; r < rebuilt.length; r++) {
          const parts2 = splitColumns(rebuilt[r], newColH, nCols);
          const used2 = parts2.map(p => p.reduce((s, g2) => s + g2.h, 0));
          pages.splice(idx + r, 0, {
            doc: pg.doc, fuls: [], fullH: 0, columns: parts2, used: used2,
            colH: newColH, overflow: used2.some(u => u > newColH + 1),
            unbalanced: false, isFirstOfDoc: false, isLastOfDoc: false, refH: 0
          });
        }
        pg.isLastOfDoc = rebuilt.length === 1;
        if (rebuilt.length > 1) {
          const lastNew = pages[idx + rebuilt.length - 1];
          lastNew.isLastOfDoc = true; lastNew.refH = rh;
        }
      }
    }
    return pages;
  }

  // 给质检面板的分页报告（不依赖 DOM，纯数据）
  function buildLayoutReport(pages, tocPages, cap) {
    return {
      cap,
      tocPages: tocPages || 0,     // 目录页数：质检报告的「共 N 页」要含目录页
      pages: pages.map((pg, idx) => ({
        no: idx + 1,                    // v3.3 成品页码：正文从 1 起算，目录页不占号
        physicalNo: tocPages + idx + 1,
        doc: pg.doc ? pg.doc.name : '',
        fullH: pg.fullH, colH: pg.colH,
        used: pg.used || [], cols: pg.columns.length,
        overflow: !!pg.overflow, unbalanced: !!pg.unbalanced,
        empty: !pg.fuls.length && !pg.columns.some(c => c.length),
        colBlocks: pg.columns.map(groups => groups.reduce((acc, g) => acc.concat(
          g.items.map(it => ({
            id: it.b.id, type: it.b.type,
            text: (it.b.html || '').replace(/<[^>]+>/g, '').trim().slice(0, 46)
          }))
        ), [])),
        fullBlocks: pg.fuls.map(it => ({ id: it.b.id, type: it.b.type }))
      }))
    };
  }

  function renderPreviewInner() {
    const preview = $('preview');
    preview.innerHTML = '';
    if (state.docs.length === 0) {
      preview.innerHTML = '<div style="color:#9aa;margin-top:60px;text-align:center">请上传 docx / zip，或点「📂 打开」载入存档</div>';
      lastLayout = null;
      updatePageNav();
      if (window.QA && QA.onLayout) QA.onLayout();
      return;
    }
    const cap = contentHeightPx();
    const fullW = bodyWidthPx() + fullInsetPx();   // 通栏区比双栏区向左外扩 10.9mm

    // 收集条目：v3.3 参考文献从正文流里抽出，统一放到文章最后一页底部
    const allItems = [];
    state.docs.forEach(d => {
      const bs = d.blocks;
      bs.forEach((b, bi) => {
        if (!ALLOWED_TYPES.includes(b.type)) return;
        const isRef = b.type === 'references';
        // v3.4：紧贴文献列表前的「参考文献 / References」小标题一并归入页底带，
        // 避免标题留在正文、条目却贴在页底造成视觉分裂（兼容英文与「参考资料」）
        const isRefHead = ['label-head', 'h1', 'h2', 'h3'].includes(b.type) &&
          /^(参考文献|参考资料|References?)\s*[:：]?$/i.test((b.html || '').replace(/<[^>]+>/g, '').trim()) &&
          bs.slice(bi + 1).some(x => x.type === 'references');
        const inRefZone = isRef || isRefHead;
        allItems.push({ b, doc: d, full: inRefZone ? true : blockFull(b), isRef: inRefZone });
      });
    });
    const items = allItems.filter(it => !it.isRef);
    const refItems = allItems.filter(it => it.isRef);

    // 测量（通栏块按整页宽测，分栏块按栏宽测）
    if (!measureEl) {
      measureEl = document.createElement('div');
      measureEl.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
      document.body.appendChild(measureEl);
    }
    // 性能关键：把所有待测块一次性放进离屏容器再统一读高度。
    // 旧写法「设宽度→清空→插入→读 offsetHeight」循环 N 次，会触发 N 次强制同步布局，
    // 导入大稿时主线程长时间卡死，用户点任何按钮都「没反应」。
    measureEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    allItems.forEach(it => {
      const w = it.full ? fullW : columnWidthPx(docCols(it.doc));
      const wrap = document.createElement('div');
      wrap.style.cssText = 'width:' + w + 'px;position:relative;';
      const el = makeBlockEl(it.b);
      if (it.b.align) el.style.textAlign = it.b.align;
      if (it.b.lineHeight) el.style.lineHeight = it.b.lineHeight;
      wrap.appendChild(el);
      frag.appendChild(wrap);
      it.el = el;
    });
    measureEl.appendChild(frag);   // 只写一次 DOM
    allItems.forEach(it => {
      // 必须把上下外边距计入高度：.blk 模板带 margin，
      // 只取 offsetHeight 会让通栏区高度偏小，最后一段被 overflow:hidden 裁掉
      let mt = 0, mb = 0;
      try {
        const cs = getComputedStyle(it.el);
        mt = parseFloat(cs.marginTop) || 0;
        mb = parseFloat(cs.marginBottom) || 0;
      } catch (e) { /* jsdom 等无样式环境忽略 */ }
      it.h = it.el.offsetHeight + mt + mb;
    });
    measureEl.innerHTML = '';

    // v3.2 装箱：显式「首页通栏槽位 + 双栏逐栏装箱 + 栏平衡」，见 layoutPages()
    // 留 8px 安全余量：离屏测量高度与真实渲染存在 2~4px 的舍入差，
    // 保守装箱可保证「通栏区实测高 + 双栏区高」不越出版心下边界（探针实测）
    const layoutCap = Math.max(100, cap - 8);
    const refHByDoc = {};
    refItems.forEach(it => { refHByDoc[it.doc.id] = (refHByDoc[it.doc.id] || 0) + it.h + 4; });
    const pages = layoutPages(items, layoutCap, refHByDoc);

    // v3.4 P5：目录页数不再靠粗估算式（旧版把每行当 ~52px 估，高估 3 倍，
    // 批量上传即出现「首页几行 + 整片空白」的分页断层）。改为下方「真实 DOM 测量
    // + 逐行装箱」得出 tocPages；此处先声明，赋值在目录渲染段完成（正文 physicalNo 依赖它）。
    let tocPages = 0;

    // 正文页码映射 + 回填目录页码（v3.3：正文首页 = 1，目录页不占号）
    lastPageLabels = {};
    pages.forEach((pg, idx) => {
      const label = idx + 1;
      const mark = it => { lastPageLabels[it.b.id] = label; };
      pg.fuls.forEach(mark);
      pg.columns.forEach(groups => groups.forEach(g => g.items.forEach(mark)));
    });
    if (state.tocEnabled) {
      state.tocEntries.forEach(e => { if (!e.manualPage) e.page = lastPageLabels[e.targetId] || '—'; });
    }

    // 渲染目录页（v3.4：真实测量逐行装箱，一页排满再换页；去【栏目名】前缀）
    // 旧版用「估高 linePx × 条目数 / 版心高」算页数，再按一级分组数平均切页，
    // 批量上传时分组数多、每组行数少，于是首页只有两三行、下方整片空白（image9 断层）。
    // 现在把所有目录行（分组标题 / 二级 / 三级 / 条目）离屏量真实高度，按版心高顺序装箱，
    // 分组标题与后随条目 keep-with-next（标题不孤悬页尾），彻底消除断层。
    if (state.tocEnabled && state.tocEntries.length) {
      const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
      // 目录条目去掉开头的【期刊导读】/［数据阅独］等栏目名前缀，只影响目录显示，
      // state.tocEntries 与正文标题原文一字不改（内容保真）。
      const cleanTocText = t => {
        const s = String(t == null ? '' : t);
        return s.replace(/^\s*[【\[［]\s*[^】\]］]{1,12}\s*[】\]］]\s*/, '').trim() || s;
      };
      const bucketOrder = [];
      const buckets = {};
      state.tocEntries.forEach(e => {
        const key = (e.cat1 || e.column || '') || '\u0000';
        if (!buckets[key]) { buckets[key] = []; bucketOrder.push(key); }
        buckets[key].push(e);
      });

      // ① 依序构建所有目录行元素
      const rows = [];   // { el, isGroup }
      bucketOrder.forEach((key, gi) => {
        const col = key === '\u0000' ? '' : key;
        if (col) {
          const gh = document.createElement('div');
          gh.className = 'toc-group';
          gh.textContent = (CN[gi] || gi + 1) + '、' + col;
          rows.push({ el: gh, isGroup: true });
        }
        let lastC2 = null, lastC3 = null;
        buckets[key].forEach(e => {
          if (e.cat2 && e.cat2 !== lastC2) {
            const h2 = document.createElement('div');
            h2.className = 'toc-group2'; h2.textContent = e.cat2;
            rows.push({ el: h2, isGroup: true }); lastC2 = e.cat2; lastC3 = null;
          }
          if (e.cat3 && e.cat3 !== lastC3) {
            const h3 = document.createElement('div');
            h3.className = 'toc-group3'; h3.textContent = e.cat3;
            rows.push({ el: h3, isGroup: true }); lastC3 = e.cat3;
          }
          const a = document.createElement('a');
          a.className = 'toc-line lvl-' + e.level + (e.custom ? ' custom' : '');
          a.href = '#';
          a.addEventListener('click', ev => {
            ev.preventDefault();
            if (e.targetId) scrollToBlock(e.targetId);
          });
          a.innerHTML = `<span class="toc-txt">${U.escapeHtml(cleanTocText(e.text) || '（空）')}</span>` +
            `<span class="dots"></span><span class="pg">${fmtPage(e.page)}</span>`;
          rows.push({ el: a, isGroup: false });
        });
      });

      // ② 离屏测量每行真实高度（含上下 margin）。目录页单栏，宽度 = 版心宽。
      const tocMeasure = document.createElement('div');
      tocMeasure.className = 'page toc-page';
      tocMeasure.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;' +
        'width:' + (state.page.w - state.page.ml - state.page.mr) * MM_PX * SCALE + 'px;';
      const flowMeasure = document.createElement('div');
      flowMeasure.className = 'content-flow';
      tocMeasure.appendChild(flowMeasure);
      document.body.appendChild(tocMeasure);
      // 目录头每页都有，先量它占的高度
      const headProbe = document.createElement('div');
      headProbe.className = 'toc-head';
      headProbe.innerHTML = '<span class="toc-cn">目录</span><span class="toc-en">CONTENTS</span>';
      flowMeasure.appendChild(headProbe);
      const headH = headProbe.offsetHeight +
        (parseFloat(getComputedStyle(headProbe).marginBottom) || 0) + 8;
      flowMeasure.innerHTML = '';
      rows.forEach(r => {
        flowMeasure.appendChild(r.el);
        const cs = getComputedStyle(r.el);
        r.h = r.el.offsetHeight + (parseFloat(cs.marginTop) || 0) +
          (parseFloat(cs.marginBottom) || 0) + 2;
      });
      tocMeasure.remove();

      // ③ 逐行装箱：填满一页再开新页；分组标题不能落在页尾（keep-with-next）
      const tocCap = Math.max(120, contentHeightPx() - headH - 8);
      const tocPagesRows = [];
      let cur = [], used = 0;
      const flush = () => { if (cur.length) { tocPagesRows.push(cur); cur = []; used = 0; } };
      rows.forEach((r, ri) => {
        if (cur.length && used + r.h > tocCap) flush();
        // 分组标题若放不下「标题 + 后随第一行」，整组标题挪到下一页
        if (r.isGroup && cur.length === 0) {
          const next = rows[ri + 1];
          if (next && next.h + r.h > tocCap) { /* 单行超高，仍放行避免死循环 */ }
        }
        cur.push(r); used += r.h;
      });
      flush();
      // 校正：把「页尾分组标题」挪到下一页开头
      for (let t = 0; t < tocPagesRows.length - 1; t++) {
        const pg = tocPagesRows[t];
        if (pg.length && pg[pg.length - 1].isGroup) {
          const moved = pg.pop();
          tocPagesRows[t + 1].unshift(moved);
        }
      }
      tocPages = tocPagesRows.length || 1;

      // ④ 渲染目录页（每页固定目录头 + 该页行）
      for (let t = 0; t < tocPages; t++) {
        const page = buildPageShell(t + 1, null, true);
        const flow = page.querySelector('.content-flow');
        const head = document.createElement('div');
        head.className = 'toc-head';
        head.innerHTML = '<span class="toc-cn">目录</span><span class="toc-en">CONTENTS</span>';
        flow.appendChild(head);
        tocPagesRows[t].forEach(r => flow.appendChild(r.el));
        preview.appendChild(page);
      }
    }

    // 渲染正文页：通栏区自然撑开；双栏区拆成两个真实栏容器（不再靠 CSS 自动分栏）
    pages.forEach((pg, idx) => {
      const label = idx + 1;
      const physicalNo = tocPages + idx + 1;
      const refs = (pg.isLastOfDoc && pg.refH > 0 && pg.doc)
        ? refItems.filter(it => it.doc === pg.doc) : [];
      const page = buildPageShell(physicalNo, label, false, pg.doc, pg.isFirstOfDoc, refs);
      const body = page.querySelector('.page-body');
      if (pg.fuls.length) {
        const fz = document.createElement('div');
        fz.className = 'full-zone';
        // v3.2：不设固定 height、不 overflow:hidden —— 内容自然撑开，绝不静默裁切
        pg.fuls.forEach(it => { it.el.id = 'blk-' + it.b.id; fz.appendChild(it.el); });
        body.appendChild(fz);
      }
      if (pg.columns.some(c => c.length)) {
        const cz = document.createElement('div');
        cz.className = 'col-zone';
        cz.style.height = pg.colH + 'px';
        cz.dataset.cols = String(pg.columns.length);
        pg.columns.forEach((groups, ci) => {
          const col = document.createElement('div');
          col.className = 'page-col';
          col.dataset.ci = String(ci);
          groups.forEach(g => g.items.forEach(it => {
            it.el.id = 'blk-' + it.b.id;
            col.appendChild(it.el);
          }));
          cz.appendChild(col);
        });
        body.appendChild(cz);
      }
      // 用真实渲染高度复核溢出：离屏测量比实际渲染略大 2~4px，
      // 若只按测量值判定会把「刚好排满」误报成溢出（几何探针实测）
      const czEl = page.querySelector('.col-zone');
      if (czEl) {
        const czBottom = czEl.getBoundingClientRect().bottom;
        let maxBottom = 0;
        czEl.querySelectorAll('.page-col .blk').forEach(b => {
          maxBottom = Math.max(maxBottom, b.getBoundingClientRect().bottom);
        });
        pg.overflow = maxBottom > czBottom + 2;
      }
      if (pg.overflow) page.classList.add('page-overflow');
      preview.appendChild(page);
    });

    lastLayout = buildLayoutReport(pages, tocPages, layoutCap);
    updatePageNav();
    if (window.QA && QA.onLayout) QA.onLayout();
  }

  function buildPageShell(physicalNo, label, isToc, doc, isFirstOfDoc, refItems) {
    const p = state.page;
    const page = document.createElement('div');
    const odd = physicalNo % 2 === 1;   // 奇偶页左右镜像按物理页号判定
    page.dataset.pageNo = String(physicalNo);
    if (doc) {
      page.dataset.docId = doc.id;
      page.dataset.docName = (doc.cat1 || doc.columnName || '') + (doc.name ? ' · ' + doc.name : '');
    }
    page.className = 'page' + (isToc ? ' toc-page' : '') +
      (!isToc && docCols(doc) === 2 ? ' cols-2' : '') +
      (!isToc && doc && doc.qr && isFirstOfDoc ? ' with-qr' : '') +
      (!isToc && doc && doc.columnName ? ' with-tab' : '') +
      (state.showGuides ? ' show-guides' : '');
    // 竖排栏目标签：奇偶页左右镜像 + 按一级栏目配不同底色（目录页无标签）
    if (!isToc && doc && doc.columnName) {
      const tab = document.createElement('div');
      tab.className = 'page-tab ' + (odd ? 'tab-left' : 'tab-right');
      tab.textContent = doc.columnName;
      tab.style.background = tabColorFor(doc);
      page.appendChild(tab);
    }
    // 首页二维码：与标题同一水平带（top = 上边距），右侧安全区内，不压编者按
    if (!isToc && doc && doc.qr && isFirstOfDoc) {
      const qr = document.createElement('img');
      qr.className = 'page-qr';
      qr.src = doc.qr;
      page.appendChild(qr);
    }
    const header = document.createElement('div');
    header.className = 'page-header';
    header.textContent = p.hdr || '';
    const body = document.createElement('div');
    body.className = 'page-body';
    const flow = document.createElement('div');
    flow.className = 'content-flow';
    flow.style.display = isToc ? 'block' : 'none';
    body.appendChild(flow);
    // v3.3：参考文献带贴该文章最后一页版心底（通栏），预览 / PDF 一致
    if (refItems && refItems.length) {
      const rz = document.createElement('div');
      rz.className = 'ref-zone';
      refItems.forEach(it => { it.el.id = 'blk-' + it.b.id; rz.appendChild(it.el); });
      body.appendChild(rz);
    }
    const footer = document.createElement('div');
    footer.className = 'page-footer';
    // v3.3：目录页不显示页码；正文页脚从 1 起算（成品纯页码居中）
    footer.innerHTML = (p.ftr ? U.escapeHtml(p.ftr) + '　' : '') +
      (p.showNum && label != null ? `<span class="page-num">${label}</span>` : '');
    page.appendChild(header);
    page.appendChild(body);
    page.appendChild(footer);
    return page;
  }

  // ---------- 操作 ----------
  function onUpload(files) {
    U.toast('正在解析文件，请稍候…');
    // 先让浏览器把提示绘制出来再进入重解析，避免界面看似「卡死没反应」
    setTimeout(() => {
      Parser.handleFiles(files).then(docs => {
        if (!docs || docs.length === 0) { U.toast('未发现可解析的 docx'); return; }
        Parser.applyTemplate(docs);   // 导入即按白皮书模板套版
        state.docs.push(...docs);
        sortDocs();
        if (!state.selectedDocId && state.docs.length) state.selectedDocId = state.docs[0].id;
        rebuildBlockMap();
        buildToc(true);
        render();
        U.toast(`已解析并套版 ${docs.length} 个文档`);
      }).catch(e => { console.error(e); U.toast('上传解析出错：' + (e.message || '')); });
    }, 30);
  }

  function sortDocs() {
    state.docs.sort((a, b) => U.compareSort(a.name || '', b.name || ''));
  }

  // 增加：新建一个可直接在预览里编辑的空白文档
  function addEmptyDoc() {
    const n = state.docs.length + 1;
    const doc = {
      id: U.uid('doc'), name: String(n).padStart(2, '0') + '_新建文档.docx',
      columnName: '', cols: 2, qr: '',
      blocks: [
        { id: U.uid('blk'), type: 'art-title', html: '请输入文章标题', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'cite-box', html: '【来源】作者，等. 期刊名，年份.', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'lead', html: '<span class="lead-kw" style="color:#008000;font-weight:700">编者按：</span>在此输入导语内容…', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '在此输入正文内容…', align: 'justify', pageBreakBefore: false, lineHeight: null }
      ]
    };
    state.docs.push(doc);
    state.selectedDocId = doc.id;
    rebuildBlockMap();
    buildToc(true);
    render();
    U.toast('已增加空白文档，请在右侧页面里直接编辑');
  }

  // 删除：同时清理目录里指向该文档的自动条目与选中态
  function deleteDoc(id) {
    const idx = state.docs.findIndex(x => x.id === id);
    if (idx < 0) return;
    state.docs.splice(idx, 1);
    if (state.selectedDocId === id) {
      state.selectedDocId = state.docs.length
        ? state.docs[Math.min(idx, state.docs.length - 1)].id : null;
    }
    rebuildBlockMap();
    buildToc(true);
    render();
    U.toast('已删除该文档');
  }

  // 删除当前聚焦的段落（用于清掉导入稿件里多余的二维码 / 空段）
  function deleteCurrentBlock() {
    const id = Editor.getBlockId();
    if (!id) { U.toast('请先点击要删除的段落或图片'); return; }
    let removed = false;
    for (const d of state.docs) {
      const i = d.blocks.findIndex(b => b.id === id);
      if (i >= 0) { d.blocks.splice(i, 1); removed = true; break; }
    }
    if (!removed) { U.toast('未找到该段落'); return; }
    rebuildBlockMap();
    buildToc(true);
    render();
    U.toast('已删除该段落');
  }

  // 重新提取目录：merge=true 时保留用户手动加的条目与手动锁定的页码
  function buildToc(merge) {
    let overrides = {}, customs = [];
    if (merge) {
      state.tocEntries.forEach(e => {
        if (e.manualPage && e.targetId) overrides[e.targetId] = e.page;
        if (e.custom) customs.push(e);
      });
    }
    const auto = Toc.buildFromDocs(state.docs);
    auto.forEach(e => {
      if (overrides[e.targetId] != null) { e.page = overrides[e.targetId]; e.manualPage = true; }
    });
    state.tocEntries = auto.concat(customs);
  }

  function setPageBreakBefore(blockId, val) {
    const b = state.blockMap[blockId];
    if (b) { b.pageBreakBefore = val; render(); }
  }

  function setFullWidth(el) {
    const id = el.getAttribute('data-block-id');
    const b = state.blockMap[id];
    if (!b) return;
    b.full = !blockFull(b);
    b.fullLocked = true;   // 手动设过的通栏/分栏，重新套版时不被槽位逻辑覆盖
    render();
    U.toast(b.full ? '已设为通栏（横跨整页）' : '已取消通栏');
  }

  // v3.2：识别结果清单里改块类型 / 调顺序（文档 04 章「识别确认机制」）
  const TYPE_LABEL = {
    'art-title': '文章标题', lead: '编者按 / 导语', 'cite-box': '文献来源',
    'label-head': '绿色小标题', highlight: '绿色重点句', body: '正文',
    caption: '图注 / 表题', references: '参考文献', image: '图片',
    h1: '一级标题', h2: '二级标题', h3: '三级标题'
  };
  const TYPE_ALIGN = {
    'art-title': 'left', lead: 'justify', 'cite-box': 'left',
    'label-head': 'left', highlight: 'left', body: 'justify',
    references: 'left', caption: 'center', h1: 'left', h2: 'left', h3: 'left'
  };

  function applyBlockType(id, type) {
    const b = state.blockMap[id];
    if (!b || !ALLOWED_TYPES.includes(type)) return;
    b.type = type;
    b.recog = 'ok';
    if (TYPE_ALIGN[type]) b.align = TYPE_ALIGN[type];
    // v3.3 关键修复：改类型后按新类型重算通栏/分栏。
    // 旧版残留 b.full 会让「识别结果里改类型」完全不生效（用户反馈「调整完没变化」）
    if (!b.fullLocked) delete b.full;
    rebuildBlockMap();
    buildToc(true);
    render();
    if (window.QA && QA.refresh) QA.refresh();
    setStatus('已把该段设为「' + (TYPE_LABEL[type] || type) + '」并刷新质检', 'busy');
  }

  function moveBlock(id, dir) {
    for (const d of state.docs) {
      const i = d.blocks.findIndex(b => b.id === id);
      if (i < 0) continue;
      const j = i + dir;
      if (j < 0 || j >= d.blocks.length) { U.toast('已到边界'); return; }
      const [m] = d.blocks.splice(i, 1);
      d.blocks.splice(j, 0, m);
      rebuildBlockMap(); buildToc(true); render();
      setStatus('已调整段落顺序', 'busy');
      return;
    }
  }

  function setGuides(v) {
    state.showGuides = !!v;
    render();
    setStatus(state.showGuides ? '已显示分栏线 / 安全边距辅助线' : '已隐藏辅助线', 'busy');
  }

  function addImageBlock(afterEl, dataUrl) {
    const id = afterEl ? afterEl.getAttribute('data-block-id') : null;
    // v3.4：图片块不再内嵌 caption；图注是紧随其后的独立 caption 块（可单独编辑/删除/调序）
    const nb = { id: U.uid('blk'), type: 'image', src: dataUrl, align: 'center', pageBreakBefore: false };
    const cap = { id: U.uid('blk'), type: 'caption', html: '', align: 'center', pageBreakBefore: false, recog: 'ok' };
    let inserted = false;
    for (const d of state.docs) {
      const idx = d.blocks.findIndex(b => b.id === id);
      if (idx >= 0) { d.blocks.splice(idx + 1, 0, nb, cap); inserted = true; break; }
    }
    if (!inserted && state.docs.length) state.docs[state.docs.length - 1].blocks.push(nb, cap);
    rebuildBlockMap();
    render();
  }

  // 示例占位图：用 canvas 画，避免依赖外部文件 / SVG 在栅格化时的兼容问题
  function sampleQr() {
    const c = document.createElement('canvas'); c.width = c.height = 168;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 168, 168);
    let s = 20261109;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    x.fillStyle = '#111';
    for (let y = 0; y < 21; y++) for (let xx = 0; xx < 21; xx++)
      if (rnd() > 0.55) x.fillRect(xx * 8, y * 8, 8, 8);
    const finder = (cx, cy) => {
      x.fillStyle = '#111'; x.fillRect(cx * 8, cy * 8, 56, 56);
      x.fillStyle = '#fff'; x.fillRect((cx + 1) * 8, (cy + 1) * 8, 40, 40);
      x.fillStyle = '#111'; x.fillRect((cx + 2) * 8, (cy + 2) * 8, 24, 24);
    };
    finder(0, 0); finder(14, 0); finder(0, 14);
    return c.toDataURL('image/png');
  }
  function samplePaper() {
    const c = document.createElement('canvas'); c.width = 560; c.height = 300;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 560, 300);
    x.strokeStyle = '#e2e7e9'; x.strokeRect(0.5, 0.5, 559, 299);
    x.fillStyle = '#2b6b3a'; x.font = 'bold 17px Georgia';
    x.fillText('Frontiers in Pharmacology', 150, 34);
    x.fillStyle = '#9aa4aa';
    for (let i = 0; i < 9; i++) x.fillRect(20, 24 + i * 15, 105 - (i % 3) * 14, 6);
    x.fillStyle = '#2a3138'; x.font = '15px Georgia';
    x.fillText('The efficacy and safety of addition', 150, 74);
    x.fillText('of pegylated interferon to long-term', 150, 96);
    x.fillText('nucleos(t)ide analogue therapy', 150, 118);
    x.fillStyle = '#ccd2d6';
    for (let i = 0; i < 8; i++) x.fillRect(150, 146 + i * 17, 360 - (i % 4) * 42, 6);
    return c.toDataURL('image/png');
  }

  function loadSample() {
    const qr = sampleQr(), paper = samplePaper();
    const K = '<span class="lead-kw" style="color:#008000;font-weight:700">';
    state.docs = [{
      id: U.uid('doc'), name: '01_前沿速递.docx', columnName: '期刊导读', cols: 2, qr: qr,
      blocks: [
        { id: U.uid('blk'), type: 'art-title', html: '【期刊导读】荟萃分析：加用聚乙二醇干扰素α治疗可显著提高核苷经治慢乙肝患者的 HBsAg 清除率及血清学转换率', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'lead', html: K + '编者按：</span>慢乙肝患者获得 HBsAg 清除可极大改善患者远期结局，减少肝脏疾病进展和肝癌发生风险。目前已有多项研究证实聚乙二醇干扰素 α（PegIFNα）联合核苷类药物（NAs）治疗可显著提高慢乙肝患者的 HBsAg 清除率，减少肝癌发生。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'image', src: paper, align: 'center', full: true, pageBreakBefore: false, lineHeight: null },
        // v3.4：图注是独立 caption 块（与图片 keep-with-next），可单独编辑 / 删除
        { id: U.uid('blk'), type: 'caption', html: '图 1. 文献原文截图', align: 'center', full: true, pageBreakBefore: false, lineHeight: null, recog: 'ok' },
        { id: U.uid('blk'), type: 'cite-box', html: '【来源】Zhang Y, 等. The efficacy and safety of addition of pegylated interferon to nucleos(t)ide analogue therapy. Frontiers in Pharmacology, 2025.', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '研究方法：', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '在 PubMed、Embase、Cochrane Library 和 Web of Science 数据库系统检索英文文献，检索时间从数据库建立至 2024 年 10 月 13 日，荟萃分析在 PROSPERO 数据库注册。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '研究结果：', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'highlight', html: '1. 加用 PegIFNα 治疗可显著提高 NAs 经治慢乙肝患者的 HBsAg 清除率及血清学转换率', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '研究共纳入 7 项试验，涉及 692 名参与者，363 例随机分到 NAs 加用 PegIFNα 组，329 例分到 NAs 单药组。与 NAs 单药组相比，加用 PegIFNα 治疗显著提高 HBsAg 清除率。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '转换率（RR 3.98, 95% CI:1.50–10.54; p = 0.005; I² = 0%）。在 HBeAg 血清学转换率方面，两者无统计学意义。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '研究结论：', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '长期接受 NAs 治疗的 CHB 患者，与 NAs 单药治疗相比，加用 PegIFNα 治疗显著提高了 HBsAg 清除率及血清学转换率。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '参考文献', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'references', html: '1. Wang X, et al. Hepatology. 2026;83(4):512-521.', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'references', html: '2. 中国肝炎防治基金会. 慢性乙型肝炎临床治愈路线图. 2025.', align: 'left', pageBreakBefore: false, lineHeight: null },
      ]
    }, {
      id: U.uid('doc'), name: '02_指南解读.docx', columnName: '指南共识', cols: 2, qr: '',
      blocks: [
        { id: U.uid('blk'), type: 'art-title', html: '【指南共识】亚太肝病学会慢乙肝管理指南 2026 更新要点解读', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'lead', html: K + '编者按：</span>2026 年版指南在治疗指征、一线药物选择与特殊人群管理方面均有重要更新，本文提炼与临床实践最相关的十条要点，供临床医生参考。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'cite-box', html: '【来源】亚太肝病学会（APASL）慢性乙型肝炎管理临床实践指南：2026年版.', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '指南要点：', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'highlight', html: '1. 新版指南进一步放宽抗病毒治疗指征，强调「应治尽治」', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '对免疫清除期定义给出了更明确的标准，并对特殊人群的抗病毒治疗时机作出推荐。一线药物优先选择强效低耐药的核苷（酸）类似物，或联合聚乙二醇干扰素追求临床治愈。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '治疗指征更新：', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '新版指南强调，抗病毒治疗的决策不应仅依据单一的血清学或病毒学指标，而应结合患者年龄、家族史、肝脏疾病进展风险以及合并症进行综合判断。对于存在明显肝纤维化或肝硬化证据者，建议尽早启动治疗并长期随访。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '特殊人群管理：', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '针对妊娠期、儿童、合并肾功能损害以及肝移植后的特殊人群，指南分别给出了用药选择与监测频率的推荐意见，并提示在治疗过程中定期评估疗效与安全性，依据应答情况及时调整方案。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'highlight', html: '2. 联合聚乙二醇干扰素追求临床治愈已成为重要治疗策略', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '对于适合追求临床治愈的患者，可在核苷（酸）类似物治疗基础上联合聚乙二醇干扰素，治疗期间需密切监测 HBsAg 水平与血清学转换情况，并依据应答调整疗程与随访计划。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '监测与随访：', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'body', html: '治疗期间应定期复查肝功能、病毒学指标与影像学检查，评估疾病进展与肝细胞癌风险；达到停药标准后仍需加强随访，及时发现病毒学复发与病情波动。', align: 'justify', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'label-head', html: '参考文献', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'references', html: '1. APASL. Clinical Practice Guidelines on Chronic Hepatitis B: 2026.', align: 'left', pageBreakBefore: false, lineHeight: null },
        { id: U.uid('blk'), type: 'references', html: '2. 中华医学会肝病学分会. 慢性乙型肝炎防治指南（2022 年版）.', align: 'left', pageBreakBefore: false, lineHeight: null },
      ]
    }];
    state.selectedDocId = state.docs[0].id;
    rebuildBlockMap();
    buildToc(false);
    render();
    setStatus(`已载入测试数据：${state.docs.length} 篇文档（仅供回归脚本使用）`, 'busy');
  }

  // ---------- 状态条 / 存档 ----------
  const APP_VER = 'v3.4';
  // v3.4 改了图注数据结构 / 目录装箱 / 参考文献识别 / PDF 清晰度 / 质检勾选，换 key 避免恢复旧版存档
  const STORE_KEY = 'kanwu_autosave_v3_4';
  let autoSaveTimer = null;

  function setStatus(msg, kind) {
    const bar = $('statusBar'), txt = $('statusText'), tm = $('statusTime');
    if (bar && txt) {
      bar.className = 'status-bar' + (kind ? ' ' + kind : '');
      txt.textContent = msg;
      if (tm) tm.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }
    U.toast(msg);
  }

  function serializeState() {
    return {
      app: '刊物内页排版工具', version: APP_VER, savedAt: new Date().toISOString(),
      page: state.page, docs: state.docs, tocEnabled: state.tocEnabled,
      tocEntries: state.tocEntries, selectedDocId: state.selectedDocId,
      showGuides: state.showGuides, categories: state.categories,
      qaDoneIssues: state.qaDoneIssues
    };
  }

  function saveArchive() {
    if (!state.docs.length) { setStatus('当前没有内容可保存，请先上传 docx / zip 或打开存档', 'err'); return; }
    try {
      const json = JSON.stringify(serializeState());
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      U.download(new Blob([json], { type: 'application/json' }), '刊物存档_' + stamp + '.json');
      const size = json.length > 1048576
        ? (json.length / 1048576).toFixed(1) + ' MB' : Math.round(json.length / 1024) + ' KB';
      setStatus(`已保存存档：${state.docs.length} 篇文档 · ${size}`, 'busy');
    } catch (e) { setStatus('保存失败：' + e.message, 'err'); }
  }

  function syncPageInputs() {
    const map = { pgW: 'w', pgH: 'h', mgT: 'mt', mgB: 'mb', mgL: 'ml', mgR: 'mr' };
    Object.keys(map).forEach(id => { const el = $(id); if (el) el.value = state.page[map[id]]; });
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('cols', String(state.page.cols || 1));
    set('lineH', String(state.page.lineH || PAGE_DEFAULT.lineH));
    set('hdrText', state.page.hdr || '');
    set('ftrText', state.page.ftr || '');
    const c = $('showPgNum'); if (c) c.checked = state.page.showNum !== false;
    const t = $('tocEnabled'); if (t) t.checked = state.tocEnabled;
  }

  function applyArchive(data) {
    if (!data || !Array.isArray(data.docs)) throw new Error('存档格式不正确（缺少 docs）');
    state.docs = data.docs;
    state.page = Object.assign({}, PAGE_DEFAULT, data.page || {});
    state.tocEnabled = data.tocEnabled !== false;
    state.tocEntries = Array.isArray(data.tocEntries) ? data.tocEntries : [];
    state.selectedDocId = data.selectedDocId || (state.docs[0] && state.docs[0].id) || null;
    state.showGuides = !!data.showGuides;
    state.categories = Object.assign({}, DEFAULT_CATEGORIES, data.categories || {});
    state.qaDoneIssues = Array.isArray(data.qaDoneIssues) ? data.qaDoneIssues.slice() : [];
    migrateImageCaptions();
    rebuildBlockMap();
    syncPageInputs();
    render();
  }

  function openArchive(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        const old = data.version && data.version !== APP_VER;
        applyArchive(data);
        setStatus(`已打开存档：${state.docs.length} 篇文档${old ? '（来自旧版本，页面设置沿用存档值；如需新规格请点「清空」重来）' : '，可继续排版'}`, 'busy');
      } catch (e) { console.error(e); setStatus('打开存档失败：' + e.message, 'err'); }
    };
    r.onerror = () => setStatus('读取存档文件失败', 'err');
    r.readAsText(file, 'utf-8');
  }

  function autoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      if (!state.docs.length) return;   // 空状态不覆盖已有存档
      try { localStorage.setItem(STORE_KEY, JSON.stringify(serializeState())); } catch (e) {}
    }, 800);
  }
  // v3.4：质检勾选状态变化后即时落盘（内容未变，不触发重排 / 不打断编辑）
  function persistQa() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(serializeState())); } catch (e) {}
  }

  function restoreAutoSave() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data.docs || !data.docs.length) return false;
      applyArchive(data);
      setStatus(`已自动恢复上次进度：${state.docs.length} 篇文档（要重来请点「清空」）`, 'busy');
      return true;
    } catch (e) { return false; }
  }

  function bindUI() {
    if (bindUI._done) return;   // 防止重复绑定导致一次上传被处理两遍
    bindUI._done = true;

    // ---- v3.4：PDF 清晰度档位（DPI）联动 ----
    const dpiSel = $('pdfDpi');
    if (dpiSel && typeof ExportPdf !== 'undefined' && ExportPdf.setDpi) {
      ExportPdf.setDpi(parseInt(dpiSel.value, 10));
      dpiSel.addEventListener('change', e => {
        ExportPdf.setDpi(parseInt(e.target.value, 10));
        setStatus('PDF 清晰度已设为 ' + e.target.value + ' DPI（下次导出/预览生效）', 'busy');
      });
    }

    // 必须先拷贝成数组：紧接着把 input.value 置空会清掉 FileList，
    // 而 onUpload 内部是延迟执行的，直接传 FileList 会变成 0 个文件
    $('fileInput').addEventListener('change', e => {
      if (e.target.files.length) onUpload(Array.from(e.target.files));
      e.target.value = '';
    });
    $('btnAppendFiles').addEventListener('click', () => $('appendInput').click());
    $('appendInput').addEventListener('change', e => {
      if (e.target.files.length) onUpload(Array.from(e.target.files));
      e.target.value = '';
    });
    $('btnAddDoc').addEventListener('click', addEmptyDoc);
    $('btnResort').addEventListener('click', () => {
      if (state.docs.length < 2) { U.toast('文档不足 2 个，无需重排'); return; }
      sortDocs(); render();
      U.toast('已按文件名序号重排');
    });
    $('btnReTemplate').addEventListener('click', () => {
      if (!state.docs.length) { U.toast('请先上传或增加文档'); return; }
      Parser.applyTemplate(state.docs, { reset: false });
      rebuildBlockMap(); buildToc(true); render();
      U.toast('已按刊物模板重新识别段落样式');
    });
    // v3.3：已移除「载入示例」按钮（误点会整体覆盖 state.docs，用户反馈会丢文章）
    $('btnSave').addEventListener('click', saveArchive);
    $('btnOpenArchive').addEventListener('click', () => $('archiveInput').click());
    $('archiveInput').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) { setStatus('正在打开存档…', 'busy'); openArchive(f); }
      e.target.value = '';
    });
    $('btnReset').addEventListener('click', () => {
      if (confirm('确定清空当前内容？')) {
        state.docs = []; state.tocEntries = []; state.selectedDocId = null;
        state.blockMap = {}; lastPageLabels = {}; state.qaDoneIssues = [];
        try { localStorage.removeItem(STORE_KEY); } catch (e) {}
        render();
        setStatus('已清空，可上传文件、点「📂 打开」存档，或按 Ctrl+Z 撤销本次清空');
      }
    });

    // 导出：一个按钮 + 格式下拉；PDF 直接生成文件，不再弹打印对话框。
    // v3.3：空状态给出明确提示并中止，不再自动载入示例（避免误触覆盖用户内容）。
    $('btnExport').addEventListener('click', () => {
      if (!state.docs.length) { U.toast('请先上传 docx / zip，或点「📂 打开」载入存档'); return; }
      // 08 章：导出前给出质检摘要（常驻状态条徽标 + 有阻断级时补一条提示），
      // 但不强制拦截导出，保持「点一下就有结果」的一键式体验
      if (window.QA && QA.blockingCount && QA.blockingCount() > 0) {
        const n = QA.blockingCount();
        setTimeout(() => U.toast(`导出前质检：${n} 项阻断级问题，详见「🔎 质检」`), 420);
      }
      const fmt = $('exportFormat').value;
      if (fmt === 'pdf') {
        setStatus('正在生成 PDF 文件…', 'busy');
        Promise.resolve(ExportPdf.run())
          .then(() => setStatus('PDF 文件已导出（可到下载文件夹查看）', 'busy'))
          .catch(e => setStatus('PDF 生成失败：' + (e.message || ''), 'err'));
      } else {
        setStatus('正在生成 Word 文件…', 'busy');
        Promise.resolve(ExportDocx.run(state, lastPageLabels))
          .then(() => setStatus('Word 文件已导出（可到下载文件夹查看）', 'busy'))
          .catch(e => { console.error(e); setStatus('Word 导出失败：' + (e.message || ''), 'err'); });
      }
    });
    $('btnPreview').addEventListener('click', () => {
      if (!state.docs.length) { U.toast('请先上传 docx / zip，或点「📂 打开」载入存档'); return; }
      setStatus('正在打开 PDF 效果预览…', 'busy');
      Promise.resolve(ExportPdf.preview())
        .then(() => setStatus('PDF 效果预览已打开', 'busy'))
        .catch(e => setStatus('预览失败：' + (e.message || ''), 'err'));
    });
    $('btnDeleteBlock').addEventListener('mousedown', e => e.preventDefault());
    $('btnDeleteBlock').addEventListener('click', e => { e.preventDefault(); deleteCurrentBlock(); });
    // ---- v3.3：撤销 / 还原 ----
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    });

    // ---- v3.3：WPS 式页面跳转条 / v3.4：目录直达 ----
    $('navToc').addEventListener('click', () => {
      // 目录是物理第 1 页（若关闭目录则回到第一页正文）
      scrollToPage(1);
      setStatus('已跳到目录页（第 1 页）', 'busy');
    });
    $('navFirst').addEventListener('click', () => scrollToPage(1));
    $('navPrev').addEventListener('click', () =>
      scrollToPage((parseInt($('navPage').value, 10) || 1) - 1));
    $('navNext').addEventListener('click', () =>
      scrollToPage((parseInt($('navPage').value, 10) || 1) + 1));
    $('navLast').addEventListener('click', () => scrollToPage(pageNavTotal));
    const doJump = () => scrollToPage(parseInt($('navPage').value, 10) || 1);
    $('navJump').addEventListener('click', doJump);
    $('navPage').addEventListener('keydown', e => { if (e.key === 'Enter') doJump(); });
    const navScroller = $('previewScroll');
    if (navScroller) {
      let navTimer = null;
      navScroller.addEventListener('scroll', () => {
        clearTimeout(navTimer); navTimer = setTimeout(syncNavFromScroll, 120);
      });
    }

    // ---- v3.3：三级栏目分类（单选 + 新增 / 删除） ----
    const catKeys = { l1: 'cat1', l2: 'cat2', l3: 'cat3' };
    const catNames = { l1: '一级目录', l2: '二级分类', l3: '三级标题' };
    ['l1', 'l2', 'l3'].forEach(k => {
      const num = k.slice(1);
      const sel = $('docCat' + num);
      if (sel) sel.addEventListener('change', e => {
        const d = selectedDoc(); if (!d) return;
        d[catKeys[k]] = e.target.value;
        if (k === 'l1' && e.target.value) d.columnName = e.target.value;
        buildToc(true); render();
      });
      const add = $('cat' + num + 'Add');
      if (add) add.addEventListener('click', () => {
        const v = (prompt('新增' + catNames[k] + '名称：', '') || '').trim();
        if (!v) return;
        if (state.categories[k].indexOf(v) < 0) state.categories[k].push(v);
        const d = selectedDoc();
        if (d) { d[catKeys[k]] = v; if (k === 'l1') d.columnName = v; }
        buildToc(true); render();
        U.toast('已新增：' + v);
      });
      const del = $('cat' + num + 'Del');
      if (del) del.addEventListener('click', () => {
        const v = sel ? sel.value : '';
        if (!v || !confirm('删除分类「' + v + '」？已使用该分类的文档会保留文字但改为未分类。')) return;
        state.categories[k] = state.categories[k].filter(x => x !== v);
        state.docs.forEach(d => { if (d[catKeys[k]] === v) d[catKeys[k]] = ''; });
        buildToc(true); render();
        U.toast('已删除：' + v);
      });
    });


    // v3.2：质检 / 识别结果面板（文档 04、08 章）+ 分栏线辅助线（03 章）
    const qaBtn = $('btnQa');
    if (qaBtn) qaBtn.addEventListener('click', () => { if (window.QA) QA.open(); });
    const gd = $('guideToggle');
    if (gd) gd.addEventListener('change', e => setGuides(e.target.checked));

    // 预览缩放（只改显示比例，分页与导出尺寸不变）
    const zoomSel = $('zoomSelect');
    if (zoomSel) zoomSel.addEventListener('change', e => setPreviewScale(e.target.value));

    // 栏目设置
    $('docColName').addEventListener('input', e => {
      const d = selectedDoc(); if (!d) return;
      d.columnName = e.target.value.trim(); render();
    });
    $('docCols').addEventListener('change', e => {
      const d = selectedDoc(); if (!d) return;
      const v = parseInt(e.target.value, 10);
      d.cols = v > 0 ? v : null; render();
    });
    $('qrInput').addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      const d = selectedDoc(); if (!d) { U.toast('请先在左侧点选一个文档'); return; }
      const r = new FileReader();
      r.onload = () => { d.qr = r.result; render(); U.toast('二维码已更新'); };
      r.readAsDataURL(f);
      e.target.value = '';
    });
    $('btnQrClear').addEventListener('click', () => {
      const d = selectedDoc(); if (!d) return;
      d.qr = ''; render();
    });

    // 通栏
    $('btnFullWidth').addEventListener('mousedown', e => e.preventDefault());
    $('btnFullWidth').addEventListener('click', () => {
      const el = document.querySelector('.blk:focus');
      if (!el) { U.toast('请先点击要设置的段落'); return; }
      setFullWidth(el);
    });

    // 页面设置
    const bindNum = (id, key) => $(id).addEventListener('input', e => {
      state.page[key] = parseFloat(e.target.value) || 0; render();
    });
    bindNum('pgW', 'w'); bindNum('pgH', 'h');
    bindNum('mgT', 'mt'); bindNum('mgB', 'mb');
    bindNum('mgL', 'ml'); bindNum('mgR', 'mr');
    $('cols').addEventListener('change', e => { state.page.cols = parseInt(e.target.value, 10); render(); });
    $('lineH').addEventListener('change', e => { state.page.lineH = parseFloat(e.target.value); render(); });
    $('hdrText').addEventListener('input', e => { state.page.hdr = e.target.value; render(); });
    $('ftrText').addEventListener('input', e => { state.page.ftr = e.target.value; render(); });
    $('showPgNum').addEventListener('change', e => { state.page.showNum = e.target.checked; render(); });
    $('tocEnabled').addEventListener('change', e => { state.tocEnabled = e.target.checked; render(); });
    $('btnRegenToc').addEventListener('click', () => { buildToc(true); render(); U.toast('已重新提取目录（保留手动调整）'); });
    $('btnAddToc').addEventListener('click', () => { addTocEntry(); U.toast('已添加手工目录条目'); });
  }

  function init() {
    if (init._done) return;
    init._done = true;
    bindUI();
    Editor.init();
    bindCompositionGuard();
    const ver = $('appVer'); if (ver) ver.textContent = APP_VER;
    // 任何脚本错误都直接显示在状态条上，避免「点了没反应」却看不到原因
    window.addEventListener('error', e => {
      if (e && e.message) setStatus('脚本错误：' + e.message, 'err');
    });
    window.addEventListener('unhandledrejection', e => {
      const r = e.reason;
      setStatus('操作失败：' + ((r && r.message) || r || '未知'), 'err');
    });
    render();
    if (!restoreAutoSave()) {
      setStatus(`就绪 · ${APP_VER} · 上传 docx / zip 或点「📂 打开」存档开始`);
    }
  }

  return { init, syncBlock, scheduleRender, render, setStatus, setPreviewScale,
           setPageBreakBefore, setFullWidth, addImageBlock, scrollToBlock,
           applyBlockType, moveBlock, setGuides, TYPE_LABEL, ALLOWED_TYPES,
           undo, redo, tabColorFor, gotoQaTarget, scrollToPage, scrollToDoc, persistQa,
           __loadSample: loadSample,
           get state() { return state; },
           get lastPageLabels() { return lastPageLabels; },
           get layout() { return lastLayout; } };
})();

// const 顶层声明不会自动成为 window 属性，但 editor.js 等模块用 window.App 调用，
// 这里显式挂载，否则工具栏的改动只停留在 DOM、同步不回数据模型，一重绘就丢
window.App = App;

// 兼容「脚本加载时 DOMContentLoaded 已触发」的预览环境，避免按钮完全没绑定
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', App.init);
} else {
  App.init();
}
