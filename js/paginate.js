/* 分页 / 分栏算法（v3.2 重写）
 *
 * 旧版只判断「两栏总容量」够不够，再把块一股脑丢给 CSS column-fill:auto：
 * 浏览器遇到放不进第一栏的大块会整块推到下一栏，第一栏底部于是留下大片空白，
 * 且 overflow:hidden 会静默裁掉溢出内容（施工单第 4 条 / 文档 05、08 章）。
 *
 * v3.2 改为 JS 显式逐栏装箱：
 *  - keepGroups()  把「标题 + 后随正文」「图片 + 图注」绑成不可分组合，避免标题孤悬、图注脱离
 *  - packColumns() 先按「页容量 = 栏高 × 栏数」切页，再在每页内按最接近半页的切点做栏平衡
 *  - 结果直接交给渲染层画成两个真实栏容器，不再依赖浏览器自动分栏（不会出现意外留白）
 *  - 溢出不裁切：标记 overflow，交给质检面板报「阻断级」并让用户看到
 */
const Paginate = (() => {

  const HEAD_TYPES = ['art-title', 'label-head', 'h1', 'h2', 'h3'];

  /**
   * 把块绑成不可分组合。
   * @param items [{b, h, doc, el, ...}]
   * @returns [{items:[...], h, doc, breakBefore, head:boolean, ...}]
   */
  function keepGroups(items) {
    const groups = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // 图注紧跟在图片后面时，并入图片所在的组合（图注与图片不分页分离）
      if (it.b.type === 'caption' && groups.length) {
        const prev = groups[groups.length - 1];
        const tail = prev.items[prev.items.length - 1];
        if (tail && tail.b.type === 'image') {
          prev.items.push(it);
          prev.h += it.h;
          continue;
        }
      }
      const g = {
        items: [it], h: it.h, doc: it.doc,
        breakBefore: !!it.b.pageBreakBefore,
        head: HEAD_TYPES.includes(it.b.type),
        key: it.b.id
      };
      // 标题 keep-with-next：与其后第一个正文块绑成一组（若下一个也是标题则不绑）
      if (g.head && i + 1 < items.length) {
        const nx = items[i + 1];
        if (!HEAD_TYPES.includes(nx.b.type) && nx.b.type !== 'caption') {
          g.items.push(nx);
          g.h += nx.h;
          i++;
        }
      }
      groups.push(g);
    }
    return groups;
  }

  /**
   * 双栏栏平衡：找最接近「总高 / 2」的切点，再校正使两栏都不超过 colH。
   * 比「填满第一栏再填第二栏」整齐，也不会因单个大块把整块推走而留下半栏空白。
   */
  function balanceTwo(all, colH) {
    const sumTo = n => all.slice(0, n).reduce((s, g) => s + g.h, 0);
    const total = sumTo(all.length);
    if (!all.length) return [[], []];
    // 阅读顺序从左到右：某页只剩 1 个内容组时，必须放左栏，不得孤零零靠右栏。
    // 修复前 best 初值 0 + 「不允许空栏」的 break 会让单组 cut=0 → 整组落右栏、左栏全空。
    if (all.length === 1) return [[all[0]], []];
    const target = total / 2;
    let best = 1, bestDiff = Infinity, acc = 0;
    for (let k = 0; k < all.length; k++) {
      acc += all[k].h;
      if (k >= all.length - 1) break;           // 不允许产生空栏
      const diff = Math.abs(acc - target);
      if (diff < bestDiff) { bestDiff = diff; best = k + 1; }
    }
    let cut = best;
    // 左栏不得超高：把切点左移，直到左栏能放下
    while (cut > 0 && sumTo(cut) > colH) cut--;
    // 右栏不得超高：把切点右移，直到右栏能放下
    while (cut < all.length && total - sumTo(cut) > colH) cut++;
    // v3.3：不允许出现空栏（旧版 while 可能把切点推到 0 或 all.length，
    // 造成「一栏排满、另一栏整片空白」）
    if (all.length > 1) cut = Math.max(1, Math.min(all.length - 1, cut));
    return [all.slice(0, cut), all.slice(cut)];
  }

  function balancePage(page, colH, cols) {
    const all = page.columns[0];
    page.columns = Array.from({ length: cols }, () => []);
    page.used = Array(cols).fill(0);
    if (cols <= 1) {
      page.columns[0] = all;
      page.used[0] = all.reduce((s, g) => s + g.h, 0);
    } else {
      const parts = balanceTwo(all, colH);
      parts.forEach((part, i) => {
        page.columns[i] = part;
        page.used[i] = part.reduce((s, g) => s + g.h, 0);
      });
    }
    // 溢出（含单块超过一栏高）：不裁切，只标记，由质检报阻断级
    page.overflow = page.overflow || page.used.some(u => u > colH + 1);
    const mx = Math.max.apply(null, page.used);
    const mn = Math.min.apply(null, page.used);
    page.unbalanced = mx > 0 && (mx - mn) / mx > 0.4;
    return page;
  }

  /**
   * 逐页 / 逐栏装箱。
   * @param groups keepGroups() 的结果
   * @param colH   单栏可用高度（px，已按预览缩放）
   * @param cols   栏数
   * @returns [{columns:[[group]], used:[h], overflow, unbalanced, breakBefore, doc}]
   */
  function packColumns(groups, colH, cols) {
    const n = Math.max(1, cols || 1);
    const pageCap = colH * n;
    const pages = [];
    const newPage = () => ({
      columns: [[]], used: [0], overflow: false, unbalanced: false,
      breakBefore: false, doc: null
    });
    let cur = newPage();
    let used = 0;
    const flush = () => {
      if (cur.columns[0].length) {
        pages.push(balancePage(cur, colH, n));
      }
    };
    groups.forEach(g => {
      if (!cur.doc) cur.doc = g.doc;
      if (g.breakBefore && used > 0) { flush(); cur = newPage(); used = 0; }
      if (used + g.h > pageCap && used > 0) { flush(); cur = newPage(); used = 0; }
      if (g.h > pageCap) cur.overflow = true;   // 单块超过整页：不静默截断
      cur.columns[0].push(g);
      used += g.h;
    });
    flush();
    return pages;
  }

  /**
   * v3.3：把「超过单栏高度」的组合按块拆成若干不超过 colH 的子组。
   * 旧版一个超高组合会被整组推到下一页，当前页另一栏于是留下大片空白。
   * 标题 keep-with-next / breakBefore 仍保留在第一个子组上。
   */
  function fitGroups(groups, colH) {
    const out = [];
    groups.forEach(g => {
      if (g.h <= colH || g.items.length <= 1) { out.push(g); return; }
      let cur = [], h = 0, first = true;
      g.items.forEach(it => {
        if (cur.length && h + it.h > colH) {
          out.push({ items: cur, h, doc: g.doc, breakBefore: first && g.breakBefore,
                     head: first && g.head, key: cur[0].b.id });
          cur = []; h = 0; first = false;
        }
        cur.push(it); h += it.h;
      });
      if (cur.length) {
        out.push({ items: cur, h, doc: g.doc, breakBefore: first && g.breakBefore,
                   head: first && g.head, key: cur[0].b.id });
      }
    });
    return out;
  }

  /** 在隐藏容器里测量一组块的高度（保留供外部/测试使用） */
  function measure(container, blockEls, widthPx) {
    container.style.width = widthPx + 'px';
    container.innerHTML = '';
    const heights = [];
    for (const el of blockEls) {
      const clone = el.cloneNode(true);
      clone.style.margin = '0 0 6px';
      container.appendChild(clone);
      heights.push(clone.offsetHeight);
    }
    return heights;
  }

  return { keepGroups, fitGroups, packColumns, balanceTwo, measure, HEAD_TYPES };
})();
