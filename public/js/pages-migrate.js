'use strict';
/**
 * 数据迁移页面：从亿星等旧系统导入客户、厂家、样品档案（读取 → 识别列 → 校验 → 导入 → 记录/回滚）
 * Data-migration page: import customers, suppliers and samples from legacy systems such as 亿星
 * (read → map columns → validate → import → history/rollback).
 */
(() => {
  const { esc, get, post, toast, modal, tableHtml, tag, can, route, setTitle, confirmBox, download, optHtml, clearOptions } = ERP;

  /**
   * 读取文件为 base64 / Read a file as a data URL.
   * @param {File} file
   * @returns {Promise<string>}
   */
  const readFile = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('读取文件失败'));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });

  /**
   * 导入结果（按亿星结果窗口分类显示）/ Render an import result grouped like 亿星's result window.
   * @param {object} res 接口返回 / API result
   * @returns {string}
   */
  function resultHtml(res) {
    const names = res.bucket_names;
    const order = ['created', 'updated', 'skipped', 'duplicate', 'ref_missing', 'locked', 'invalid'];
    const cls = { created: 'ok', updated: 'ok', skipped: 'info', duplicate: 'warn', ref_missing: 'danger', locked: 'danger', invalid: 'danger' };
    const cards = order.map((k) => `<div class="card mig-bucket"><div class="l">${esc(names[k])}</div><div class="v"><span class="tag ${cls[k]}">${(res.buckets[k] || []).length}</span></div></div>`).join('');
    const problems = order.filter((k) => !['created', 'updated'].includes(k) && (res.buckets[k] || []).length);
    const detail = problems.map((k) => `<h4 class="mig-sub">${esc(names[k])}（${res.buckets[k].length}）</h4>
      ${tableHtml(['Excel行号', '关键值', '说明'], res.buckets[k].map((x) => [x.row, esc(x.key), esc(x.msg)]))}`).join('');
    const warns = (res.warnings || []).length ? `<h4 class="mig-sub">提示（已导入，但请留意）（${res.warnings.length}）</h4>
      ${tableHtml(['Excel行号', '关键值', '说明'], res.warnings.map((x) => [x.row, esc(x.key), esc(x.msg)]))}` : '';
    return `<div class="cards mig-cards">${cards}</div>${detail}${warns}`;
  }

  route(/^\/migrate$/, async (_, main) => {
    setTitle('数据迁移（亿星导入）');
    const [profiles, emps] = await Promise.all([get('/api/migrate/profiles'), ERP.options('employee', true)]);
    const canImport = can('system', 'add');
    const st = { entity: profiles[0].key, file: null, data: '', preview: null, mapping: [] };

    main.innerHTML = `<div class="panel">
        <div class="panel-head"><h3>数据迁移：从亿星导入基础资料</h3><span class="muted small">建议顺序：厂家档案 → 客户档案 → 样品档案（样品需要关联厂家）</span></div>
        <div class="alert info"><span>在亿星中打开对应列表（如【客户管理】），用“单据输出 / Excel导出”导出表格，再在这里导入。系统会按亿星的列名（客户编号、客户简称、货号、厂号、外箱规格……）自动识别列。
          先点<b>校验</b>查看结果（不写入），确认无误后再<b>正式导入</b>；每次导入都会留下记录，可整批回滚。旧版 .xls 请先另存为 .xlsx。</span></div>
        <div class="form-grid">
          <label><span class="req">资料类型</span><select id="migEntity">${optHtml(profiles.map((p) => ({ id: p.key, label: p.title })), st.entity, false)}</select></label>
          <label><span class="req">导入文件（.xlsx / .csv）</span><input type="file" id="migFile" accept=".xlsx,.csv,.txt"></label>
          <label><span>表头所在行（留空自动识别）</span><input type="number" id="migHeader" min="1" placeholder="自动"></label>
          <label><span>系统中已存在时</span><select id="migMode"><option value="overwrite">覆盖原有记录（以Excel为准，空单元格不清空）</option><option value="skip">跳过，不修改原有记录</option></select></label>
          <label id="migDesignerBox"><span>默认设计师（表格无“设计师”列时使用）</span><select id="migDesigner">${optHtml(emps, '')}</select></label>
          <label id="migSalesBox"><span>默认业务员（表格无“业务员”列时使用）</span><select id="migSales">${optHtml(emps, '')}</select></label>
        </div>
        <p class="muted small" id="migHint"></p>
        <div class="toolbar">
          <button class="btn" id="migTpl" type="button">下载导入模板</button>
          <button class="btn" id="migCols" type="button">查看可识别的列名</button>
          ${canImport ? '<button class="btn primary" id="migRead" type="button">① 读取并识别列</button>' : '<span class="muted small">您没有导入权限（需要系统权限管理的“新增”权限）</span>'}
        </div>
      </div>
      <div id="migPreview"></div>
      <div id="migResult"></div>
      <div class="panel"><div class="panel-head"><h3>导入记录</h3><span class="muted small">只能回滚某类资料最近一次的导入；已被报价/订单/样品引用的新增记录会保留</span></div><div id="migHistory"></div></div>`;

    const $ = (s) => main.querySelector(s);
    const profile = () => profiles.find((p) => p.key === st.entity);
    const syncOptions = () => {
      $('#migHint').textContent = profile().hint;
      $('#migDesignerBox').style.display = st.entity === 'sample' ? '' : 'none';
      $('#migSalesBox').style.display = st.entity === 'customer' ? '' : 'none';
    };
    syncOptions();

    $('#migEntity').onchange = () => {
      st.entity = $('#migEntity').value;
      st.preview = null;
      $('#migPreview').innerHTML = '';
      $('#migResult').innerHTML = '';
      syncOptions();
    };
    $('#migFile').onchange = () => { st.file = $('#migFile').files[0] || null; st.data = ''; st.preview = null; $('#migPreview').innerHTML = ''; $('#migResult').innerHTML = ''; };
    $('#migTpl').onclick = async () => { try { await download('/api/migrate/template/' + st.entity); } catch (e) { toast(e.message, 'error'); } };
    $('#migCols').onclick = () => modal({
      title: `可识别的列名：${profile().title}`, wide: true,
      body: tableHtml(['模板列名（亿星叫法）', '也能识别为', '必填'], profile().columns.map((c) => [esc(c.label), esc(c.aliases.join('、')), c.required ? '是' : ''])),
    });

    /** 渲染列对应关系 / render the column mapping table */
    const renderPreview = () => {
      const p = st.preview;
      const fieldOpts = [{ id: '', label: '（不导入）' }, ...profile().columns.map((c) => ({ id: c.field, label: c.label + (c.required ? ' *' : '') }))];
      const matched = st.mapping.filter(Boolean).length;
      $('#migPreview').innerHTML = `<div class="panel">
        <div class="panel-head"><h3>② 核对列对应关系</h3><span class="muted small">表头在第 ${p.header_row} 行，数据 ${p.data_rows} 行，识别 ${matched}/${p.headers.length} 列。识别不对的列可手动改选。</span></div>
        <div class="table-wrap mig-map"><table><thead><tr><th>Excel列</th><th>对应系统字段</th><th>示例数据</th></tr></thead><tbody>
        ${p.headers.map((h, i) => `<tr class="${st.mapping[i] ? '' : 'mig-off'}"><td>${esc(h || `(第${i + 1}列无表头)`)}</td>
          <td><select data-col="${i}">${optHtml(fieldOpts, st.mapping[i] || '', false)}</select></td>
          <td class="muted small">${esc(p.sample.slice(0, 3).map((r) => r[i]).filter((v) => v !== '').join(' ｜ '))}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="toolbar" style="margin-top:10px"><button class="btn" id="migCheck" type="button">③ 校验（不写入）</button><button class="btn primary" id="migGo" type="button">④ 正式导入</button></div></div>`;
      main.querySelectorAll('[data-col]').forEach((sel) => {
        sel.onchange = () => {
          const i = Number(sel.dataset.col);
          // 同一字段只能对应一列 / a field maps to at most one column
          if (sel.value) st.mapping = st.mapping.map((f, k) => (k !== i && f === sel.value ? '' : f));
          st.mapping[i] = sel.value;
          renderPreview();
        };
      });
      $('#migCheck').onclick = () => run(true);
      $('#migGo').onclick = () => run(false);
    };

    /** 当前导入参数 / current import parameters */
    const payload = () => ({
      entity: st.entity, file_name: st.file.name, data: st.data, header_row: st.preview ? st.preview.header_row : $('#migHeader').value,
      mapping: st.mapping, mode: $('#migMode').value, defaults: { designer_id: $('#migDesigner').value || undefined, salesman_id: $('#migSales').value || undefined },
    });

    /**
     * 校验或导入 / validate or import
     * @param {boolean} dry 仅校验 / validate only
     */
    const run = async (dry) => {
      if (!dry && !(await confirmBox(`确定把「${st.file.name}」正式导入为${profile().title}？导入后可在下方“导入记录”中整批回滚。`))) return;
      const btns = main.querySelectorAll('#migCheck,#migGo');
      btns.forEach((b) => { b.disabled = true; });
      try {
        const res = await post('/api/migrate/import', { ...payload(), dry_run: dry });
        $('#migResult').innerHTML = `<div class="panel"><div class="panel-head"><h3>${dry ? '校验结果（未写入数据库）' : `导入完成：${esc(res.batch.batch_no)}`}</h3>
          <span class="muted small">共 ${res.counts.total} 行：新增 ${res.counts.created}，覆盖 ${res.counts.updated}，跳过 ${res.counts.skipped}，未导入 ${res.counts.failed}</span></div>${resultHtml(res)}</div>`;
        if (!dry) { toast('导入完成', 'ok'); clearOptions(); loadHistory(); }
        $('#migResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { toast(e.message, 'error'); } finally { btns.forEach((b) => { b.disabled = false; }); }
    };

    const rb = $('#migRead');
    if (rb) {
      rb.onclick = async () => {
        if (!st.file) { toast('请先选择要导入的文件', 'error'); return; }
        rb.disabled = true;
        try {
          if (!st.data) st.data = await readFile(st.file);
          st.preview = await post('/api/migrate/preview', { entity: st.entity, file_name: st.file.name, data: st.data, header_row: $('#migHeader').value });
          st.mapping = st.preview.mapping.slice();
          $('#migHeader').value = st.preview.header_row;
          $('#migResult').innerHTML = '';
          renderPreview();
        } catch (e) { toast(e.message, 'error'); } finally { rb.disabled = false; }
      };
    }

    /** 导入记录 / import history */
    async function loadHistory() {
      const rows = await get('/api/migrate/batches');
      const latest = {};
      for (const b of rows) if (b.status === '已导入' && !latest[b.entity]) latest[b.entity] = b.id;
      $('#migHistory').innerHTML = tableHtml(['批次号', '资料类型', '文件', '方式', '总行数', '新增', '覆盖', '跳过', '未导入', '状态', '操作人', '时间', '操作'],
        rows.map((b) => [esc(b.batch_no), esc(b.entity_title), esc(b.file_name), b.mode === 'skip' ? '跳过已有' : '覆盖已有', b.total, b.created, b.updated, b.skipped, b.failed,
          b.status === '已导入' ? tag('已完成') : tag('已回滚'), esc(b.user_name), esc(b.created_at),
          `<button class="btn small" data-bd="${b.id}">明细</button>${latest[b.entity] === b.id && can('system', 'delete') ? ` <button class="btn small danger" data-rb="${b.id}">回滚</button>` : ''}`]),
        new Set([4, 5, 6, 7, 8]));
      main.querySelectorAll('[data-bd]').forEach((b) => {
        b.onclick = async () => {
          const d = await get('/api/migrate/batches/' + b.dataset.bd);
          modal({ title: `导入明细：${d.batch_no}（${d.entity_title}）`, wide: true, body: resultHtml(d) });
        };
      });
      main.querySelectorAll('[data-rb]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('确定回滚这次导入？新增的记录会被删除（已被业务单据引用的保留），覆盖的字段恢复为导入前的值。'))) return;
          try {
            const r = await post(`/api/migrate/batches/${b.dataset.rb}/rollback`);
            toast(`已回滚：删除 ${r.deleted} 条，恢复 ${r.restored} 条${r.kept.length ? `，保留 ${r.kept.length} 条` : ''}`, 'ok');
            if (r.kept.length) modal({ title: '以下记录已被引用，未删除', body: tableHtml(['关键值', '原因'], r.kept.map((k) => [esc(k.key), esc(k.msg)])) });
            clearOptions();
            loadHistory();
          } catch (e) { toast(e.message, 'error'); }
        };
      });
    }
    loadHistory();
  });
})();
