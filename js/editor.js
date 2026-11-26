/* 编辑器：工具栏命令、格式刷、块级样式、对齐、插入图片/分页
 *
 * 关键修复：render() 会整体重建预览 DOM，若把「当前块」存成元素引用，
 * 重绘后引用就指向已废弃节点，字号/加粗/对齐等命令会全部「点了没反应」。
 * 因此这里只存 data-block-id，用时再到当前文档里动态查找。 */
const Editor = (() => {
  let currentBlockId = null;   // 当前聚焦块的 id（不是元素引用）
  let painter = null;          // 格式刷捕获的样式串
  let painterOn = false;

  function $(id) { return document.getElementById(id); }

  function currentEl() {
    if (!currentBlockId) return null;
    try {
      return document.querySelector('.blk[data-block-id="' + CSS.escape(currentBlockId) + '"]');
    } catch (e) {
      return document.querySelector('.blk[data-block-id="' + currentBlockId + '"]');
    }
  }

  function setCurrentBlock(el) {
    currentBlockId = el ? el.getAttribute('data-block-id') : null;
    syncToolbar();
  }

  function getBlockId() { return currentBlockId; }

  function syncToolbar() {
    const el = currentEl();
    if (!el) return;
    const sel = $('blockStyle');
    if (sel) sel.value = el.getAttribute('data-type') || 'body';
    const lh = el.style.lineHeight;
    const sl = $('selLineH');
    if (sl) sl.value = lh ? parseFloat(lh).toString() : '1.64';
    const al = $('alignSelect');
    if (al) al.value = el.style.textAlign || 'left';
    const fs = $('fontSize');
    if (fs) fs.value = el.dataset.pt || '';
    const ff = $('fontFamily');
    if (ff) ff.value = el.style.fontFamily || '';
    // v3.8 P4：缩进 / 段间距 / 行距（可输入框）
    const ti = el.style.textIndent;
    const si = $('selIndent');
    if (si) {
      if (ti === '2em') si.value = 'indent2';
      else if (ti === '0') si.value = 'none';
      else if (ti === '-2em') si.value = 'hang2';
      else si.value = '';
    }
    const sb = $('selSpaceBefore'); if (sb) sb.value = parseFloat(el.style.marginTop) || 0;
    const sa = $('selSpaceAfter'); if (sa) sa.value = parseFloat(el.style.marginBottom) || 0;
    const sl2 = $('selLineH');
    if (sl2) sl2.value = el.style.lineHeight ? parseFloat(el.style.lineHeight).toString() : '1.79';
  }

  function markDirty() {
    const el = currentEl();
    if (el && window.App) window.App.syncBlock(el);
  }

  function renderSoon() {
    if (window.App && window.App.scheduleRender) window.App.scheduleRender();
  }

  // 字符级命令（浏览器原生，可靠）
  function cmd(name) {
    if (painterOn) return;
    document.execCommand(name, false, null);
    markDirty();
  }

  // 选区是否仍属于当前文档（render 重建后旧选区节点会脱离文档）
  function liveRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const host = node && node.nodeType === 1 ? node : (node && node.parentNode);
    if (!host || !document.contains(host)) return null;
    return range;
  }

  // 下拉里的数字是「成品真实字号 pt」。预览页整体按 --fs 缩放，
  // 所以写入 calc(真实pt × var(--fs))，换预览比例时字号自动跟随，导出 Word 时用 data-pt 还原。
  const FS_CSS = pt => `calc(${pt}pt * var(--fs))`;

  // 用 span 包裹选区并施加行内样式（用于字号/颜色/字体/格式刷）
  function wrapSelection(styleStr, attrs) {
    const range = liveRange();
    if (!range) return false;
    const span = document.createElement('span');
    span.setAttribute('style', styleStr);
    if (attrs) Object.keys(attrs).forEach(k => span.setAttribute(k, String(attrs[k])));
    try {
      range.surroundContents(span);
    } catch (e) {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    window.getSelection().removeAllRanges();
    markDirty();
    return true;
  }

  // 整块级：直接写到块元素 style，不再往外包一层 span。
  // 旧写法每次点击都新建 span 包住全部内容，多点几次会层层嵌套，且内层样式优先级
  // 高于外层导致「怎么点都改不动」。
  function setWholeBlock(cssProp, cssVal, dataKey, dataVal) {
    const el = currentEl();
    if (!el) return false;
    if (el.getAttribute('data-type') === 'image') return false; // 图片块不套用
    el.style[cssProp] = cssVal;
    if (dataKey) {
      if (dataVal == null || dataVal === '') el.removeAttribute(dataKey);
      else el.setAttribute(dataKey, String(dataVal));
    }
    markDirty();   // App.syncBlock 会把 fontPt / fontFamily / color 存回数据模型
    return true;
  }

  function applyFontSize(pt) {
    const n = parseFloat(pt);
    if (!n) return;
    // 有有效选区只改选区；否则整块生效（避免无选区时「点了没反应」）
    if (wrapSelection('font-size:' + FS_CSS(n), { 'data-pt': n })) return;
    if (setWholeBlock('fontSize', FS_CSS(n), 'data-pt', n)) return;
    U.toast('请先点击要设置的文字或段落');
  }

  // 清空字号框 = 清除手动字号，恢复模板类字号（图注9 / 文献7.6 / 正文10.6 ...）。
  // 旧逻辑 `if(e.target.value)` 直接跳过空值，导致被 Word 或手动设成大字号的块
  // 无法恢复模板字号，表现为「字号调了没变化」。这里显式清除块与选区里的字号残留。
  function clearFontSize() {
    const el = currentEl();
    if (!el) { U.toast('请先点击要清除字号的段落'); return; }
    // 清除块自身 inline 字号与 data-pt
    el.style.fontSize = '';
    el.removeAttribute('data-pt');
    // 清除块内所有手动包过的字号 span（保留其它格式如加粗/斜体）
    el.querySelectorAll('[data-pt]').forEach(sp => {
      sp.style.fontSize = '';
      sp.removeAttribute('data-pt');
      if (!sp.getAttribute('style') || sp.getAttribute('style').trim() === '') {
        const attrs = Array.from(sp.attributes).map(a => a.name);
        if (attrs.every(a => a === 'class')) sp.replaceWith(...sp.childNodes);
      }
    });
    markDirty();
    renderSoon();
    U.toast('已恢复模板字号');
  }

  function applyFontFamily(fam) {
    if (!fam) return;
    if (wrapSelection('font-family:' + fam)) return;
    if (setWholeBlock('fontFamily', fam)) return;
    U.toast('请先点击要设置的文字或段落');
  }

  // v3.9：绿色 dominance 判定——刊物三色（#008000 / #187838 / #58A830）都应加粗。
  function isGreenColor(hex) {
    const m = String(hex).trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (!m) return false;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return g > 90 && g > r * 1.15 && g > b * 1.15;
  }
  function applyColor(hex) {
    if (!hex) return;
    const el = currentEl();
    const green = isGreenColor(hex) && el && el.getAttribute('data-type') !== 'references';
    const css = 'color:' + hex + (green ? ';font-weight:700' : '');
    if (wrapSelection(css)) return;
    if (setWholeBlock('color', hex)) {
      if (el) { el.style.fontWeight = green ? '700' : ''; markDirty(); }
      return;
    }
    U.toast('请先点击要设置的文字或段落');
  }

  // 块级样式
  function applyBlockStyle(type) {
    const el = currentEl();
    if (!el) { U.toast('请先点击要设置的段落'); return; }
    el.setAttribute('data-type', type);
    el.className = 'blk ' + (type === 'image' ? 'imgblk' : type);
    markDirty();
    renderSoon();   // 类型变化可能影响通栏/分栏与目录，需要重新分页
  }

  function applyBlockLineHeight(lh) {
    const el = currentEl();
    if (!el) { U.toast('请先点击要设置的段落'); return; }
    el.style.lineHeight = lh;
    markDirty();
    renderSoon();
  }

  function applyBlockAlign(align) {
    const el = currentEl();
    if (!el) { U.toast('请先点击要设置的段落'); return; }
    el.style.textAlign = align;
    markDirty();
    const al = $('alignSelect');
    if (al) al.value = align;
  }

  // v3.8 P4：缩进方式（首行缩进 2 字 / 顶格 / 悬挂缩进 2 字）
  function applyIndent(mode) {
    const el = currentEl();
    if (!el) { U.toast('请先点击要设置的段落'); return; }
    if (!mode) {
      el.style.textIndent = '';
      el.style.paddingLeft = '';
    } else if (mode === 'indent2') {
      el.style.textIndent = '2em';
      el.style.paddingLeft = '';
    } else if (mode === 'none') {
      el.style.textIndent = '0';
      el.style.paddingLeft = '';
    } else if (mode === 'hang2') {
      el.style.textIndent = '-2em';
      el.style.paddingLeft = '2em';
    }
    markDirty();
    renderSoon();
  }

  // v3.8 P4：段前 / 段后间距（pt）。段后距覆盖 .blk 默认的 margin-bottom。
  function applySpacing(which, pt) {
    const el = currentEl();
    if (!el) { U.toast('请先点击要设置的段落'); return; }
    const n = parseFloat(pt);
    const px = isNaN(n) ? 0 : n;
    if (which === 'before') el.style.marginTop = px + 'pt';
    else el.style.marginBottom = px + 'pt';
    markDirty();
    renderSoon();
  }

  // v3.8 P9：有序 / 无序分点编号。序号用 CSS ::before 显示，不改原文文字（内容保真）。
  // ol 序号按同一文档内连续的 ol 块自动累加；ul 统一显示圆点。
  function toggleList(kind) {
    const el = currentEl();
    if (!el) { U.toast('请先点击要分点的段落'); return; }
    const b = window.App && App.state ? App.state.blockMap[getBlockId()] : null;
    if (!b) return;
    const same = b.listType === kind;
    b.listType = same ? '' : kind;
    b.listN = 0;
    // 重算同文档内连续 ol 块的序号
    if (b.listType === 'ol') {
      let n = 0;
      (App.state.docs.find(d => d.blocks.indexOf(b) >= 0) || { blocks: [] }).blocks.forEach(bb => {
        if (bb.listType === 'ol') { bb.listN = ++n; }
        else n = 0;
      });
    }
    // 修复「点了没反应」：markDirty()→syncBlock() 会用 DOM 的 dataset.list 旧值覆盖内存，
    // 必须先把新值同步到 DOM，再 markDirty。序号同样按重算结果写回。
    if (b.listType) {
      el.dataset.list = b.listType;
      if (b.listN) el.dataset.listN = String(b.listN); else el.removeAttribute('data-list-n');
    } else {
      el.removeAttribute('data-list');
      el.removeAttribute('data-list-n');
    }
    // 同文档其它 ol 块的序号也变了，同步它们的 DOM（避免下次 syncBlock 回写旧序号）
    const owner = App.state.docs.find(d => d.blocks.indexOf(b) >= 0);
    if (owner) owner.blocks.forEach(bb => {
      if (bb === b || bb.listType !== 'ol') return;
      const be = document.querySelector('.blk[data-block-id="' + CSS.escape(bb.id) + '"]');
      if (be) be.dataset.listN = String(bb.listN || 1);
    });
    markDirty();
    renderSoon();
    U.toast(same ? '已取消编号' : (kind === 'ol' ? '已设为有序分点' : '已设为无序分点'));
  }

  function insertPageBreak() {
    if (!currentEl()) { U.toast('请先点击要在其前方分页的段落'); return; }
    if (window.App) window.App.setPageBreakBefore(getBlockId(), true);
    U.toast('已在该段前插入分页');
  }

  function insertImage(dataUrl) {
    if (window.App) window.App.addImageBlock(currentEl(), dataUrl);
  }

  // 格式刷
  function capturePainter() {
    const range = liveRange();
    const sel = window.getSelection();
    if (!range || !sel) return;
    let node = sel.anchorNode;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node) return;
    const cs = getComputedStyle(node);
    painter = `font-size:${cs.fontSize};font-weight:${cs.fontWeight};` +
              `font-style:${cs.fontStyle};text-decoration:${cs.textDecoration};` +
              `color:${cs.color};vertical-align:${cs.verticalAlign}`;
    painterOn = true;
    $('btnFormatPainter').classList.add('active');
    U.toast('格式刷已开启：选中目标文字即可套用');
  }

  function tryApplyPainter() {
    if (!painterOn || !painter) return;
    if (wrapSelection(painter)) {
      painterOn = false;
      $('btnFormatPainter').classList.remove('active');
      U.toast('格式已套用');
    }
  }

  const ALIGN_MAP = {
    justifyLeft: 'left', justifyCenter: 'center',
    justifyRight: 'right', justifyFull: 'justify'
  };

  function init() {
    // 字符命令 / 对齐按钮
    document.querySelectorAll('.tb-btn[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault()); // 防止失焦
      btn.addEventListener('click', () => {
        const c = btn.getAttribute('data-cmd');
        if (ALIGN_MAP[c]) {
          applyBlockAlign(ALIGN_MAP[c]);   // 块级对齐，比 execCommand 更可靠
        } else if (c === 'superscript' || c === 'subscript') {
          document.execCommand(c, false, null);
          markDirty();
        } else {
          cmd(c);
        }
      });
    });

    $('blockStyle').addEventListener('change', e => applyBlockStyle(e.target.value));
    $('fontSize').addEventListener('change', e => {
      if (e.target.value) applyFontSize(e.target.value);
      else clearFontSize();
    });
    const fontSel = $('fontFamily');
    if (fontSel) fontSel.addEventListener('change', e => applyFontFamily(e.target.value));
    $('selLineH').addEventListener('change', e => { if (e.target.value) applyBlockLineHeight(e.target.value); });
    const alignSel = $('alignSelect');
    if (alignSel) alignSel.addEventListener('change', e => applyBlockAlign(e.target.value));
    // v3.8 P4 / P9：新增控件
    const si = $('selIndent'); if (si) si.addEventListener('change', e => applyIndent(e.target.value));
    const sb = $('selSpaceBefore'); if (sb) sb.addEventListener('change', e => applySpacing('before', e.target.value));
    const sa = $('selSpaceAfter'); if (sa) sa.addEventListener('change', e => applySpacing('after', e.target.value));
    const bol = $('btnOList'); if (bol) bol.addEventListener('click', e => { e.preventDefault(); toggleList('ol'); });
    const bul = $('btnUList'); if (bul) bul.addEventListener('click', e => { e.preventDefault(); toggleList('ul'); });

    $('btnFormatPainter').addEventListener('click', e => {
      e.preventDefault();
      if (painterOn) { painterOn = false; e.currentTarget.classList.remove('active'); }
      else capturePainter();
    });

    $('btnPageBreak').addEventListener('click', e => { e.preventDefault(); insertPageBreak(); });

    $('btnAddImage').addEventListener('click', e => { e.preventDefault(); $('imgInput').click(); });
    $('imgInput').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => insertImage(r.result);
      r.readAsDataURL(f);
      e.target.value = '';
    });

    // 选中文字后若格式刷开启则套用
    document.addEventListener('mouseup', () => {
      if (painterOn) tryApplyPainter();
    });

    // 文字颜色（简单取色）
    const colorBtn = document.createElement('button');
    colorBtn.className = 'tb-btn'; colorBtn.textContent = 'A'; colorBtn.title = '文字颜色';
    colorBtn.style.color = '#c0392b';
    colorBtn.addEventListener('click', e => {
      e.preventDefault();
      const hex = prompt('输入颜色十六进制（如 #c0392b）：', '#c0392b');
      if (hex) applyColor(hex);
    });
    document.querySelector('.tb-group').appendChild(colorBtn);
  }

  return { init, setCurrentBlock, cmd, getBlockId, applyBlockAlign, currentEl,
           applyFontSize, applyFontFamily, applyColor };
})();
