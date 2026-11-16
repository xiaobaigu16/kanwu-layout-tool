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

  function applyFontFamily(fam) {
    if (!fam) return;
    if (wrapSelection('font-family:' + fam)) return;
    if (setWholeBlock('fontFamily', fam)) return;
    U.toast('请先点击要设置的文字或段落');
  }

  function applyColor(hex) {
    if (!hex) return;
    if (wrapSelection('color:' + hex)) return;
    if (setWholeBlock('color', hex)) return;
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
    $('fontSize').addEventListener('change', e => applyFontSize(e.target.value));
    const fontSel = $('fontFamily');
    if (fontSel) fontSel.addEventListener('change', e => applyFontFamily(e.target.value));
    $('selLineH').addEventListener('change', e => applyBlockLineHeight(e.target.value));
    const alignSel = $('alignSelect');
    if (alignSel) alignSel.addEventListener('change', e => applyBlockAlign(e.target.value));

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
