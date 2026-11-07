'use strict';
/**
 * 基础档案页面：通用档案列表、客户/样品详情、系统管理
 * Master-data pages: generic entity lists, customer/sample detail, system administration.
 */
(() => {
  const { esc, money, get, post, put, del, toast, modal, formHtml, readForm, tableHtml, tag, can, route, setTitle, exportTable, printHtml, confirmBox, clearOptions } = ERP;

  /**
   * 单元格显示值 / Cell display value for an entity field.
   * @param {object} f 字段 / field
   * @param {object} row 行 / row
   * @param {string} key 实体键 / entity key
   * @returns {string}
   */
  function cell(f, row, key) {
    const v = row[f.name];
    if (f.type === 'ref') return esc(row[f.name + '_label'] ?? '');
    if (f.name === 'status' || f.name === 'progress') return tag(v);
    if (key === 'sample' && f.name === 'company_no') return `<a href="#/sample/${row.id}">${esc(v)}</a>`;
    if (key === 'customer' && f.name === 'name') return `<a href="#/customer/${row.id}">${esc(v)}</a>`;
    if (f.type === 'textarea') return `<span title="${esc(v)}">${esc(String(v ?? '').slice(0, 40))}${String(v ?? '').length > 40 ? '…' : ''}</span>`;
    return esc(v);
  }

  /**
   * 通用档案列表页 / Generic entity list page.
   * @param {string} key 实体键 / entity key
   * @param {HTMLElement} main
   * @param {URLSearchParams} qs
   */
  async function entityPage(key, main, qs) {
    const ent = ERP.state.meta.entities[key];
    if (!ent) throw new Error('无权访问该页面或模块已停用');
    setTitle(ent.title);
    const canAdd = !ent.readonly && can(ent.module, 'add');
    const canEdit = !ent.readonly && can(ent.module, 'edit');
    const canDel = !ent.readonly && can(ent.module, 'delete');
    const textOf = (f, r) => (f.type === 'ref' ? r[f.name + '_label'] ?? '' : r[f.name] ?? '');
    const columns = ent.fields.map((f) => ({
      key: f.name, label: f.label, num: f.type === 'number', nofilter: f.type === 'textarea',
      text: (r) => textOf(f, r), html: (r) => cell(f, r, key),
    }));
    if (key === 'inventory') columns.push({ key: 'alert', label: '库存预警', nofilter: true, text: (r) => r.alert, html: (r) => tag(r.alert) });
    const toolbar = `${canAdd ? '<button class="btn primary" type="button" id="add">＋ 新增</button>' : ''}
      ${key === 'currency' && can('trade', 'edit') ? '<button class="btn primary" type="button" id="autoRate">⟳ 自动更新汇率</button>' : ''}`;
    const headHtml = `${key === 'currency' ? '<div class="alert info" id="rateStatus">汇率来源加载中…</div>' : ''}
      ${ent.readonly ? '<div class="alert info">此台账由系统根据业务自动生成，只读。</div>' : ''}`;
    // 地址栏中的 f_ 条件作为初始筛选（如从工作台跳转）/ f_ params in the hash act as initial filters
    const initFilters = Object.fromEntries([...qs.entries()].filter(([k]) => k.startsWith('f_')).map(([k, v]) => [k.slice(2), [v]]));
    const g = await ERP.grid(main, {
      key: 'e.' + key, title: ent.title, mode: 'server', entity: key, module: ent.module, q: qs.get('q') || '',
      columns, defaultCols: [...ent.fields.filter((f) => f.list).map((f) => f.name), ...(key === 'inventory' ? ['alert'] : [])],
      tree: (ent.tree || []).map((k) => ({ key: k, label: (ent.fields.find((f) => f.name === k) || {}).label || k })),
      schemes: ent.schemes || [],
      quick: (ent.quick || []).map((k) => ({ key: k, label: (ent.fields.find((f) => f.name === k) || {}).label || k })),
      toolbar, headHtml,
      actions: canEdit || canDel ? (r) => `${canEdit ? `<button class="btn small" type="button" data-edit="${esc(r.id)}">编辑</button> ` : ''}${canDel ? `<button class="btn small danger" type="button" data-del="${esc(r.id)}">删除</button>` : ''}` : null,
      bind: (root) => {
        root.querySelectorAll('[data-edit]').forEach((b) => {
          b.onclick = async () => open(await get(`/api/e/${key}/${encodeURIComponent(b.dataset.edit)}`));
        });
        root.querySelectorAll('[data-del]').forEach((b) => {
          b.onclick = async () => {
            if (!(await confirmBox('确定删除该记录吗？删除后不可恢复。'))) return;
            try { await del(`/api/e/${key}/${encodeURIComponent(b.dataset.del)}`); toast('已删除', 'ok'); clearOptions(); g.reload(); } catch (e) { toast(e.message, 'error'); }
          };
        });
      },
      initFilters,
    });
    const open = async (row) => modal({
      title: (row ? '编辑' : '新增') + ent.title, wide: ent.fields.length > 8, body: await formHtml(ent.fields, row || {}),
      buttons: [{
        text: '保存', cls: 'primary', onClick: async (mm) => {
          const body = readForm(mm.el);
          if (row) await put(`/api/e/${key}/${encodeURIComponent(row.id)}`, body); else await post(`/api/e/${key}`, body);
          mm.close();
          clearOptions();
          toast('保存成功', 'ok');
          g.reload();
        },
      }],
    });
    const addBtn = main.querySelector('#add');
    if (addBtn) addBtn.onclick = () => open(null);
    if (key === 'currency') {
      get('/api/rates/status').then((st) => {
        const el = main.querySelector('#rateStatus');
        if (el) el.textContent = `最近自动更新：${st.last || '尚未更新'}　来源：${st.source || st.api}　自动更新周期：${Number(st.hours) ? `每${st.hours}小时` : '已关闭'}　单次波动超过${st.max_change}%不自动采用（可在 系统权限管理→系统参数 中修改）`;
      }).catch(() => {});
      const ar = main.querySelector('#autoRate');
      if (ar) {
        ar.onclick = async () => {
          ar.disabled = true;
          try {
            const r = await post('/api/rates/update');
            modal({
              title: '汇率更新结果', body: `<p class="small muted">来源：${esc(r.source)}　数据时间：${esc(r.date)}</p>
                ${r.updated.length || r.skipped.length ? tableHtml(['币种', '原汇率', '新汇率', '结果'], [...r.updated.map((x) => [esc(x.code), x.old, x.new, tag('已更新')]), ...r.skipped.map((x) => [esc(x.code), x.old ?? '', x.new ?? '', `<span class="tag warn">${esc(x.reason)}</span>`])]) : '<div class="alert info">汇率已是最新，无需更新。</div>'}
                ${r.unchanged ? `<p class="small muted">${r.unchanged} 个币种汇率无变化</p>` : ''}`,
            });
            ERP.clearOptions();
            g.reload();
          } catch (e) { toast(e.message, 'error'); } finally { ar.disabled = false; }
        };
      }
    }
  }

  route(/^\/e\/(\w+)$/, ([key], main, qs) => entityPage(key, main, qs));

  /**
   * 其余有值的档案字段（含亿星兼容字段），避免详情页漏显示
   * Remaining non-empty entity fields (incl. 亿星-compatible ones) for detail pages.
   * @param {string} key 实体键 / entity key
   * @param {object} row 记录 / record
   * @param {string[]} skip 已显示的字段 / fields already shown
   * @returns {Promise<string>}
   */
  async function moreKv(key, row, skip) {
    const fields = ERP.state.meta.entities[key].fields.filter((f) => !skip.includes(f.name) && row[f.name] !== null && row[f.name] !== undefined && row[f.name] !== '');
    const items = await Promise.all(fields.map(async (f) => {
      let v = row[f.name];
      if (f.type === 'ref') {
        const opt = (await ERP.options(f.ref)).find((o) => String(o.id) === String(v));
        v = opt ? opt.label : v;
      }
      return `<div class="${f.type === 'textarea' ? 'kv-wide' : ''}"><b>${esc(f.label)}</b><span>${esc(v)}</span></div>`;
    }));
    return items.join('');
  }

  /** 客户页签（参照亿星客户管理页签）/ customer tabs modelled on 亿星 */
  const CUSTOMER_TABS = [['customer_contact', '联系人'], ['customer_mark', '唛头'], ['customer_forwarder', '货代'], ['customer_bank', '银行账号']];

  /**
   * 渲染客户的联系人/唛头/货代/银行账号页签 / Render the contact, mark, forwarder and bank tabs of a customer.
   * @param {HTMLElement} box 容器 / container
   * @param {number} customerId 客户ID / customer id
   * @param {string} [active] 当前页签 / active tab
   */
  async function customerTabs(box, customerId, active) {
    const tabs = CUSTOMER_TABS.filter(([k]) => ERP.state.meta.entities[k]);
    if (!tabs.length) { box.remove(); return; }
    const cur = active || tabs[0][0];
    const ent = ERP.state.meta.entities[cur];
    const counts = await Promise.all(tabs.map(([k]) => get(`/api/e/${k}?size=1&f_customer_id=${customerId}`).then((d) => d.total).catch(() => 0)));
    const { rows } = await get(`/api/e/${cur}?size=200&f_customer_id=${customerId}`);
    const fields = ent.fields.filter((f) => f.name !== 'customer_id');
    const canEdit = can('customer', 'edit');
    const canAdd = can('customer', 'add');
    box.innerHTML = `<div class="panel-head"><div class="tabs">${tabs.map(([k, l], i) => `<button class="tab ${k === cur ? 'active' : ''}" type="button" data-ctab="${k}">${l} <span class="muted small">${counts[i]}</span></button>`).join('')}</div>
      ${canAdd ? `<button class="btn small primary" type="button" data-cadd>＋ 新增${esc(tabs.find(([k]) => k === cur)[1])}</button>` : ''}</div>
      ${tableHtml([...fields.map((f) => f.label), ...(canEdit ? ['操作'] : [])], rows.map((r) => [...fields.map((f) => (f.type === 'textarea' ? `<span class="pre">${esc(r[f.name])}</span>` : esc(f.type === 'ref' ? r[f.name + '_label'] : r[f.name]))),
        ...(canEdit ? [`<button class="btn small" type="button" data-cedit="${r.id}">编辑</button> <button class="btn small danger" type="button" data-cdel="${r.id}">删除</button>`] : [])]))}`;
    box.querySelectorAll('[data-ctab]').forEach((b) => { b.onclick = () => customerTabs(box, customerId, b.dataset.ctab); });
    const form = async (row) => modal({
      title: `${row ? '编辑' : '新增'}${ent.title}`, wide: fields.length > 6, body: await formHtml(fields, row || {}),
      buttons: [{
        text: '保存', cls: 'primary', onClick: async (m) => {
          const body = { ...readForm(m.el), customer_id: customerId };
          if (row) await put(`/api/e/${cur}/${row.id}`, body); else await post(`/api/e/${cur}`, body);
          m.close();
          toast('已保存', 'ok');
          if (cur === 'customer_contact' && body.is_main === '是') ERP.navigate(); else customerTabs(box, customerId, cur);
        },
      }],
    });
    const ab = box.querySelector('[data-cadd]');
    if (ab) ab.onclick = () => form(null);
    box.querySelectorAll('[data-cedit]').forEach((b) => { b.onclick = () => form(rows.find((r) => r.id === Number(b.dataset.cedit))); });
    box.querySelectorAll('[data-cdel]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmBox('确定删除这条记录？'))) return;
        try { await del(`/api/e/${cur}/${b.dataset.cdel}`); toast('已删除', 'ok'); customerTabs(box, customerId, cur); } catch (e) { toast(e.message, 'error'); }
      };
    });
  }

  // ---------- 客户 360 / customer overview ----------
  route(/^\/customer\/(\d+)$/, async ([id], main) => {
    const d = await get(`/api/customers/${id}/overview`);
    setTitle('客户档案：' + d.customer.name);
    const c = d.customer;
    const sec = (title, headers, rows) => `<div class="panel"><h3 class="section-title">${title} <span class="muted small">${rows.length} 条</span></h3>${tableHtml(headers, rows)}</div>`;
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(c.name)} ${tag(c.level)}</h2>
        <div class="toolbar">${can('customer', 'add') ? '<button class="btn primary" id="follow">＋ 跟进记录</button>' : ''}<a class="btn" href="#/e/customer">返回列表</a></div></div>
      <div class="kv"><div><b>编码</b><span>${esc(c.code)}</span></div><div><b>国别</b><span>${esc(c.country)}</span></div><div><b>联系人</b><span>${esc(c.contact)}</span></div>
      <div><b>邮箱</b><span>${esc(c.email)}</span></div><div><b>业务员</b><span>${esc(c.salesman_name)}</span></div><div><b>来源</b><span>${esc(c.source)}</span></div>
      ${await moreKv('customer', c, ['code', 'name', 'country', 'contact', 'email', 'salesman_id', 'source', 'level'])}</div></div>
      <div class="panel" id="custTabs"></div>
      ${sec('跟进日志 / 询盘记录', ['时间', '类型', '内容', '下次跟进', '记录人'], d.follows.map((x) => [esc(x.created_at), esc(x.type), esc(x.content), esc(x.next_date), esc(x.user_name)]))}
      ${sec('往来邮件', ['时间', '方向', '主题', '分类'], d.mails.map((x) => [esc(x.created_at), esc(x.direction), esc(x.subject), esc(x.category)]))}
      ${sec('历史报价', ['报价单号', '日期', '金额', '状态'], d.quotes.map((x) => [`<a href="#/quote/${x.id}">${esc(x.quote_no)}</a>`, esc(String(x.created_at).slice(0, 10)), `${money(x.amount)} ${esc(x.currency)}`, tag(x.status)]))}
      ${sec('历史送样', ['送样单号', '货号', '快递单号', '状态'], d.sends.map((x) => [`<a href="#/send/${x.id}">${esc(x.send_no)}</a>`, esc(x.item_nos), esc(x.tracking_no), tag(x.status)]))}
      ${sec('历史订单', ['订单号', '下单日期', '金额', '状态'], d.orders.map((x) => [`<a href="#/order/${x.id}">${esc(x.order_no)}</a>`, esc(x.order_date), `${money(x.amount)} ${esc(x.currency)}`, tag(x.status)]))}
      ${sec('回款记录', ['日期', '订单', '类型', '金额', '折人民币'], d.receipts.map((x) => [esc(x.receipt_date), esc(x.order_no), esc(x.type), `${money(x.amount)} ${esc(x.currency)}`, money(x.amount_cny)]))}`;
    customerTabs(main.querySelector('#custTabs'), Number(id));
    const fb = main.querySelector('#follow');
    if (fb) {
      fb.onclick = async () => modal({
        title: '新增跟进记录', body: await formHtml(ERP.state.meta.entities.customer_follow.fields.filter((f) => f.name !== 'customer_id'), {}),
        buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/e/customer_follow', { ...readForm(m.el), customer_id: id }); m.close(); toast('已记录', 'ok'); ERP.navigate(); } }],
      });
    }
  });

  /** 样品明细页签（亿星：配件明细、包材明细、工序明细、多包装方案）/ sample BOM tabs */
  const SAMPLE_TABS = [['parts', '配件明细', 'sample_part', '配件'], ['pack', '包材明细', 'sample_part', '包材'], ['proc', '工序明细', 'sample_process'], ['plans', '包装方案', 'sample_package']];

  /**
   * 渲染样品明细页签与成本汇总 / Render the sample BOM tabs with the cost roll-up.
   * @param {HTMLElement} box 容器 / container
   * @param {number} sampleId 样品ID / sample id
   * @param {string} [active] 当前页签 / active tab
   */
  async function sampleTabs(box, sampleId, active) {
    if (!ERP.state.meta.entities.sample_part) { box.remove(); return; }
    const bom = await get(`/api/samples/${sampleId}/bom`);
    const cur = SAMPLE_TABS.find((t) => t[0] === active) || SAMPLE_TABS[0];
    const [, label, key, kind] = cur;
    const ent = ERP.state.meta.entities[key];
    const rows = key === 'sample_part' ? bom.parts.filter((p) => p.kind === kind) : key === 'sample_process' ? bom.processes : bom.packages;
    const counts = { parts: bom.parts.filter((p) => p.kind === '配件').length, pack: bom.parts.filter((p) => p.kind === '包材').length, proc: bom.processes.length, plans: bom.packages.length };
    const fields = ent.fields.filter((f) => !['sample_id', 'kind'].includes(f.name) && f.list !== false);
    const canEdit = can('sample', 'edit');
    const show = (f, r) => (f.type === 'ref' ? esc(r[f.name.replace('_id', '_name')] ?? r[f.name + '_label'] ?? '') : f.type === 'textarea' ? `<span class="pre">${esc(r[f.name])}</span>` : esc(r[f.name]));
    const extra = key === 'sample_part' ? ['每只成本¥'] : [];
    // 配件/包材/工序可勾选后向供应商询价 / parts, packaging and processes can be sent for inquiry
    const canInq = key !== 'sample_package' && can('quote', 'edit') && ERP.state.meta.user.scope !== 'designer' && rows.length > 0;
    const pick = (r) => (canInq ? [`<input type="checkbox" data-inq="${r.id}" aria-label="选择询价">`] : []);
    box.innerHTML = `<div class="panel-head"><div class="tabs">${SAMPLE_TABS.map(([k, l]) => `<button class="tab ${k === cur[0] ? 'active' : ''}" type="button" data-stab="${k}">${l} <span class="muted small">${counts[k]}</span></button>`).join('')}</div>
      <div class="toolbar">${canInq ? '<button class="btn small" type="button" data-sinq>询价所选</button>' : ''}${canEdit ? `<button class="btn small primary" type="button" data-sadd>＋ 新增${esc(label.replace('明细', ''))}</button>` : ''}</div></div>
      ${tableHtml([...(canInq ? ['询价'] : []), ...fields.map((f) => f.label), ...extra, ...(canEdit ? ['操作'] : [])], rows.map((r) => [...pick(r), ...fields.map((f) => show(f, r)), ...(key === 'sample_part' ? [money(r.cost_per_pc)] : []),
    ...(canEdit ? [`<button class="btn small" type="button" data-sedit="${r.id}">编辑</button> <button class="btn small danger" type="button" data-sdel="${r.id}">删除</button>`] : [])]))}
      <div class="kv" style="margin-top:10px"><div><b>配件成本/只</b><span>¥${money(bom.cost.parts)}</span></div><div><b>包材成本/只</b><span>¥${money(bom.cost.packaging)}</span></div>
        <div><b>工序工价/只</b><span>¥${money(bom.cost.process)}</span></div><div><b>明细合计/只</b><span><b>¥${money(bom.cost.total)}</b></span></div>
        <div><b>档案现成本</b><span>材料¥${money(bom.current.material_cost)} + 人工¥${money(bom.current.labor_cost)}</span></div><div><b>装箱数</b><span>${bom.per_carton || '-'}</span></div></div>
      ${bom.warnings.length ? `<div class="alert warn" style="margin-top:6px"><span>${esc(bom.warnings.join('；'))}</span></div>` : ''}
      ${canEdit && (bom.parts.length || bom.processes.length) ? '<div class="toolbar" style="margin-top:8px"><button class="btn small" type="button" data-apply>按明细更新样品成本（材料=配件+包材，人工=工序）</button></div>' : ''}
      ${key === 'sample_package' ? '<p class="muted small">“默认方案”会同步到样品档案的包装率、外箱尺寸、CBM、毛净重；订单明细可另选方案，出货时按所选方案计算箱数。</p>' : ''}`;
    box.querySelectorAll('[data-stab]').forEach((b) => { b.onclick = () => sampleTabs(box, sampleId, b.dataset.stab); });
    const form = async (row) => modal({
      title: `${row ? '编辑' : '新增'}${label.replace('明细', '')}`, wide: true, body: await formHtml(ent.fields.filter((f) => !['sample_id', 'kind'].includes(f.name)), row || {}),
      buttons: [{
        text: '保存', cls: 'primary', onClick: async (m) => {
          const body = { ...readForm(m.el), sample_id: sampleId, ...(kind ? { kind } : {}) };
          if (row) await put(`/api/e/${key}/${row.id}`, body); else await post(`/api/e/${key}`, body);
          m.close();
          toast('已保存', 'ok');
          if (key === 'sample_package' && body.is_default === '是') ERP.navigate(); else sampleTabs(box, sampleId, cur[0]);
        },
      }],
    });
    const ab = box.querySelector('[data-sadd]');
    if (ab) ab.onclick = () => form(null);
    const ib = box.querySelector('[data-sinq]');
    if (ib) {
      ib.onclick = async () => {
        const ids = [...box.querySelectorAll('[data-inq]:checked')].map((c) => Number(c.dataset.inq));
        if (!ids.length) { toast('请先勾选要询价的明细', 'error'); return; }
        const sups = await ERP.options('supplier');
        modal({
          title: `向供应商询价（${ids.length}项）`,
          body: `<div class="form-grid"><label><span class="req">供应商</span><select name="supplier_id">${ERP.optHtml(sups, '')}</select></label>
            <label><span>询价数量（可空）</span><input type="number" min="0" name="qty"></label><label><span>报价有效期</span><input type="date" name="valid_until"></label>
            <label class="wide"><span>备注/要求</span><input name="remark"></label></div>`,
          buttons: [{
            text: '生成询价单', cls: 'primary', onClick: async (m) => {
              const f = readForm(m.el);
              const r = await post('/api/bom-inquiries', { supplier_id: f.supplier_id, valid_until: f.valid_until, remark: f.remark,
                lines: ids.map((sid) => ({ source_type: key === 'sample_part' ? 'part' : 'process', source_id: sid, qty: f.qty })) });
              m.close();
              toast(`询价单 ${r.inq_no} 已生成`, 'ok');
              location.hash = '#/bom-inquiry/' + r.id;
            },
          }],
        });
      };
    }
    box.querySelectorAll('[data-sedit]').forEach((b) => { b.onclick = async () => form(await get(`/api/e/${key}/${b.dataset.sedit}`)); });
    box.querySelectorAll('[data-sdel]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmBox('确定删除这条明细？'))) return;
        try { await del(`/api/e/${key}/${b.dataset.sdel}`); toast('已删除', 'ok'); sampleTabs(box, sampleId, cur[0]); } catch (e) { toast(e.message, 'error'); }
      };
    });
    const ap = box.querySelector('[data-apply]');
    if (ap) {
      ap.onclick = async () => {
        if (!(await confirmBox(`把样品成本更新为：材料¥${bom.cost.material}、人工¥${bom.cost.process}？会记录到改样日志。`))) return;
        try { await post(`/api/samples/${sampleId}/apply-bom-cost`); toast('样品成本已更新', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); }
      };
    }
  }

  // ---------- 样品详情 / sample detail ----------
  route(/^\/sample\/(\d+)$/, async ([id], main) => {
    const d = await get(`/api/samples/${id}/overview`);
    const s = d.sample;
    setTitle('样品档案：' + s.company_no);
    const imgs = String(s.images || '').split(/[,，\s]+/).filter(Boolean);
    const sec = (title, headers, rows) => `<div class="panel"><h3 class="section-title">${title} <span class="muted small">${rows.length} 条</span></h3>${tableHtml(headers, rows)}</div>`;
    const cost = (Number(s.material_cost) || 0) + (Number(s.labor_cost) || 0);
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(s.company_no)} ${esc(s.name)} ${tag(s.status)} ${tag(s.progress)}</h2>
        <div class="toolbar">${can('sample', 'add') ? '<button class="btn" id="rev">＋ 改样日志</button>' : ''}<a class="btn" href="#/e/sample">返回列表</a></div></div>
      ${s.status === '已锁定' ? `<div class="lock-banner">该旧货号已被新货号 ${d.children.map((c) => `<a href="#/sample/${c.id}">${esc(c.company_no)}</a>`).join('、')} 替代并锁定，禁止报价/下单/出货。</div>` : ''}
      <div class="kv">
        <div><b>公司货号</b><span>${esc(s.company_no)}</span></div><div><b>客户货号</b><span>${esc(s.customer_no)}</span></div><div><b>工厂货号</b><span>${esc(s.factory_no)}</span></div>
        <div><b>英文品名</b><span>${esc(s.name_en)}</span></div><div><b>尺寸(cm)</b><span>${s.length_cm ? `${s.length_cm}×${s.width_cm}×${s.height_cm}` : ''}</span></div>
        <div><b>材质</b><span>${esc(s.material)}</span></div><div><b>工艺</b><span>${esc(s.craft)}</span></div><div><b>花色</b><span>${esc(s.color)}</span></div>
        <div><b>耗材</b><span>${esc(s.consumables)}</span></div><div><b>设计师</b><span>${esc(s.designer_name)}</span></div><div><b>生产工厂</b><span>${esc(s.supplier_name)}</span></div>
        <div><b>材料+人工成本</b><span>¥${money(cost)}</span></div><div><b>打样费用</b><span>¥${money(s.sample_fee)}</span></div><div><b>样品库存</b><span>${esc(s.stock_qty)}</span></div>
        <div><b>包装要求</b><span>${esc(s.package_req)}</span></div><div><b>标签规范</b><span>${esc(s.label_req)}</span></div><div><b>内盒</b><span>${esc(s.inner_box)}</span></div>
        <div><b>外箱(cm)</b><span>${s.outer_l ? `${s.outer_l}×${s.outer_w}×${s.outer_h}，${s.pcs_per_carton}只/箱` : ''}</span></div><div><b>MOQ</b><span>${esc(s.moq)}</span></div>
        <div><b>原货号</b><span>${s.parent_no ? esc(s.parent_no) : '-'}</span></div>
        ${await moreKv('sample', s, ['company_no', 'customer_no', 'factory_no', 'name', 'name_en', 'length_cm', 'width_cm', 'height_cm', 'material', 'craft', 'color', 'consumables',
    'designer_id', 'supplier_id', 'material_cost', 'labor_cost', 'sample_fee', 'stock_qty', 'package_req', 'label_req', 'inner_box', 'outer_l', 'outer_w', 'outer_h', 'pcs_per_carton', 'moq',
    'parent_no', 'status', 'progress', 'images'])}
      </div>
      <div class="panel-head" style="margin:14px 0 6px"><h3>样品图片 <span class="muted small">${imgs.length} 张</span></h3>
        ${can('sample', 'edit') ? '<label class="btn small">＋ 上传图片<input type="file" id="upl" accept="image/*" multiple hidden></label>' : ''}</div>
      <div class="gallery">${imgs.length ? imgs.map((u) => `<figure><img data-ref="${esc(u)}" alt="样品图片" loading="lazy">
        ${can('sample', 'edit') && u.startsWith('file:') ? `<button class="btn small danger" data-delimg="${esc(u.slice(5))}" title="删除">✕</button>` : ''}</figure>`).join('') : '<div class="muted small">暂无图片（可上传多角度样品照片，自动压缩）</div>'}</div></div>
      <div class="panel" id="bomTabs"></div>
      ${sec('改样日志', ['时间', '阶段', '内容', '记录人'], d.revisions.map((x) => [esc(x.created_at), tag(x.stage), esc(x.content), esc(x.user_name)]))}
      ${d.quotes ? sec('报价记录', ['报价单号', '客户', '数量', '单价', '新货号', '状态'], d.quotes.map((x) => [`<a href="#/quote/${x.quote_id}">${esc(x.quote_no)}</a>`, esc(x.customer_name), esc(x.qty), `${money(x.price)} ${esc(x.currency)}`, esc(x.new_item_no), tag(x.status)])) : ''}
      ${d.sends ? sec('送样记录', ['送样单号', '客户', '数量', '新货号', '状态'], d.sends.map((x) => [`<a href="#/send/${x.send_id}">${esc(x.send_no)}</a>`, esc(x.customer_name), esc(x.qty), esc(x.new_item_no), tag(x.status)])) : ''}
      ${d.orders ? sec('订单记录', ['订单号', '客户', '数量', '单价', '状态'], d.orders.map((x) => [`<a href="#/order/${x.order_id}">${esc(x.order_no)}</a>`, esc(x.customer_name), esc(x.qty), `${money(x.unit_price)} ${esc(x.currency)}`, tag(x.status)])) : ''}
      <div class="panel"><h3 class="section-title">送样转化率</h3><div class="kv"><div><b>送样次数</b><span>${d.stats.sends}</span></div><div><b>成交订单数</b><span>${d.stats.orders}</span></div><div><b>转化率</b><span>${d.stats.rate}</span></div></div></div>`;
    ERP.loadImages(main);
    sampleTabs(main.querySelector('#bomTabs'), Number(id));
    main.querySelectorAll('.gallery img').forEach((im) => {
      im.onclick = () => modal({ title: `${s.company_no} 样品图片`, wide: true, body: `<img src="${im.src}" alt="样品图片" style="max-width:100%;display:block;margin:auto">` });
    });
    const upl = main.querySelector('#upl');
    if (upl) {
      upl.onchange = async () => {
        let n = 0;
        for (const f of upl.files) {
          try {
            await post(`/api/samples/${id}/images`, { name: f.name, data: await ERP.compressImage(f) });
            n++;
          } catch (e) { toast(`${f.name}：${e.message}`, 'error'); }
        }
        if (n) toast(`已上传 ${n} 张图片`, 'ok');
        ERP.navigate();
      };
    }
    main.querySelectorAll('[data-delimg]').forEach((b) => {
      b.onclick = async () => { if (await confirmBox('删除这张图片？')) { await del(`/api/samples/${id}/images/${b.dataset.delimg}`); toast('已删除', 'ok'); ERP.navigate(); } };
    });
    const rb = main.querySelector('#rev');
    if (rb) {
      rb.onclick = async () => modal({
        title: '新增改样日志', body: await formHtml(ERP.state.meta.entities.sample_revision.fields.filter((f) => f.name !== 'sample_id'), {}),
        buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/e/sample_revision', { ...readForm(m.el), sample_id: id }); m.close(); toast('已记录', 'ok'); ERP.navigate(); } }],
      });
    }
  });

  // ---------- 系统管理 / system administration ----------
  route(/^\/system$/, async (_, main, qs) => {
    setTitle('系统权限管理');
    const tab = qs.get('tab') || 'modules';
    const tabs = [['modules', '模块启停'], ['roles', '岗位角色权限'], ['users', '账号管理'], ['settings', '系统参数'], ['logs', '登录/操作日志']];
    main.innerHTML = `<div class="panel"><div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="tabBody"></div></div>`;
    main.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = '#/system?tab=' + b.dataset.tab; }; });
    const body = main.querySelector('#tabBody');
    const editable = can('system', 'edit');
    if (tab === 'modules') {
      const mods = ERP.state.meta.modules;
      const stage = ['', '一期 基础档案', '二期 外贸获客', '三期 订单出货', '四期 财务收付', '五期 生产供应链', '六期 统计分析'];
      body.innerHTML = `<div class="alert info">松耦合可插拔：每个模块独立启停，停用后菜单隐藏、接口拒绝访问，数据保留，重新启用即可恢复。</div>
        ${tableHtml(['阶段', '模块', '状态', '启停'], mods.map((m) => [esc(stage[m.stage]), esc(m.name), tag(m.enabled ? '启用' : '禁用'),
          m.key === 'system' ? '<span class="muted small">核心模块</span>' : `<label class="switch"><input type="checkbox" data-mod="${m.key}" ${m.enabled ? 'checked' : ''} ${editable ? '' : 'disabled'}><span></span></label>`]))}`;
      body.querySelectorAll('[data-mod]').forEach((el) => {
        el.onchange = async () => {
          try { await put('/api/modules/' + el.dataset.mod, { enabled: el.checked }); toast(el.checked ? '模块已启用' : '模块已停用', 'ok'); await ERP.reloadMeta(); ERP.navigate(); } catch (e) { toast(e.message, 'error'); el.checked = !el.checked; }
        };
      });
    }
    if (tab === 'roles') {
      const { rows, actions } = await get('/api/roles');
      const actName = { view: '查看', add: '新增', edit: '修改', delete: '删除', export: '导出', print: '打印', audit: '审核' };
      const scopeName = { all: '全部数据', own: '仅本人数据', designer: '设计师本人样品' };
      body.innerHTML = `<div class="toolbar" style="margin-bottom:10px">${can('system', 'add') ? '<button class="btn primary" id="addRole">＋ 新增角色</button>' : ''}</div>
        ${tableHtml(['角色', '代码', '数据范围', '账号数', '说明', '操作'], rows.map((r) => [esc(r.name), esc(r.code), esc(scopeName[r.data_scope]), r.user_count, esc(r.remark),
          `${editable ? `<button class="btn small" data-role="${r.id}">配置权限</button>` : ''} ${can('system', 'delete') ? `<button class="btn small danger" data-delrole="${r.id}">删除</button>` : ''}`]))}`;
      const openRole = (role) => {
        const perms = role ? JSON.parse(role.perms || '{}') : {};
        const mods = ERP.state.meta.modules;
        const m = modal({
          title: role ? `配置权限：${role.name}` : '新增角色', wide: true,
          body: `<div class="form-grid"><label><span class="req">角色代码</span><input name="code" value="${esc(role?.code)}"></label><label><span class="req">角色名称</span><input name="name" value="${esc(role?.name)}"></label>
            <label><span>数据范围</span><select name="data_scope">${ERP.optHtml(Object.entries(scopeName).map(([id, label]) => ({ id, label })), role?.data_scope || 'all', false)}</select></label>
            <label><span>说明</span><input name="remark" value="${esc(role?.remark)}"></label></div>
            <div class="table-wrap" style="margin-top:12px"><table class="perm-table"><thead><tr><th>模块</th>${actions.map((a) => `<th>${actName[a]}</th>`).join('')}<th>整行</th></tr></thead><tbody>
            ${mods.map((md) => `<tr><td>${esc(md.name)}</td>${actions.map((a) => `<td><input type="checkbox" data-p="${md.key}:${a}" ${(perms[md.key] || []).includes(a) ? 'checked' : ''}></td>`).join('')}<td><button class="btn small" data-row="${md.key}" type="button">全选</button></td></tr>`).join('')}
            </tbody></table></div>`,
          buttons: [{
            text: '保存', cls: 'primary', onClick: async (mm) => {
              const p = {};
              mm.el.querySelectorAll('[data-p]').forEach((c) => { if (c.checked) { const [k, a] = c.dataset.p.split(':'); (p[k] = p[k] || []).push(a); } });
              const f = {};
              mm.el.querySelectorAll('.form-grid [name]').forEach((el) => { f[el.name] = el.value; });
              if (role) await put('/api/roles/' + role.id, { ...f, perms: p }); else await post('/api/roles', { ...f, perms: p });
              mm.close(); toast('角色权限已保存', 'ok'); ERP.navigate();
            },
          }],
        });
        m.el.querySelectorAll('[data-row]').forEach((b) => { b.onclick = () => m.el.querySelectorAll(`[data-p^="${b.dataset.row}:"]`).forEach((c) => { c.checked = true; }); });
      };
      const ab = body.querySelector('#addRole');
      if (ab) ab.onclick = () => openRole(null);
      body.querySelectorAll('[data-role]').forEach((b) => { b.onclick = () => openRole(rows.find((x) => x.id === Number(b.dataset.role))); });
      body.querySelectorAll('[data-delrole]').forEach((b) => { b.onclick = async () => { if (await confirmBox('确定删除该角色？')) { try { await del('/api/roles/' + b.dataset.delrole); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } } }; });
    }
    if (tab === 'users') {
      const [{ rows, policy }, roles, emps] = await Promise.all([get('/api/users'), ERP.options('role', true), ERP.options('employee', true)]);
      /** 一次性显示临时密码 / show a temporary password once */
      const showTemp = (title, username, pw) => modal({
        title, body: `<div class="alert warn"><span>请把以下临时密码通过安全渠道告知 <b>${esc(username)}</b>。此密码只显示这一次，对方首次登录后必须修改。</span></div>
          <div style="font-size:20px;text-align:center;margin:12px 0"><code style="user-select:all;padding:6px 12px;background:var(--bg);border-radius:6px">${esc(pw)}</code></div>`,
      });
      const secTag = (u) => (u.locked ? tag('已锁定') : u.must_change_password ? '<span class="tag warn">待改密</span>' : u.pw_is_default ? '<span class="tag warn">演示密码</span>' : '<span class="tag ok">正常</span>');
      body.innerHTML = `<div class="toolbar" style="margin-bottom:10px">${can('system', 'add') ? '<button class="btn primary" id="addUser">＋ 新增账号</button>' : ''}
        ${editable ? `<span class="muted small">批量授权：勾选账号后选择角色</span><select id="batchRole" style="width:160px">${ERP.optHtml(roles, '')}</select><button class="btn" id="batchBtn">批量授权</button>` : ''}</div>
        <div class="alert info">密码规则：${esc(policy)}。连续输错密码将自动锁定账号；重置密码会生成一次性临时密码，员工首次登录必须修改。</div>
        ${tableHtml(['', '账号', '姓名', '角色', '绑定员工', '状态', '密码安全', '最近登录', '操作'], rows.map((u) => [`<input type="checkbox" data-uid="${u.id}">`, esc(u.username), esc(u.name), esc(u.role_name), esc(u.employee_name), tag(u.status),
          secTag(u), esc(u.last_login_at), editable ? `<button class="btn small" data-eu="${u.id}">编辑</button> <button class="btn small" data-rp="${u.id}">重置密码</button>
          ${u.locked ? `<button class="btn small primary" data-unlock="${u.id}">解锁</button>` : ''} <button class="btn small ${u.status === '启用' ? 'danger' : ''}" data-tg="${u.id}">${u.status === '启用' ? '禁用' : '启用'}</button>` : '']))}`;
      const userForm = (u) => `<div class="form-grid"><label><span class="req">账号</span><input name="username" value="${esc(u?.username)}" ${u ? 'disabled' : ''}></label>
        <label><span class="req">姓名</span><input name="name" value="${esc(u?.name)}"></label>
        <label><span class="req">角色</span><select name="role_id">${ERP.optHtml(roles, u?.role_id)}</select></label>
        <label><span>绑定员工（设计师/业务员必须绑定）</span><select name="employee_id">${ERP.optHtml(emps, u?.employee_id)}</select></label>
        ${u ? '' : '<label><span>初始密码（留空则自动生成强密码）</span><input name="password" type="password" autocomplete="new-password"></label>'}</div>`;
      const au = body.querySelector('#addUser');
      if (au) {
        au.onclick = () => modal({
          title: '新增账号', body: userForm(null), buttons: [{
            text: '保存', cls: 'primary', onClick: async (m) => {
              const f = readForm(m.el);
              const r = await post('/api/users', f);
              m.close();
              ERP.navigate();
              if (!f.password) showTemp('账号已创建：临时密码', f.username, r.temp_password); else toast('账号已创建，首次登录需修改密码', 'ok');
            },
          }],
        });
      }
      body.querySelectorAll('[data-eu]').forEach((b) => {
        const u = rows.find((x) => x.id === Number(b.dataset.eu));
        b.onclick = () => modal({ title: '编辑账号', body: userForm(u), buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await put('/api/users/' + u.id, readForm(m.el)); m.close(); toast('已保存', 'ok'); ERP.navigate(); } }] });
      });
      body.querySelectorAll('[data-rp]').forEach((b) => {
        const u = rows.find((x) => x.id === Number(b.dataset.rp));
        b.onclick = async () => {
          if (!(await confirmBox(`为 ${u.username} 生成新的临时密码？对方当前所有登录将被退出。`))) return;
          const r = await post(`/api/users/${u.id}/reset-password`, {});
          ERP.navigate();
          showTemp('密码已重置：临时密码', u.username, r.temp_password);
        };
      });
      body.querySelectorAll('[data-unlock]').forEach((b) => { b.onclick = async () => { await put('/api/users/' + b.dataset.unlock, { unlock: true }); toast('账号已解锁', 'ok'); ERP.navigate(); }; });
      body.querySelectorAll('[data-tg]').forEach((b) => {
        const u = rows.find((x) => x.id === Number(b.dataset.tg));
        b.onclick = async () => { try { await put('/api/users/' + u.id, { status: u.status === '启用' ? '禁用' : '启用' }); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } };
      });
      const bb = body.querySelector('#batchBtn');
      if (bb) {
        bb.onclick = async () => {
          const ids = [...body.querySelectorAll('[data-uid]:checked')].map((c) => Number(c.dataset.uid));
          try { const r = await post('/api/users/batch-role', { ids, role_id: body.querySelector('#batchRole').value }); toast(`已为${r.count}个账号授权`, 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); }
        };
      }
    }
    if (tab === 'settings') {
      const s = await get('/api/settings');
      body.innerHTML = `<div class="form-grid"><label><span>公司中文名</span><input name="company_name" value="${esc(s.company_name)}"></label>
        <label><span>公司英文名</span><input name="company_name_en" value="${esc(s.company_name_en)}"></label>
        <label><span>报价最低利润率%（低于则审批预警）</span><input name="quote_min_profit" type="number" value="${esc(s.quote_min_profit)}"></label>
        <label class="wide"><span>汇率接口地址（失败时自动切换备用接口）</span><input name="rate_api_url" value="${esc(s.rate_api_url)}"></label>
        <label><span>汇率自动更新周期（小时，0=关闭）</span><input name="rate_auto_hours" type="number" value="${esc(s.rate_auto_hours)}"></label>
        <label><span>汇率异常波动阈值%（超过不自动采用）</span><input name="rate_max_change" type="number" value="${esc(s.rate_max_change)}"></label>
        <label><span>自动收信间隔（分钟，0=关闭）</span><input name="mail_fetch_minutes" type="number" value="${esc(s.mail_fetch_minutes)}"></label>
        <label><span>新邮箱首次同步最近邮件数</span><input name="mail_initial_sync" type="number" value="${esc(s.mail_initial_sync)}"></label>
        <label><span>登录页显示演示账号（正式使用请关闭）</span><select name="show_demo_accounts">${ERP.optHtml([{ id: '1', label: '显示' }, { id: '0', label: '不显示' }], s.show_demo_accounts, false)}</select></label>
        <label><span>连续输错几次密码锁定账号</span><input name="lockout_threshold" type="number" min="3" value="${esc(s.lockout_threshold)}"></label>
        <label><span>锁定时长（分钟）</span><input name="lockout_minutes" type="number" min="1" value="${esc(s.lockout_minutes)}"></label>
        <label><span>应收单笔销账上限（原币金额）</span><input name="ar_writeoff_max" type="number" step="any" value="${esc(s.ar_writeoff_max)}"></label>
        <label><span>出运前必须先做成品销售出库</span><select name="fg_require_out_before_ship">${ERP.optHtml([{ id: '0', label: '不要求（默认）' }, { id: '1', label: '要求' }], s.fg_require_out_before_ship, false)}</select></label>
        <label><span>允许内网/本机邮件服务器（有SSRF风险，仅内网部署时开启）</span><select name="mail_allow_private_hosts">${ERP.optHtml([{ id: '0', label: '不允许（推荐）' }, { id: '1', label: '允许' }], s.mail_allow_private_hosts, false)}</select></label></div>
        ${editable ? '<div style="margin-top:12px"><button class="btn primary" id="saveSet">保存参数</button></div>' : ''}`;
      const sb = body.querySelector('#saveSet');
      if (sb) sb.onclick = async () => { await put('/api/settings', readForm(body)); toast('参数已保存', 'ok'); await ERP.reloadMeta(); };
    }
    if (tab === 'logs') {
      location.hash = '#/e/log';
    }
  });
})();
